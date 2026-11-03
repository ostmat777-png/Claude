"""Search pipeline orchestration (multi-stage, resumable via caches)."""
from __future__ import annotations

import logging
import time

from shapely.geometry import mapping, shape

from . import candidates as C
from . import db, footprints, osm, scoring
from .config import settings
from .geo import LocalProj, area_from_geojson, polygon_area_km2

log = logging.getLogger(__name__)

ID_STRIDE = 10_000_000


def create_run(geojson, area_id=None, name=None, options=None) -> int:
    poly = area_from_geojson(geojson)
    name = name or f"{poly.centroid.y:.3f}, {poly.centroid.x:.3f} · {polygon_area_km2(poly):.1f} км²"
    cur = db.write(db.app_con(),
                   "INSERT INTO runs(area_id, name, geojson, status, started, params, stats) VALUES(?,?,?,?,?,?,?)",
                   (area_id, name, db.dumps(geojson), "running", time.time(), db.dumps(options or {}), "{}"))
    return cur.lastrowid


def _opts(run_params: dict) -> dict:
    o = dict(settings().data)
    for k, v in (run_params or {}).items():
        if v is not None and v != "":
            o[k] = v
    if isinstance(o.get("use_vlm"), str) and o["use_vlm"] in ("true", "false"):
        o["use_vlm"] = o["use_vlm"] == "true"
    return o


# ---------------------------------------------------------------- persistence
def save_candidates(run_id: int, cands: list, status=None, stats=None):
    con = db.app_con()
    keep_min = 0.0
    rows = []
    now = time.time()
    for c in cands:
        if c["score"] < keep_min:
            continue
        fp = mapping(c["footprint"]) if c.get("footprint") is not None else None
        f = dict(c["f"])
        f["key"] = c["key"]
        if c.get("parent_lifecycle"):
            f["parent_lifecycle"] = c["parent_lifecycle"]
        if c.get("parent_tags"):
            f["parent_tags"] = c["parent_tags"]
        rows.append((run_id * ID_STRIDE + c["idx"], run_id, c["lat"], c["lon"], c["kind"], c["title"],
                     db.dumps(fp) if fp else None, db.dumps(sorted(c["sources"])), db.dumps(c["tags"]),
                     db.dumps(f), float(c["score"]), db.dumps(c["reasons"]), c["guard"],
                     db.dumps(c["guard_reasons"]), int(c.get("stage", 1)), now))
    with db._write_lock:
        con.execute("DELETE FROM candidates WHERE run_id=?", (run_id,))
        con.executemany("INSERT INTO candidates(id, run_id, lat, lon, kind, title, footprint, sources, tags, features,"
                        " score, reasons, guard, guard_reasons, stage, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        rows)
        if status or stats is not None:
            sets, params = [], []
            if status:
                sets.append("status=?")
                params.append(status)
                if status in ("done", "error", "cancelled"):
                    sets.append("finished=?")
                    params.append(time.time())
            if stats is not None:
                sets.append("stats=?")
                params.append(db.dumps(stats))
            con.execute(f"UPDATE runs SET {', '.join(sets)} WHERE id=?", params + [run_id])
        con.commit()


def load_candidates(run_id: int) -> list:
    rows = db.app_con().execute("SELECT * FROM candidates WHERE run_id=? ORDER BY id", (run_id,)).fetchall()
    out = []
    for r in rows:
        f = db.loads(r["features"], {})
        fp = db.loads(r["footprint"])
        c = C.new_candidate(f.pop("key", f"db:{r['id']}"), r["lat"], r["lon"], r["kind"], r["title"],
                            shape(fp) if fp else None, db.loads(r["sources"], []), db.loads(r["tags"], {}))
        c["f"] = f
        c["idx"] = r["id"] % ID_STRIDE
        c["id"] = r["id"]
        c["score"] = r["score"]
        c["stage"] = r["stage"]
        if f.get("parent_lifecycle"):
            c["parent_lifecycle"] = f["parent_lifecycle"]
        if f.get("parent_tags"):
            c["parent_tags"] = f["parent_tags"]
        out.append(c)
    return out


def _set_status(run_id, status, stats=None):
    con = db.app_con()
    if stats is None:
        db.write(con, "UPDATE runs SET status=?, finished=? WHERE id=?", (status, time.time(), run_id))
    else:
        db.write(con, "UPDATE runs SET status=?, finished=?, stats=? WHERE id=?",
                 (status, time.time(), db.dumps(stats), run_id))


def _index(cands, start=0):
    for i, c in enumerate(cands):
        if "idx" not in c:
            c["idx"] = start + i


def _rescore(cands, weights=None):
    scoring.apply(cands, weights)


# ---------------------------------------------------------------- main search
def run_search(job, run_id: int):
    row = db.app_con().execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    gj = db.loads(row["geojson"])
    opts = _opts(db.loads(row["params"], {}))
    poly = area_from_geojson(gj)
    cen = poly.centroid
    lp = LocalProj(cen.y, cen.x)
    stats = {"area_km2": round(polygon_area_km2(poly), 3)}
    use_img = bool(opts.get("use_imagery"))
    use_models = bool(opts.get("use_models")) and use_img
    use_wb = bool(opts.get("use_wayback")) and use_img
    vlm_opt = opts.get("use_vlm", "auto")
    stage_names = ["OSM (Overpass)", "Контуры зданий Microsoft", "Кандидаты и контекст OSM"]
    if use_img:
        stage_names += ["Снимки: загрузка тайлов", "Снимки: сплошной скан"]
    if use_models:
        stage_names += ["Модель: обучение на примерах", "Точная проверка (z18, SigLIP)"]
    if use_wb:
        stage_names += ["Сравнение по годам (Wayback)"]
    if vlm_opt and use_img:
        stage_names += ["Уточнение VLM (Ollama)"]
    stage_names += ["Итог: балл и статус охраны"]
    n = len(stage_names)
    k = 0

    def stage(name):
        nonlocal k
        k += 1
        job.set_stage(k, n, name)

    weights = None
    try:
        from .training import load_meta_weights
        weights = load_meta_weights()
    except Exception:
        weights = None

    try:
        # 1. OSM
        stage(stage_names[0])
        try:
            els, failed = osm.fetch_area(poly, job)
        except Exception as e:
            job.info(f"OSM недоступен: {e}. Продолжаю без OSM.")
            els, failed = [], ["all"]
        d = osm.parse(els)
        d.failed = failed
        stats["osm_elements"] = len(els)
        stats["osm_failed"] = failed
        job.info(f"OSM: зданий {len(d.buildings)}, lifecycle {len(d.lifecycle)}, военных {len(d.military)}, "
                 f"дорог {len(d.highways)}, ограждений {len(d.barriers_line) + len(d.barriers_node)}")

        # 2. footprints
        stage(stage_names[1])
        fps = footprints.load(poly, job) if opts.get("use_footprints") else []
        stats["ms_footprints"] = len(fps)
        job.info(f"Контуры Microsoft: {len(fps)}")

        # 3. candidates
        stage(stage_names[2])
        cands, ctx = C.assemble(d, fps, lp, poly, job)
        C.compute_context(cands, ctx, job)
        cands = C.merge_duplicates(cands, lp, opts.get("merge_radius_m", 18))
        _index(cands)
        _rescore(cands, weights)
        save_candidates(run_id, cands, stats=stats)
        job.info(f"Кандидатов после OSM/контуров: {len(cands)}")

        scan = None
        if use_img:
            from . import imagery
            stage(stage_names[k])
            scan = imagery.Scanner(poly, lp, opts, job)
            scan.download()
            stage(stage_names[k])
            new = scan.run(cands, ctx, fps, d)
            if new:
                C.compute_context(new, ctx, job)
                merged = C.merge_duplicates(cands + new, lp, opts.get("merge_radius_m", 18))
                _index(merged, start=max(c.get("idx", 0) for c in cands) + 1 if cands else 0)
                cands = merged
            _rescore(cands, weights)
            stats.update(scan.stats)
            save_candidates(run_id, cands, stats=stats)

        def optional(title, fn, *a, **kw):
            """Optional refinement stages must not kill the whole search (network hiccups etc.)."""
            from .jobs import Cancelled
            try:
                fn(*a, **kw)
            except Cancelled:
                raise
            except Exception as ex:
                log.exception(title)
                job.info(f"{title}: ошибка ({type(ex).__name__}: {ex}) — этап пропущен, поиск продолжается")
                stats.setdefault("stage_errors", []).append(title)

        if use_models:
            from . import stageb, training
            stage(stage_names[k])
            optional("Классификатор A", training.train_and_score_A, job, cands, opts, scan)
            _rescore(cands, weights)
            save_candidates(run_id, cands, stats=stats)
            stage(stage_names[k])
            optional("Точная проверка", stageb.run, job, cands, opts)
            _rescore(cands, weights)
            save_candidates(run_id, cands, stats=stats)

        if use_wb:
            from . import wayback
            stage(stage_names[k])
            optional("Wayback", wayback.run, job, cands, opts, scan)
            _rescore(cands, weights)
            save_candidates(run_id, cands, stats=stats)

        if vlm_opt and use_img:
            from . import vlm
            stage(stage_names[k])
            optional("VLM", vlm.run, job, cands, opts, force=(vlm_opt is True))
            _rescore(cands, weights)

        stage(stage_names[-1])
        _rescore(cands, weights)
        keep = opts.get("min_score_keep", 0.03)
        stats["candidates"] = len(cands)
        stats["above_keep"] = sum(1 for c in cands if c["score"] >= keep)
        stats["red"] = sum(1 for c in cands if c["score"] >= keep and c["guard"] == "red")
        stats["green"] = sum(1 for c in cands if c["score"] >= keep and c["guard"] == "green")
        stats["yellow"] = sum(1 for c in cands if c["score"] >= keep and c["guard"] == "yellow")
        save_candidates(run_id, cands, status="done", stats=stats)
        job.info(f"Итого кандидатов: {stats['above_keep']} (красных {stats['red']}, жёлтых {stats['yellow']}, "
                 f"зелёных {stats['green']})")
        return stats
    except Exception as e:
        from .jobs import Cancelled
        st = "cancelled" if isinstance(e, Cancelled) else "error"
        try:
            if "cands" in locals() and cands:
                _rescore(cands, weights)
                save_candidates(run_id, cands, status=st, stats=stats)
            else:
                _set_status(run_id, st, stats)
        except Exception:
            log.exception("save on error failed")
        raise


def run_retrain(job, run_id=None):
    """Retrain classifiers (examples + labels), re-weight the evidence and re-rank the run(s)."""
    from . import training
    job.set_stage(1, 3, "Дообучение классификаторов")
    rows = db.app_con().execute("SELECT id FROM runs ORDER BY id DESC").fetchall()
    run_ids = [run_id] if run_id else [r["id"] for r in rows[:1]]
    all_c = {rid: load_candidates(rid) for rid in run_ids if rid}
    pool = [c for cs in all_c.values() for c in cs]
    opts = _opts({})
    training.retrain(job, pool, opts)
    job.set_stage(2, 3, "Подбор весов признаков по отметкам")
    weights = training.fit_meta_weights(job, pool)
    job.set_stage(3, 3, "Пересчёт ранжирования")
    for rid, cs in all_c.items():
        _rescore(cs, weights)
        save_candidates(rid, cs)
    return {"runs": list(all_c), "candidates": len(pool)}
