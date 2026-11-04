"""Read-side helpers for the UI: candidate lists, details, image crops."""
from __future__ import annotations

import io
import math

from PIL import Image, ImageDraw

from . import db, tiles
from .config import settings
from .geo import google_maps_url, lonlat_to_pixel, osm_url


def label_index():
    rows = db.app_con().execute("SELECT id, lat, lon, label FROM labels").fetchall()
    grid = {}
    for r in rows:
        grid.setdefault((round(r["lat"], 3), round(r["lon"], 3)), []).append(r)
    return grid


def find_label(grid, lat, lon, radius_m=15.0):
    best = None
    for dl in (-0.001, 0, 0.001):
        for dn in (-0.001, 0, 0.001):
            for r in grid.get((round(lat + dl, 3), round(lon + dn, 3)), []):
                d = math.hypot((r["lat"] - lat) * 110574, (r["lon"] - lon) * 111320 * math.cos(math.radians(lat)))
                if d <= radius_m and (best is None or d < best[0]):
                    best = (d, r)
    return best[1] if best else None


def compact_candidates(run_id: int, min_score: float = 0.0):
    keep = max(min_score, settings().get("min_score_keep", 0.03))
    rows = db.app_con().execute(
        "SELECT id, lat, lon, score, guard, kind, title, json_extract(features, '$.confirm_n') AS cn, "
        "json_extract(features, '$.reliable') AS rel, json_extract(features, '$.complex_key') AS ck, "
        "json_extract(features, '$.similar') AS sim "
        "FROM candidates WHERE run_id=? AND (score>=? OR json_extract(features, '$.similar') IS NOT NULL) "
        "ORDER BY score DESC",
        (run_id, keep)).fetchall()
    grid = label_index()
    # objects you marked are always sent, whatever their score
    seen = {r["id"] for r in rows}
    extra = []
    for lb in db.app_con().execute("SELECT lat, lon FROM labels").fetchall():
        d = 0.0003
        for r in db.app_con().execute(
                "SELECT id, lat, lon, score, guard, kind, title, json_extract(features, '$.confirm_n') AS cn, "
                "json_extract(features, '$.reliable') AS rel, json_extract(features, '$.complex_key') AS ck, "
                "json_extract(features, '$.similar') AS sim FROM candidates WHERE run_id=? AND kind!='complex' "
                "AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                (run_id, lb["lat"] - d, lb["lat"] + d, lb["lon"] - 2 * d, lb["lon"] + 2 * d)).fetchall():
            if r["id"] not in seen:
                seen.add(r["id"])
                extra.append(r)
    items = []
    for r in list(rows) + extra:
        lb = find_label(grid, r["lat"], r["lon"]) if grid else None
        items.append([r["id"], round(r["lat"], 6), round(r["lon"], 6), round(r["score"], 4), r["guard"], r["kind"],
                      r["title"] or "", lb["label"] if lb else None, r["cn"] or 0, 1 if r["rel"] else 0,
                      1 if r["ck"] else 0, round(r["sim"], 3) if r["sim"] else 0])
    return {"run_id": run_id, "items": items}


def complexes_geojson(run_id: int):
    rows = db.app_con().execute(
        "SELECT id, score, guard, footprint, json_extract(features, '$.reliable') AS rel FROM candidates "
        "WHERE run_id=? AND kind='complex'", (run_id,)).fetchall()
    return [{"id": r["id"], "score": r["score"], "guard": r["guard"], "reliable": 1 if r["rel"] else 0,
             "geometry": db.loads(r["footprint"])} for r in rows if r["footprint"]]


def candidate_detail(cid: int):
    r = db.app_con().execute("SELECT * FROM candidates WHERE id=?", (cid,)).fetchone()
    if r is None:
        return None
    f = db.loads(r["features"], {})
    lb = find_label(label_index(), r["lat"], r["lon"])
    srcs = db.loads(r["sources"], [])
    if f.get("pA") is not None or f.get("tree_ring") is not None:
        srcs = srcs + ["снимок z%d" % settings()["scan_zoom"]]
    if f.get("zs_abandoned") is not None:
        srcs = srcs + ["снимок z%d (SigLIP)" % settings()["crop_zoom"]]
    if f.get("wb_dates"):
        srcs = srcs + ["сравнение по годам: " + ", ".join(d["date"] for d in f["wb_dates"])]
    if f.get("annexes") or f.get("satellites"):
        srcs = srcs + [f"объединено в одну метку: {f.get('annexes', 0)} мелких построек рядом, "
                       f"{f.get('satellites', 0)} точек (тупики/прогалины/неподтверждённые контуры)"]
    if isinstance(f.get("vlm"), dict):
        srcs = srcs + ["VLM " + str(f["vlm"].get("model", ""))]
    return {
        "id": r["id"], "run_id": r["run_id"], "lat": r["lat"], "lon": r["lon"], "kind": r["kind"],
        "title": r["title"], "score": r["score"], "reasons": db.loads(r["reasons"], []),
        "guard": r["guard"], "guard_reasons": db.loads(r["guard_reasons"], []),
        "sources": srcs, "tags": db.loads(r["tags"], {}), "stage": r["stage"],
        "area_m2": f.get("area_m2"), "imagery_date": f.get("imagery_date"),
        "wayback": f.get("wb_dates") or [],
        "confirm": f.get("confirm") or [], "contra": f.get("contra") or [], "confirm_n": f.get("confirm_n") or 0,
        "label": lb["label"] if lb else None,
        "google_maps": google_maps_url(r["lat"], r["lon"]), "osm_url": osm_url(r["lat"], r["lon"]),
        "features": {k: v for k, v in f.items() if not isinstance(v, (dict, list)) or k in ("gates", "landuse")},
        "reliable": bool(f.get("reliable")), "members": _members(r["run_id"], f.get("members") or []),
        "similar": f.get("similar"), "pU": f.get("pU"),
        "footprint": db.loads(r["footprint"]),
    }


def candidate_image(cid: int, src: str = "current", zoom: int | None = None, size: int = 320):
    r = db.app_con().execute("SELECT lat, lon, footprint FROM candidates WHERE id=?", (cid,)).fetchone()
    if r is None:
        return None
    size = int(max(96, min(size, 1024)))
    z = zoom or settings()["crop_zoom"]
    provider = settings()["imagery_provider"] if src == "current" else src
    if provider.startswith("wayback:"):
        z = zoom or settings()["scan_zoom"] + 1
    fp0 = db.loads(r["footprint"])
    if fp0 and not zoom:
        from shapely.geometry import shape as _shape
        from .geo import meters_per_pixel
        b = _shape(fp0).bounds
        ext = max((b[2] - b[0]) * 111320 * 0.49, (b[3] - b[1]) * 110574)  # metres (~60°N)
        while z > 14 and ext / meters_per_pixel(r["lat"], z) > 300:
            z -= 1
    # crop footprint: ~110 m at z18, keep requested output size
    native = 384 if z >= 18 else 320
    img, valid = tiles.crop_lonlat(provider, z, r["lon"], r["lat"], native)
    if valid < 0.2 and z > 16:
        z -= 1
        img, valid = tiles.crop_lonlat(provider, z, r["lon"], r["lat"], native // 2 * 2)
    im = Image.fromarray(img)
    fp = db.loads(r["footprint"])
    cx, cy = lonlat_to_pixel(r["lon"], r["lat"], z)
    d = ImageDraw.Draw(im)
    if fp:
        polys = fp["coordinates"] if fp["type"] == "Polygon" else [p for mp in fp["coordinates"] for p in [mp[0]]]
        rings = [polys[0]] if fp["type"] == "Polygon" else polys
        for ring in rings:
            pts = []
            for lon, lat in ring:
                px, py = lonlat_to_pixel(lon, lat, z)
                pts.append((px - cx + native / 2, py - cy + native / 2))
            if len(pts) > 2:
                d.line(pts + [pts[0]], fill=(0, 220, 255), width=2)
    else:
        m = native / 2
        d.ellipse((m - 9, m - 9, m + 9, m + 9), outline=(0, 220, 255), width=2)
    if im.size[0] != size:
        im = im.resize((size, size), Image.LANCZOS)
    b = io.BytesIO()
    im.save(b, format="JPEG", quality=88)
    return b.getvalue()


def _members(run_id, idxs):
    if not idxs:
        return []
    from .pipeline import ID_STRIDE
    ids = [run_id * ID_STRIDE + int(i) for i in idxs]
    q = ",".join("?" * len(ids))
    rows = db.app_con().execute(f"SELECT id, score, guard, kind, title, json_extract(features, '$.reliable') AS rel "
                                f"FROM candidates WHERE id IN ({q}) ORDER BY score DESC", ids).fetchall()
    return [{"id": r["id"], "score": r["score"], "guard": r["guard"], "kind": r["kind"], "title": r["title"],
             "reliable": bool(r["rel"])} for r in rows]
