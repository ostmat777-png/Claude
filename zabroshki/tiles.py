"""Tile providers, disk cache (SQLite), mosaics and crops."""
from __future__ import annotations

import io
import logging
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from PIL import Image

from . import db, net
from .config import settings
from .geo import TILE, lonlat_to_pixel

log = logging.getLogger(__name__)

BUILTIN_PROVIDERS = {
    "esri": {
        "name": "Esri World Imagery (спутник)",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "max_zoom": 19, "kind": "sat",
        "attribution": "Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community",
    },
    "osm": {
        "name": "OpenStreetMap (схема)",
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "max_zoom": 19, "kind": "map",
        "attribution": "© OpenStreetMap contributors",
    },
    "esri_topo": {
        "name": "Esri Topo (схема)",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
        "max_zoom": 19, "kind": "map",
        "attribution": "© Esri",
    },
    "esri_labels": {
        "name": "Подписи",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        "max_zoom": 19, "kind": "overlay",
        "attribution": "© Esri",
    },
}

WAYBACK_TILE_URL = ("https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/"
                    "default028mm/MapServer/tile/{release}/{z}/{y}/{x}")


def providers() -> dict:
    p = dict(BUILTIN_PROVIDERS)
    p.update(settings().get("custom_providers") or {})
    return p


def provider_url(provider: str, z: int, x: int, y: int) -> str:
    if provider.startswith("wayback:"):
        rel = provider.split(":", 1)[1]
        return WAYBACK_TILE_URL.format(release=rel, z=z, x=x, y=y)
    p = providers()[provider]
    return p["url"].format(z=z, x=x, y=y, s="a")


def is_placeholder(data: bytes) -> bool:
    """Esri returns a grey 'Map data not yet available' tile where there is no imagery."""
    if data is None or len(data) > 6000:
        return False
    try:
        im = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return True
    a = np.asarray(im, dtype=np.int16)
    med = np.median(a.reshape(-1, 3), axis=0)
    if abs(med[0] - med[1]) > 4 or abs(med[1] - med[2]) > 4:
        return False
    close = (np.abs(a - med).max(axis=2) <= 4).mean()
    return close > 0.85


def fetch_tile(provider: str, z: int, x: int, y: int, interactive=False) -> tuple[int, bytes | None]:
    """Returns (status, bytes). Cached forever in cache.sqlite."""
    row = db.tile_get(provider, z, x, y)
    if row is not None:
        return row[0], row[1]
    url = provider_url(provider, z, x, y)
    try:
        quick = provider.startswith("wayback:")  # history is optional: do not wait long for it
        r = net.get(url, interactive=interactive, ok_statuses=(200, 404), timeout=15 if quick else 30,
                    retries=1 if quick else 4, allow_redirects=True)
    except net.HttpError as e:
        log.warning("tile failed %s: %s", url, e)
        return 0, None  # do not cache transient errors
    if r.status_code == 404 or not r.content:
        db.tile_put(provider, z, x, y, 404, None)
        return 404, None
    data = r.content
    status = 200
    if providers().get(provider, {}).get("kind", "sat") == "sat" or provider.startswith("wayback:"):
        if is_placeholder(data):
            status = 204
    db.tile_put(provider, z, x, y, status, data)
    return status, data


def prefetch(provider: str, z: int, xys, progress=None, checkpoint=None, threads=None) -> dict:
    """Download all missing tiles (polite, parallel). Returns {(x,y): status}."""
    xys = list(xys)
    have = db.tiles_cached(provider, z, xys)
    todo = [xy for xy in xys if xy not in have]
    done = len(xys) - len(todo)
    if progress:
        progress(done, len(xys))
    result = {}
    threads = threads or settings()["download_threads"]
    if not todo:
        return result
    with ThreadPoolExecutor(max_workers=threads) as ex:
        it = iter(todo)
        futs = {}
        for _ in range(threads * 2):
            xy = next(it, None)
            if xy is None:
                break
            futs[ex.submit(fetch_tile, provider, z, xy[0], xy[1])] = xy
        while futs:
            for f in as_completed(list(futs)):
                xy = futs.pop(f)
                try:
                    result[xy] = f.result()[0]
                except Exception as e:  # pragma: no cover
                    log.warning("prefetch error %s", e)
                done += 1
                if progress and done % 10 == 0:
                    progress(done, len(xys))
                if checkpoint:
                    checkpoint()
                nxt = next(it, None)
                if nxt is not None:
                    futs[ex.submit(fetch_tile, provider, z, nxt[0], nxt[1])] = nxt
                break
    if progress:
        progress(len(xys), len(xys))
    return result


# ---------------------------------------------------------------- decoding
class _LRU:
    def __init__(self, n=2048):
        self.n = n
        self.d: OrderedDict = OrderedDict()
        self.lock = threading.Lock()

    def get(self, k):
        with self.lock:
            v = self.d.get(k)
            if v is not None:
                self.d.move_to_end(k)
            return v

    def put(self, k, v):
        with self.lock:
            self.d[k] = v
            self.d.move_to_end(k)
            while len(self.d) > self.n:
                self.d.popitem(last=False)


_decoded = _LRU(3000)


def tile_array(provider: str, z: int, x: int, y: int, fetch=True) -> np.ndarray | None:
    """Decoded RGB uint8 array (256,256,3) or None if not available."""
    key = (provider, z, x, y)
    a = _decoded.get(key)
    if a is not None:
        return a if a.size else None
    if fetch:
        status, data = fetch_tile(provider, z, x, y)
    else:
        row = db.tile_get(provider, z, x, y)
        status, data = (row if row else (0, None))
    if status != 200 or not data:
        if status in (404, 204):
            _decoded.put(key, np.zeros((0,), np.uint8))
        return None
    try:
        a = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
    except Exception:
        a = None
    if a is None or a.shape[:2] != (TILE, TILE):
        _decoded.put(key, np.zeros((0,), np.uint8))
        return None
    _decoded.put(key, a)
    return a


def mosaic_px(provider: str, z: int, px0: float, py0: float, w: int, h: int, fetch=True,
              fallback_zoom=True) -> tuple[np.ndarray, float]:
    """Image of size (h,w) whose top-left is global pixel (px0,py0) at zoom z.
    Returns (image, valid_fraction). Missing tiles are filled from z-1 (upscaled) if possible."""
    out = np.zeros((h, w, 3), np.uint8)
    valid = np.zeros((h, w), bool)
    px0, py0 = int(round(px0)), int(round(py0))
    tx0, ty0 = px0 // TILE, py0 // TILE
    tx1, ty1 = (px0 + w - 1) // TILE, (py0 + h - 1) // TILE
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            a = tile_array(provider, z, tx, ty, fetch=fetch)
            if a is None and fallback_zoom and z > 12:
                a = _upscaled_from_parent(provider, z, tx, ty, fetch)
            if a is None:
                continue
            sx0 = max(px0, tx * TILE)
            sy0 = max(py0, ty * TILE)
            sx1 = min(px0 + w, (tx + 1) * TILE)
            sy1 = min(py0 + h, (ty + 1) * TILE)
            out[sy0 - py0:sy1 - py0, sx0 - px0:sx1 - px0] = a[sy0 - ty * TILE:sy1 - ty * TILE,
                                                               sx0 - tx * TILE:sx1 - tx * TILE]
            valid[sy0 - py0:sy1 - py0, sx0 - px0:sx1 - px0] = True
    return out, float(valid.mean())


def _upscaled_from_parent(provider, z, tx, ty, fetch):
    pa = tile_array(provider, z - 1, tx // 2, ty // 2, fetch=fetch)
    if pa is None:
        return None
    ox, oy = (tx % 2) * 128, (ty % 2) * 128
    sub = pa[oy:oy + 128, ox:ox + 128]
    return np.asarray(Image.fromarray(sub).resize((TILE, TILE), Image.BILINEAR))


def crop_lonlat(provider: str, z: int, lon: float, lat: float, size: int, fetch=True):
    px, py = lonlat_to_pixel(lon, lat, z)
    return mosaic_px(provider, z, px - size / 2, py - size / 2, size, size, fetch=fetch)


def tiles_for_crop(z: int, lon: float, lat: float, size: int) -> list[tuple[int, int]]:
    px, py = lonlat_to_pixel(lon, lat, z)
    x0, y0 = int((px - size / 2) // TILE), int((py - size / 2) // TILE)
    x1, y1 = int((px + size / 2 - 1) // TILE), int((py + size / 2 - 1) // TILE)
    return [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def to_jpeg(a: np.ndarray, quality=88) -> bytes:
    b = io.BytesIO()
    Image.fromarray(a).save(b, format="JPEG", quality=quality)
    return b.getvalue()
