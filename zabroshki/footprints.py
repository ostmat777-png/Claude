"""Microsoft Global ML Building Footprints (ODbL) for the search area."""
from __future__ import annotations

import csv
import gzip
import io
import json
import logging

from shapely.geometry import shape

from . import db, net
from .config import DATA_DIR
from .geo import lonlat_to_tile, quadkey

log = logging.getLogger(__name__)
LINKS_URL = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"


def _links() -> list[dict]:
    raw = db.http_cache_get("ms_links", 30 * 86400)
    if raw is None:
        raw = net.get(LINKS_URL, timeout=120).content
        db.http_cache_put("ms_links", raw)
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))


def quadkeys_for_bbox(w, s, e, n, z=9) -> set[str]:
    x0, y0 = lonlat_to_tile(w, n, z)
    x1, y1 = lonlat_to_tile(e, s, z)
    return {quadkey(x, y, z) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)}


def load(poly, job=None) -> list:
    """List of shapely Polygons (lon/lat) intersecting the polygon's bbox (+margin)."""
    w, s, e, n = poly.bounds
    m = 0.003
    w, s, e, n = w - 2 * m, s - m, e + 2 * m, n + m
    qks = quadkeys_for_bbox(w, s, e, n)
    try:
        rows = [r for r in _links() if r["QuadKey"] in qks]
    except Exception as ex:
        log.warning("MS footprints index unavailable: %s", ex)
        if job:
            job.info(f"Контуры Microsoft недоступны: {ex}")
        return []
    out = []
    folder = DATA_DIR / "footprints"
    folder.mkdir(parents=True, exist_ok=True)
    for i, r in enumerate(rows):
        if job:
            job.checkpoint()
            job.progress(i, len(rows), f"Контуры Microsoft: {r['Location']} {r['QuadKey']}")
        f = folder / f"{r['Location']}_{r['QuadKey']}.geojsonl.gz"
        if not f.exists():
            try:
                data = net.get(r["Url"], timeout=300).content
                f.write_bytes(data)
            except Exception as ex:
                log.warning("footprints download failed %s: %s", r["Url"], ex)
                continue
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            for line in fh:
                try:
                    c = line.find("[[[")
                    if c > 0:  # quick bbox check on the first vertex
                        j = line.index("]", c)
                        lon, lat = map(float, line[c + 3:j].split(","))
                        if not (w <= lon <= e and s <= lat <= n):
                            continue
                    g = shape(json.loads(line)["geometry"])
                    if g.is_valid and not g.is_empty:
                        out.append(g)
                except Exception:
                    continue
    if job:
        job.progress(len(rows), len(rows))
    return out
