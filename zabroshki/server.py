"""Local HTTP API + static UI (served to the desktop window)."""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import db, tiles
from .config import DATA_DIR, STATIC_DIR, settings
from .jobs import Job, manager

log = logging.getLogger(__name__)
app = FastAPI(title="Zabroshki", docs_url="/api/docs")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

_EMPTY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


# ------------------------------------------------------------------ tiles
@app.get("/tiles/{provider}/{z}/{x}/{y}")
def tile(provider: str, z: int, x: int, y: int):
    if not provider.startswith("wayback:") and provider not in tiles.providers():
        raise HTTPException(404)
    status, data = tiles.fetch_tile(provider, z, x, y, interactive=True)
    if status == 204 and z > 3:
        # "no imagery at this zoom" placeholder -> upscale the parent tile instead
        for dz in range(1, 4):
            ps, pdata = tiles.fetch_tile(provider, z - dz, x >> dz, y >> dz, interactive=True)
            if ps == 200 and pdata:
                import io
                from PIL import Image
                im = Image.open(io.BytesIO(pdata)).convert("RGB")
                k = 256 >> dz
                ox, oy = (x % (1 << dz)) * k, (y % (1 << dz)) * k
                im = im.crop((ox, oy, ox + k, oy + k)).resize((256, 256), Image.BILINEAR)
                b = io.BytesIO()
                im.save(b, format="JPEG", quality=85)
                return Response(b.getvalue(), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
    if status not in (200, 204) or not data:
        return Response(_EMPTY_PNG, media_type="image/png", headers={"Cache-Control": "max-age=600"})
    mt = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
    return Response(data, media_type=mt, headers={"Cache-Control": "max-age=86400"})


@app.get("/api/providers")
def get_providers():
    s = settings()
    return {"providers": tiles.providers(), "imagery": s["imagery_provider"]}


# ------------------------------------------------------------------ settings
@app.get("/api/settings")
def get_settings():
    return settings().data


@app.post("/api/settings")
def set_settings(values: dict = Body(...)):
    settings().update(values)
    return settings().data


# ------------------------------------------------------------------ areas
@app.get("/api/areas")
def list_areas():
    rows = db.app_con().execute("SELECT id, name, geojson, created FROM areas ORDER BY id DESC").fetchall()
    return [{"id": r["id"], "name": r["name"], "geojson": db.loads(r["geojson"]), "created": r["created"]}
            for r in rows]


@app.post("/api/areas")
def save_area(payload: dict = Body(...)):
    name = (payload.get("name") or "").strip() or time.strftime("Область %d.%m %H:%M")
    gj = payload.get("geojson")
    if not gj:
        raise HTTPException(400, "geojson required")
    from .geo import area_from_geojson, polygon_area_km2
    poly = area_from_geojson(gj)
    cur = db.write(db.app_con(), "INSERT INTO areas(name, geojson, created) VALUES(?,?,?)",
                   (name, db.dumps(gj), time.time()))
    return {"id": cur.lastrowid, "name": name, "area_km2": round(polygon_area_km2(poly), 3)}


@app.delete("/api/areas/{area_id}")
def delete_area(area_id: int):
    db.write(db.app_con(), "DELETE FROM areas WHERE id=?", (area_id,))
    return {"ok": True}


@app.post("/api/area_info")
def area_info(payload: dict = Body(...)):
    from .geo import area_from_geojson, polygon_area_km2, tiles_for_polygon
    poly = area_from_geojson(payload["geojson"])
    km2 = polygon_area_km2(poly)
    z = settings()["scan_zoom"]
    n = len(tiles_for_polygon(poly, z)) if km2 < 3000 else int(km2 / 0.0225)
    return {"area_km2": round(km2, 3), "scan_tiles": n, "scan_zoom": z}


# ------------------------------------------------------------------ search jobs
@app.post("/api/search")
def start_search(payload: dict = Body(...)):
    from . import pipeline
    gj = payload.get("geojson")
    if not gj:
        raise HTTPException(400, "Сначала выделите область")
    opts = payload.get("options") or {}
    run_id = pipeline.create_run(gj, payload.get("area_id"), payload.get("name"), opts)
    try:
        job = manager.start(Job("search", pipeline.run_search, run_id=run_id))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"run_id": run_id, "job": job.status()}


@app.get("/api/job")
def job_status():
    j = manager.current
    return j.status() if j else {"state": "idle"}


@app.post("/api/job/{action}")
def job_action(action: str):
    j = manager.current
    if not j:
        return {"state": "idle"}
    if action == "pause":
        j.pause()
    elif action == "resume":
        j.resume()
    elif action == "cancel":
        j.cancel()
    else:
        raise HTTPException(400)
    return j.status()


# ------------------------------------------------------------------ results
@app.get("/api/runs")
def list_runs():
    rows = db.app_con().execute(
        "SELECT r.id, r.name, r.status, r.started, r.finished, r.stats, r.geojson, "
        "(SELECT COUNT(*) FROM candidates c WHERE c.run_id=r.id) AS n FROM runs r ORDER BY r.id DESC LIMIT 100"
    ).fetchall()
    return [{"id": r["id"], "name": r["name"], "status": r["status"], "started": r["started"],
             "finished": r["finished"], "stats": db.loads(r["stats"], {}), "count": r["n"],
             "geojson": db.loads(r["geojson"])} for r in rows]


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: int):
    con = db.app_con()
    db.write(con, "DELETE FROM candidates WHERE run_id=?", (run_id,))
    db.write(con, "DELETE FROM runs WHERE id=?", (run_id,))
    return {"ok": True}


@app.get("/api/runs/{run_id}/candidates")
def run_candidates(run_id: int, min_score: float = 0.0):
    from .results import compact_candidates
    return compact_candidates(run_id, min_score)


@app.get("/api/candidates/{cid}")
def candidate_detail(cid: int):
    from .results import candidate_detail as cd
    d = cd(cid)
    if d is None:
        raise HTTPException(404)
    return d


@app.get("/api/candidates/{cid}/image")
def candidate_image(cid: int, src: str = "current", zoom: int | None = None, size: int = 320):
    from .results import candidate_image as ci
    data = ci(cid, src, zoom, size)
    if data is None:
        raise HTTPException(404)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


@app.post("/api/candidates/{cid}/label")
def candidate_label(cid: int, payload: dict = Body(...)):
    from .training import set_label
    return set_label(cid, payload.get("label"), payload.get("note"))


@app.get("/api/labels")
def list_labels():
    rows = db.app_con().execute("SELECT id, lat, lon, label, note, ts FROM labels ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/retrain")
def retrain(payload: dict = Body(default={})):
    from . import pipeline
    run_id = payload.get("run_id")
    try:
        job = manager.start(Job("retrain", pipeline.run_retrain, run_id=run_id))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return job.status()


@app.post("/api/evaluate")
def evaluate_start(payload: dict = Body(default={})):
    from . import evaluate
    try:
        job = manager.start(Job("evaluate", evaluate.run_job, run_id=payload.get("run_id")))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return job.status()


@app.get("/api/evaluate/report")
def evaluate_report(run_id: int):
    p = DATA_DIR / f"eval_run{run_id}.md"
    if not p.exists():
        raise HTTPException(404, "Отчёта нет — нажмите «Оценить качество»")
    return Response(p.read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8")


@app.get("/api/model")
def model_info():
    from .training import model_status
    return model_status()


# ------------------------------------------------------------------ export
@app.post("/api/export")
def export(payload: dict = Body(...)):
    from .export import export_run
    path = export_run(int(payload["run_id"]), payload.get("format", "geojson"), payload.get("filters") or {})
    return {"path": str(path), "name": path.name}


@app.get("/api/export/download")
def export_download(name: str = Query(...)):
    p = (DATA_DIR / "exports" / Path(name).name)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, filename=p.name)


@app.post("/api/open_folder")
def open_folder(payload: dict = Body(default={})):
    p = Path(payload.get("path") or (DATA_DIR / "exports"))
    if p.is_file():
        p = p.parent
    p.mkdir(parents=True, exist_ok=True)
    try:
        if sys.platform.startswith("win"):
            os.startfile(str(p))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e), "path": str(p)})
    return {"ok": True, "path": str(p)}


@app.get("/api/health")
def health():
    from .models import device_info
    return {"ok": True, "data_dir": str(DATA_DIR), "device": device_info()}
