"""Esri World Imagery Wayback: distinct historical versions of a place and year-to-year change features."""
from __future__ import annotations

import json
import logging
import re

import numpy as np

from . import db, net, tiles
from .geo import TILE, lonlat_to_pixel, lonlat_to_tile, meters_per_pixel

log = logging.getLogger(__name__)
CONFIG_URL = "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json"
TILEMAP_URL = "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/{r}/{z}/{y}/{x}"


def releases() -> list[dict]:
    """All Wayback releases, newest first: {release, date, metadata}."""
    raw = db.http_cache_get("wayback_config", 86400)
    if raw is None:
        raw = net.get(CONFIG_URL, timeout=60).content
        db.http_cache_put("wayback_config", raw)
    cfg = json.loads(raw)
    out = []
    for k, v in cfg.items():
        m = re.search(r"(\d{4}-\d{2}-\d{2})", v.get("itemTitle", ""))
        out.append({"release": int(k), "date": m.group(1) if m else "", "metadata": v.get("metadataLayerUrl")})
    out.sort(key=lambda r: r["date"], reverse=True)
    return out


def tilemap(release: int, z: int, x: int, y: int):
    key = f"wbtm:{release}:{z}:{x}:{y}"
    raw = db.http_cache_get(key)
    if raw is None:
        r = net.get(TILEMAP_URL.format(r=release, z=z, x=x, y=y), timeout=30, ok_statuses=(200, 404))
        raw = r.content if r.status_code == 200 else b"{}"
        db.http_cache_put(key, raw)
    try:
        d = json.loads(raw)
    except Exception:
        return False, None
    has = bool(d.get("data") and d["data"][0])
    sel = d.get("select")[0] if d.get("select") else None
    return has, sel


def distinct_versions(z: int, x: int, y: int, max_versions=8) -> list[int]:
    """Release numbers whose imagery differs for this tile, newest first (Esri 'local changes' algorithm)."""
    key = f"wbver:{z}:{x}:{y}:{max_versions}"
    raw = db.http_cache_get(key, 30 * 86400)
    if raw is not None:
        return json.loads(raw)
    rels = releases()
    pos = {r["release"]: i for i, r in enumerate(rels)}
    out = []
    i = 0
    misses = 0
    while i < len(rels) and len(out) < max_versions:
        r = rels[i]["release"]
        has, sel = tilemap(r, z, x, y)
        if has:
            s = sel or r
            if s not in out:
                out.append(s)
            i = max(i, pos.get(s, i)) + 1
            misses = 0
        else:
            misses += 1
            i += 1
            if misses >= 3:
                break
    db.http_cache_put(key, json.dumps(out).encode())
    return out


def capture_date(release: int, lat: float, lon: float, z: int) -> dict:
    """Acquisition date/source from the Wayback metadata service (cached per release and ~1 km cell)."""
    rels = {r["release"]: r for r in releases()}
    info = rels.get(release, {})
    key = f"wbmeta:{release}:{z}:{lat:.2f}:{lon:.2f}"
    raw = db.http_cache_get(key)
    if raw is None:
        res = {"date": None, "src": None, "res": None, "release_date": info.get("date")}
        url = info.get("metadata")
        if url:
            layer = max(0, min(13, 23 - z))
            q = (f"{url}/{layer}/query?geometry={lon},{lat}&geometryType=esriGeometryPoint&inSR=4326"
                 "&spatialRel=esriSpatialRelIntersects&outFields=SRC_DATE,SRC_DATE2,SRC_DESC,SRC_RES"
                 "&returnGeometry=false&f=json")
            try:
                d = net.get(q, timeout=30).json()
                feats = d.get("features") or []
                if feats:
                    a = feats[0]["attributes"]
                    sd = a.get("SRC_DATE")
                    if sd:
                        s = str(sd)
                        res["date"] = f"{s[:4]}-{s[4:6]}-{s[6:8]}" if len(s) >= 8 else s
                    res["src"] = a.get("SRC_DESC")
                    res["res"] = a.get("SRC_RES")
            except Exception as e:
                log.info("wayback metadata failed: %s", e)
        raw = json.dumps(res).encode()
        db.http_cache_put(key, raw)
    return json.loads(raw)


def _summerness(date: str | None) -> int:
    """2 = full leaf (Jun–Aug), 1 = shoulder (May, Sep), 0 = leaf-off / snow season (at ~60°N)."""
    if not date or len(date) < 7:
        return 1
    m = int(date[5:7])
    return 2 if 6 <= m <= 8 else (1 if m in (5, 9) else 0)


def _date(v):
    return v.get("date") or v.get("release_date") or "0000-00-00"


def choose_pair(vers: list[dict]):
    """Pick (new, old): the newest full-leaf image vs the oldest full-leaf image ≥3 years older.
    Falls back to shoulder-season images; returns (new, old, same_season)."""
    if len(vers) < 2:
        return None
    best = max(_summerness(v.get("date")) for v in vers)
    cands_new = [v for v in vers if _summerness(v.get("date")) == best]
    new = max(cands_new, key=_date)
    y_new = int(_date(new)[:4])
    for min_gap in (3, 1):
        olds = [v for v in vers if v is not new and y_new - int(_date(v)[:4]) >= min_gap]
        if olds:
            break
    if not olds:
        return None
    old = min(olds, key=lambda v: (-_summerness(v.get("date")), _date(v)))
    same = _summerness(new.get("date")) == 2 and _summerness(old.get("date")) == 2
    return new, old, same


def _crop_detector(scan, img):
    """Detector probability around the centre + mean token embedding for a crop (needs DINOv2)."""
    if scan is None or scan.dino is None:
        return None, None
    toks, cls = scan.dino.tokens(img[None])
    G = scan.dino.grid
    tk = toks[0]
    c = G // 2
    rad = max(1, G // 16)
    centre = tk[c - rad - 1:c + rad + 1, c - rad - 1:c + rad + 1].reshape(-1, tk.shape[-1])
    bp = None
    if scan.detector is not None:
        bp = float(scan._detect(centre).max())
    emb = tk.reshape(-1, tk.shape[-1]).mean(axis=0)
    emb = emb / (np.linalg.norm(emb) + 1e-6)
    return bp, emb


def run(job, cands, opts, scan):
    from .imagery import crop_features
    k = int(opts.get("wayback_top_k", 400))
    pool = [c for c in cands if c["kind"] not in ("deadend",)]
    pool.sort(key=lambda c: (-(c.get("stage", 1) >= 2), -c["score"]))
    sel = pool[:k]
    if not sel:
        return
    z = int(opts.get("scan_zoom", 17))
    try:
        releases()
    except Exception as e:
        job.info(f"Wayback недоступен: {e}")
        return
    job.info(f"Сравнение по годам: {len(sel)} кандидатов (z{z})")
    by_tile: dict = {}
    for c in sel:
        by_tile.setdefault(lonlat_to_tile(c["lon"], c["lat"], z), []).append(c)
    done = 0
    n_changed = 0
    for (tx, ty), group in by_tile.items():
        job.checkpoint()
        try:
            vers_ids = distinct_versions(z, tx, ty)
        except Exception as e:
            log.info("wayback versions failed: %s", e)
            vers_ids = []
        for c in group:
            done += 1
            job.progress(done, len(sel), f"Wayback: {done}/{len(sel)}")
            if len(vers_ids) < 2:
                c["f"]["wb_versions"] = len(vers_ids)
                continue
            vers = []
            seen_dates = set()
            for r in vers_ids[:8]:
                md = capture_date(r, c["lat"], c["lon"], z)
                d = md.get("date") or ("r" + str(md.get("release_date")))
                if d in seen_dates:
                    continue  # another release, same acquisition at this point
                seen_dates.add(d)
                vers.append({"release": r, "date": md.get("date"), "release_date": md.get("release_date"),
                             "src": md.get("src")})
            pair = choose_pair(vers)
            c["f"]["wb_dates"] = [{"release": v["release"], "date": v.get("date") or ("релиз " + (v.get("release_date") or "?")),
                                   "note": ""} for v in vers]
            c["f"]["wb_versions"] = len(vers)
            if not pair:
                continue
            new, old, same_season = pair
            mpp = meters_per_pixel(c["lat"], z)
            feats = {}
            embs = {}
            for tag, v in (("new", new), ("old", old)):
                prov = f"wayback:{v['release']}"
                img, valid = tiles.crop_lonlat(prov, z, c["lon"], c["lat"], 256, fetch=True)
                if valid < 0.6:
                    feats[tag] = None
                    continue
                cf = crop_features(prov, z, c, mpp, size=256, img=img)
                bp, emb = _crop_detector(scan, img)
                cf["bprob"] = bp
                feats[tag] = cf
                embs[tag] = emb
            fn, fo = feats.get("new"), feats.get("old")
            if not fn or not fo or not fn.get("img_valid") or not fo.get("img_valid"):
                continue
            def g(d, k):
                return d.get(k) if d.get(k) is not None else 0.0
            dv = np.mean([g(fn, "tree_on") - g(fo, "tree_on"), g(fn, "tree_ring") - g(fo, "tree_ring"),
                          g(fn, "veg_yard") - g(fo, "veg_yard")])
            f = c["f"]
            if not same_season:
                dv *= 0.4  # leaf-on vs leaf-off differences are mostly seasonal
            f["wb_season_mismatch"] = not same_season
            f["wb_veg_delta"] = round(float(dv), 3)
            f["wb_from"] = old.get("date") or old.get("release_date")
            f["wb_to"] = new.get("date") or new.get("release_date")
            if fn.get("bprob") is not None and fo.get("bprob") is not None:
                f["wb_bprob_old"] = round(fo["bprob"], 3)
                f["wb_bprob_new"] = round(fn["bprob"], 3)
                f["wb_bprob_drop"] = round(fo["bprob"] - fn["bprob"], 3)
            if embs.get("new") is not None and embs.get("old") is not None:
                cos = float(embs["new"] @ embs["old"])
                f["wb_cos"] = round(cos, 3)
                f["wb_change"] = round(float(np.clip((0.97 - cos) / 0.25, 0, 1)), 3)
            for d in f["wb_dates"]:
                if d["release"] == new["release"]:
                    d["note"] = "сравнение: новый"
                elif d["release"] == old["release"]:
                    d["note"] = "сравнение: старый"
            c["stage"] = max(c.get("stage", 1), 3)
            n_changed += 1
    job.info(f"Wayback: пары снимков сравнены у {n_changed} из {len(sel)}")
