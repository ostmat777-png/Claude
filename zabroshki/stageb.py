"""Stage B: precise check of the top candidates on z18 crops (SigLIP zero-shot + classifier B)."""
from __future__ import annotations

import logging

import numpy as np

from . import db, osm, tiles
from .config import settings

log = logging.getLogger(__name__)
CROP = 384  # px at crop zoom (~110 m at z18, 60°N)


def emb_key(name, provider, z, lat, lon):
    from .models import use_tta
    return f"B|{name}|{provider}|{z}|{'tta|' if use_tta() else ''}{lat:.6f},{lon:.6f}"


def embed_points_B(points, provider=None, z=None, job=None):
    """SigLIP embeddings of crops around points (cached)."""
    from .models import get_siglip
    provider = provider or settings()["imagery_provider"]
    z = z or settings()["crop_zoom"]
    sg = get_siglip()
    keys = [emb_key(sg.name, provider, z, lat, lon) for lat, lon in points]
    have = db.emb_get_many(keys)
    out = [have.get(k) for k in keys]
    todo = [i for i, e in enumerate(out) if e is None]
    if not todo:
        return out
    need = sorted({t for i in todo for t in tiles.tiles_for_crop(z, points[i][1], points[i][0], CROP)})
    tiles.prefetch(provider, z, need, checkpoint=job.checkpoint if job else None,
                   progress=(lambda d, n: job.progress(d, n, f"Снимки z{z}: {d}/{n}")) if job else None)
    new = {}
    B = 32
    for s in range(0, len(todo), B):
        if job:
            job.checkpoint()
            job.progress(s, len(todo), f"SigLIP z{z}: {s}/{len(todo)}")
        idx = todo[s:s + B]
        imgs, ok = [], []
        for i in idx:
            img, valid = tiles.crop_lonlat(provider, z, points[i][1], points[i][0], CROP, fetch=True)
            if valid < 0.3:
                continue
            imgs.append(img)
            ok.append(i)
        if not imgs:
            continue
        from .models import use_tta
        e = sg.image_embeddings(np.stack(imgs), tta=use_tta())
        for i, v in zip(ok, e):
            out[i] = v
            new[keys[i]] = v
    db.emb_put_many(new)
    return out


def select(cands, k, min_score):
    labels_like = [c for c in cands if osm.lifecycle_strength(c["tags"])[0] > 0]
    ranked = sorted([c for c in cands if c["kind"] != "deadend" and c["score"] >= min_score],
                    key=lambda c: -c["score"])[:k]
    seen = {id(c) for c in ranked}
    for c in labels_like:
        if id(c) not in seen and c["kind"] != "deadend":
            ranked.append(c)
            seen.add(id(c))
    return ranked


def run(job, cands, opts):
    from .models import torch_available
    if not torch_available():
        job.info("PyTorch не установлен — точная проверка пропущена")
        return
    k = int(opts.get("stage_b_top_k", 1500))
    sel = select(cands, k, float(opts.get("stage_b_min_score", 0.08)))
    if not sel:
        return
    provider = opts.get("imagery_provider", "esri")
    z = int(opts.get("crop_zoom", 18))
    job.info(f"Точная проверка: {len(sel)} кандидатов на z{z}")
    from .models import get_siglip
    sg = get_siglip()
    embs = embed_points_B([(c["lat"], c["lon"]) for c in sel], provider, z, job)
    ok = [(c, e) for c, e in zip(sel, embs) if e is not None]
    if not ok:
        return
    E = np.stack([e for _, e in ok])
    zs = sg.zero_shot(E)
    for (c, _), pa, pc, pn in zip(ok, zs["abandoned"], zs["cars"], zs["nobuilding"]):
        c["f"]["zs_abandoned"] = round(float(pa), 4)
        c["f"]["zs_cars"] = round(float(pc), 4)
        c["f"]["zs_nobuilding"] = round(float(pn), 4)
        c["stage"] = max(c.get("stage", 1), 2)
    from .training import train_B
    clf = train_B(job, cands, opts, lambda pts: embed_points_B(pts, provider, z, job))
    if clf is not None:
        p = clf.predict_proba(E)[:, 1]
        for (c, _), v in zip(ok, p):
            c["f"]["pB"] = round(float(v), 4)
            c["f"]["pB_trained"] = True


def retrain_B(job, pool, opts):
    from .models import get_siglip
    provider = opts.get("imagery_provider", "esri")
    z = int(opts.get("crop_zoom", 18))
    sg = get_siglip()
    have = db.emb_get_many([emb_key(sg.name, provider, z, c["lat"], c["lon"]) for c in pool])
    from .training import train_B
    clf = train_B(job, pool, opts, lambda pts: embed_points_B(pts, provider, z, job))
    if clf is None:
        return
    rows = [(c, have.get(emb_key(sg.name, provider, z, c["lat"], c["lon"]))) for c in pool]
    rows = [(c, e) for c, e in rows if e is not None]
    if rows:
        p = clf.predict_proba(np.stack([e for _, e in rows]))[:, 1]
        for (c, _), v in zip(rows, p):
            c["f"]["pB"] = round(float(v), 4)
            c["f"]["pB_trained"] = True
