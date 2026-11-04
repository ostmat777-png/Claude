"""Local HTTP API + static UI (served to the desktop window)."""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from . import db, tiles
from .config import DATA_DIR, STATIC_DIR, settings
from .jobs import Job, manager

log = logging.getLogger(__name__)
app = FastAPI(title="Zabroshki", docs_url="/api/docs")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.state.lan_token = None
app.state.lan_urls = []

_LOCAL = ("127.0.0.1", "::1", "localhost", "testclient")


@app.middleware("http")
async def lan_guard(request, call_next):
    """Requests from other devices (phone over Wi-Fi) need the secret key from the LAN link."""
    client = request.client.host if request.client else ""
    if client in _LOCAL:
        return await call_next(request)
    token = app.state.lan_token
    key = request.query_params.get("key")
    if not token or (key != token and request.cookies.get("zkey") != token):
        return PlainTextResponse("Доступ закрыт. Откройте ссылку с ключом, которую показывает программа "
                                 "(кнопка «📱» или консоль при запуске run_lan.bat).", status_code=403)
    resp = await call_next(request)
    if key == token:
        resp.set_cookie("zkey", token, httponly=True, samesite="lax", max_age=30 * 86400)
    return resp


@app.get("/api/lan")
def lan_info():
    """LAN access info with a QR code (only meaningful when started with --lan)."""
    urls = app.state.lan_urls or []
    qr = None
    if urls:
        try:
            import segno
            qr = segno.make(urls[0], error="m").svg_inline(scale=5, dark="#000", light="#fff")
        except Exception:
            qr = None
    return {"enabled": bool(app.state.lan_token), "urls": urls, "qr_svg": qr}

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
    is_imagery = provider.startswith("wayback:") or tiles.providers().get(provider, {}).get("kind") == "sat"
    if (status == 204 or (status == 404 and is_imagery)) and z > 3:
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
@app.get("/api/wayback/releases")
def wayback_releases():
    """All Esri Wayback releases (newest first) + the latest release of every year."""
    from . import wayback
    try:
        rels = wayback.releases()
    except Exception as e:
        raise HTTPException(503, f"Wayback недоступен: {e}")
    years = {}
    for r in rels:  # newest first -> first seen per year is the latest of that year
        y = (r["date"] or "")[:4]
        if y and y not in years:
            years[y] = r
    return {"releases": [{"release": r["release"], "date": r["date"]} for r in rels],
            "years": [{"year": y, "release": r["release"], "date": r["date"]} for y, r in years.items()]}


@app.get("/api/wayback/local")
def wayback_local(lat: float, lon: float, z: int = 16):
    """Distinct imagery versions at this place with real acquisition dates (like the Esri Wayback app)."""
    from . import wayback
    from .geo import lonlat_to_tile
    zz = max(12, min(int(z), 17))
    x, y = lonlat_to_tile(lon, lat, zz)
    try:
        vers = wayback.distinct_versions(zz, x, y, max_versions=14)
    except Exception as e:
        raise HTTPException(503, f"Wayback недоступен: {e}")
    rel_dates = {r["release"]: r["date"] for r in wayback.releases()}
    out, seen = [], set()
    for r in vers:
        md = wayback.capture_date(r, lat, lon, zz)
        d = md.get("date")
        key = d or f"r{r}"
        if key in seen:
            continue
        seen.add(key)
        out.append({"release": r, "date": d, "release_date": rel_dates.get(r), "src": md.get("src"),
                    "res": md.get("res")})
    return {"z": zz, "versions": out}


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


@app.get("/api/runs/{run_id}/complexes")
def run_complexes(run_id: int):
    from .results import complexes_geojson
    return complexes_geojson(run_id)


@app.post("/api/labels/manual")
def manual_label(payload: dict = Body(...)):
    """A label placed directly on the map (e.g. an abandoned object the search missed)."""
    lat, lon, label = float(payload["lat"]), float(payload["lon"]), payload.get("label")
    if label not in (0, 1):
        raise HTTPException(400, "label must be 0 or 1")
    cur = db.write(db.app_con(), "INSERT INTO labels(lat, lon, label, note, run_id, candidate_id, features, ts) "
                                 "VALUES(?,?,?,?,?,?,?,?)",
                   (lat, lon, int(label), payload.get("note") or "отмечено на карте", None, None, None, time.time()))
    return {"ok": True, "id": cur.lastrowid}


@app.delete("/api/labels/{label_id}")
def delete_label(label_id: int):
    db.write(db.app_con(), "DELETE FROM labels WHERE id=?", (label_id,))
    return {"ok": True}


@app.get("/api/candidates/{cid}")
def candidate_detail(cid: int):
    from .results import candidate_detail as cd
    d = cd(cid)
    if d is None:
        raise HTTPException(404)
    return d


@app.get("/api/candidates/{cid}/info")
def candidate_info(cid: int, refresh: bool = False):
    from .info import get_info
    d = get_info(cid, refresh)
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


@app.get("/api/examples")
def list_examples():
    """Examples from examples/positives.csv and negatives.csv (shown on the map as ☆ / ✕ outlines)."""
    from .training import NEG_CSV, read_points_csv, read_positives
    return {"positives": read_positives(), "negatives": read_points_csv(NEG_CSV)}


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
