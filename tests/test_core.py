"""Fast unit tests of the pure logic (no network, no models).  Run: python -m pytest -q tests"""
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("ZABROSHKI_DATA", tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from shapely.geometry import LineString, box  # noqa: E402

from zabroshki import candidates as C  # noqa: E402
from zabroshki import osm, scoring, vlm, wayback  # noqa: E402
from zabroshki.geo import (LocalProj, lonlat_to_pixel, lonlat_to_tile, pixel_to_lonlat, quadkey,  # noqa: E402
                           tiles_for_polygon)
from zabroshki.imagery import veg_tree_masks  # noqa: E402
from zabroshki.tiles import is_placeholder  # noqa: E402
from zabroshki.training import read_points_csv  # noqa: E402


def test_tile_math_roundtrip():
    lon, lat = 28.75, 60.71
    x, y = lonlat_to_pixel(lon, lat, 17)
    lon2, lat2 = pixel_to_lonlat(x, y, 17)
    assert abs(lon - lon2) < 1e-9 and abs(lat - lat2) < 1e-9
    assert lonlat_to_tile(lon, lat, 17) == (76003, 37540)
    assert quadkey(*lonlat_to_tile(lon, lat, 9), 9) == "120121020"


def test_tiles_for_polygon_count():
    poly = box(28.70, 60.70, 28.76, 60.73)
    assert 500 < len(tiles_for_polygon(poly, 17)) < 600


def test_csv_reader_formats(tmp_path):
    p = tmp_path / "a.csv"
    p.write_text("# c\nlat,lon,comment\n60.71,28.75,дом\n", encoding="utf-8")
    assert read_points_csv(p) == [{"lat": 60.71, "lon": 28.75, "comment": "дом"}]
    p.write_text("широта;долгота;комментарий\n60,71;28,75;в лесу\n", encoding="utf-8")
    assert read_points_csv(p)[0]["lat"] == 60.71
    p.write_text("60.71,28.75\n60.72,28.76,x\n", encoding="utf-8")
    r = read_points_csv(p)
    assert len(r) == 2 and r[1]["comment"] == "x"


def test_lifecycle_tags():
    assert osm.lifecycle_strength({"building": "ruins"})[0] > 3
    assert osm.lifecycle_strength({"abandoned:building": "house"})[0] == 3.0
    assert osm.lifecycle_strength({"building": "house"})[0] == 0
    assert osm.is_lifecycle({"disused:amenity": "school"})
    assert osm.tags_type({"building": "cowshed"}) == "farm"
    assert osm.tags_type({"building": "ruins"}) == "ruins"


def test_dead_ends():
    a = LineString
    hw = [(a([(0, 0), (1, 0)]), {"highway": "track"}, "w1"), (a([(1, 0), (2, 0)]), {"highway": "residential"}, "w2")]
    ends = osm.find_dead_ends(hw)
    assert len(ends) == 1 and ends[0][0].x == 0


def _cand(**f):
    c = C.new_candidate("osm:way/1", 60.7, 28.7, "house", footprint=box(28.7, 60.7, 28.7001, 60.70005))
    c["sources"] = {"OSM"}
    c["f"].update(f)
    return c


def test_score_monotonic_and_capped():
    base = scoring.score(_cand(in_settlement=True))[0]
    forest = scoring.score(_cand(outside_settlement=True, tree_ring=0.9, tree_on=0.8))[0]
    assert forest > base
    # many correlated image models must not explode the score
    c = _cand(pA=0.999, pA_trained=True, pB=0.999, pB_trained=True, zs_abandoned=0.999)
    p, reasons = scoring.score(c)
    total = sum(r["w"] for r in reasons if r["k"] in ("clfA", "clfB", "zs"))
    assert total <= scoring.GROUPS["image_models"][1] + 0.02  # reasons are rounded to 0.01


def test_guard_rules():
    red, rs = scoring.guard_status(_cand(in_military=True, fence_strong=True, fence_near=1))
    assert red == "red"
    c = _cand(outside_settlement=True)
    c["score"] = 0.8
    g, rs = scoring.guard_status(c)
    assert g == "green"
    c["score"] = 0.1
    assert scoring.guard_status(c)[0] == "yellow"


def test_merge_duplicates_rules():
    lp = LocalProj(60.7, 28.7)
    fp1 = box(28.70000, 60.70000, 28.70020, 60.70010)
    fp2 = box(28.70005, 60.70002, 28.70025, 60.70012)   # overlaps fp1
    fp3 = box(28.70040, 60.70000, 28.70060, 60.70010)   # 10 m away, separate building
    a = C.new_candidate("osm:way/1", 60.70005, 28.7001, "house", footprint=fp1, sources=["OSM"])
    b = C.new_candidate("ms:1", 60.70007, 28.70015, "house", footprint=fp2, sources=["MS Footprints"])
    d = C.new_candidate("ms:2", 60.70005, 28.7005, "house", footprint=fp3, sources=["MS Footprints"])
    e = C.new_candidate("dead:1", 60.7003, 28.7001, "deadend", sources=["OSM (тупик)"])
    out = C.merge_duplicates([a, b, d, e], lp)
    assert len(out) == 2
    main = [c for c in out if c["key"] == "osm:way/1"][0]
    assert "MS Footprints" in main["sources"] and main["f"].get("dead_end_near")


def test_wayback_pair_prefers_summer():
    v = [{"release": 1, "date": "2025-06-04"}, {"release": 2, "date": "2023-07-13"},
         {"release": 3, "date": "2019-07-04"}, {"release": 4, "date": "2017-05-23"}]
    new, old, same = wayback.choose_pair(v)
    assert new["date"] == "2025-06-04" and old["date"] == "2019-07-04" and same


def test_vlm_parse():
    d = vlm.parse_answer('blah {"abandoned_probability": "0.8", "vehicles": "false", "roof": "collapsed"} x')
    assert d["abandoned_probability"] == 0.8 and d["vehicles"] is False
    assert vlm.parse_answer("no json") is None


def test_tree_mask_grass_vs_forest():
    rng = np.random.RandomState(0)
    grass = np.zeros((128, 128, 3), np.uint8) + np.array([70, 100, 50], np.uint8)
    grass = np.clip(grass + rng.randint(-3, 4, grass.shape), 0, 255).astype(np.uint8)
    forest = np.zeros((128, 128, 3), np.uint8) + np.array([40, 75, 30], np.uint8)
    forest = np.clip(forest.astype(int) + rng.randint(-35, 36, (128, 128, 1)), 0, 255).astype(np.uint8)
    _, tg, _, _ = veg_tree_masks(grass)
    _, tf, _, _ = veg_tree_masks(forest)
    assert tg.mean() < 0.1 and tf.mean() > 0.6


def test_placeholder_detection():
    import io
    from PIL import Image
    im = Image.new("RGB", (256, 256), (204, 204, 204))
    b = io.BytesIO()
    im.save(b, format="JPEG")
    assert is_placeholder(b.getvalue())


def test_absorb_satellites_and_annexes():
    lp = LocalProj(60.7, 28.7)
    big = C.new_candidate("osm:way/1", 60.70005, 28.7001, "house",
                          footprint=box(28.70000, 60.70000, 28.70040, 60.70020), sources=["OSM"])
    big["f"].update({"area_m2": 500.0})
    shed = C.new_candidate("osm:way/2", 60.70024, 28.70010, "house",
                           footprint=box(28.70008, 60.70022, 28.70012, 60.70026), sources=["OSM"])
    shed["f"].update({"area_m2": 20.0})
    clear = C.new_candidate("clear:1", 60.70010, 28.70060, "clearing", sources=["снимок"])
    far = C.new_candidate("osm:way/3", 60.7100, 28.7100, "house",
                          footprint=box(28.70995, 60.70995, 28.71005, 60.71005), sources=["OSM"])
    far["f"].update({"area_m2": 30.0})
    cands = [big, shed, clear, far]
    for c in cands:
        c["score"] = 0.6
    C.absorb_satellites(cands, lp)
    keys = {c["key"] for c in cands}
    assert keys == {"osm:way/1", "osm:way/3"}
    assert big["f"].get("annexes") == 1 and big["f"].get("satellites") == 1


def test_dense_cluster_dacha_not_outside():
    c = _cand(outside_settlement=True, footprints_100m=30, tree_ring=0.8)
    xv = scoring.feature_vector(c)
    assert "outside" not in xv and "dense" in xv
