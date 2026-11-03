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
def _num(s):
    s = str(s).strip().replace(",", ".")
    return float(s)


def read_points_csv(path) -> list[dict]:
    """Robust reader: columns lat/lon (or широта/долгота) + comment; ',' ';' or tab; decimal comma ok."""
    if not path.exists():
        return []
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1251", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    if not lines:
        return []
    sample = "\n".join(lines[:5])
    delim = ";" if sample.count(";") > sample.count(",") / 3 and ";" in sample else ("\t" if "\t" in sample else ",")
    rows = list(csv.reader(io.StringIO("\n".join(lines)), delimiter=delim))
    out = []
    header = [h.strip().lower() for h in rows[0]]

    def find(names):
        for i, h in enumerate(header):
            if any(n == h or h.startswith(n) for n in names):
                return i
        return None
    ilat = find(["lat", "широта", "latitude", "y"])
    ilon = find(["lon", "lng", "долгота", "longitude", "x"])
    start = 1
    if ilat is None or ilon is None:  # no header -> first two numeric columns
        ilat, ilon, start = 0, 1, 0
    icom = None
    for i in range(len(header)):
        if i not in (ilat, ilon):
            icom = i
            break
    if start == 0:
        icom = 2
    for r in rows[start:]:
        try:
            lat, lon = _num(r[ilat]), _num(r[ilon])
        except (ValueError, IndexError):
            # "60,71","28,75" written with comma decimals and comma delimiter -> 4 fields
            try:
                lat, lon = _num(r[0] + "." + r[1]), _num(r[2] + "." + r[3])
            except Exception:
                continue
        if abs(lat) > 90 and abs(lon) <= 90:
            lat, lon = lon, lat
        com = r[icom].strip() if icom is not None and icom < len(r) else ""
        out.append({"lat": lat, "lon": lon, "comment": com})
    return out


def read_positives():
    return read_points_csv(POS_CSV)


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
    return obj


def model_status():
    from .models import device_info
    labels = all_labels()
    st = {
        "positives_csv": len(read_positives()),
        "positives_csv_path": str(POS_CSV),
        "labels_pos": sum(1 for l in labels if l["label"] == 1),
        "labels_neg": sum(1 for l in labels if l["label"] == 0),
        "labels_since_train": labels_since_train(),
        "device": device_info(),
        "models": {},
    }
    for name, title in (("clfA", "Классификатор A (z17, DINOv2)"), ("clfB", "Классификатор B (z18, SigLIP)"),
                        ("meta_weights", "Веса признаков")):
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


def build_training_points(cands, opts, rng=None):
    """Returns list of (lat, lon, y, weight, source)."""
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
    pool = [c for c in cands
            if c["kind"] in ("house", "building", "industrial", "farm")
            and (c["f"].get("in_settlement") or c["f"].get("in_dacha"))
            and not osm.is_lifecycle(c["tags"]) and not c.get("parent_lifecycle")
            and not c["f"].get("in_military")]
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
    pts, n_real = build_training_points(cands, opts)
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
            if any(s.embedding(c) is not None for c in pool):
                train_and_score_A(job, pool, opts, s)
            from . import stageb
            stageb.retrain_B(job, pool, opts)
        except Exception as e:
            log.exception("retrain")
            job.info(f"Дообучение классификаторов не удалось: {e}")
    else:
        job.info("PyTorch недоступен — переобучаются только веса признаков")


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
    _save_model("meta_weights", weights, {"desc": desc})
    job.info("Веса признаков: " + desc)
    return weights


def save_eval(summary: str, details: dict):
    _save_model("eval", details, {"summary": summary})
