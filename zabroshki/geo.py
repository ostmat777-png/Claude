"""Geometry helpers: Web-Mercator tiles, local metric projection, distances."""
from __future__ import annotations

import math
from dataclasses import dataclass

from shapely.geometry import Polygon, box, shape, mapping
from shapely.ops import transform

TILE = 256
EARTH_R = 6378137.0


def lonlat_to_pixel(lon: float, lat: float, z: int) -> tuple[float, float]:
    """Global pixel coordinates at zoom z (Web-Mercator)."""
    n = TILE * (2 ** z)
    x = (lon + 180.0) / 360.0 * n
    lat = max(min(lat, 85.05112878), -85.05112878)
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def pixel_to_lonlat(x: float, y: float, z: int) -> tuple[float, float]:
    n = TILE * (2 ** z)
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    x, y = lonlat_to_pixel(lon, lat, z)
    return int(x // TILE), int(y // TILE)


def tile_bounds(x: int, y: int, z: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) of a tile."""
    w, n = pixel_to_lonlat(x * TILE, y * TILE, z)
    e, s = pixel_to_lonlat((x + 1) * TILE, (y + 1) * TILE, z)
    return w, s, e, n


def meters_per_pixel(lat: float, z: int) -> float:
    return 2 * math.pi * EARTH_R * math.cos(math.radians(lat)) / (TILE * 2 ** z)


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(a))


@dataclass
class LocalProj:
    """Equirectangular projection around a centre: good to <0.1% over ~50 km."""
    lat0: float
    lon0: float

    def __post_init__(self):
        self.kx = math.cos(math.radians(self.lat0)) * 111320.0
        self.ky = 110574.0

    def fwd(self, lon, lat):
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky

    def inv(self, x, y):
        return self.lon0 + x / self.kx, self.lat0 + y / self.ky

    def geom_to_m(self, g):
        return transform(lambda x, y, z=None: ((x - self.lon0) * self.kx, (y - self.lat0) * self.ky), g)

    def geom_to_ll(self, g):
        return transform(lambda x, y, z=None: (self.lon0 + x / self.kx, self.lat0 + y / self.ky), g)


def area_from_geojson(obj) -> Polygon:
    """Accepts a GeoJSON Feature / geometry / FeatureCollection with one polygon."""
    if obj.get("type") == "FeatureCollection":
        obj = obj["features"][0]
    if obj.get("type") == "Feature":
        obj = obj["geometry"]
    g = shape(obj)
    if not g.is_valid:
        g = g.buffer(0)
    return g


def geom_to_geojson(g) -> dict:
    return mapping(g)


def tiles_for_polygon(poly, z: int) -> list[tuple[int, int]]:
    """All tiles at zoom z that intersect the polygon (lon/lat geometry)."""
    w, s, e, n = poly.bounds
    x0, y0 = lonlat_to_tile(w, n, z)
    x1, y1 = lonlat_to_tile(e, s, z)
    out = []
    prepared = poly
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            tw, ts, te, tn = tile_bounds(tx, ty, z)
            if prepared.intersects(box(tw, ts, te, tn)):
                out.append((tx, ty))
    return out


def quadkey(x: int, y: int, z: int) -> str:
    q = []
    for i in range(z, 0, -1):
        d = 0
        m = 1 << (i - 1)
        if x & m:
            d += 1
        if y & m:
            d += 2
        q.append(str(d))
    return "".join(q)


def polygon_area_km2(poly) -> float:
    c = poly.centroid
    lp = LocalProj(c.y, c.x)
    return lp.geom_to_m(poly).area / 1e6


def google_maps_url(lat: float, lon: float) -> str:
    return f"https://www.google.com/maps/@{lat:.6f},{lon:.6f},150m/data=!3m1!1e3"


def osm_url(lat: float, lon: float) -> str:
    return f"https://www.openstreetmap.org/?mlat={lat:.6f}&mlon={lon:.6f}#map=18/{lat:.6f}/{lon:.6f}"
