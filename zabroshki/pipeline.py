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
    fast = opts.get("search_mode", "fast") == "fast"
    stage_names = ["Контуры зданий Microsoft и обзор местности", "OSM (Overpass)", "Кандидаты и контекст OSM"]
    if use_img:
        stage_names += ["Снимки: загрузка и сплошной скан"]
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

    scan = None
    wb_thread = None
    t_start = time.time()
    try:
        # 1. footprints + water overview; tiles that are needed anyway start downloading in the background
        stage(stage_names[0])
        fps = footprints.load(poly, job) if opts.get("use_footprints") else []
        stats["ms_footprints"] = len(fps)
        job.info(f"Контуры Microsoft: {len(fps)}")
        if use_img:
            from . import imagery
            scan = imagery.Scanner(poly, lp, opts, job)
            n_bg = scan.prepare(fps, job)
            job.info(f"Тайлов снимка z{scan.z} в области: {len(scan.tiles)}"
                     + (f", открытая вода (пропуск): {len(scan.water)}" if scan.water else "")
                     + f"; {n_bg} из них скачиваются в фоне, пока грузится OSM")

        # 2. OSM
        stage(stage_names[1])
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

        # 3. candidates
        stage(stage_names[2])
        cands, ctx = C.assemble(d, fps, lp, poly, job)
        C.compute_context(cands, ctx, job, failed)
        cands = C.merge_duplicates(cands, lp, opts.get("merge_radius_m", 18))
        _index(cands)
        _rescore(cands, weights)
        save_candidates(run_id, cands, stats=stats)
        job.info(f"Кандидатов после OSM/контуров: {len(cands)}")

        if use_img:
            stage(stage_names[k])
            n_skip = scan.plan(cands)
            if n_skip and fast:
                job.info(f"Быстрый режим: сканируется {len(scan.scan_tiles)} из {len(scan.tiles)} тайлов — только там, "
                         f"где есть постройки, способные стать надёжной меткой (без пустого леса/полей/воды "
                         f"и кварталов дач/плотной застройки без тегов OSM). Поиск построек, которых нет ни на одной "
                         f"карте, и прогалин — в режиме «полный»")
            elif n_skip:
                job.info(f"Открытая вода без построек: не сканируется {n_skip} тайлов")
            new = scan.run(cands, ctx, fps, d)
            if new:
                C.compute_context(new, ctx, job, failed)
                merged = C.merge_duplicates(cands + new, lp, opts.get("merge_radius_m", 18))
                _index(merged, start=max(c.get("idx", 0) for c in cands) + 1 if cands else 0)
                cands = merged
            _rescore(cands, weights)
            n_abs = C.absorb_satellites(cands, lp)
            if n_abs:
                _rescore(cands, weights)
                job.info(f"Объединено точек-дублей с соседними зданиями: {n_abs} — точная проверка пойдёт по разным объектам")
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
            if use_wb:   # collect imagery dates for the likely Wayback set while the z18 check runs
                import threading
                from . import wayback as _wb
                wb_minutes = float(opts.get("wayback_max_minutes_fast", 15) if fast else opts.get("wayback_max_minutes", 40))
                opts["_wb_deadline"] = time.time() + 60 * wb_minutes   # one budget for the background part + stage
                wb_thread = threading.Thread(target=_wb.prefetch_versions,
                                             args=(cands, opts, int(opts.get("scan_zoom", 17)), job.checkpoint,
                                                   opts["_wb_deadline"]),
                                             daemon=True)
                wb_thread.start()
            optional("Точная проверка", stageb.run, job, cands, opts)
            _rescore(cands, weights)
            save_candidates(run_id, cands, stats=stats)

        if use_wb:
            from . import wayback
            stage(stage_names[k])
            # the background date collection is simply continued inside the stage (same cache, same time budget)
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
        n_abs = C.absorb_satellites(cands, lp)
        if n_abs:
            job.info(f"Объединено мелких точек с соседними зданиями: {n_abs} (одна метка на объект)")
        _rescore(cands, weights)
        _mark_similar(cands, opts, job)
        _add_complexes(cands, lp, job)
        keep = opts.get("min_score_keep", 0.03)
        stats["candidates"] = len(cands)
        stats["above_keep"] = sum(1 for c in cands if c["score"] >= keep)
        stats["red"] = sum(1 for c in cands if c["score"] >= keep and c["guard"] == "red")
        stats["green"] = sum(1 for c in cands if c["score"] >= keep and c["guard"] == "green")
        stats["yellow"] = sum(1 for c in cands if c["score"] >= keep and c["guard"] == "yellow")
        stats["confirmed"] = sum(1 for c in cands if c["score"] >= keep and (c["f"].get("confirm_n") or 0) >= 2)
        stats["reliable"] = sum(1 for c in cands if c["f"].get("reliable") and not c["f"].get("complex_key"))
        stats["similar"] = sum(1 for c in cands if c["f"].get("similar"))
        tm = job.timings()
        stats["timings"] = [(n_, round(t_)) for n_, t_ in tm]
        stats["total_s"] = round(time.time() - t_start)
        save_candidates(run_id, cands, status="done", stats=stats)
        job.info("Время поиска: " + _fmt_s(stats["total_s"]) + " — " +
                 "; ".join(f"{n_}: {_fmt_s(t_)}" for n_, t_ in tm if t_ >= 1))
        job.info(f"Итого кандидатов: {stats['above_keep']} (красных {stats['red']}, жёлтых {stats['yellow']}, "
                 f"зелёных {stats['green']}); надёжных объектов (показываются по умолчанию): {stats['reliable']}")
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
    finally:
        if scan is not None:
            scan.close()


def _fmt_s(sec) -> str:
    sec = int(sec)
    if sec >= 3600:
        return f"{sec // 3600} ч {sec % 3600 // 60:02d} мин"
    if sec >= 60:
        return f"{sec // 60} мин {sec % 60:02d} с"
    return f"{sec} с"


def _add_complexes(cands, lp, job=None):
    from .complexes import build_complexes
    start = max((c.get("idx", 0) for c in cands), default=0) + 1
    cx = build_complexes(cands, lp, start)
    cands.extend(cx)
    if job and cx:
        job.info(f"Территорий (комплексов) выделено: {len(cx)} — одна метка и контур на весь объект")


def _mark_similar(cands, opts, job=None):
    try:
        from .training import mark_similar
        n = mark_similar(cands, opts)
        if n and job:
            job.info(f"Похоже на ваши примеры: {n} объектов (≈ на карте) — проверьте и отметьте «Заброшка»/«Не заброшка»")
    except Exception:
        log.exception("mark_similar")


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
        row = db.app_con().execute("SELECT geojson FROM runs WHERE id=?", (rid,)).fetchone()
        try:
            cen = area_from_geojson(db.loads(row["geojson"])).centroid
            lpx = LocalProj(cen.y, cen.x)
            cs[:] = [c for c in cs if c["kind"] != "complex"]
            _rescore(cs, weights)
            C.absorb_satellites(cs, lpx)
            _rescore(cs, weights)
            _mark_similar(cs, _opts({}), job)
            _add_complexes(cs, lpx, job)
        except Exception:
            log.exception("absorb_satellites / complexes")
            _rescore(cs, weights)
        save_candidates(rid, cs)
    return {"runs": list(all_c), "candidates": len(pool)}
