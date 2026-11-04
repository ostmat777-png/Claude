"""Evidence -> score (log-odds sum with human readable reasons) and guard status."""
from __future__ import annotations

import math

from . import osm

# Version of the evidence model; meta-weights learned for another version are ignored.
SCORING_VERSION = 3

# Precision first (user feedback): context alone (forest, remote, outside settlements…) must never make an
# object "abandoned". High scores need DIRECT evidence: OSM lifecycle tag, damaged/vanished roof, standing out
# from neighbouring buildings, history of the place, VLM.
DEFAULT_WEIGHTS = {
    "bias": -3.5,
    # direct evidence
    "osm_lifecycle": 3.0,
    "military_disused": 1.0,
    "clfA": 0.6,
    "clfB": 0.5,
    "zs": 0.3,
    "tree_on_roof": 0.8,
    "overgrowth": 0.3,
    "bprob_low": 0.4,
    "wb_veg": 0.8,
    "wb_roof": 1.2,
    "wb_change": 0.3,
    "vlm": 1.2,
    # weak context (capped together, see GROUPS["context"])
    "military_ctx": 0.3,
    "outside": 0.5,
    "farm": 0.3,
    "industrial": 0.1,
    "unmapped": 0.15,
    "far_from_roads": 0.2,
    "minor_access": 0.2,
    "dead_end": 0.2,
    "road_abandoned": 0.4,
    "isolated": 0.3,
    "forest": 0.3,
    "clearing": 0.3,
    "no_paths": 0.1,
    "road_overgrown": 0.4,
    "image_detected": 0.2,
    # active / ordinary places
    "dacha": 0.0,
    "settlement": -0.5,
    "dense": -0.8,
    "active_neighbours": -0.8,
    "garages": -1.5,
    "park": -2.5,
    "museum": -2.5,
    "construction": -2.0,
    "protected": -1.5,
    "monument": -2.0,
    "cemetery": -1.5,
    "zs_cars": -1.0,
    "zs_nobuilding": -1.5,
    "ms_unconfirmed": -1.5,
    "tiny": -1.0,
    "kind_deadend": -1.5,
    "kind_clearing": -1.5,
}

DENSE_N = 12  # buildings within ~100 m: a dacha cooperative / village even if OSM does not map it as one


def dense_cluster(f) -> bool:
    n = max(f.get("footprints_100m") or 0, int(1.5 * (f.get("osm_buildings_80m") or 0)))
    return n >= DENSE_N

# Evidence that is meaningless (tautological or out-of-distribution) for candidates that are not a known building:
# a forest clearing is surrounded by forest by definition; image-only detections are only searched under tree cover;
# the abandonment classifiers were trained on buildings, not on bogs and meadows.
NOT_FOR_POINTS = {"forest", "overgrowth", "tree_on_roof", "no_paths", "clfA", "clfB", "zs", "isolated"}


def _logit(p, lo=-4.0, hi=4.0):
    p = min(max(float(p), 1e-4), 1 - 1e-4)
    return max(lo, min(hi, math.log(p / (1 - p))))


def _clip(x, lo, hi):
    return max(lo, min(hi, x))


def _relative(p, neigh, src=None):
    """How much MORE abandoned the object looks than the buildings around it (logit difference).
    A dacha that looks like all neighbouring dachas gets ~0, whatever the absolute classifier output."""
    v = _logit(p)
    if neigh is None:
        return v - 1.0, " (соседей для сравнения нет — вес снижен)"
    if src == "region":
        return v - _logit(neigh), f" (обычные здания такой застройки в регионе {neigh:.2f})"
    return v - _logit(neigh), f" (соседи {neigh:.2f})"


def _ctx_class(f) -> str:
    if dense_cluster(f):
        return "dense"
    if f.get("in_dacha"):
        return "dacha"
    return "settlement" if f.get("in_settlement") else "outside"


def neighbour_context(cands, radius_m=250.0, min_n=6, min_cover=0.5):
    """Median classifier-A probability of ordinary mapped buildings nearby -> f['pA_neigh'].
    * buildings with OSM lifecycle tags are not part of the baseline (ruins of one site must not cancel each other);
    * if most buildings around have no image score (their tiles were not scanned in the fast mode), the few that
      have one are a biased sample (often parts of the same site) -> use the regional median of ordinary buildings
      in the same setting (dense / dacha / settlement / outside) instead, f['pA_neigh_src'] = 'region'."""
    import numpy as np
    blds = [c for c in cands if c.get("footprint") is not None and c["kind"] != "complex"]
    pts = [c for c in blds if c["f"].get("pA") is not None]
    if len(pts) < min_n:
        return
    tagged = {id(c) for c in blds if osm.lifecycle_strength(c["tags"])[0] > 0}
    reg: dict = {}
    for c in pts:
        if id(c) not in tagged:
            reg.setdefault(_ctx_class(c["f"]), []).append(c["f"]["pA"])
    reg = {k: float(np.median(v)) for k, v in reg.items() if len(v) >= 20}
    k = 111320.0 * math.cos(math.radians(pts[0]["lat"]))
    cell = radius_m
    grid: dict = {}
    for c in blds:
        x, y = c["lon"] * k, c["lat"] * 110574.0
        p = None if id(c) in tagged else c["f"].get("pA")
        grid.setdefault((int(x // cell), int(y // cell)), []).append((x, y, p))
    for c in cands:
        if c["f"].get("pA") is None:
            continue
        x, y = c["lon"] * k, c["lat"] * 110574.0
        gx, gy = int(x // cell), int(y // cell)
        near = [p for dx in (-1, 0, 1) for dy in (-1, 0, 1) for (x2, y2, p) in grid.get((gx + dx, gy + dy), ())
                if 0 < (x2 - x) ** 2 + (y2 - y) ** 2 <= radius_m ** 2]
        vals = [p for p in near if p is not None]
        c["f"].pop("pA_neigh_src", None)
        if len(vals) >= min_n and len(vals) >= min_cover * len(near):
            c["f"]["pA_neigh"] = round(float(np.median(vals)), 4)
        elif len(near) >= min_n and _ctx_class(c["f"]) in reg:
            c["f"]["pA_neigh"] = round(reg[_ctx_class(c["f"])], 4)
            c["f"]["pA_neigh_src"] = "region"
        else:
            c["f"]["pA_neigh"] = None
    # median "trees over the roof" of mapped neighbours: in green dacha areas every roof is partly under trees
    tp = [c for c in cands if c["f"].get("tree_on") is not None and c.get("footprint") is not None]
    grid2: dict = {}
    for c in tp:
        x, y = c["lon"] * k, c["lat"] * 110574.0
        grid2.setdefault((int(x // cell), int(y // cell)), []).append((x, y, c["f"]["tree_on"]))
    for c in tp:
        x, y = c["lon"] * k, c["lat"] * 110574.0
        gx, gy = int(x // cell), int(y // cell)
        vals = [p for dx in (-1, 0, 1) for dy in (-1, 0, 1) for (x2, y2, p) in grid2.get((gx + dx, gy + dy), ())
                if 0 < (x2 - x) ** 2 + (y2 - y) ** 2 <= radius_m ** 2]
        c["f"]["tree_on_neigh"] = round(float(np.median(vals)), 3) if len(vals) >= min_n else None


def feature_vector(c) -> dict:
    """Numeric evidence x_k (same names as weights) + text for each."""
    f = c["f"]
    t = c["tags"]
    x: dict[str, tuple[float, str]] = {}
    lc, why = osm.lifecycle_strength(t)
    plc = c.get("parent_lifecycle", 0.0) or f.get("parent_lifecycle", 0.0)
    if "OSM" not in c["sources"]:
        plc = 0.0  # only real mapped buildings inherit "abandoned territory" (not stray MS polygons/detections)
    if plc and plc * 0.7 > lc:
        lc, why = plc * 0.7, "Внутри территории с OSM-тегом заброшенности (" + _ptags(c) + ")"
    if lc:
        x["osm_lifecycle"] = (lc / 3.0, why)
    if f.get("in_military"):
        if f.get("military_disused"):
            x["military_disused"] = (1.0, "Бывшая военная территория (OSM)")
        else:
            x["military_ctx"] = (1.0, "Военная территория/объект в OSM " + " ".join(f.get("military_tags") or []))
    dense = dense_cluster(f) and c["kind"] not in ("deadend", "clearing")
    if f.get("outside_settlement") and not dense:
        x["outside"] = (1.0, "Вне населённых пунктов и садоводств")
    elif f.get("in_dacha") and not dense:
        x["dense"] = (0.6, "В садоводстве (дачи) — участки обычно используются")
    if dense and not f.get("in_settlement"):
        x["dense"] = (1.0, "Плотная застройка вокруг (похоже на садоводство/посёлок, даже если его нет в OSM)")
    if t.get("building") in ("garage", "garages", "carport") or t.get("amenity") == "parking" \
            or f.get("in_garages") or "garage" in str(t.get("disused:building", "")):
        x["garages"] = (1.0, "Гаражи — обычно используются, выглядят «заброшенно» из-за ржавых крыш")
    if f.get("in_settlement"):
        x["settlement"] = (1.0, "В населённом пункте" + (f" ({f['near_place_name']})" if f.get("near_place_name") else ""))
    if f.get("in_park"):
        x["park"] = (1.0, "Внутри парка/сквера (OSM leisure) — действующая территория")
    if f.get("in_museum"):
        x["museum"] = (1.0, "Музей/достопримечательность (OSM tourism) — действующая территория")
    if f.get("in_protected"):
        x["protected"] = (1.0, "Охраняемая природная территория/заповедник")
    if (f.get("in_construction") or osm.is_construction(t)) and lc < 2.2:
        x["construction"] = (1.0, "Стройплощадка (OSM) — территория используется")
    if f.get("in_cemetery"):
        x["cemetery"] = (1.0, "Кладбище")
    hist = t.get("historic")
    if hist and hist not in ("ruins", "fort", "bunker", "military") and lc < 2.2:
        x["monument"] = (1.0, f"Памятник/исторический объект (historic={hist}) — обычно ухоженный")
    if c["kind"] == "farm":
        x["farm"] = (1.0, "Сельхоз-постройка / ферма")
    if c["kind"] == "industrial" or f.get("in_industrial"):
        x["industrial"] = (1.0, "Промышленная постройка/зона")
    if "OSM" not in c["sources"] and c["kind"] not in ("deadend", "clearing") and not f.get("in_settlement"):
        x["unmapped"] = (1.0, "Постройки нет в OSM (найдена по контурам/снимку)")
    rd = f.get("road_dist")
    if rd is not None and rd > 60:
        x["far_from_roads"] = (_clip((rd - 60) / 200, 0, 1), f"До ближайшей дороги ~{min(rd, 400):.0f} м")
    if f.get("only_minor_roads_100m"):
        x["minor_access"] = (1.0, f"Подъезд только по грунтовке/тропе ({f.get('road_class')})")
    if f.get("dead_end_near") and c["kind"] != "deadend" and not f.get("in_settlement"):
        x["dead_end"] = (1.0, "К объекту ведёт тупиковая дорога/тропа")
    if f.get("road_abandoned"):
        x["road_abandoned"] = (1.0, "Рядом заброшенная дорога (OSM)")
    if f.get("outside_settlement") and f.get("footprints_100m", 99) <= 2 and c["kind"] not in ("deadend", "clearing"):
        x["isolated"] = (1.0, "Одиночная постройка (соседей ≤2 в 100 м)")
    if f.get("active_neighbours"):
        x["active_neighbours"] = (min(f["active_neighbours"], 3) / 3, "Рядом действующие объекты (магазины/учреждения)")
    # ---- imagery, stage A
    if f.get("tree_ring") is not None:
        tr = f["tree_ring"]
        if tr >= 0.25:
            x["forest"] = (_clip((tr - 0.25) / 0.5, 0, 1), f"Вокруг лес/деревья ({tr * 100:.0f}% кольца 10–40 м)")
    if f.get("veg_rel") is not None and abs(f["veg_rel"]) >= 0.5:
        v = _clip(f["veg_rel"], -2, 3)
        x["overgrowth"] = (v, ("Участок заметно заросший относительно соседей" if v > 0 else
                               "Участок ухоженнее соседей") + f" (z={v:+.1f})")
    if f.get("tree_on") is not None and c.get("footprint") is not None and c["kind"] not in ("deadend", "clearing"):
        # only if the roof is still partly visible (otherwise it is just a building under a tree crown)
        # and clearly greener than the neighbours' roofs
        base = f.get("tree_on_neigh") or 0.0
        excess = f["tree_on"] - max(base, 0.15)
        roof_visible = f.get("bprob") is None or f["bprob"] >= 0.3
        if excess >= 0.25 and roof_visible:
            x["tree_on_roof"] = (_clip(excess / 0.5, 0, 1),
                                 f"Растительность поверх крыши {f['tree_on'] * 100:.0f}% (у соседей ~{base * 100:.0f}%) — "
                                 "крыша разрушена или заросла")
    if f.get("veg_yard") is not None and f["veg_yard"] >= 0.85 and c.get("footprint") is not None \
            and not f.get("in_settlement") and c["kind"] not in ("deadend", "clearing"):
        x["no_paths"] = (_clip((f["veg_yard"] - 0.85) / 0.12, 0.2, 1),
                         f"Нет дорожек и площадок у стен: вокруг сплошная зелень ({f['veg_yard'] * 100:.0f}%)")
    if f.get("road_tree") is not None and not f.get("in_settlement") \
            and f.get("access_road") in ("track", "path", "bridleway", "footway", "service") \
            and (f["road_tree"] >= 0.6 or f.get("road_veg", 0) >= 0.92):
        v = max(_clip((f["road_tree"] - 0.6) / 0.3, 0, 1), _clip((f.get("road_veg", 0) - 0.92) / 0.08, 0, 1), 0.3)
        x["road_overgrown"] = (v, f"Подъездная дорога ({f.get('access_road')}) заросла на снимке: деревья "
                                  f"{f['road_tree'] * 100:.0f}%, зелень {f.get('road_veg', 0) * 100:.0f}%")
    if f.get("bprob") is not None and c.get("footprint") is not None and f.get("detector_ok") \
            and (lc > 0 or (f.get("tree_on") or 0) < 0.5):  # roof hidden by a crown is not "damaged"
        b = f["bprob"]
        if b < 0.35:
            x["bprob_low"] = (_clip((0.35 - b) / 0.35, 0, 1), f"На снимке крыша почти не читается (детектор {b:.2f})")
    if f.get("on_clearing") or c["kind"] == "clearing":
        x["clearing"] = (1.0, "Прогалина в лесу" + (f" ~{f['clearing_area_m2']:.0f} м²" if f.get("clearing_area_m2") else ""))
    if f.get("image_detected") and "OSM" not in c["sources"]:
        b = f.get("bprob") or 0.75
        x["image_detected"] = (_clip((b - 0.7) / 0.3, 0.2, 1), f"Постройка распознана на снимке (детектор {b:.2f})")
    if c.get("footprint") is None and f.get("image_detected") and "OSM" not in c["sources"] \
            and f.get("zs_nobuilding") is not None and f["zs_nobuilding"] >= 0.5:
        x["zs_nobuilding"] = (_clip((f["zs_nobuilding"] - 0.5) / 0.4, 0, 1),
                              f"SigLIP: на снимке z18 скорее нет постройки ({f['zs_nobuilding']:.2f})")
    if f.get("pA") is not None and f.get("pA_trained"):
        v, txt = _relative(f["pA"], f.get("pA_neigh"), f.get("pA_neigh_src"))
        x["clfA"] = (v, f"Классификатор по снимку z17: {f['pA']:.2f}" + txt)
    # ---- stage B
    if f.get("zs_abandoned") is not None:
        x["zs"] = (_logit(f["zs_abandoned"], -3, 3), f"SigLIP: «заброшено/руины» {f['zs_abandoned']:.2f}")
    if f.get("zs_cars") is not None and f["zs_cars"] >= 0.3:
        x["zs_cars"] = (f["zs_cars"], f"SigLIP: машины/техника во дворе {f['zs_cars']:.2f}")
    if f.get("pB") is not None and f.get("pB_trained"):
        v, txt = _relative(f["pB"], f.get("pA_neigh"), f.get("pA_neigh_src"))
        x["clfB"] = (v, f"Классификатор по снимку z18: {f['pB']:.2f}" + txt)
    # ---- wayback
    if f.get("wb_veg_delta") is not None:
        dv = f["wb_veg_delta"]
        if abs(dv) >= 0.05:
            x["wb_veg"] = (_clip(dv / 0.25, -1, 2), (f"Заросло с {f.get('wb_from', '?')} по {f.get('wb_to', '?')} "
                                                     if dv > 0 else f"Расчищено/освоено с {f.get('wb_from', '?')} по {f.get('wb_to', '?')} ")
                           + f"(растительность {dv * 100:+.0f} п.п."
                           + (", снимки разных сезонов — вес снижен)" if f.get("wb_season_mismatch") else ")"))
    if f.get("wb_bprob_drop") is not None and f["wb_bprob_drop"] >= 0.15:
        x["wb_roof"] = (_clip(f["wb_bprob_drop"] / 0.4, 0, 2),
                        f"Крыша была, а теперь хуже читается ({f.get('wb_from', '?')} → {f.get('wb_to', '?')})")
    if f.get("wb_change") is not None and f["wb_change"] >= 0.25:
        x["wb_change"] = (_clip(f["wb_change"], 0, 1), f"Сильное изменение снимка между годами ({f['wb_change']:.2f})")
    # ---- VLM
    vlm = f.get("vlm")
    if isinstance(vlm, dict) and vlm.get("abandoned_probability") is not None:
        txt = f"VLM: заброшено с вероятностью {vlm['abandoned_probability']:.2f}"
        if vlm.get("explanation"):
            txt += " — " + str(vlm["explanation"])[:140]
        x["vlm"] = (_logit(vlm["abandoned_probability"], -3, 3), txt)
    if c["kind"] == "deadend":
        x["kind_deadend"] = (1.0, "Только конец тупиковой дороги (постройка не найдена)")
    if c["kind"] == "clearing":
        b = f.get("bprob") or 0
        x["kind_clearing"] = (1.0 if b < 0.5 else 0.4, "Только прогалина (постройка не подтверждена)"
                              if b < 0.5 else f"Прогалина, на снимке похоже на остатки постройки (детектор {b:.2f})")
    # Microsoft ML footprints have false positives on forest canopy: if our own building detector does not
    # see a building there, treat it as unconfirmed (classifiers would read the canopy as "overgrown ruin").
    ms_only = c.get("footprint") is not None and "OSM" not in c["sources"] and "MS Footprints" in c["sources"]
    unconfirmed = ms_only and f.get("detector_ok") and (f.get("bprob") or 0) < 0.3 and lc == 0
    if unconfirmed:
        x["ms_unconfirmed"] = (1.0, "Контур Microsoft не подтверждён детектором зданий на снимке "
                                    f"({(f.get('bprob') or 0):.2f}) — возможно, это кроны деревьев")
    if ms_only and (f.get("area_m2") or 99) < 12 and lc == 0:
        x["tiny"] = (1.0, f"Очень маленький контур ({f.get('area_m2'):.0f} м²) — сарай или ошибка распознавания")
    known_building = (c.get("footprint") is not None and not unconfirmed) or lc > 0
    if not known_building:
        for k in NOT_FOR_POINTS:
            x.pop(k, None)
    return x


def _ptags(c):
    pt = c.get("parent_tags") or {}
    keys = [k for k in pt if osm.is_lifecycle({k: pt[k]})]
    return ", ".join(f"{k}={pt[k]}" for k in keys[:2]) or "территория"


# Correlated evidence (several detectors that all react to "lots of trees", several image models)
# must not be summed as if independent: each group's total contribution is capped.
GROUPS = {
    "image_models": (("clfA", "clfB", "zs"), 2.0),
    "context": (("outside", "far_from_roads", "minor_access", "dead_end", "isolated", "road_abandoned",
                 "road_overgrown", "forest", "clearing", "no_paths", "unmapped", "image_detected", "farm",
                 "industrial", "military_ctx"), 0.9),
    "vegetation": (("overgrowth", "tree_on_roof", "bprob_low"), 1.2),
    "history": (("wb_veg", "wb_roof", "wb_change"), 1.8),
}


def score(c, weights=None) -> tuple[float, list]:
    W = dict(DEFAULT_WEIGHTS)
    if weights:
        W.update(weights)
    x = feature_vector(c)
    contrib = {name: W.get(name, 0.0) * val for name, (val, text) in x.items()}
    notes = {}
    for gname, (members, cap) in GROUPS.items():
        pos = sum(v for k, v in contrib.items() if k in members and v > 0)
        neg = sum(v for k, v in contrib.items() if k in members and v < 0)
        for total, sign in ((pos, 1), (neg, -1)):
            if abs(total) > cap:
                k_scale = cap / abs(total)
                for k in members:
                    if k in contrib and contrib[k] * sign > 0:
                        contrib[k] *= k_scale
                        notes[k] = " *"
    z = W["bias"] + sum(contrib.values())
    reasons = []
    for name, (val, text) in x.items():
        reasons.append({"w": round(contrib[name], 2), "text": text + notes.get(name, ""), "k": name})
    reasons.sort(key=lambda r: -abs(r["w"]))
    p = 1 / (1 + math.exp(-z))
    return p, reasons


# ------------------------------------------------------------------------- guard
def guard_status(c) -> tuple[str, list]:
    """Red only with at least one STRONG sign of guarding/active use. Fences and gates from OSM alone are weak:
    around abandoned objects they are often broken or long gone (their weight is halved there)."""
    f = c["f"]
    t = c["tags"]
    strong, weak = [], []
    if f.get("in_military") and not f.get("military_disused"):
        strong.append((2.0, "Действующая военная территория по OSM " + " ".join(f.get("military_tags") or [])))
    acc = t.get("access") or f.get("access")
    if acc in ("private", "no", "military", "permit"):
        strong.append((1.5, f"Доступ ограничен: access={acc}"))
    if f.get("guardhouse"):
        strong.append((2.0, f"Будка охраны/КПП в {f.get('guardhouse_dist', 0):.0f} м"))
    if f.get("strong_gate"):
        strong.append((1.2, f"Шлагбаум/КПП в {f.get('gate_dist', 0):.0f} м"))
    if f.get("zs_cars") is not None and f["zs_cars"] >= 0.5:
        strong.append((1.0, f"На снимке машины/техника во дворе ({f['zs_cars']:.2f})"))
    if f.get("wb_veg_delta") is not None and f["wb_veg_delta"] <= -0.12 and (f.get("wb_bprob_drop") or 0) < 0.15:
        strong.append((0.8, "Свежие следы использования: участок расчищен на последних снимках"))
    vlm = f.get("vlm") if isinstance(f.get("vlm"), dict) else {}
    if vlm.get("guard_booth") is True:
        strong.append((1.5, "VLM: видна будка охраны/шлагбаум"))
    if vlm.get("vehicles") is True:
        strong.append((0.8, "VLM: видны машины/техника"))
    if vlm.get("signs_of_use") is True:
        strong.append((0.8, "VLM: есть свежие следы использования"))
    if f.get("in_military") and f.get("military_disused"):
        weak.append((0.3, "Бывшая военная территория"))
    if f.get("enclosed_by_fence"):
        weak.append((1.0, "Объект внутри замкнутого забора/стены (OSM barrier)"))
    elif f.get("fence_strong"):
        weak.append((0.8, "Забор или стена ближе 35 м (OSM barrier)"))
    elif f.get("fence_near"):
        weak.append((0.3, "Рядом ограждение (OSM barrier)"))
    if f.get("gates") and not f.get("strong_gate"):
        weak.append((0.4, f"Ворота ({', '.join(f['gates'])}) в {f.get('gate_dist', 0):.0f} м"))
    if vlm.get("fence") is True:
        weak.append((0.6, "VLM: виден забор/периметр"))
    if f.get("in_industrial") and not f.get("industrial_disused"):
        weak.append((0.6, "Действующая промзона (landuse=industrial)"))
    if f.get("in_commercial") or f.get("in_retail"):
        weak.append((0.5, "Коммерческая территория"))
    if f.get("active_neighbours"):
        weak.append((0.4, "Рядом действующие объекты"))
    if f.get("in_settlement") or dense_cluster(f):
        weak.append((0.3, "Рядом жилые дома/участки — есть люди"))

    sc = c.get("score", 0)
    clearly_abandoned = sc >= 0.7 or osm.lifecycle_strength(t)[0] >= 2.2
    k = 0.5 if clearly_abandoned else 1.0
    s_pts = sum(w for w, _ in strong)
    w_pts = sum(w for w, _ in weak) * k
    R = [{"w": round(w, 2), "text": txt} for w, txt in strong] + \
        [{"w": round(w * k, 2), "text": txt + (" (объект заброшен — ограждение могло разрушиться, вес ×0.5)"
                                               if k < 1 else "")} for w, txt in weak]
    total = s_pts + w_pts
    if strong and total >= 2.0:
        return "red", R
    need = 0.6 if (dense_cluster(f) or f.get("in_dacha") or f.get("in_settlement")) else 0.35
    if not strong and w_pts < 1.0 and sc >= need:
        G = []
        if not weak:
            G.append({"w": 0, "text": "Ограждений, ворот и КПП рядом в OSM нет"})
        else:
            G.append({"w": 0, "text": f"Только слабые признаки ограждения (сумма {w_pts:.1f} < 1) — на месте проверьте"})
        if f.get("road_class") in ("track", "path", "footway", "unclassified", "service", "bridleway") or f.get("only_minor_roads_100m"):
            G.append({"w": 0, "text": f"Свободный подъезд ({f.get('road_class')})"})
        if f.get("zs_cars") is not None:
            G.append({"w": 0, "text": "Машин во дворе на снимке не видно"})
        return "green", G + R
    if not R:
        R.append({"w": 0, "text": "Данных об охране нет — по умолчанию «неясно»"})
    elif not strong:
        R.append({"w": 0, "text": "Сильных признаков охраны (КПП, шлагбаум, действующая часть, машины, access=private) нет"})
    else:
        R.append({"w": 0, "text": f"Признаков охраны недостаточно для красного (сумма {total:.1f} < 2)"})
    if sc < need:
        R.append({"w": 0, "text": "Балл заброшенности низкий — статус доступа не уточнялся"})
    return "yellow", R


def confirmation(c) -> tuple[int, list, list]:
    """Independent evidence families that agree that the object is abandoned (and those that contradict).
    'Confirmed' = at least two independent families agree, nothing contradicts, AND the building itself is
    visible/known (canopy alone fools every image model in the same way, so it cannot confirm anything)."""
    f, t = c["f"], c["tags"]
    pos, neg = [], []
    lc = osm.lifecycle_strength(t)[0]
    b = f.get("bprob")
    osm_building = "OSM" in c["sources"] and (t.get("building") or lc > 0)
    visible = b is not None and b >= 0.5
    present = bool(osm_building or visible)
    if lc >= 2.2:
        pos.append("OSM: объект отмечен как заброшенный/руины")
    pa, pb = f.get("pA") if f.get("pA_trained") else None, f.get("pB") if f.get("pB_trained") else None
    neigh = f.get("pA_neigh")
    # All image-based models look at the same picture and fail the same way -> ONE evidence family "снимок".
    vis = []
    if present and pa is not None and pb is not None and pa >= 0.7 and pb >= 0.7 \
            and (neigh is None or pa - neigh >= 0.15):
        vis.append(f"обе нейросети уверены (z17 {pa:.2f}, z18 {pb:.2f}) и объект выделяется среди соседей")
    if c.get("footprint") is not None and (f.get("tree_on") or 0) >= 0.5 and b is not None and b >= 0.3:
        vis.append("крыша видна, но заросла деревьями/кустами")
    if present and (f.get("zs_abandoned") or 0) >= 0.6:
        vis.append("SigLIP видит руины/заброшенность")
    if f.get("image_detected") and (b or 0) >= 0.9 and (f.get("zs_nobuilding") or 1) < 0.4 \
            and not f.get("in_settlement"):
        vis.append("постройка уверенно видна на снимке вне карт")
    if vis:
        pos.append("Снимок: " + ", ".join(vis))
    hist = []
    if (f.get("wb_bprob_drop") or 0) >= 0.3 and (f.get("wb_bprob_old") or 0) >= 0.6:
        hist.append("крыша была и исчезла/разрушилась")
    if (f.get("wb_veg_delta") or 0) >= 0.08 and not f.get("wb_season_mismatch") and c.get("footprint") is not None:
        hist.append("участок зарос")
    if hist:
        pos.append(f"История снимков {f.get('wb_from', '')}→{f.get('wb_to', '')}: " + ", ".join(hist))
    vlm = f.get("vlm") if isinstance(f.get("vlm"), dict) else {}
    if vlm.get("abandoned_probability") is not None:
        if vlm["abandoned_probability"] >= 0.6:
            pos.append(f"VLM: заброшено ({vlm['abandoned_probability']:.2f})")
        elif vlm["abandoned_probability"] <= 0.3:
            neg.append(f"VLM: похоже, используется ({vlm['abandoned_probability']:.2f})")
        if vlm.get("signs_of_use") is True:
            neg.append("VLM: свежие следы использования")
    if (f.get("zs_cars") or 0) >= 0.5:
        neg.append("на снимке машины/техника")
    if f.get("wb_veg_delta") is not None and f["wb_veg_delta"] <= -0.12 and (f.get("wb_bprob_drop") or 0) < 0.15:
        neg.append("участок расчищен на последних снимках")
    if f.get("image_detected") and (f.get("zs_nobuilding") or 0) >= 0.6:
        neg.append("на снимке z18 постройки, скорее, нет")
    if "OSM" not in c["sources"] and "MS Footprints" in c["sources"] and (b if b is not None else 1) < 0.3 and lc == 0:
        neg.append("контур Microsoft не подтверждён детектором")
    if pa is not None and neigh is not None and pa - neigh < 0 and lc == 0:
        neg.append("не выделяется среди соседних построек")
    if not present and lc == 0 and c["kind"] not in ("deadend", "clearing"):
        neg.append("саму постройку на снимке не видно (под деревьями?) — подтвердить по снимку нельзя")
    for k, txt in (("in_park", "парк/сквер — действующая территория"), ("in_museum", "музей/достопримечательность"),
                   ("in_protected", "охраняемая природная территория"), ("in_construction", "стройплощадка")):
        if f.get(k):
            neg.append(txt)
    if t.get("historic") and t.get("historic") not in ("ruins", "fort", "bunker", "military") and lc < 2.2:
        neg.append(f"памятник (historic={t.get('historic')})")
    if dense_cluster(f) and lc == 0 and not (pa is not None and neigh is not None and pa - neigh >= 0.25):
        neg.append("обычный дом в плотной застройке (дачи/посёлок), не выделяется среди соседей")
    return len(pos), pos, neg


NOT_BUILDINGS = {"castle_wall", "wall", "city_wall", "roof", "carport", "bridge", "construction", "grandstand",
                 "ship", "train_station_roof"}


NEVER_TEXT = {
    "kind": "тупик дороги / прогалина — не постройка",
    "not_building": "не здание (стена, навес, крыша над платформой …)",
    "dacha": "в садоводстве (дачи) без тега заброшенности OSM",
    "dense": "в плотной застройке без тега заброшенности OSM",
    "garages": "гаражи",
    "park": "в парке", "museum": "на территории музея/достопримечательности",
    "protected": "в заповеднике/ООПТ", "construction": "на стройплощадке", "cemetery": "на кладбище",
}


def never_reason(c, allow=()):
    """Why the candidate can never become a reliable mark (key of NEVER_TEXT), or None. `allow`: settings
    ('dacha', 'dense') where you gave your own examples — they are searched there too."""
    f, t = c["f"], c["tags"]
    if c["kind"] in ("deadend", "clearing"):
        return "kind"
    if t.get("building") in NOT_BUILDINGS and t.get("building") != "ruins":
        return "not_building"
    if osm.lifecycle_strength(t)[0] >= 2.2 or "military" in t or f.get("in_military"):
        return None
    for k in ("park", "museum", "protected", "construction", "cemetery", "garages"):
        if f.get("in_" + k):
            return k
    if f.get("in_dacha") and "dacha" not in allow:
        return "dacha"
    if dense_cluster(f) and "dense" not in allow:
        return "dense"
    return None


def never_reliable(c) -> bool:
    """Can never become a reliable mark whatever the imagery shows (see reliable()). The fast search mode does not
    spend downloads on such candidates: dachas, garages and dense settlements without an OSM tag, parks, museums,
    protected areas, construction sites, cemeteries, road dead ends and clearings."""
    return never_reason(c) is not None


def promising(c, pa_min=0.5) -> bool:
    """Worth the expensive checks (z18 crop, Wayback) in the fast mode: an OSM lifecycle tag / military object, or the
    z17 classifier already sees something (both classifiers >= 0.7 are needed for a reliable mark without a tag)."""
    if never_reliable(c):
        return False
    f = c["f"]
    if osm.lifecycle_strength(c["tags"])[0] > 0 or "military" in c["tags"] or f.get("in_military"):
        return True
    if not f.get("pA_trained"):
        return True   # no classifier A (no torch / too few examples): cannot judge, keep it
    return (f.get("pA") or 0) >= pa_min


def strong_evidence(c) -> bool:
    """Both trained classifiers agree and the object stands out, the roof vanished between imagery years, or the VLM
    is confident."""
    f = c["f"]
    pa = f.get("pA") if f.get("pA_trained") else None
    pb = f.get("pB") if f.get("pB_trained") else None
    neigh = f.get("pA_neigh")
    if pa is not None and pb is not None and pa >= 0.7 and pb >= 0.7 and (neigh is None or pa - neigh >= 0.15):
        return True
    if (f.get("wb_bprob_drop") or 0) >= 0.3 and (f.get("wb_bprob_old") or 0) >= 0.6:
        return True
    vlm = f.get("vlm") if isinstance(f.get("vlm"), dict) else {}
    return (vlm.get("abandoned_probability") or 0) >= 0.6 and not vlm.get("signs_of_use")


def reliable(c) -> bool:
    """Shown by default ('мало, но верно'): good score AND (two independent sources, or an OSM lifecycle tag on a
    real building) AND nothing contradicts."""
    f, t = c["f"], c["tags"]
    if c.get("score", 0) < 0.5 or f.get("contra"):
        return False
    if t.get("building") in NOT_BUILDINGS:
        return False
    lc = osm.lifecycle_strength(t)[0]
    if (f.get("confirm_n") or 0) >= 2 and lc < 2.2:
        # no OSM tag: dachas and dense settlements are never shown by default, and at least one STRONG signal is
        # required ("overgrown" + "SigLIP" alone also fit a working forest base or an unkempt garden)
        if f.get("in_dacha") or dense_cluster(f) or f.get("in_garages"):
            return False
        return strong_evidence(c)
    if (f.get("confirm_n") or 0) >= 2:
        return True
    return lc >= 2.2 and c["kind"] not in ("deadend", "clearing", "area") and \
        (c.get("footprint") is not None or t.get("historic") == "ruins" or t.get("ruins") or t.get("building"))


def apply(cands, weights=None):
    neighbour_context(cands)
    for c in cands:
        if c["kind"] == "complex":
            continue  # complexes are re-built from their members (complexes.build_complexes)
        c["score"], c["reasons"] = score(c, weights)
        n, pos, neg = confirmation(c)
        c["f"]["confirm_n"] = n if not neg else max(0, n - len(neg))
        c["f"]["confirm"] = pos
        c["f"]["contra"] = neg
        if n >= 2 and not neg:
            # independent agreement is stronger than the (capped) sum suggests
            c["score"] = max(c["score"], min(0.97, c["score"] + 0.1 * (n - 1)))
        c["f"]["reliable"] = reliable(c)
        c["guard"], c["guard_reasons"] = guard_status(c)
