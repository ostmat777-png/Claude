"""Examples (positives.csv), automatic negatives, user labels, classifiers A/B and meta-weights."""
from __future__ import annotations

import csv
import io
import logging
import math
import pickle
import random
import time

import numpy as np

from . import db, osm, scoring
from .config import EXAMPLES_DIR

log = logging.getLogger(__name__)
POS_CSV = EXAMPLES_DIR / "positives.csv"
NEG_CSV = EXAMPLES_DIR / "negatives.csv"   # optional, same format


# ------------------------------------------------------------------ examples
import re  # noqa: E402

_DEC = re.compile(r"-?\d{1,3}[.,]\d{2,}")
_DMS = re.compile(r"(\d{1,3})\s*[°º]\s*(\d{1,2})?\s*['′’]?\s*(\d{1,2}(?:[.,]\d+)?)?\s*[\"″”]?\s*([NSEWСЮВЗ])", re.I)


def _num(s):
    s = str(s).strip().replace(",", ".")
    return float(s)


def _find_file(path):
    """positives.csv, or what Notepad/Excel often makes of it (positives.csv.txt, positives.txt …)."""
    if path.exists():
        return path
    stem = path.stem.lower()
    if path.parent.exists():
        for p in sorted(path.parent.iterdir()):
            n = p.name.lower()
            if p.is_file() and (n.startswith(stem + ".") or n == stem) and n.endswith((".csv", ".txt", ".tsv")):
                return p
    return path


def _parse_line(line: str):
    """(lat, lon, comment) from almost any way of writing coordinates, or None."""
    t = line.strip().strip("﻿")
    m = list(_DMS.finditer(t))
    if len(m) >= 2:
        vals = {}
        for g in m[:2]:
            v = float(g.group(1)) + float(g.group(2) or 0) / 60 + _num(g.group(3) or 0) / 3600
            h = g.group(4).upper()
            if h in ("S", "Ю", "W", "З"):
                v = -v
            vals["lat" if h in ("N", "S", "С", "Ю") else "lon"] = v
        if "lat" in vals and "lon" in vals:
            com = t[m[1].end():].strip(" ,;\t")
            return vals["lat"], vals["lon"], com
    nums = list(_DEC.finditer(t))
    if len(nums) < 2:
        return None
    a, b = _num(nums[0].group()), _num(nums[1].group())
    low = t.lower()
    if "ll=" in low or "pt=" in low or "yandex" in low:   # Yandex links write lon,lat
        a, b = b, a
    if abs(a) > 90 and abs(b) <= 90:
        a, b = b, a
    if abs(a) > 90 or abs(b) > 180:
        return None
    rest = t[nums[1].end():]
    if "http" in low:
        rest = ""
    com = re.sub(r"^[\s,;\t]+", "", rest).strip().strip('"')
    return a, b, com


def read_points_csv(path, report: list | None = None) -> list[dict]:
    """Robust reader: one object per line — decimal degrees separated by comma/semicolon/tab/space (decimal point or
    comma), degrees-minutes-seconds (60°42'44"N 28°44'44"E), links from Google/Yandex maps; optional header
    (lat/lon, широта/долгота; a header with lon before lat swaps the columns) and comment. Lines that could not be
    read are added to `report` as (line number, text)."""
    path = _find_file(path)
    if not path.exists():
        return []
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1251", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    out = []
    swap = False
    for i, ln in enumerate(text.splitlines(), start=1):
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        low = s.lower()
        if not _DEC.search(s) and not _DMS.search(s):
            hdr = [h.strip() for h in re.split(r"[,;\t]", low)]
            ilat = next((k for k, h in enumerate(hdr) if h.startswith(("lat", "широта", "y"))), None)
            ilon = next((k for k, h in enumerate(hdr) if h.startswith(("lon", "lng", "долгота", "x"))), None)
            if ilat is not None and ilon is not None:
                swap = ilon < ilat
                continue
            if report is not None:
                report.append((i, s[:80]))
            continue
        r = _parse_line(s)
        if r is None:
            if report is not None:
                report.append((i, s[:80]))
            continue
        lat, lon, com = r
        if swap and "http" not in low:
            lat, lon = lon, lat
        out.append({"lat": lat, "lon": lon, "comment": com})
    return out


def read_positives(report=None):
    return read_points_csv(POS_CSV, report)


def user_examples():
    """Your own examples: positives.csv + map marks 'Заброшка' / negatives.csv + marks 'Не заброшка'."""
    labels = all_labels()
    pos = [{"lat": p["lat"], "lon": p["lon"], "comment": p.get("comment") or "пример из файла"} for p in read_positives()]
    pos += [{"lat": l["lat"], "lon": l["lon"], "comment": l.get("note") or "ваша отметка"} for l in labels if l["label"] == 1]
    neg = [{"lat": p["lat"], "lon": p["lon"]} for p in read_points_csv(NEG_CSV)]
    neg += [{"lat": l["lat"], "lon": l["lon"]} for l in labels if l["label"] == 0]
    return pos, neg


# ------------------------------------------------------------------ labels
def set_label(cid: int, label, note=None):
    con = db.app_con()
    r = con.execute("SELECT id, run_id, lat, lon, features FROM candidates WHERE id=?", (cid,)).fetchone()
    if r is None:
        raise ValueError("candidate not found")
    lat, lon = r["lat"], r["lon"]
    dlat = 15 / 110574
    dlon = 15 / (111320 * math.cos(math.radians(lat)))
    with db._write_lock:
        con.execute("DELETE FROM labels WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                    (lat - dlat, lat + dlat, lon - dlon, lon + dlon))
        if label in (0, 1, True, False):
            con.execute("INSERT INTO labels(lat, lon, label, note, run_id, candidate_id, features, ts) VALUES(?,?,?,?,?,?,?,?)",
                        (lat, lon, int(label), note, r["run_id"], cid, r["features"], time.time()))
        con.commit()
    return {"ok": True, "label": label, "labels_since_train": labels_since_train()}


def all_labels():
    return [dict(r) for r in db.app_con().execute("SELECT * FROM labels").fetchall()]


def labels_since_train():
    meta = _model_meta("clfA")
    t = meta.get("ts", 0) if meta else 0
    return db.app_con().execute("SELECT COUNT(*) FROM labels WHERE ts>?", (t,)).fetchone()[0]


# ------------------------------------------------------------------ model storage
def _save_model(name, obj, meta):
    meta = dict(meta)
    meta["ts"] = time.time()
    db.write(db.app_con(), "INSERT OR REPLACE INTO models(name, data, meta, ts) VALUES(?,?,?,?)",
             (name, pickle.dumps(obj), db.dumps(meta), time.time()))


def _load_model(name):
    r = db.app_con().execute("SELECT data, meta FROM models WHERE name=?", (name,)).fetchone()
    if r is None:
        return None, None
    try:
        return pickle.loads(r["data"]), db.loads(r["meta"], {})
    except Exception:
        return None, None


def _model_meta(name):
    r = db.app_con().execute("SELECT meta FROM models WHERE name=?", (name,)).fetchone()
    return db.loads(r["meta"], {}) if r else None


def load_meta_weights():
    obj, meta = _load_model("meta_weights")
    if obj is None or (meta or {}).get("version") != scoring.SCORING_VERSION:
        return None  # learned for an older evidence model
    return obj


def model_status():
    from .models import device_info
    labels = all_labels()
    bad: list = []
    st = {
        "positives_csv": len(read_positives(bad)),
        "positives_csv_path": str(_find_file(POS_CSV)),
        "positives_bad": bad[:8],
        "positives_bad_n": len(bad),
        "negatives_csv": len(read_points_csv(NEG_CSV)),
        "labels_pos": sum(1 for l in labels if l["label"] == 1),
        "labels_neg": sum(1 for l in labels if l["label"] == 0),
        "labels_since_train": labels_since_train(),
        "device": device_info(),
        "models": {},
    }
    for name, title in (("clfA", "Классификатор A (z17, DINOv2)"), ("clfB", "Классификатор B (z18, SigLIP)"),
                        ("clfU", "Похоже на ваши примеры"), ("meta_weights", "Веса признаков")):
        meta = _model_meta(name)
        if meta:
            desc = meta.get("desc") or ""
            st["models"][title] = f"{desc} · {time.strftime('%d.%m %H:%M', time.localtime(meta.get('ts', 0)))}"
        else:
            st["models"][title] = "не обучен (будет обучен при поиске)"
    ev = _model_meta("eval")
    if ev:
        st["metrics"] = ev.get("summary")
    return st


# ------------------------------------------------------------------ training sets
def _near(lat, lon, items, radius_m):
    best, bd = None, radius_m
    for it in items:
        d = math.hypot((it["lat"] - lat) * 110574, (it["lon"] - lon) * 111320 * math.cos(math.radians(lat)))
        if d <= bd:
            best, bd = it, d
    return best


def build_training_points(cands, opts, rng=None, neg_ok=None):
    """Returns list of (lat, lon, y, weight, source). neg_ok(c): automatic negatives only among these candidates
    (e.g. ones whose image embedding is already computed, so training needs no extra downloads)."""
    rng = rng or random.Random(7)
    pts = []
    pos = read_positives()
    for p in pos:
        pts.append((p["lat"], p["lon"], 1, 2.0, "csv"))
    for p in read_points_csv(NEG_CSV):
        pts.append((p["lat"], p["lon"], 0, 2.0, "csv_neg"))
    labels = all_labels()
    for l in labels:
        pts.append((l["lat"], l["lon"], int(l["label"]), 3.0, "label"))
    n_pos = sum(1 for p in pts if p[2] == 1)
    if opts.get("use_osm_weak_positives", True):
        weak = [c for c in cands if osm.lifecycle_strength(c["tags"])[0] >= 2.2 and c["kind"] not in ("deadend", "area")]
        rng.shuffle(weak)
        for c in weak[:300]:
            pts.append((c["lat"], c["lon"], 1, 1.0, "osm_weak"))
    n_pos_all = sum(1 for p in pts if p[2] == 1)
    # automatic negatives: random ordinary houses in settlements / dachas
    labeled_pos = [{"lat": p[0], "lon": p[1]} for p in pts if p[2] == 1]
    # "Ordinary buildings of the region": any mapped building (OSM or Microsoft footprint) without
    # lifecycle tags — in towns, dachas AND in the countryside. Taking negatives only from settlements
    # teaches the classifier "not a settlement = abandoned" instead of what an abandoned building looks like.
    pool = [c for c in cands
            if c["kind"] in ("house", "building", "industrial", "farm", "unmapped")
            and c.get("footprint") is not None
            and not osm.is_lifecycle(c["tags"]) and not c.get("parent_lifecycle")
            and not c["f"].get("in_military")]
    if neg_ok is not None:
        pref = [c for c in pool if neg_ok(c)]
        if len(pref) >= opts.get("min_negatives", 80):
            pool = pref
    rng.shuffle(pool)
    n_neg = max(opts.get("min_negatives", 80), opts.get("negatives_per_positive", 6) * n_pos_all)
    # Match the negatives' tree-cover distribution to the positives', otherwise the classifier simply
    # learns "trees around = abandoned" (abandoned objects are more often in green surroundings).
    def tbin(c):
        v = c["f"].get("forest_100m")
        if v is None:
            v = c["f"].get("tree_ring")
        return None if v is None else min(3, int(v * 4))
    by_ll = {(round(c["lat"], 6), round(c["lon"], 6)): c for c in cands}
    pos_bins = [tbin(by_ll[(round(p[0], 6), round(p[1], 6))]) for p in pts
                if p[2] == 1 and (round(p[0], 6), round(p[1], 6)) in by_ll]
    pos_bins = [b for b in pos_bins if b is not None]
    quota = None
    if len(pos_bins) >= 5:
        quota = {b: max(1, int(round(n_neg * pos_bins.count(b) / len(pos_bins)))) for b in range(4)}
    added = 0
    taken = {b: 0 for b in range(4)}
    rest = []
    for c in pool:
        if added >= n_neg:
            break
        if _near(c["lat"], c["lon"], labeled_pos, 30):
            continue
        b = tbin(c)
        if quota is not None and b is not None:
            if taken[b] >= quota[b]:
                rest.append(c)
                continue
            taken[b] += 1
        pts.append((c["lat"], c["lon"], 0, 1.0, "auto_neg"))
        added += 1
    for c in rest:  # fill up if some bins had too few houses
        if added >= n_neg:
            break
        pts.append((c["lat"], c["lon"], 0, 1.0, "auto_neg"))
        added += 1
    return pts, n_pos


def _fit(X, y, w):
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    clf = make_pipeline(StandardScaler(), LogisticRegression(C=0.05, class_weight="balanced", max_iter=3000))
    clf.fit(X, y, logisticregression__sample_weight=w)
    return clf


def _cv_metrics(X, y, w, src):
    """Cross-validated AUC and recall of real (csv/label) positives in the top 20% of scores."""
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import StratifiedKFold
    n_pos = int(y.sum())
    if n_pos < 4 or (len(y) - n_pos) < 4:
        return None
    k = min(5, n_pos)
    p = np.zeros(len(y))
    for tr, te in StratifiedKFold(k, shuffle=True, random_state=0).split(X, y):
        if len(set(y[tr])) < 2:
            continue
        p[te] = _fit(X[tr], y[tr], w[tr]).predict_proba(X[te])[:, 1]
    auc = roc_auc_score(y, p)
    thr = np.quantile(p, 0.8)
    real = np.array([s in ("csv", "label") for s in src]) & (y == 1)
    rec = float((p[real] >= thr).mean()) if real.any() else None
    return {"auc": round(float(auc), 3), "recall_top20_real": None if rec is None else round(rec, 3),
            "n_pos": n_pos, "n_neg": int(len(y) - n_pos)}


def train_and_score_A(job, cands, opts, scan):
    """Classifier A on DINOv2 embeddings (scan zoom). Positives: csv + labels + OSM weak; negatives: auto."""
    if scan is None or not scan.use_models:
        job.info("Классификатор A пропущен (нет эмбеддингов)")
        return
    from .imagery import embed_points_A
    pts, n_real = build_training_points(cands, opts, neg_ok=lambda c: scan.embedding(c) is not None)
    if sum(1 for p in pts if p[2] == 1) < 3:
        job.info("Положительных примеров < 3 — классификатор A не обучается (работают эвристики и zero-shot)")
        return
    job.info(f"Обучение A: позитивов {sum(1 for p in pts if p[2] == 1)} (из них ваших/отметок {n_real}), "
             f"негативов {sum(1 for p in pts if p[2] == 0)}")
    embs = embed_points_A([(p[0], p[1]) for p in pts], scan.provider, scan.z, job)
    keep = [i for i, e in enumerate(embs) if e is not None]
    X = np.stack([embs[i] for i in keep])
    y = np.array([pts[i][2] for i in keep])
    w = np.array([pts[i][3] for i in keep])
    src = [pts[i][4] for i in keep]
    met = _cv_metrics(X, y, w, src)
    clf = _fit(X, y, w)
    desc = f"поз. {int(y.sum())}, нег. {int(len(y) - y.sum())}" + (f", CV AUC {met['auc']}" if met else "")
    _save_model("clfA", clf, {"desc": desc, "metrics": met, "dino": scan.dino.name, "size": scan.dino.size,
                              "provider": scan.provider, "z": scan.z})
    job.info("Классификатор A: " + desc)
    _score_A(cands, clf, scan)
    try:
        train_and_score_U(job, cands, opts, scan)
    except Exception as e:  # optional
        from .jobs import Cancelled
        if isinstance(e, Cancelled):
            raise
        log.exception("classifier U")


def _score_A(cands, clf, scan):
    keys, rows = [], []
    for c in cands:
        e = scan.embedding(c) if scan is not None else None
        if e is not None:
            keys.append(c)
            rows.append(e)
    if not rows:
        return
    p = clf.predict_proba(np.stack(rows))[:, 1]
    for c, v in zip(keys, p):
        c["f"]["pA"] = round(float(v), 4)
        c["f"]["pA_trained"] = True


# ------------------------------------------------------------------ "similar to your examples"
def example_settings(cands, pos=None) -> set:
    """Settings ('dacha', 'dense', …) of the candidates your positive examples point at."""
    pos = user_examples()[0] if pos is None else pos
    out = set()
    if not pos:
        return out
    grid: dict = {}
    for c in cands:
        grid.setdefault((round(c["lat"], 3), round(c["lon"], 3)), []).append(c)
    for p in pos:
        best, bd = None, 40.0
        for dl in (-0.001, 0, 0.001):
            for dn in (-0.001, 0, 0.001):
                for c in grid.get((round(p["lat"] + dl, 3), round(p["lon"] + dn, 3)), ()):
                    d = math.hypot((c["lat"] - p["lat"]) * 110574, (c["lon"] - p["lon"]) * 55660)
                    if d < bd and c["kind"] not in ("deadend", "clearing", "complex"):
                        best, bd = c, d
        if best is not None:
            f = best["f"]
            if f.get("in_dacha"):
                out.add("dacha")
            if scoring.dense_cluster(f):
                out.add("dense")
    return out


def train_and_score_U(job, cands, opts, scan):
    """Classifier U: ONLY your examples (positives.csv + marks 'Заброшка') against ordinary buildings and your
    'Не заброшка' — no OSM-tagged ruins, which otherwise outnumber your 20 examples 10:1. Gives f['pU']."""
    from .imagery import embed_points_A
    for c in cands:
        c["f"].pop("pU", None)
    pos, _ = user_examples()
    if len(pos) < 3:
        return None
    o = dict(opts, use_osm_weak_positives=False, negatives_per_positive=10, min_negatives=150)
    pts, n_real = build_training_points(cands, o, neg_ok=lambda c: scan.embedding(c) is not None)
    embs = embed_points_A([(p[0], p[1]) for p in pts], scan.provider, scan.z, job)
    keep = [i for i, e in enumerate(embs) if e is not None]
    y = np.array([pts[i][2] for i in keep])
    if y.sum() < 3 or (len(y) - y.sum()) < 10:
        return None
    X = np.stack([embs[i] for i in keep])
    w = np.array([pts[i][3] for i in keep])
    met = _cv_metrics(X, y, w, [pts[i][4] for i in keep])
    clf = _fit(X, y, w)
    desc = f"ваших примеров {int(y.sum())}, обычных зданий {int(len(y) - y.sum())}" + \
        (f", CV AUC {met['auc']}" if met else "")
    _save_model("clfU", clf, {"desc": desc, "metrics": met})
    job.info("Модель «похоже на ваши примеры»: " + desc)
    rows = [(c, scan.embedding(c)) for c in cands]
    rows = [(c, e) for c, e in rows if e is not None]
    if rows:
        p = clf.predict_proba(np.stack([e for _, e in rows]))[:, 1]
        for (c, _), v in zip(rows, p):
            c["f"]["pU"] = round(float(v), 4)
    return clf


def mark_similar(cands, opts=None) -> int:
    """f['similar'] for the best candidates "like your examples" (shown by default with '≈', for you to check).
    Ranking: how much the object stands out from the buildings around it BOTH by similarity to your examples
    (classifier U) AND by the general abandonment classifier A. Similarity alone mostly finds "a big city building
    like yours" (tested on Vyborg: 5 of 40 real abandoned objects; with the relative pair: 19 of 40).
    Skipped: objects already shown as reliable, your own examples, places you marked 'Не заброшка', parks/museums/
    construction sites…, dachas and dense blocks unless your examples are there too."""
    from .config import settings
    opts = opts or settings().data
    for c in cands:
        c["f"].pop("similar", None)
    pos, neg = user_examples()
    if len(pos) < 3:
        return 0
    allow = example_settings(cands, pos)
    k = int(opts.get("similar_top_k", 40))
    thr = float(opts.get("similar_min", 0.5))
    blds = [c for c in cands if c["f"].get("pU") is not None and c["kind"] not in ("deadend", "clearing", "complex")]
    if not blds:
        return 0
    L = scoring._logit
    reg: dict = {}
    for c in blds:
        reg.setdefault(scoring._ctx_class(c["f"]), []).append(c["f"]["pU"])
    reg = {kk: float(np.median(v)) for kk, v in reg.items()}
    kx = 111320.0 * math.cos(math.radians(blds[0]["lat"]))
    grid: dict = {}
    for c in blds:
        grid.setdefault((int(c["lon"] * kx // 250), int(c["lat"] * 110574 // 250)), []).append(c)
    pool = []
    for c in blds:
        f = c["f"]
        if f["pU"] < thr or f.get("reliable") or scoring.never_reason(c, allow) is not None:
            continue
        # must be checked on the image and contradiction-free: building visible, no cars, not cleared …
        if not f.get("img_valid") or f.get("contra") or (f.get("bprob") is not None and f["bprob"] < 0.3) \
                or (f.get("zs_cars") or 0) >= 0.5:
            continue
        if _near(c["lat"], c["lon"], pos, 40) is not None or _near(c["lat"], c["lon"], neg, 40) is not None:
            continue
        x, y = c["lon"] * kx, c["lat"] * 110574
        gx, gy = int(x // 250), int(y // 250)
        v = [o["f"]["pU"] for dx in (-1, 0, 1) for dy in (-1, 0, 1) for o in grid.get((gx + dx, gy + dy), ())
             if o is not c and (o["lon"] * kx - x) ** 2 + (o["lat"] * 110574 - y) ** 2 <= 250 ** 2]
        un = float(np.median(v)) if len(v) >= 6 else reg.get(scoring._ctx_class(f), 0.05)
        pa = f.get("pA") if f.get("pA_trained") else None
        rel_a = (L(pa) - L(f.get("pA_neigh") or 0.05)) if pa is not None else 0.0
        rank = (L(f["pU"]) - L(un)) + rel_a
        if rank > 0:
            pool.append((rank, c))
    pool.sort(key=lambda t: -t[0])
    for _, c in pool[:k]:
        c["f"]["similar"] = c["f"]["pU"]
    return min(k, len(pool))


def train_B(job, cands, opts, embed_fn):
    """Classifier B on SigLIP embeddings of z18 crops."""
    pts, n_real = build_training_points(cands, opts)
    if sum(1 for p in pts if p[2] == 1) < 3:
        return None
    embs = embed_fn([(p[0], p[1]) for p in pts])
    keep = [i for i, e in enumerate(embs) if e is not None]
    if len(keep) < 10:
        return None
    X = np.stack([embs[i] for i in keep])
    y = np.array([pts[i][2] for i in keep])
    w = np.array([pts[i][3] for i in keep])
    if len(set(y)) < 2:
        return None
    met = _cv_metrics(X, y, w, [pts[i][4] for i in keep])
    clf = _fit(X, y, w)
    desc = f"поз. {int(y.sum())}, нег. {int(len(y) - y.sum())}" + (f", CV AUC {met['auc']}" if met else "")
    _save_model("clfB", clf, {"desc": desc, "metrics": met})
    if job:
        job.info("Классификатор B: " + desc)
    return clf


# ------------------------------------------------------------------ retrain (button)
def retrain(job, pool, opts):
    """Re-fit A and B from stored embeddings (no downloads unless new example points need them)."""
    from .models import torch_available
    if not pool:
        job.info("Нет кандидатов для пересчёта")
        return
    metaA = _model_meta("clfA") or {}
    provider = metaA.get("provider", opts.get("imagery_provider", "esri"))
    z = metaA.get("z", opts.get("scan_zoom", 17))
    if torch_available():

        class _S:  # minimal scan-like adapter around stored embeddings
            use_models = True

            def __init__(self):
                from .models import get_dino
                self.dino = get_dino()
                self.provider, self.z = provider, z
                keys = [self.key(c) for c in pool]
                self.store = db.emb_get_many(keys)

            def key(self, c):
                return f"A|{self.dino.name}|{self.dino.size}|{self.provider}|{self.z}|{c['lat']:.6f},{c['lon']:.6f}"

            def embedding(self, c):
                return self.store.get(self.key(c))
        try:
            s = _S()
            _embed_like_examples(job, pool, opts, s)
            if any(s.embedding(c) is not None for c in pool):
                train_and_score_A(job, pool, opts, s)
            from . import stageb
            stageb.retrain_B(job, pool, opts)
        except Exception as e:
            log.exception("retrain")
            job.info(f"Дообучение классификаторов не удалось: {e}")
    else:
        job.info("PyTorch недоступен — переобучаются только веса признаков")


def _embed_like_examples(job, pool, opts, s):
    """Fast-mode runs have no image embeddings for dachas / dense blocks. If your examples are there, fetch the
    missing ones (capped) so 'similar to your examples' can look there too."""
    pos, _ = user_examples()
    if len(pos) < 3:
        return
    allow = example_settings(pool, pos)
    if not allow:
        return
    from .geo import lonlat_to_tile
    from .imagery import embed_points_A
    miss = [c for c in pool if c.get("footprint") is not None and s.embedding(c) is None
            and c["kind"] not in ("deadend", "clearing", "complex") and scoring.never_reason(c, allow) is None]
    if not miss:
        return
    cap = int(opts.get("retrain_embed_tiles", 3000))
    tiles_seen: set = set()
    take = []
    for c in sorted(miss, key=lambda c: -c["score"]):
        t = lonlat_to_tile(c["lon"], c["lat"], s.z)
        if t not in tiles_seen and len(tiles_seen) >= cap:
            continue
        tiles_seen.add(t)
        take.append(c)
    job.info(f"Ваши примеры есть в местах, которые быстрый поиск пропускал ({', '.join(sorted(allow))}) — "
             f"докачиваю снимки для {len(take)} построек ({len(tiles_seen)} тайлов)")
    embed_points_A([(c["lat"], c["lon"]) for c in take], s.provider, s.z, job)
    s.store = db.emb_get_many([s.key(c) for c in pool])


def fit_meta_weights(job, pool):
    """Adjust evidence weights from user labels (+ matched CSV positives): ridge-regularised towards defaults."""
    from scipy.optimize import minimize
    labels = all_labels()
    pos = read_positives()
    data = []
    for c in pool:
        lb = _near(c["lat"], c["lon"], labels, 15)
        if lb is not None:
            data.append((c, int(lb["label"]), 3.0))
            continue
        if _near(c["lat"], c["lon"], pos, 25) is not None:
            data.append((c, 1, 1.5))
    n1 = sum(1 for d in data if d[1] == 1)
    n0 = sum(1 for d in data if d[1] == 0)
    current = load_meta_weights() or {}
    if n1 < 3 or n0 < 3:
        job.info(f"Для подбора весов нужно ≥3 отметок каждого класса (сейчас {n1} «заброшка», {n0} «не заброшка») — "
                 "веса не меняются")
        return current or None
    names = list(scoring.DEFAULT_WEIGHTS)
    prior = np.array([scoring.DEFAULT_WEIGHTS[k] for k in names])
    X = np.zeros((len(data), len(names)))
    y = np.zeros(len(data))
    sw = np.zeros(len(data))
    for i, (c, lab, wt) in enumerate(data):
        xv = scoring.feature_vector(c)
        X[i, 0] = 1.0
        for j, k in enumerate(names[1:], start=1):
            if k in xv:
                X[i, j] = xv[k][0]
        y[i] = lab
        sw[i] = wt
    # balance classes
    sw[y == 1] *= len(y) / (2 * max(1, n1))
    sw[y == 0] *= len(y) / (2 * max(1, n0))
    lam = 4.0

    def loss(wv):
        zz = X @ wv
        ll = np.logaddexp(0, -zz) * y + np.logaddexp(0, zz) * (1 - y)
        return float((sw * ll).sum() + lam * ((wv - prior) ** 2).sum())

    def grad(wv):
        zz = X @ wv
        p = 1 / (1 + np.exp(-zz))
        return X.T @ (sw * (p - y)) + 2 * lam * (wv - prior)
    res = minimize(loss, prior.copy(), jac=grad, method="L-BFGS-B")
    wv = res.x
    weights = {k: round(float(v), 3) for k, v in zip(names, wv)}
    changed = sorted(((k, weights[k] - scoring.DEFAULT_WEIGHTS[k]) for k in names), key=lambda t: -abs(t[1]))[:5]
    desc = f"по {n1}+{n0} отметкам; сильнее всего изменены: " + ", ".join(f"{k} {d:+.2f}" for k, d in changed)
    _save_model("meta_weights", weights, {"desc": desc, "version": scoring.SCORING_VERSION})
    job.info("Веса признаков: " + desc)
    return weights


def save_eval(summary: str, details: dict):
    _save_model("eval", details, {"summary": summary})
