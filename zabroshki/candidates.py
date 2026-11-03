"""Candidate assembly from all sources, duplicate merging and OSM context features."""
from __future__ import annotations

import logging
import math

import numpy as np
from shapely import STRtree
from shapely.geometry import Point, Polygon
from shapely.prepared import prep

from . import osm
from .geo import LocalProj

log = logging.getLogger(__name__)

FENCE_TYPES = {"fence", "wall", "city_wall", "retaining_wall", "guard_rail", "hedge", "jersey_barrier",
               "chain", "barbed_wire", "concrete_fence"}
STRONG_FENCES = {"fence", "wall", "city_wall", "barbed_wire", "concrete_fence"}
GATE_TYPES = {"gate", "lift_gate", "swing_gate", "sliding_gate", "border_control", "toll_booth",
              "turnstile", "full-height_turnstile", "bump_gate", "hampshire_gate", "entrance", "kissing_gate"}
STRONG_GATES = {"lift_gate", "border_control", "full-height_turnstile", "toll_booth"}
MAJOR_ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
               "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "living_street"}
MINOR_ROADS = {"track", "path", "footway", "bridleway", "cycleway", "service"}


def new_candidate(key, lat, lon, kind, title="", footprint=None, sources=(), tags=None):
    return {"key": key, "lat": lat, "lon": lon, "kind": kind, "title": title,
            "footprint": footprint, "sources": set(sources), "tags": dict(tags or {}), "osm_ids": [],
            "f": {}, "score": 0.0, "reasons": [], "guard": "yellow", "guard_reasons": [], "stage": 1}


class Context:
    """Spatial indexes of OSM context in a local metric projection."""

    def __init__(self, d: osm.OsmData, lp: LocalProj, footprints_ll=()):
        self.lp = lp
        m = lp.geom_to_m

        def tree(items, geom_of=lambda x: x[0]):
            geoms = [m(geom_of(it)) for it in items]
            return (STRtree(geoms) if geoms else None), geoms, items

        self.landuse = {}
        for cls, items in d.landuse.items():
            self.landuse[cls] = tree(items)
        self.places = [(m(p), pl, name, r) for p, pl, name, r in d.places]
        self.barrier_lines = tree([b for b in d.barriers_line if b[1].get("barrier") in FENCE_TYPES])
        self.barrier_nodes = tree([b for b in d.barriers_node if b[1].get("barrier") in GATE_TYPES])
        self.gate_lines = tree([b for b in d.barriers_line if b[1].get("barrier") in GATE_TYPES])
        self.guard = tree(d.guard_objs)
        self.access = tree(d.access_areas)
        self.military = tree(d.military, geom_of=lambda x: x["geom"])
        self.highways = tree(d.highways)
        self.buildings = tree(d.buildings, geom_of=lambda x: x["geom"])
        self.footprints_m = [m(g) for g in footprints_ll]
        self.fp_tree = STRtree(self.footprints_m) if self.footprints_m else None
        dead = osm.find_dead_ends(d.highways)
        self.dead_ends = tree(dead)
        self.dead_end_items = dead

    # ------------------------------------------------------------ helpers
    @staticmethod
    def _containing(t, pt):
        tr, geoms, items = t
        if tr is None:
            return []
        idx = tr.query(pt, predicate="intersects")
        return [items[i] for i in idx]

    @staticmethod
    def _within(t, g, dist):
        tr, geoms, items = t
        if tr is None:
            return []
        idx = tr.query(g, predicate="dwithin", distance=dist)
        return [(items[i], geoms[i].distance(g)) for i in idx]

    def landuse_at(self, pt) -> dict:
        out = {}
        for cls, t in self.landuse.items():
            hits = self._containing(t, pt)
            if hits:
                out[cls] = hits[0][1]
        return out

    def settlement(self, pt):
        best = None
        for p, pl, name, r in self.places:
            dd = p.distance(pt)
            if dd <= r and (best is None or dd / r < best[0]):
                best = (dd / r, pl, name)
        return best

    def features(self, pt, fp=None, own_tags=None) -> dict:
        """OSM context features for a point/footprint in metric coordinates."""
        g = fp if fp is not None else pt
        f = {}
        lu = self.landuse_at(pt)
        f["landuse"] = sorted(lu)
        for cls in ("residential", "allotments", "industrial", "commercial", "retail", "farmyard", "garages",
                    "military", "brownfield", "quarry", "construction", "railway", "cemetery", "landfill",
                    "place_area"):
            f["in_" + cls] = cls in lu
        f["industrial_disused"] = bool(lu.get("industrial") and osm.is_lifecycle(lu["industrial"]))
        st = self.settlement(pt)
        f["near_place"] = st[1] if st else None
        f["near_place_name"] = st[2] if st else None
        f["in_settlement"] = bool(f["in_residential"] or f["in_place_area"] or
                                  (st and st[1] in ("city", "town", "village", "suburb", "quarter", "neighbourhood")))
        f["in_dacha"] = bool(f["in_allotments"] or (st and st[1] == "allotments"))
        f["outside_settlement"] = not (f["in_settlement"] or f["in_dacha"] or f["in_industrial"]
                                       or f["in_commercial"] or f["in_retail"] or f["in_garages"])
        # military
        mil = self._containing(self.military, pt) if self.military[0] is not None else []
        mil_near = self._within(self.military, g, 30)
        mil_items = [x for x in mil] + [x for x, _ in mil_near]
        f["in_military"] = bool(mil_items) or f["in_military"]
        f["military_disused"] = any(osm.is_lifecycle(x["tags"]) for x in mil_items)
        f["military_tags"] = sorted({f"military={x['tags'].get('military')}" for x in mil_items if x["tags"].get("military")})[:4]
        # barriers
        fences = self._within(self.barrier_lines, g, 35)
        f["fence_near"] = len(fences)
        f["fence_strong"] = any(x[1].get("barrier") in STRONG_FENCES for x, _ in fences)
        enclosed = False
        for x, _ in fences:
            geom = self.lp.geom_to_m(x[0])
            cs = list(geom.coords) if geom.geom_type == "LineString" else []
            if len(cs) >= 4 and cs[0] == cs[-1]:
                try:
                    if Polygon(cs).buffer(0).contains(pt):
                        enclosed = True
                        break
                except Exception:
                    pass
        # area polygons with barrier tag (fenced areas)
        f["enclosed_by_fence"] = enclosed
        gates = self._within(self.barrier_nodes, g, 150) + self._within(self.gate_lines, g, 150)
        f["gates"] = sorted({x[1].get("barrier") for x, _ in gates})
        f["gate_dist"] = min([d for _, d in gates], default=None)
        f["strong_gate"] = any(x[1].get("barrier") in STRONG_GATES for x, _ in gates)
        guards = self._within(self.guard, g, 200)
        f["guardhouse"] = len(guards) > 0
        f["guardhouse_dist"] = min([d for _, d in guards], default=None)
        # access
        acc = own_tags.get("access") if own_tags else None
        acc_areas = self._containing(self.access, pt) if self.access[0] is not None else []
        f["access"] = acc or (acc_areas[0][1].get("access") if acc_areas else None)
        # roads
        roads = self._within(self.highways, g, 400)
        if roads:
            near = sorted(roads, key=lambda r: r[1])
            f["road_dist"] = round(near[0][1], 1)
            f["road_class"] = near[0][0][1].get("highway")
            f["road_access"] = near[0][0][1].get("access")
            majors = [d for (it, d) in roads if it[1].get("highway") in MAJOR_ROADS]
            f["major_road_dist"] = round(min(majors), 1) if majors else 999.0
            f["only_minor_roads_100m"] = all(it[1].get("highway") in MINOR_ROADS for it, d in roads if d <= 100) \
                and any(d <= 100 for _, d in roads)
            f["road_abandoned"] = any(osm.is_lifecycle(it[1]) or it[1].get("highway") == "abandoned"
                                      for it, d in roads if d <= 60)
        else:
            f["road_dist"], f["road_class"], f["major_road_dist"] = 999.0, None, 999.0
            f["only_minor_roads_100m"] = False
            f["road_abandoned"] = False
        de = self._within(self.dead_ends, g, 70)
        f["dead_end_near"] = len(de) > 0
        # neighbours (active use around)
        nb = self._within(self.buildings, pt, 80)
        f["osm_buildings_80m"] = len(nb)
        f["active_neighbours"] = sum(1 for it, d in nb if any(k in it["tags"] for k in ("shop", "amenity", "office", "craft"))
                                     and not osm.is_lifecycle(it["tags"]))
        if self.fp_tree is not None:
            f["footprints_100m"] = int(len(self.fp_tree.query(pt, predicate="dwithin", distance=100)))
        else:
            f["footprints_100m"] = 0
        return f


def _type_context(f):
    return {"in_military": f.get("in_military"), "in_farmyard": f.get("in_farmyard"),
            "in_industrial": f.get("in_industrial"), "in_allotments": f.get("in_dacha"),
            "in_residential": f.get("in_settlement")}


def assemble(d: osm.OsmData, footprints_ll, lp: LocalProj, area_poly_ll, job=None):
    """Build candidate list (dicts) from OSM + MS footprints. Imagery detections are added later."""
    area_prep = prep(area_poly_ll.buffer(0.0003))
    ctx = Context(d, lp, footprints_ll)
    cands = {}

    # --- OSM buildings
    bld_by_id = {}
    for b in d.buildings:
        g = b["geom"]
        c = g.representative_point() if g.geom_type != "Point" else g
        if not area_prep.contains(c):
            continue
        cand = new_candidate("osm:" + b["id"], c.y, c.x, "building", _title(b["tags"]),
                             g if g.geom_type in ("Polygon", "MultiPolygon") else None, ["OSM"], b["tags"])
        cand["osm_ids"].append(b["id"])
        cands[cand["key"]] = cand
        bld_by_id[b["id"]] = cand
    # --- OSM lifecycle objects (may be nodes inside buildings, areas, etc.)
    bld_polys_m = []
    bld_keys = []
    for k, c in cands.items():
        if c["footprint"] is not None:
            bld_polys_m.append(lp.geom_to_m(c["footprint"]))
            bld_keys.append(k)
    bld_tree = STRtree(bld_polys_m) if bld_polys_m else None
    for obj in d.lifecycle + [m for m in d.military if m not in d.lifecycle]:
        oid = obj["id"]
        if oid in bld_by_id:
            continue  # already a building candidate (its tags carry the lifecycle info)
        g = obj["geom"]
        c = g.representative_point() if g.geom_type not in ("Point",) else g
        if not area_prep.contains(c):
            continue
        cm = lp.geom_to_m(c)
        merged = False
        if bld_tree is not None:
            if g.geom_type == "Point":
                hits = bld_tree.query(cm, predicate="dwithin", distance=20)
                for i in hits:
                    tgt = cands[bld_keys[i]]
                    for kk, vv in obj["tags"].items():
                        tgt["tags"].setdefault(kk, vv)
                    tgt["osm_ids"].append(oid)
                    merged = True
                    break
            else:
                gm = lp.geom_to_m(g)
                if gm.area > 0:
                    inside = bld_tree.query(gm, predicate="intersects")
                    for i in inside:
                        tgt = cands[bld_keys[i]]
                        tgt.setdefault("parent_tags", {}).update({kk: vv for kk, vv in obj["tags"].items()
                                                                  if kk not in ("name",)})
                        tgt["parent_lifecycle"] = max(tgt.get("parent_lifecycle", 0.0),
                                                      osm.lifecycle_strength(obj["tags"])[0])
                    if len(inside) > 0 and gm.area > 3000:
                        merged = True  # big area: its buildings represent it
        if merged:
            continue
        kind = osm.tags_type(obj["tags"])
        fp = g if g.geom_type in ("Polygon", "MultiPolygon") else None
        cand = new_candidate("osm:" + oid, c.y, c.x, kind, _title(obj["tags"]), fp, ["OSM"], obj["tags"])
        cand["osm_ids"].append(oid)
        cands[cand["key"]] = cand

    # --- MS footprints not present in OSM
    n_ms = 0
    for i, g in enumerate(footprints_ll):
        c = g.representative_point()
        if not area_prep.contains(c):
            continue
        gm = lp.geom_to_m(g)
        if bld_tree is not None:
            hits = bld_tree.query(gm, predicate="intersects")
            matched = False
            for h in hits:
                inter = bld_polys_m[h].intersection(gm).area
                if inter > 0.25 * min(gm.area, bld_polys_m[h].area):
                    matched = True
                    cands[bld_keys[h]]["sources"].add("MS Footprints")
                    break
            if matched:
                continue
        cand = new_candidate(f"ms:{c.y:.6f},{c.x:.6f}", c.y, c.x, "unmapped", "нет в OSM (контур Microsoft)", g,
                             ["MS Footprints"])
        cands[cand["key"]] = cand
        n_ms += 1

    # --- dead ends of minor roads outside settlements
    for pt, tags, oid in ctx.dead_end_items:
        if not area_prep.contains(pt):
            continue
        cand = new_candidate(f"dead:{pt.y:.6f},{pt.x:.6f}", pt.y, pt.x, "deadend",
                             f"конец highway={tags.get('highway')}", None, ["OSM (тупик)"], {})
        cand["osm_ids"].append(oid)
        cand["road_tags"] = tags
        cands[cand["key"]] = cand

    out = list(cands.values())
    if job:
        job.info(f"Кандидаты: OSM-построек {len(bld_by_id)}, OSM lifecycle/военных {len(d.lifecycle) + len(d.military)}, "
                 f"MS-контуров без OSM {n_ms}, тупиков {len(ctx.dead_end_items)}")
    return out, ctx


def neutralize_missing(f: dict, failed) -> None:
    """If parts of OSM could not be downloaded, do not pretend we know the context."""
    failed = set(failed or [])
    if "all" in failed or "context" in failed:
        for k in ("outside_settlement", "in_settlement", "in_dacha", "in_military", "in_industrial"):
            f[k] = False
        f["osm_context_missing"] = True
    if "all" in failed or "highways" in failed:
        f["road_dist"] = None
        f["only_minor_roads_100m"] = False
        f["dead_end_near"] = False
        f["osm_roads_missing"] = True


def compute_context(cands, ctx: Context, job=None, failed=None):
    lp = ctx.lp
    drop = []
    for i, c in enumerate(cands):
        if job and i % 500 == 0:
            job.checkpoint()
            job.progress(i, len(cands), "Контекст OSM")
        pt = Point(*lp.fwd(c["lon"], c["lat"]))
        fp = lp.geom_to_m(c["footprint"]) if c.get("footprint") is not None else None
        f = ctx.features(pt, fp, c["tags"])
        if fp is not None:
            f["area_m2"] = round(fp.area, 1)
        if failed:
            neutralize_missing(f, failed)
        c["f"].update(f)
        if c["kind"] in ("building", "unmapped"):
            if c["tags"]:
                kind = osm.tags_type(c["tags"], _type_context(f))
            elif f["in_military"]:
                kind = "military"
            elif f["in_farmyard"]:
                kind = "farm"
            elif f["in_industrial"] or f["in_garages"]:
                kind = "industrial"
            elif f["in_settlement"] or f["in_dacha"]:
                kind = "house"
            else:
                kind = "unmapped"
            c["kind"] = kind
        if c["kind"] == "deadend":
            # dead ends only matter outside settlements
            if f["in_settlement"] or f["in_dacha"] or f["in_industrial"]:
                drop.append(i)
    if drop:
        ds = set(drop)
        cands[:] = [c for j, c in enumerate(cands) if j not in ds]
    if job:
        job.progress(len(cands), len(cands))


def merge_duplicates(cands, lp: LocalProj, radius=18.0):
    """Union candidates from *different* sources that are closer than radius (dead ends: 60 m into buildings)."""
    if not cands:
        return cands
    xy = np.array([lp.fwd(c["lon"], c["lat"]) for c in cands])
    cell = 60.0
    grid: dict = {}
    for i, (x, y) in enumerate(xy):
        grid.setdefault((int(x // cell), int(y // cell)), []).append(i)
    parent = list(range(len(cands)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def src_family(c):
        k = c["key"].split(":")[0]
        return k

    point_like = {"dead": 60.0, "clear": 35.0}
    for i, (x, y) in enumerate(xy):
        ci = cands[i]
        fi = src_family(ci)
        if fi in point_like:
            continue
        gx, gy = int(x // cell), int(y // cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((gx + dx, gy + dy), ()):
                    if j <= i:
                        continue
                    cj = cands[j]
                    fj = src_family(cj)
                    if fj in point_like or fi == fj:
                        continue
                    dist = math.hypot(xy[j][0] - x, xy[j][1] - y)
                    if {fi, fj} <= {"osm", "ms"}:
                        # two footprints: same object only if they overlap (or nearly coincide)
                        gi, gj = ci.get("footprint"), cj.get("footprint")
                        if gi is not None and gj is not None:
                            try:
                                if not gi.intersects(gj) and dist > 6:
                                    continue
                            except Exception:
                                if dist > 6:
                                    continue
                        elif dist > radius:
                            continue
                    elif "img" in (fi, fj):
                        other = cj if fi == "img" else ci
                        pt = cands[i if fi == "img" else j]
                        g = other.get("footprint")
                        inside = g is not None and dist < 40 and g.buffer(0.00008).contains(Point(pt["lon"], pt["lat"]))
                        if dist > 15 and not inside:
                            continue
                    elif dist > radius:
                        continue
                    parent[find(j)] = find(i)
    # dead ends / clearings: attach to the single nearest object (no chaining through them)
    for i, (x, y) in enumerate(xy):
        fi = src_family(cands[i])
        if fi not in point_like:
            continue
        best, bd = None, point_like[fi]
        gx, gy = int(x // cell), int(y // cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((gx + dx, gy + dy), ()):
                    if src_family(cands[j]) in point_like:
                        continue
                    dist = math.hypot(xy[j][0] - x, xy[j][1] - y)
                    if dist <= bd:
                        best, bd = j, dist
        if best is not None:
            parent[find(i)] = find(best)
    groups: dict = {}
    for i in range(len(cands)):
        groups.setdefault(find(i), []).append(i)
    out = []
    rank = {"osm": 0, "ms": 1, "img": 2, "clear": 3, "dead": 4}
    for idx in groups.values():
        if len(idx) == 1:
            out.append(cands[idx[0]])
            continue
        idx.sort(key=lambda k: rank.get(src_family(cands[k]), 9))
        main = cands[idx[0]]
        for k in idx[1:]:
            o = cands[k]
            main["sources"] |= o["sources"]
            main["osm_ids"] += o["osm_ids"]
            for kk, vv in o["tags"].items():
                main["tags"].setdefault(kk, vv)
            fam = src_family(o)
            if fam == "dead":
                main["f"]["dead_end_near"] = True
            if fam == "clear":
                main["f"]["on_clearing"] = True
                for kk in ("clearing_area_m2", "forest_ring"):
                    if kk in o["f"]:
                        main["f"][kk] = o["f"][kk]
            if fam == "img":
                main["f"]["image_detected"] = True
            if main.get("footprint") is None and o.get("footprint") is not None:
                main["footprint"] = o["footprint"]
        out.append(main)
    return out


def _title(tags: dict) -> str:
    name = tags.get("name") or tags.get("old_name") or tags.get("was:name") or ""
    parts = []
    if name:
        parts.append(name)
    for k in ("building", "abandoned:building", "disused:building", "ruins:building", "historic", "military",
              "landuse", "man_made", "amenity", "abandoned:amenity", "disused:amenity"):
        if k in tags and tags[k] not in ("yes",):
            parts.append(f"{k}={tags[k]}")
            break
    if not parts and tags.get("building"):
        parts.append("building=" + tags["building"])
    return ", ".join(parts)[:80]


def _is_satellite(c) -> bool:
    """Weak, footprint-less or unconfirmed candidates that usually describe a part of a nearby object."""
    f = c["f"]
    if c["kind"] in ("deadend", "clearing"):
        return True
    if c.get("footprint") is None:
        return True
    ms_only = "OSM" not in c["sources"] and "MS Footprints" in c["sources"]
    if ms_only and ((f.get("bprob") or 0) < 0.3 or (f.get("area_m2") or 99) < 15):
        return True
    return False


def absorb_satellites(cands, lp: LocalProj, radius=25.0):
    """One object = one marker: merge satellites into the best nearby real building within `radius` m."""
    import math as _m
    mains = [c for c in cands if not _is_satellite(c)]
    if not mains:
        return cands
    cell = radius
    grid: dict = {}
    for c in mains:
        x, y = lp.fwd(c["lon"], c["lat"])
        grid.setdefault((int(x // cell), int(y // cell)), []).append((x, y, c))
    out = []
    absorbed = 0
    for c in cands:
        if not _is_satellite(c):
            out.append(c)
            continue
        x, y = lp.fwd(c["lon"], c["lat"])
        r = 60.0 if c["kind"] == "deadend" else radius
        best, bd = None, r
        gx, gy = int(x // cell), int(y // cell)
        rng = 3 if r > cell else 1
        for dx in range(-rng, rng + 1):
            for dy in range(-rng, rng + 1):
                for (x2, y2, m) in grid.get((gx + dx, gy + dy), ()):
                    d = _m.hypot(x2 - x, y2 - y)
                    if m.get("footprint") is not None:
                        try:
                            from shapely.geometry import Point as _P
                            d = min(d, lp.geom_to_m(m["footprint"]).distance(_P(x, y)))
                        except Exception:
                            pass
                    if d <= bd:
                        best, bd = m, d
        if best is None:
            out.append(c)
            continue
        absorbed += 1
        best["sources"] |= set(c["sources"])
        bf = best["f"]
        bf["satellites"] = bf.get("satellites", 0) + 1
        if c["kind"] == "deadend":
            bf["dead_end_near"] = True
        if c["kind"] == "clearing" or c["f"].get("on_clearing"):
            bf["on_clearing"] = True
        for kk, vv in c["tags"].items():
            best["tags"].setdefault(kk, vv)
    cands[:] = out
    absorbed += absorb_annexes(cands, lp)
    return absorbed


def absorb_annexes(cands, lp: LocalProj, radius=40.0, small_m2=120.0):
    """Small buildings (sheds, annexes) next to a clearly bigger building of a similar or higher score are
    shown as parts of one complex. Must run after scoring (uses c['score']); tags are NOT copied."""
    import math as _m
    if not cands or "score" not in cands[0]:
        return 0
    big = [c for c in cands if c.get("footprint") is not None and (c["f"].get("area_m2") or 0) >= small_m2]
    cell = radius + 60
    grid: dict = {}
    for c in big:
        x, y = lp.fwd(c["lon"], c["lat"])
        grid.setdefault((int(x // cell), int(y // cell)), []).append((x, y, c))
    out, n = [], 0
    for c in cands:
        a = c["f"].get("area_m2") or 0
        if c.get("footprint") is None or a >= small_m2 or a == 0:
            out.append(c)
            continue
        x, y = lp.fwd(c["lon"], c["lat"])
        gx, gy = int(x // cell), int(y // cell)
        best, bd = None, radius
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for (x2, y2, m) in grid.get((gx + dx, gy + dy), ()):
                    if (m["f"].get("area_m2") or 0) < 2 * a or m.get("score", 0) < c.get("score", 0) - 0.1:
                        continue
                    d = _m.hypot(x2 - x, y2 - y)
                    if d > radius + 60:
                        continue
                    try:  # distance to the big building's outline, not to its centre
                        d = lp.geom_to_m(m["footprint"]).distance(lp.geom_to_m(c["footprint"]))
                    except Exception:
                        pass
                    if d <= bd:
                        best, bd = m, d
        if best is None:
            out.append(c)
            continue
        n += 1
        best["f"]["annexes"] = best["f"].get("annexes", 0) + 1
        best["sources"] |= set(c["sources"])
    cands[:] = out
    return n
