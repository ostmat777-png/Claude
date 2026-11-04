"""OpenStreetMap via Overpass: robust download (mirrors, chunking, caching) and parsing."""
from __future__ import annotations

import hashlib
import json
import logging
import math
import time
from dataclasses import dataclass, field

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge, polygonize, unary_union

from . import db, net
from .config import settings

log = logging.getLogger(__name__)

LIFECYCLE_PREFIXES = ("abandoned", "disused", "ruins", "was", "demolished", "razed")

# ways/nodes: tags+geometry; relations: members with geometry (needed for multipolygons)
OUT = "(node.a; way.a;); out tags geom qt;\nrel.a; out body geom qt;"

# query groups: (name, overpass body, chunk size in degrees lat, out statement)
_LC_KEYS = ["abandoned", "disused", "ruins"] + [
    f"{p}:{k}" for p in ("abandoned", "disused", "ruins")
    for k in ("building", "amenity", "railway", "man_made", "landuse", "military", "shop", "office",
              "industrial", "place", "aeroway", "power", "tourism", "leisure", "historic")]
_LC = "\n".join(f'  nwr["{k}"];' for k in _LC_KEYS)


# query groups: (name, overpass body, chunk size in degrees lat, out statement).
# Explicit keys instead of regex keys: much cheaper for public Overpass servers.
GROUPS = [
    ("context", _LC + """
  nwr["building"="ruins"]; nwr["historic"~"^(ruins|bunker|fort|military)$"];
  nwr["was:building"]; nwr["was:amenity"]; nwr["was:military"];
  nwr["military"];
  nwr["landuse"~"^(residential|allotments|industrial|commercial|retail|farmyard|garages|quarry|construction|landfill|railway|cemetery|military|brownfield)$"];
  nwr["man_made"~"^(water_tower|tower|chimney|works|silo|bunker_silo)$"];
  nwr["access"~"^(private|no|military|permit)$"]["highway"!~"."]["barrier"!~"."];
  nwr["barrier"]; nwr["building"="guardhouse"]; nwr["military"="checkpoint"]; nwr["amenity"="security"];
  node["place"]; way["place"];
""", 0.08, OUT),
    ("buildings", """
  way["building"]; relation["building"];
""", 0.05, OUT),
    ("highways", """
  way["highway"];
""", 0.06, OUT),
    # active / protected places: parks, museums, reserves, monuments — never "abandoned objects" for the user
    ("leisure", """
  nwr["leisure"~"^(park|garden|nature_reserve|recreation_ground|playground|sports_centre|stadium)$"];
  nwr["boundary"="protected_area"];
  nwr["tourism"~"^(museum|attraction|zoo|theme_park|gallery|camp_site)$"];
  nwr["historic"~"^(monument|memorial|castle|manor|church|city_gate|citywalls|fort|archaeological_site)$"];
""", 0.12, OUT),
]


class OverpassError(Exception):
    pass


def _chunks(s, w, n, e, step_lat):
    step_lon = step_lat * 2.0
    out = []
    lat = s
    while lat < n - 1e-9:
        lat2 = min(n, lat + step_lat)
        lon = w
        while lon < e - 1e-9:
            lon2 = min(e, lon + step_lon)
            out.append((round(lat, 5), round(lon, 5), round(lat2, 5), round(lon2, 5)))
            lon = lon2
        lat = lat2
    return out


_good_mirror = {"i": 0}


def overpass(body: str, bbox, out: str, checkpoint=None, timeout=90) -> list:
    s, w, n, e = bbox
    q = f"[out:json][timeout:{timeout}][bbox:{s},{w},{n},{e}];\n(\n{body}\n)->.a;\n{out}"
    key = "overpass:" + hashlib.sha1(q.encode()).hexdigest()
    cached = db.http_cache_get(key, settings()["osm_cache_days"] * 86400)
    if cached is not None:
        return json.loads(cached)
    urls = list(settings()["overpass_urls"])
    errors = []
    deadline = time.time() + 15 * 60  # be patient with busy public servers, but not forever
    attempt = 0
    while time.time() < deadline and attempt < 14:
        now = time.time()
        order = sorted(range(len(urls)), key=lambda i: (_penalty.get(urls[i], 0) > now,
                                                        (i - _good_mirror["i"]) % len(urls)))
        i = order[0]
        url = urls[i]
        wait = _penalty.get(url, 0) - now
        if wait > 0:  # every mirror is cooling down
            _sleep(min(wait, 60), checkpoint)
        if checkpoint:
            checkpoint()
        attempt += 1
        try:
            r = net.post(url, data={"data": q}, timeout=(15, timeout + 15), retries=0, ok_statuses=(200,))
            txt = r.text
            if not txt.lstrip().startswith("{"):
                raise OverpassError("non-JSON answer")
            d = json.loads(txt)
            rem = d.get("remark") or ""
            if "runtime error" in rem or "timed out" in rem:
                raise OverpassError(rem[:200])
            els = d.get("elements", [])
            _good_mirror["i"] = i
            _penalty.pop(url, None)
            db.http_cache_put(key, json.dumps(els).encode())
            return els
        except Exception as ex:  # cool this mirror down and try another one
            msg = str(ex)
            errors.append(f"{url.split('/')[2]}: {msg}"[:160])
            log.info("overpass %s failed: %s", url, msg[:200])
            if any(t in msg for t in ("Connection reset", "Failed to establish", "NameResolution", "Connection aborted")):
                cool = 900
            elif "timed out" in msg.lower() or "timeout" in msg.lower():
                cool = 300
            elif "429" in msg:
                cool = 60
            else:
                cool = 10 + 5 * attempt
            _penalty[url] = time.time() + cool
    raise OverpassError("; ".join(errors[-4:]))


def _sleep(seconds, checkpoint=None):
    t_end = time.time() + seconds
    while time.time() < t_end:
        if checkpoint:
            checkpoint()
        time.sleep(0.5)


_penalty: dict = {}


def fetch_area(poly, job=None) -> list:
    """Downloads all needed OSM data for the polygon bbox (with margin). Returns merged elements."""
    w, s, e, n = poly.bounds
    m = 0.004  # ~400 m margin for context (fences, roads, settlements)
    s, w, n, e = s - m, w - m * 2, n + m, e + m * 2
    plan = []
    for name, body, step, out in GROUPS:
        for ch in _chunks(s, w, n, e, step):
            plan.append((name, body, ch, out))
    els_by_id = {}
    failed = []
    for i, (name, body, ch, out) in enumerate(plan):
        if job:
            job.progress(i, len(plan), f"OSM: {name} ({i + 1}/{len(plan)})")
        got = _fetch_split(body, ch, out, job, depth=0, failed=failed, name=name)
        for el in got:
            els_by_id[(el["type"], el["id"])] = el
    if job:
        job.progress(len(plan), len(plan))
        if failed:
            job.info(f"OSM: не удалось скачать {len(failed)} фрагм. ({', '.join(sorted(set(failed)))}) — результат может быть неполным")
    return list(els_by_id.values()), failed


def _fetch_split(body, ch, out, job, depth, failed, name):
    try:
        return overpass(body, ch, out, checkpoint=job.checkpoint if job else None)
    except OverpassError as ex:
        if depth >= 2:
            log.warning("overpass gave up on %s %s: %s", name, ch, ex)
            failed.append(name)
            return []
        s, w, n, e = ch
        ml, mo = (s + n) / 2, (w + e) / 2
        res = []
        for sub in ((s, w, ml, mo), (s, mo, ml, e), (ml, w, n, mo), (ml, mo, n, e)):
            res.extend(_fetch_split(body, sub, out, job, depth + 1, failed, name))
        return res


# ---------------------------------------------------------------- parsing
def _way_coords(el):
    g = el.get("geometry") or []
    return [(p["lon"], p["lat"]) for p in g if p]


def _assemble_multipolygon(el):
    outers, inners = [], []
    for m in el.get("members", []):
        if m.get("type") != "way" or not m.get("geometry"):
            continue
        coords = [(p["lon"], p["lat"]) for p in m["geometry"] if p]
        if len(coords) < 2:
            continue
        (inners if m.get("role") == "inner" else outers).append(LineString(coords))
    if not outers:
        return None
    try:
        polys = list(polygonize(linemerge(unary_union(outers))))
        if not polys:
            return None
        g = unary_union(polys)
        if inners:
            holes = list(polygonize(linemerge(unary_union(inners))))
            if holes:
                g = g.difference(unary_union(holes))
        return g if not g.is_empty else None
    except Exception:
        return None


def element_geometry(el):
    t = el["type"]
    if t == "node":
        if "lat" in el:
            return Point(el["lon"], el["lat"])
        return None
    if t == "way":
        coords = _way_coords(el)
        if len(coords) < 2:
            if "center" in el:
                return Point(el["center"]["lon"], el["center"]["lat"])
            return None
        closed = len(coords) >= 4 and coords[0] == coords[-1]
        tags = el.get("tags", {})
        is_line = tags.get("highway") or (tags.get("barrier") and not tags.get("area") == "yes")
        if closed and not is_line:
            p = Polygon(coords)
            if not p.is_valid:
                p = p.buffer(0)
            return p
        return LineString(coords)
    if t == "relation":
        if "center" in el:
            return Point(el["center"]["lon"], el["center"]["lat"])
        g = _assemble_multipolygon(el)
        if g is None and el.get("bounds"):
            b = el["bounds"]
            return Point((b["minlon"] + b["maxlon"]) / 2, (b["minlat"] + b["maxlat"]) / 2)
        return g
    return None


_CONSTR_WORDS = ("строительство", "стройка", "стройплощад", "жилой комплекс", "жк ", "жк\u00a0", "реконструкция")


def is_construction(tags: dict) -> bool:
    """Active construction / redevelopment site (often still tagged landuse=brownfield in OSM)."""
    if tags.get("landuse") == "construction" or tags.get("building") == "construction":
        return True
    if tags.get("construction") not in (None, "no") and not tags.get("highway"):
        return True
    if "building" in tags:   # names of buildings ("строительный техникум") say nothing about the site state
        return False
    txt = " " + " ".join(str(tags.get(k, "")) for k in ("name", "description", "note")).lower() + " "
    return any(w in txt for w in _CONSTR_WORDS)


LC_PREFIXES = ("abandoned", "disused", "ruins")
GONE_PREFIXES = ("was", "demolished", "removed", "razed", "destroyed")
# uses that occupy a whole building / site: "disused:amenity=school" means the school building stands empty
WHOLE_AMENITY = {"school", "kindergarten", "childcare", "hospital", "clinic", "sanatorium", "cinema", "theatre",
                 "community_centre", "library", "prison", "university", "college", "townhall", "social_facility",
                 "nursing_home", "place_of_worship", "monastery", "fire_station", "police", "bus_station",
                 "arts_centre", "public_bath", "courthouse", "events_venue", "dormitory", "conference_centre"}
SITE_MAN_MADE = {"works", "water_tower", "tower", "chimney", "silo", "bunker_silo", "lighthouse", "pumping_station",
                 "wastewater_plant", "water_works", "gasometer", "kiln", "observatory", "mineshaft", "storage_tank"}
SITE_TOURISM = {"hotel", "motel", "hostel", "guest_house", "chalet", "alpine_hut", "camp_site", "museum"}
SITE_LEISURE = {"sports_centre", "stadium", "resort", "ice_rink", "sports_hall", "summer_camp"}
SITE_HISTORIC = {"ruins", "fort", "bunker", "castle", "manor", "monastery", "military", "church"}
FEATURE_KEYS = ("building", "amenity", "shop", "office", "craft", "man_made", "railway", "highway", "barrier", "power",
                "military", "landuse", "leisure", "tourism", "historic", "aeroway", "waterway", "place", "industrial",
                "cuisine", "healthcare", "club", "public_transport", "bridge", "emergency", "vending", "atm")


def _site_feature(base: str, v: str) -> bool:
    """Is this feature a whole building/site (vs. a shop or office inside a house, a fountain, a platform …)?"""
    if base in ("building", "military", "landuse", "industrial"):
        return True
    return v in {"amenity": WHOLE_AMENITY, "man_made": SITE_MAN_MADE, "tourism": SITE_TOURISM,
                 "leisure": SITE_LEISURE, "historic": SITE_HISTORIC,
                 "railway": {"station"}, "aeroway": {"hangar", "terminal"}}.get(base, ())


def _features(tags: dict) -> list:
    out = []
    for k, v in tags.items():
        pre, _, base = k.partition(":")
        key = base if base and pre in LC_PREFIXES + GONE_PREFIXES else k
        if key in FEATURE_KEYS:
            out.append((key, v))
    return out


def site_lifecycle(tags: dict) -> dict:
    """Lifecycle tags that describe a whole building or site. A closed shop/office/cafe inside a working house
    (disused:shop=…), an abandoned fountain/well/platform or an object that no longer exists (was:/demolished:)
    say nothing about an abandoned building and are ignored."""
    feats = _features(tags)
    site_feat = any(_site_feature(b, v) for b, v in feats)
    out = {}
    for k, v in tags.items():
        if v in ("no", "false"):
            continue
        if k in LC_PREFIXES:
            if site_feat or not feats:
                out[k] = v
            continue
        pre, _, base = k.partition(":")
        if pre in LC_PREFIXES and base and _site_feature(base.split(":")[0], v):
            out[k] = v
    return out


def is_lifecycle(tags: dict) -> bool:
    if tags.get("landuse") == "brownfield" and is_construction(tags):
        return False
    if site_lifecycle(tags):
        return True
    if tags.get("building") == "ruins" or tags.get("historic") == "ruins" or tags.get("landuse") == "brownfield":
        return True
    return False


def lifecycle_strength(tags: dict) -> tuple[float, str]:
    """Prior weight (log-odds) and human readable reason from OSM lifecycle tags."""
    best, why = 0.0, ""

    def take(w, t):
        nonlocal best, why
        if w > best:
            best, why = w, t
    site = site_lifecycle(tags)
    for k, v in tags.items():
        kv = f"{k}={v}"
        pre, _, base = k.partition(":")
        if k == "building" and v == "ruins":
            take(3.2, "OSM: building=ruins (руины)")
        elif k == "historic" and v == "ruins":
            take(3.0, "OSM: historic=ruins")
        elif k in site and pre in ("ruins", "abandoned"):
            take(3.0, f"OSM: {kv}" + (" (заброшено)" if pre == "abandoned" else ""))
        elif k in site and pre == "disused":
            take(2.2, f"OSM: {kv} (не используется)")
        elif k == "landuse" and v == "brownfield" and not is_construction(tags):
            take(1.6, "OSM: landuse=brownfield (заброшенная промплощадка)")
        elif pre == "was" and base and "building" in tags and base != "building" and _site_feature(base, v):
            take(0.8, f"OSM: {kv} (здание раньше использовалось иначе)")
        elif k == "building" and v in ("collapsed", "damaged", "abandoned"):
            take(3.0, f"OSM: {kv}")
        elif k == "condition" and v in ("deficient", "poor", "ruins"):
            take(1.5, f"OSM: {kv}")
    return best, why


SETTLEMENT_RADIUS = {
    "city": 3500, "town": 1800, "village": 700, "hamlet": 300, "isolated_dwelling": 90,
    "suburb": 900, "quarter": 500, "neighbourhood": 350, "allotments": 350, "farm": 150, "locality": 0,
}


@dataclass
class OsmData:
    buildings: list = field(default_factory=list)      # dicts: id, geom, tags
    lifecycle: list = field(default_factory=list)      # dicts: id, geom, tags
    military: list = field(default_factory=list)       # military areas/objects
    landuse: dict = field(default_factory=dict)        # class -> list of (geom, tags, id)
    places: list = field(default_factory=list)         # (Point, place, name, radius)
    barriers_line: list = field(default_factory=list)  # (geom, tags, id)
    barriers_node: list = field(default_factory=list)  # (Point, tags, id)
    guard_objs: list = field(default_factory=list)     # (geom, tags, id)
    access_areas: list = field(default_factory=list)   # (geom, tags, id)
    highways: list = field(default_factory=list)       # (LineString, tags, id)
    towers: list = field(default_factory=list)         # man_made objects (geom, tags, id)
    failed: list = field(default_factory=list)


def parse(elements) -> OsmData:
    d = OsmData()
    for el in elements:
        tags = el.get("tags") or {}
        if not tags:
            continue
        oid = f"{el['type']}/{el['id']}"
        g = None

        def geom():
            nonlocal g
            if g is None:
                g = element_geometry(el)
            return g

        if "building" in tags and el["type"] in ("way", "relation"):
            gg = geom()
            if gg is not None and gg.geom_type in ("Polygon", "MultiPolygon"):
                d.buildings.append({"id": oid, "geom": gg, "tags": tags})
            elif gg is not None:
                d.buildings.append({"id": oid, "geom": gg.centroid if gg.geom_type != "Point" else gg, "tags": tags})
        if is_lifecycle(tags) or tags.get("building") in ("collapsed", "damaged", "abandoned"):
            if geom() is not None:
                d.lifecycle.append({"id": oid, "geom": geom(), "tags": tags})
        if ("military" in tags or tags.get("landuse") == "military") and geom() is not None:
            d.military.append({"id": oid, "geom": geom(), "tags": tags})
        lu = tags.get("landuse")
        if lu == "brownfield" and is_construction(tags):
            lu = "construction"   # a redevelopment site, not an abandoned one
        if lu and geom() is not None and geom().geom_type in ("Polygon", "MultiPolygon"):
            d.landuse.setdefault(lu, []).append((geom(), tags, oid))
        extra = None
        if tags.get("leisure") in ("park", "garden", "recreation_ground", "playground", "sports_centre", "stadium"):
            extra = "park"
        elif tags.get("leisure") == "nature_reserve" or tags.get("boundary") == "protected_area":
            extra = "protected"
        elif tags.get("tourism") in ("museum", "attraction", "zoo", "theme_park", "gallery", "camp_site"):
            extra = "museum"
        if extra and geom() is not None and geom().geom_type in ("Polygon", "MultiPolygon"):
            d.landuse.setdefault(extra, []).append((geom(), tags, oid))
        if "place" in tags and geom() is not None:
            p = geom() if geom().geom_type == "Point" else geom().centroid
            pl = tags["place"]
            r = SETTLEMENT_RADIUS.get(pl, 0)
            if r:
                d.places.append((p, pl, tags.get("name", ""), r))
            if geom().geom_type in ("Polygon", "MultiPolygon") and pl in ("city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood"):
                d.landuse.setdefault("place_area", []).append((geom(), tags, oid))
        if "barrier" in tags and geom() is not None:
            if geom().geom_type == "Point":
                d.barriers_node.append((geom(), tags, oid))
            else:
                d.barriers_line.append((geom(), tags, oid))
        if tags.get("building") == "guardhouse" or tags.get("military") == "checkpoint" or tags.get("amenity") == "security":
            if geom() is not None:
                d.guard_objs.append((geom(), tags, oid))
        if tags.get("access") in ("private", "no", "military", "permit") and "highway" not in tags and "barrier" not in tags:
            if geom() is not None and geom().geom_type in ("Polygon", "MultiPolygon"):
                d.access_areas.append((geom(), tags, oid))
        if "highway" in tags and el["type"] == "way" and geom() is not None and geom().geom_type == "LineString":
            d.highways.append((geom(), tags, oid))
        if tags.get("man_made") in ("water_tower", "tower", "chimney", "works", "silo", "bunker_silo"):
            if geom() is not None:
                d.towers.append((geom(), tags, oid))
    return d


def find_dead_ends(highways, classes=("track", "service", "path", "unclassified", "bridleway", "footway")):
    """Endpoints of minor roads that do not connect to any other road."""
    def k(c):
        return (round(c[0], 6), round(c[1], 6))
    degree: dict = {}
    for g, tags, oid in highways:
        cs = list(g.coords)
        for i, c in enumerate(cs):
            kk = k(c)
            degree[kk] = degree.get(kk, 0) + (1 if i in (0, len(cs) - 1) else 2)
    out = []
    for g, tags, oid in highways:
        if tags.get("highway") not in classes:
            continue
        cs = list(g.coords)
        for end in (cs[0], cs[-1]):
            if degree.get(k(end), 0) == 1:
                out.append((Point(end), tags, oid))
    return out


def tags_type(tags: dict, context: dict | None = None) -> str:
    """Object type code for the UI filter."""
    context = context or {}
    b = tags.get("building", "")
    vals = " ".join(f"{k}={v}" for k, v in tags.items())
    if b == "ruins" or tags.get("historic") == "ruins" or "ruins" in tags or any(k.startswith("ruins:") for k in tags):
        return "ruins"
    if "military" in tags or tags.get("landuse") == "military" or "military" in vals or context.get("in_military"):
        return "military"
    if tags.get("landuse") in ("brownfield",) and "building" not in tags:
        return "area"
    farm = ("farm", "farm_auxiliary", "barn", "cowshed", "stable", "greenhouse", "sty", "hangar", "silo")
    if any(f"building={x}" in vals or f":building={x}" in vals for x in farm) or context.get("in_farmyard"):
        return "farm"
    ind = ("industrial", "warehouse", "factory", "manufacture", "works", "storage_tank", "service", "garages",
           "transformer_tower", "hangar", "boathouse")
    if any(f"building={x}" in vals or f":building={x}" in vals for x in ind) or context.get("in_industrial") \
            or tags.get("man_made") in ("works", "chimney", "water_tower", "silo"):
        return "industrial"
    house = ("house", "detached", "residential", "apartments", "cabin", "hut", "bungalow", "semidetached_house",
             "terrace", "dacha", "farmhouse", "static_caravan")
    if any(f"building={x}" in vals or f":building={x}" in vals for x in house) or context.get("in_allotments") \
            or context.get("in_residential"):
        return "house"
    if tags.get("landuse") or (not b and tags):
        return "area"
    return "building"


def bbox_of(g):
    return g.bounds


def meters_to_deg_lat(m):
    return m / 110574.0


def meters_to_deg_lon(m, lat):
    return m / (111320.0 * math.cos(math.radians(lat)))
