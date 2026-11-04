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


def test_info_parsers():
    from zabroshki import info
    wd = {"results": {"bindings": [
        {"item": {"value": "http://www.wikidata.org/entity/Q1"}, "itemLabel": {"value": "Руины церкви"},
         "loc": {"value": "Point(28.7331 60.7106)"}, "inception": {"value": "1481-01-01T00:00:00Z"},
         "stateLabel": {"value": "руины"}, "image": {"value": "http://commons.wikimedia.org/wiki/Special:FilePath/A.jpg"},
         "ru": {"value": "https://ru.wikipedia.org/wiki/%D0%A0%D1%83%D0%B8%D0%BD%D1%8B"}}]}}
    items = info.parse_wikidata(wd, 60.7106, 28.7331)
    assert items[0]["facts"]["Основано/построено"] == "1481" and items[0]["facts"]["Состояние"] == "руины"
    assert items[0]["image_thumb"].startswith("https://") and "width=" in items[0]["image_thumb"]
    assert info.wiki_title_from_url(items[0]["wiki"]["ru"]) == ("ru", "Руины")
    cm = {"query": {"pages": [{"title": "File:X.jpg", "coordinates": [{"lat": 60.7107, "lon": 28.7331}],
                               "imageinfo": [{"thumburl": "t", "descriptionurl": "d", "url": "u",
                                              "extmetadata": {"Artist": {"value": "<a>Ivan</a>"},
                                                              "LicenseShortName": {"value": "CC BY-SA 4.0"}}}]}]}}
    ph = info.parse_commons(cm, 60.7106, 28.7331)
    assert ph[0]["author"] == "Ivan" and ph[0]["license"] == "CC BY-SA 4.0" and ph[0]["dist_m"] < 20
    pm = {"features": [{"id": "a", "geometry": {"coordinates": [28.7331, 60.7101]},
                        "properties": {"view:azimuth": 0, "license": "CC-BY-SA-4.0", "datetime": "2023-06-27T17:13"},
                        "assets": {"sd": {"href": "s"}, "hd": {"href": "h"}}}]}
    pp = info.parse_panoramax(pm, 60.7106, 28.7331)
    assert pp[0]["looks_at"] is True and pp[0]["license"] == "CC-BY-SA-4.0"
    notes = info.notes_from_text("Церковь разрушена пожаром в 1944 году. Здание является объектом культурного "
                                 "наследия и находится под охраной государства. Территория огорожена забором, "
                                 "есть сторож.", "src", "u")
    cats = [n["cat"] for n in notes]
    assert cats == ["condition", "security"] and "сторож" in notes[1]["text"]
    links = info.links(60.71, 28.73, {"name": "Форт"}, "ruins")
    assert any("urban3p" in l["url"] for l in links) and all(l["url"].startswith("https://") for l in links)


def test_construction_site_is_not_abandoned():
    t = {"landuse": "brownfield", "name": "Строительство ЖК \"Ратуша\""}
    assert osm.is_construction(t) and not osm.is_lifecycle(t)
    assert osm.lifecycle_strength(t)[0] == 0
    t2 = {"landuse": "brownfield", "name": "Бывший завод"}
    assert not osm.is_construction(t2) and osm.is_lifecycle(t2)
    assert not osm.is_construction({"highway": "construction", "construction": "residential"})
    assert not osm.is_construction({"building": "school", "name": "Лицей (Строительное отделение)"})


def test_building_like_filters_fences_and_monuments():
    lp = LocalProj(60.7, 28.7)
    poly = box(28.7000, 60.7000, 28.7004, 60.7002)
    tiny = box(28.70000, 60.70000, 28.70002, 60.70001)
    assert C.building_like({"building": "ruins"}, poly, lp)
    assert not C.building_like({"building": "ruins"}, tiny, lp)
    assert not C.building_like({"barrier": "fence", "abandoned": "yes"}, LineString([(28.7, 60.7), (28.701, 60.7)]), lp)
    assert not C.building_like({"historic": "memorial", "disused": "yes"}, poly.centroid, lp)


def test_complex_from_cluster_and_reliability():
    from zabroshki.complexes import build_complexes
    lp = LocalProj(60.7, 28.7)
    a = C.new_candidate("osm:way/1", 60.70005, 28.70010, "industrial",
                        footprint=box(28.70000, 60.70000, 28.70020, 60.70010), sources=["OSM"])
    b = C.new_candidate("osm:way/2", 60.70025, 28.70010, "industrial",
                        footprint=box(28.70000, 60.70020, 28.70020, 60.70030), sources=["OSM"])
    far = C.new_candidate("osm:way/3", 60.7100, 28.7100, "house",
                          footprint=box(28.70995, 60.70995, 28.71005, 60.71005), sources=["OSM"])
    for i, (c, sc) in enumerate(((a, 0.7), (b, 0.6), (far, 0.9))):
        c.update({"score": sc, "idx": i, "guard": "yellow", "reasons": [], "guard_reasons": []})
    cands = [a, b, far]
    out = build_complexes(cands, lp, 10)
    assert len(out) == 1 and out[0]["f"]["n_members"] == 2
    assert not out[0]["f"]["reliable"]                      # no reliable member -> hidden by default
    assert a["f"]["complex_key"] == out[0]["key"] and "complex_key" not in far["f"]
    a["f"]["reliable"] = True
    out = build_complexes(cands, lp, 10)
    assert out[0]["f"]["reliable"] and out[0]["footprint"].contains(out[0]["footprint"].representative_point())


def test_lifecycle_scope_whole_building_only():
    # a closed shop / cafe inside a working house is not an abandoned building
    assert osm.lifecycle_strength({"building": "yes", "disused:shop": "car_parts"})[0] == 0
    assert not osm.is_lifecycle({"disused:shop": "greengrocer", "demolished:building": "retail"})
    assert not osm.is_lifecycle({"was:building": "yes"})                        # the object is gone
    assert not osm.is_lifecycle({"abandoned": "yes", "amenity": "fountain"})
    assert not osm.is_lifecycle({"abandoned": "yes", "abandoned:railway": "halt"})
    # whole buildings / sites still count
    assert osm.lifecycle_strength({"disused:amenity": "school", "building": "school"})[0] >= 2.2
    assert osm.lifecycle_strength({"abandoned": "yes", "building": "yes"})[0] >= 3.0
    assert osm.lifecycle_strength({"abandoned:building": "industrial"})[0] >= 3.0
    assert osm.lifecycle_strength({"building": "ruins"})[0] >= 3.0
    assert osm.lifecycle_strength({"abandoned": "yes"})[0] >= 3.0                 # nothing else tagged: the object itself


def test_reliable_needs_strong_signal_without_osm_tag():
    c = _cand(outside_settlement=True)
    c.update({"score": 0.8, "tags": {"building": "yes"}, "kind": "building"})
    c["f"].update({"confirm_n": 2, "contra": []})
    assert not scoring.reliable(c)                          # e.g. "overgrown" + "SigLIP" only
    c["f"].update({"wb_bprob_drop": 0.4, "wb_bprob_old": 0.8})
    assert scoring.reliable(c)                              # the roof vanished between imagery years
    c["f"]["in_dacha"] = True
    assert not scoring.reliable(c)                          # dachas need an OSM tag


def test_water_like_overview():
    from zabroshki.imagery import _water_like
    rng = np.random.default_rng(0)
    water = np.full((32, 32, 3), (28, 40, 52), np.uint8) + rng.integers(0, 3, (32, 32, 3)).astype(np.uint8)
    forest = np.clip(rng.normal((40, 75, 35), 25, (32, 32, 3)), 0, 255).astype(np.uint8)
    field = np.full((32, 32, 3), (150, 160, 110), np.uint8)
    assert _water_like(water)
    assert not _water_like(forest) and not _water_like(field)


def test_never_reliable_and_promising():
    dacha = _cand(in_dacha=True)
    assert scoring.never_reliable(dacha) and not scoring.promising(dacha)
    tagged = _cand(in_dacha=True)
    tagged["tags"] = {"building": "ruins"}
    assert not scoring.never_reliable(tagged) and scoring.promising(tagged)
    forest = _cand(outside_settlement=True, pA=0.2, pA_trained=True)
    assert not scoring.never_reliable(forest) and not scoring.promising(forest)   # z17 classifier sees nothing
    forest["f"]["pA"] = 0.8
    assert scoring.promising(forest)
    assert scoring.never_reliable(C.new_candidate("de:1", 60.7, 28.7, "deadend"))
    wall = _cand(in_military=True)
    wall["tags"] = {"building": "castle_wall"}
    assert scoring.never_reliable(wall)


def test_fast_mode_selection_stage_b_and_wayback():
    from zabroshki import stageb
    from zabroshki import wayback as W
    weak = _cand(outside_settlement=True, pA=0.1, pA_trained=True)
    strong = _cand(outside_settlement=True, pA=0.9, pA_trained=True, pB=0.9, pB_trained=True)
    dacha = _cand(in_dacha=True, pA=0.95, pA_trained=True)
    ruin = _cand(in_settlement=True)
    ruin["tags"] = {"building": "ruins"}
    for i, (c, sc) in enumerate(((weak, 0.4), (strong, 0.3), (dacha, 0.5), (ruin, 0.6))):
        c["score"], c["key"] = sc, f"osm:way/{i}"
    cands = [weak, strong, dacha, ruin]
    sel = stageb.select(cands, 100, 0.08, fast=True)
    assert strong in sel and ruin in sel and weak not in sel and dacha not in sel
    assert len(stageb.select(cands, 100, 0.08, fast=False)) == 4
    wsel = W.select(cands, {"search_mode": "fast"})
    assert wsel[0] is strong and ruin in wsel and dacha not in wsel and weak not in wsel
    assert len(W.select(cands, {"search_mode": "full"})) == 4


def test_scanner_plan_skips_dense_and_water():
    from zabroshki.geo import tiles_for_polygon
    from zabroshki.imagery import Scanner

    class _Job:
        def checkpoint(self):
            pass

        def progress(self, *a, **k):
            pass

        def info(self, *a):
            pass
    class _NoFeed:   # no network in unit tests
        order: list = []

        def add(self, xys):
            pass

        def close(self):
            pass
    poly = box(28.700, 60.700, 28.712, 60.706)
    lp = LocalProj(60.703, 28.706)
    sc = Scanner(poly, lp, {"search_mode": "fast", "use_models": False}, _Job())
    sc.feeder = _NoFeed()
    tl = tiles_for_polygon(poly, 17)
    assert len(tl) >= 4
    t_dense, t_mixed, t_water, t_water_b = tl[0], tl[1], tl[2], tl[3]
    sc.water = {t_water, t_water_b}

    def at(t, **f):
        from zabroshki.geo import tile_bounds
        w, s, e, n = tile_bounds(t[0], t[1], 17)
        c = _cand(**f)
        c["lat"], c["lon"] = (s + n) / 2, (w + e) / 2
        return c
    cands = [at(t_dense, in_dacha=True), at(t_dense, footprints_100m=40),
             at(t_mixed, in_dacha=True), at(t_mixed, outside_settlement=True),
             at(t_water_b, outside_settlement=True)]          # a building on an island: keep the tile
    try:
        sc.plan(cands)
        assert t_dense in sc.skipped and t_water in sc.skipped
        assert t_mixed not in sc.skipped and t_water_b not in sc.skipped
        sc2 = Scanner(poly, lp, {"search_mode": "full", "use_models": False}, _Job())
        sc2.feeder = _NoFeed()
        sc2.plan(cands)
        assert not sc2.skipped
        sc2.close()
    finally:
        sc.close()


def test_neighbour_baseline_falls_back_to_region_when_not_scanned():
    import random
    rng = random.Random(1)
    cands = []
    # a region of ordinary scanned buildings (low classifier output)
    for i in range(40):
        c = _cand(in_settlement=True, pA=0.05 + rng.random() * 0.02)
        c["lat"], c["lon"] = 60.70 + i * 0.0003, 28.80
        cands.append(c)
    # a ruin among 20 buildings, only 3 of them scanned and those are parts of the same site
    ruin = _cand(in_settlement=True, pA=0.8)
    ruin["lat"], ruin["lon"] = 60.75, 28.70
    ruin["tags"] = {"building": "ruins"}
    cands.append(ruin)
    for i in range(20):
        c = _cand(in_settlement=True, **({"pA": 0.75} if i < 3 else {}))
        c["lat"], c["lon"] = 60.75 + (i % 5) * 0.0003, 28.70 + (i // 5) * 0.0005
        cands.append(c)
    scoring.neighbour_context(cands)
    assert ruin["f"]["pA_neigh_src"] == "region" and ruin["f"]["pA_neigh"] < 0.1
    # fully scanned neighbourhood: local median, lifecycle-tagged neighbours excluded
    other = cands[20]
    assert other["f"].get("pA_neigh_src") is None and other["f"]["pA_neigh"] < 0.1
