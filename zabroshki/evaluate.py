"""Quality report: recall on examples/positives.csv and a blind proxy test on OSM-tagged abandoned objects.

    python -m zabroshki evaluate [--run RUN_ID]
"""
from __future__ import annotations

import copy
import math
import time

import numpy as np
from shapely.geometry import Point

from . import db, osm, scoring
from .config import DATA_DIR
from .geo import area_from_geojson
from .pipeline import load_candidates
from .training import _fit, build_training_points, load_meta_weights, read_positives, save_eval

MATCH_M = 40.0


def _dist(a, b):
    return math.hypot((a["lat"] - b["lat"]) * 110574, (a["lon"] - b["lon"]) * 111320 * math.cos(math.radians(a["lat"])))


def why_hidden(c, allow=()):
    """Plain-language answer to "why is this object not on the map in the default view"."""
    f = c["f"]
    if f.get("reliable"):
        return "показан: надёжная метка"
    if f.get("similar"):
        return "показан: ≈ похоже на ваши примеры"
    out = []
    r = scoring.never_reason(c, allow)
    if r:
        out.append(scoring.NEVER_TEXT[r])
    if f.get("contra"):
        out.append("противоречие: " + f["contra"][0])
    if c["score"] < 0.5:
        out.append(f"балл {c['score']:.2f} < 0,50")
    if f.get("pA") is None and c["kind"] not in ("deadend", "clearing"):
        out.append("снимок здесь не сканировался (быстрый режим)")
    elif osm.lifecycle_strength(c["tags"])[0] < 2.2 and not scoring.strong_evidence(c):
        out.append("нет тега OSM и сильного признака на снимке")
    if f.get("pU") is not None:
        out.append(f"сходство с вашими примерами {f['pU']:.2f}")
    return "скрыт: " + ("; ".join(out) or "не прошёл правило надёжной метки")


def _strip_osm(c):
    """Copy of a candidate without OSM lifecycle evidence (as if the object were not tagged)."""
    c2 = copy.deepcopy(c)
    c2["tags"] = {k: v for k, v in c2["tags"].items() if not osm.is_lifecycle({k: v})
                  and k not in ("abandoned", "disused", "ruins")}
    if c2["tags"].get("building") in ("ruins", "collapsed", "damaged", "abandoned"):
        c2["tags"]["building"] = "yes"
    c2.pop("parent_lifecycle", None)
    c2["f"].pop("parent_lifecycle", None)
    c2["f"]["military_disused"] = False
    if c2["kind"] == "ruins":
        c2["kind"] = "building"
    return c2


def _cv_pA(cands, opts_neg=None):
    """Out-of-fold classifier-A probabilities, so OSM weak positives are never scored by a model that saw them."""
    from .training import _model_meta
    meta = _model_meta("clfA")
    if not meta:
        return None
    keys = [f"A|{meta['dino']}|{meta['size']}|{meta['provider']}|{meta['z']}|{c['lat']:.6f},{c['lon']:.6f}" for c in cands]
    store = db.emb_get_many(keys)
    if not store:
        return None
    pts, _ = build_training_points(cands, {"use_osm_weak_positives": True, "min_negatives": 80, "negatives_per_positive": 6})
    tkeys = [f"A|{meta['dino']}|{meta['size']}|{meta['provider']}|{meta['z']}|{p[0]:.6f},{p[1]:.6f}" for p in pts]
    tstore = db.emb_get_many(tkeys)
    rows = [(i, tstore.get(k)) for i, k in enumerate(tkeys)]
    rows = [(i, e) for i, e in rows if e is not None]
    if len(rows) < 20:
        return None
    X = np.stack([e for _, e in rows])
    y = np.array([pts[i][2] for i, _ in rows])
    w = np.array([pts[i][3] for i, _ in rows])
    if y.sum() < 4:
        return None
    from sklearn.model_selection import StratifiedKFold
    oof = {}
    for tr, te in StratifiedKFold(5, shuffle=True, random_state=1).split(X, y):
        m = _fit(X[tr], y[tr], w[tr])
        p = m.predict_proba(X[te])[:, 1]
        for j, v in zip(te, p):
            oof[tkeys[rows[j][0]]] = float(v)
    full = _fit(X, y, w)
    out = {}
    have = [(k, e) for k, e in store.items()]
    if have:
        P = full.predict_proba(np.stack([e for _, e in have]))[:, 1]
        for (k, _), v in zip(have, P):
            out[k] = float(v)
    out.update(oof)
    return [out.get(key) for key in keys]


def proxy_eval(cands, weights):
    """Blind test: OSM 'abandoned/ruins/disused' objects ranked with their OSM tags hidden."""
    prox = [c for c in cands if osm.lifecycle_strength(c["tags"])[0] >= 2.2 and c["kind"] not in ("deadend", "area")]
    if len(prox) < 3:
        return None, []
    oof = _cv_pA(cands)
    oof_list = oof
    blind = []
    for i, c in enumerate(cands):
        c2 = _strip_osm(c)
        if oof_list is not None:
            v = oof_list[i]
            if v is not None:
                c2["f"]["pA"] = v
                c2["f"]["pA_trained"] = True
        # classifier B was trained with OSM weak positives in-sample: drop it for the blind test
        c2["f"].pop("pB", None)
        c2["f"].pop("pB_trained", None)
        s, _ = scoring.score(c2, weights)
        blind.append(s)
    blind = np.array(blind)
    is_p = np.array([osm.lifecycle_strength(c["tags"])[0] >= 2.2 and c["kind"] not in ("deadend", "area") for c in cands])
    order = np.argsort(-blind)
    rank = np.empty(len(order), int)
    rank[order] = np.arange(1, len(order) + 1)
    from sklearn.metrics import roc_auc_score
    auc = roc_auc_score(is_p, blind) if 0 < is_p.sum() < len(is_p) else None
    n = len(cands)
    res = {"n_candidates": n, "n_osm_abandoned": int(is_p.sum()), "auc": None if auc is None else round(float(auc), 3)}
    for k in (50, 100, 200, 500, 1000):
        if k < n:
            res[f"recall@top{k}"] = round(float((rank[is_p] <= k).mean()), 3)
    for t in (0.1, 0.25, 0.5):
        res[f"recall@score≥{t}"] = round(float((blind[is_p] >= t).mean()), 3)
        res[f"share_of_all@score≥{t}"] = round(float((blind >= t).mean()), 3)
    res["median_rank_percent"] = round(float(np.median(rank[is_p]) / n * 100), 1)
    detail = sorted([(int(rank[i]), round(float(blind[i]), 3), cands[i]) for i in np.nonzero(is_p)[0]], key=lambda t: t[0])
    return res, detail


def positives_eval(cands, run_poly):
    pos = read_positives()
    # objects the user marked on the map as abandoned (e.g. ones the search missed) are examples too
    for r in db.app_con().execute("SELECT lat, lon, note FROM labels WHERE label=1 AND candidate_id IS NULL"):
        pos.append({"lat": r["lat"], "lon": r["lon"], "comment": r["note"] or "отметка на карте"})
    if not pos:
        return None, []
    order = sorted(range(len(cands)), key=lambda i: -cands[i]["score"])
    rank = {order[k]: k + 1 for k in range(len(order))}
    rows = []
    for p in pos:
        inside = run_poly is None or run_poly.buffer(0.0005).contains(Point(p["lon"], p["lat"]))
        best, bd = None, MATCH_M
        for i, c in enumerate(cands):
            if abs(c["lat"] - p["lat"]) > 0.001 or abs(c["lon"] - p["lon"]) > 0.002:
                continue
            d = _dist(p, c)
            # prefer the best scored candidate within the radius
            if d <= MATCH_M and (best is None or c["score"] > cands[best]["score"]):
                best, bd = i, d
        if best is None:  # inside the outline of a found territory/building counts as found
            pt = Point(p["lon"], p["lat"])
            for i, c in enumerate(cands):
                fp = c.get("footprint")
                if fp is not None and abs(c["lat"] - p["lat"]) < 0.01 and fp.buffer(0.0002).contains(pt):
                    if best is None or c["score"] > cands[best]["score"]:
                        best, bd = i, 0.0
        rows.append((p, inside, best, bd))
    inside_rows = [r for r in rows if r[1]]
    n = len(inside_rows)
    if n == 0:
        return {"n": len(pos), "in_area": 0}, rows
    found = [r for r in inside_rows if r[2] is not None]
    sc = [cands[r[2]]["score"] for r in found]
    rk = [rank[r[2]] for r in found]
    res = {"n": len(pos), "in_area": n, "found_as_candidate": round(len(found) / n, 3)}
    for t in (0.1, 0.25, 0.5):
        res[f"recall@score≥{t}"] = round(sum(1 for s in sc if s >= t) / n, 3)
    for k in (50, 100, 200, 500):
        res[f"recall@top{k}"] = round(sum(1 for r in rk if r <= k) / n, 3)
    res["median_rank"] = int(np.median(rk)) if rk else None
    return res, rows


def run_job(job, run_id=None):
    job.set_stage(1, 1, "Оценка качества")
    main(run_id, quiet=True)
    return {"run_id": run_id}


def main(run_id=None, quiet=False):
    con = db.app_con()
    if run_id is None:
        r = con.execute("SELECT id FROM runs WHERE status='done' ORDER BY id DESC LIMIT 1").fetchone()
        if r is None:
            print("Нет завершённых запусков")
            return 1
        run_id = r["id"]
    run = con.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    poly = area_from_geojson(db.loads(run["geojson"]))
    cands = load_candidates(run_id)
    weights = load_meta_weights()
    lines = [f"# Оценка качества — запуск #{run_id} ({run['name']})", "",
             f"Дата: {time.strftime('%Y-%m-%d %H:%M')}. Кандидатов в запуске: {len(cands)}.", ""]
    pres, prow = positives_eval(cands, poly)
    lines.append("## Ваши примеры (examples/positives.csv)")
    if pres is None:
        lines.append("Файл пуст или отсутствует — добавьте свои заброшки (широта, долгота, комментарий).")
    else:
        lines.append("| метрика | значение |\n|---|---|")
        for k, v in pres.items():
            lines.append(f"| {k} | {v} |")
        lines.append("")
        lines.append("| # | координаты | комментарий | в области | найден | балл | место | цвет | на карте? | главные причины |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|")
        from .training import example_settings
        allow = example_settings(cands)
        order = sorted(range(len(cands)), key=lambda i: -cands[i]["score"])
        rank = {order[k]: k + 1 for k in range(len(order))}
        for j, (p, inside, best, d) in enumerate(prow, 1):
            if best is None:
                why = ("нет ни в OSM, ни в контурах Microsoft — такие постройки ищутся только в режиме поиска «полный»"
                       if inside else "вне области поиска")
                lines.append(f"| {j} | {p['lat']:.5f}, {p['lon']:.5f} | {p['comment']} | {'да' if inside else 'нет'} | нет | — | — | — | {why} | — |")
            else:
                c = cands[best]
                rs = "; ".join(r["text"] for r in sorted(scoring.score(c, weights)[1], key=lambda r: -r["w"])[:3])
                lines.append(f"| {j} | {p['lat']:.5f}, {p['lon']:.5f} | {p['comment']} | {'да' if inside else 'нет'} | "
                             f"да ({d:.0f} м) | {c['score']:.2f} | {rank[best]} | {c['guard']} | {why_hidden(c, allow)} | {rs} |")
    lines.append("")
    res, detail = proxy_eval(cands, weights)
    lines.append("## Слепой тест на объектах OSM с тегами заброшенности")
    lines.append("Теги abandoned/ruins/disused скрыты от модели, классификатор A пересчитан по фолдам (без утечки), "
                 "классификатор B не используется. Показывает, нашла бы программа эти объекты только по снимкам и контексту.")
    if res is None:
        lines.append("Мало объектов с такими тегами в области.")
    else:
        lines.append("| метрика | значение |\n|---|---|")
        for k, v in res.items():
            lines.append(f"| {k} | {v} |")
        lines.append("")
        lines.append("| место | слепой балл | тип | объект | признаки (без OSM-тега) |")
        lines.append("|---|---|---|---|---|")
        for rk, s, c in detail[:40]:
            c2 = _strip_osm(c)
            c2["f"].pop("pB", None)
            c2["f"].pop("pB_trained", None)
            _, rs = scoring.score(c2, weights)
            lines.append(f"| {rk} | {s:.2f} | {c['kind']} | {c['title'] or c['key']} | "
                         f"{'; '.join(r['text'] for r in rs if r['w'] > 0)[:160]} |")
    text = "\n".join(lines)
    out = DATA_DIR / f"eval_run{run_id}.md"
    out.write_text(text, encoding="utf-8")
    summary = []
    if pres and pres.get("in_area"):
        summary.append(f"ваши примеры: найдено {pres['found_as_candidate'] * 100:.0f}%, балл≥0.25 у {pres['recall@score≥0.25'] * 100:.0f}%")
    if res:
        summary.append(f"слепой тест OSM: AUC {res['auc']}, медианное место {res['median_rank_percent']}% списка")
    save_eval("; ".join(summary) or "нет данных", {"positives": pres, "proxy": res, "run": run_id})
    if not quiet:
        print(text)
        print(f"\nОтчёт сохранён: {out}")
    return 0
