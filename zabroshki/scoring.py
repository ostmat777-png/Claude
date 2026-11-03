"""Evidence -> score (log-odds sum with human readable reasons) and guard status."""
from __future__ import annotations

import math

from . import osm

DEFAULT_WEIGHTS = {
    "bias": -3.0,
    "osm_lifecycle": 3.0,
    "military_ctx": 0.6,
    "military_disused": 1.5,
    "outside": 1.0,
    "dacha": 0.2,
    "settlement": -0.5,
    "farm": 0.6,
    "industrial": 0.3,
    "unmapped": 0.3,
    "far_from_roads": 0.5,
    "minor_access": 0.3,
    "dead_end": 0.4,
    "road_abandoned": 0.6,
    "isolated": 0.3,
    "active_neighbours": -0.8,
    "forest": 1.0,
    "overgrowth": 0.35,
    "tree_on_roof": 1.0,
    "bprob_low": 0.6,
    "clearing": 0.5,
    "image_detected": 0.3,
    "clfA": 0.45,
    "zs": 0.3,
    "zs_cars": -0.8,
    "clfB": 0.45,
    "wb_veg": 0.6,
    "wb_roof": 0.8,
    "wb_change": 0.4,
    "vlm": 0.7,
    "kind_deadend": -0.6,
    "kind_clearing": -0.3,
}


def _logit(p, lo=-4.0, hi=4.0):
    p = min(max(float(p), 1e-4), 1 - 1e-4)
    return max(lo, min(hi, math.log(p / (1 - p))))


def _clip(x, lo, hi):
    return max(lo, min(hi, x))


def feature_vector(c) -> dict:
    """Numeric evidence x_k (same names as weights) + text for each."""
    f = c["f"]
    t = c["tags"]
    x: dict[str, tuple[float, str]] = {}
    lc, why = osm.lifecycle_strength(t)
    plc = c.get("parent_lifecycle", 0.0) or f.get("parent_lifecycle", 0.0)
    if plc and plc * 0.7 > lc:
        lc, why = plc * 0.7, "Внутри территории с OSM-тегом заброшенности (" + _ptags(c) + ")"
    if lc:
        x["osm_lifecycle"] = (lc / 3.0, why)
    if f.get("in_military"):
        if f.get("military_disused"):
            x["military_disused"] = (1.0, "Бывшая военная территория (OSM)")
        else:
            x["military_ctx"] = (1.0, "Военная территория/объект в OSM " + " ".join(f.get("military_tags") or []))
    if f.get("outside_settlement"):
        x["outside"] = (1.0, "Вне населённых пунктов и садоводств")
    elif f.get("in_dacha"):
        x["dacha"] = (1.0, "В садоводстве (дачи)")
    if f.get("in_settlement"):
        x["settlement"] = (1.0, "В населённом пункте" + (f" ({f['near_place_name']})" if f.get("near_place_name") else ""))
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
    if f.get("tree_on") is not None and f["tree_on"] >= 0.15 and c.get("footprint") is not None \
            and c["kind"] not in ("deadend", "clearing"):
        x["tree_on_roof"] = (_clip((f["tree_on"] - 0.15) / 0.5, 0, 1),
                             f"Растительность поверх контура здания ({f['tree_on'] * 100:.0f}%) — крыша разрушена/заросла")
    if f.get("bprob") is not None and c.get("footprint") is not None and f.get("detector_ok"):
        b = f["bprob"]
        if b < 0.35:
            x["bprob_low"] = (_clip((0.35 - b) / 0.35, 0, 1), f"На снимке крыша почти не читается (детектор {b:.2f})")
    if f.get("on_clearing") or c["kind"] == "clearing":
        x["clearing"] = (1.0, "Прогалина в лесу" + (f" ~{f['clearing_area_m2']:.0f} м²" if f.get("clearing_area_m2") else ""))
    if f.get("image_detected") and "OSM" not in c["sources"]:
        x["image_detected"] = (1.0, "Постройка распознана на снимке")
    if f.get("pA") is not None and f.get("pA_trained"):
        x["clfA"] = (_logit(f["pA"]), f"Классификатор по снимку z17: {f['pA']:.2f}")
    # ---- stage B
    if f.get("zs_abandoned") is not None:
        x["zs"] = (_logit(f["zs_abandoned"], -3, 3), f"SigLIP: «заброшено/руины» {f['zs_abandoned']:.2f}")
    if f.get("zs_cars") is not None and f["zs_cars"] >= 0.3:
        x["zs_cars"] = (f["zs_cars"], f"SigLIP: машины/техника во дворе {f['zs_cars']:.2f}")
    if f.get("pB") is not None and f.get("pB_trained"):
        x["clfB"] = (_logit(f["pB"]), f"Классификатор по снимку z18: {f['pB']:.2f}")
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
        x["kind_clearing"] = (1.0, "Только прогалина (постройка не подтверждена)")
    return x


def _ptags(c):
    pt = c.get("parent_tags") or {}
    keys = [k for k in pt if osm.is_lifecycle({k: pt[k]})]
    return ", ".join(f"{k}={pt[k]}" for k in keys[:2]) or "территория"


# Correlated evidence (several detectors that all react to "lots of trees", several image models)
# must not be summed as if independent: each group's total contribution is capped.
GROUPS = {
    "image_models": (("clfA", "clfB", "zs", "vlm"), 2.4),
    "vegetation": (("forest", "overgrowth", "tree_on_roof", "bprob_low"), 1.8),
    "remoteness": (("outside", "far_from_roads", "minor_access", "dead_end", "isolated", "road_abandoned"), 1.8),
    "history": (("wb_veg", "wb_roof", "wb_change"), 2.0),
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
                        notes[k] = " (сумма коррелирующих признаков ограничена)"
    z = W["bias"] + sum(contrib.values())
    reasons = []
    for name, (val, text) in x.items():
        reasons.append({"w": round(contrib[name], 2), "text": text + notes.get(name, ""), "k": name})
    reasons.sort(key=lambda r: -abs(r["w"]))
    p = 1 / (1 + math.exp(-z))
    return p, reasons


# ------------------------------------------------------------------------- guard
def guard_status(c) -> tuple[str, list]:
    f = c["f"]
    t = c["tags"]
    pts = 0.0
    R = []

    def red(w, text):
        nonlocal pts
        pts += w
        R.append({"w": w, "text": text})

    if f.get("in_military"):
        if f.get("military_disused"):
            red(0.5, "Бывшая военная территория — может охраняться")
        else:
            red(2.0, "Военная территория по OSM " + " ".join(f.get("military_tags") or []))
    acc = t.get("access") or f.get("access")
    if acc in ("private", "no", "military", "permit"):
        red(1.5, f"Доступ ограничен: access={acc}")
    if f.get("enclosed_by_fence"):
        red(1.5, "Объект внутри замкнутого забора/стены (OSM barrier)")
    elif f.get("fence_strong"):
        red(1.0, "Забор или стена ближе 35 м (OSM barrier)")
    elif f.get("fence_near"):
        red(0.4, "Рядом ограждение (OSM barrier)")
    if f.get("guardhouse"):
        red(2.0, f"Будка охраны/КПП в {f.get('guardhouse_dist', 0):.0f} м")
    if f.get("strong_gate"):
        red(1.2, f"Шлагбаум/КПП в {f.get('gate_dist', 0):.0f} м")
    elif f.get("gates"):
        red(0.6, f"Ворота ({', '.join(f['gates'])}) в {f.get('gate_dist', 0):.0f} м")
    if f.get("in_industrial") and not f.get("industrial_disused"):
        red(0.8, "Действующая промзона (landuse=industrial)")
    if f.get("in_commercial") or f.get("in_retail"):
        red(0.6, "Коммерческая территория")
    if f.get("active_neighbours"):
        red(0.5, "Рядом действующие объекты")
    if f.get("in_settlement"):
        red(0.3, "В населённом пункте — рядом жильцы")
    if f.get("zs_cars") is not None and f["zs_cars"] >= 0.5:
        red(1.0, f"На снимке машины/техника во дворе ({f['zs_cars']:.2f})")
    if f.get("wb_veg_delta") is not None and f["wb_veg_delta"] <= -0.12 and (f.get("wb_bprob_drop") or 0) < 0.15:
        red(0.8, "Свежие следы использования: участок расчищен на последних снимках")
    vlm = f.get("vlm") if isinstance(f.get("vlm"), dict) else {}
    for k, w, text in (("vehicles", 0.8, "VLM: видны машины/техника"), ("fence", 0.8, "VLM: виден забор/периметр"),
                       ("guard_booth", 1.5, "VLM: видна будка охраны/шлагбаум"),
                       ("signs_of_use", 0.8, "VLM: есть свежие следы использования")):
        if vlm.get(k) is True:
            red(w, text)

    if pts >= 2.0:
        return "red", R
    abandoned_evidence = (c.get("score", 0) >= 0.35)
    no_barrier = not (f.get("fence_near") or f.get("gates") or f.get("guardhouse") or f.get("enclosed_by_fence"))
    if pts < 0.6 and abandoned_evidence and no_barrier:
        G = [{"w": 0, "text": "Ограждений, ворот и КПП рядом в OSM нет"}]
        if f.get("road_class") in ("track", "path", "footway", "unclassified", "service", "bridleway") or f.get("only_minor_roads_100m"):
            G.append({"w": 0, "text": f"Свободный подъезд ({f.get('road_class')})"})
        if f.get("zs_cars") is not None:
            G.append({"w": 0, "text": "Машин во дворе на снимке не видно"})
        if f.get("tree_on") and f["tree_on"] > 0.15 or (f.get("veg_rel") or 0) > 0.5 or (f.get("wb_veg_delta") or 0) > 0.05:
            G.append({"w": 0, "text": "Нет признаков использования: зарастание"})
        return "green", G + R
    if not R:
        R.append({"w": 0, "text": "Данных об охране нет — по умолчанию «неясно»"})
    elif pts < 2.0:
        R.append({"w": 0, "text": f"Признаков охраны недостаточно для красного (сумма {pts:.1f} < 2)"})
    if not abandoned_evidence:
        R.append({"w": 0, "text": "Балл заброшенности низкий — статус доступа не уточнялся"})
    return "yellow", R


def apply(cands, weights=None):
    for c in cands:
        c["score"], c["reasons"] = score(c, weights)
        c["guard"], c["guard_reasons"] = guard_status(c)
