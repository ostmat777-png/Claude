"""Export of results: KML, GeoJSON, CSV."""
from __future__ import annotations

import csv
import json
import time
from pathlib import Path
from xml.sax.saxutils import escape

from . import db
from .config import DATA_DIR
from .geo import google_maps_url
from .results import find_label, label_index

GUARD_RU = {"red": "охраняется/закрыто", "yellow": "неясно", "green": "свободный доступ"}
KML_COLORS = {"red": "ff3b38e5", "yellow": "ff30c4f4", "green": "ff53c62d"}  # aabbggrr
TYPE_RU = {
    "house": "Дом / дача", "industrial": "Промздание", "farm": "Ферма / с/х", "ruins": "Руины",
    "military": "Военный объект", "building": "Постройка", "unmapped": "Постройка по снимку",
    "clearing": "Прогалина в лесу", "deadend": "Тупик дороги", "area": "Территория",
}


def _rows(run_id, filters):
    rows = db.app_con().execute("SELECT * FROM candidates WHERE run_id=? ORDER BY score DESC", (run_id,)).fetchall()
    guards = set(filters.get("guard") or ["red", "yellow", "green"])
    types = set(filters.get("types") or [])
    min_score = float(filters.get("min_score") or 0)
    only_unl = bool(filters.get("only_unlabeled"))
    only_conf = bool(filters.get("only_confirmed"))
    grid = label_index()
    out = []
    for r in rows:
        if r["guard"] not in guards or r["score"] < min_score:
            continue
        if types and r["kind"] not in types:
            continue
        lb = find_label(grid, r["lat"], r["lon"]) if grid else None
        if only_unl and lb is not None:
            continue
        if only_conf and (db.loads(r["features"], {}).get("confirm_n") or 0) < 2:
            continue
        out.append((r, lb["label"] if lb else None))
    return out


def _reasons_text(r, n=6):
    rs = db.loads(r["reasons"], [])
    return "; ".join(f"{x['text']} ({x['w']:+.2f})" for x in rs[:n])


def _guard_text(r, n=4):
    rs = db.loads(r["guard_reasons"], [])
    return "; ".join(x["text"] for x in rs[:n])


def export_run(run_id: int, fmt: str, filters: dict) -> Path:
    fmt = fmt.lower()
    rows = _rows(run_id, filters)
    folder = DATA_DIR / "exports"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    path = folder / f"zabroshki_run{run_id}_{stamp}.{ 'kml' if fmt == 'kml' else ('geojson' if fmt == 'geojson' else 'csv')}"
    if fmt == "geojson":
        feats = []
        for r, lb in rows:
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
                          "properties": {
                              "id": r["id"], "score": round(r["score"], 4), "guard": r["guard"],
                              "guard_ru": GUARD_RU.get(r["guard"]), "type": r["kind"], "type_ru": TYPE_RU.get(r["kind"]),
                              "title": r["title"], "sources": db.loads(r["sources"], []),
                              "reasons": db.loads(r["reasons"], []), "guard_reasons": db.loads(r["guard_reasons"], []),
                              "tags": db.loads(r["tags"], {}), "label": lb,
                              "confirmed_by": db.loads(r["features"], {}).get("confirm") or [],
                              "google_maps": google_maps_url(r["lat"], r["lon"]),
                              "footprint": db.loads(r["footprint"]),
                          }})
        path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, indent=1),
                        encoding="utf-8")
    elif fmt == "csv":
        with open(path, "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.writer(fh, delimiter=";")
            w.writerow(["id", "lat", "lon", "score", "guard", "type", "title", "confirmed_by", "sources", "reasons",
                        "guard_reasons", "label", "google_maps"])
            for r, lb in rows:
                w.writerow([r["id"], f"{r['lat']:.6f}", f"{r['lon']:.6f}", f"{r['score']:.3f}", GUARD_RU.get(r["guard"]),
                            TYPE_RU.get(r["kind"], r["kind"]), r["title"],
                            "; ".join(db.loads(r["features"], {}).get("confirm") or []),
                            ", ".join(db.loads(r["sources"], [])),
                            _reasons_text(r, 10), _guard_text(r, 6), "" if lb is None else lb,
                            google_maps_url(r["lat"], r["lon"])])
    else:
        parts = ['<?xml version="1.0" encoding="UTF-8"?>',
                 '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
                 f"<name>Заброшки — запуск {run_id}</name>"]
        for g, col in KML_COLORS.items():
            parts.append(f'<Style id="{g}"><IconStyle><color>{col}</color><scale>1.0</scale>'
                         '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>'
                         f'</IconStyle></Style>')
        for g in ("red", "yellow", "green"):
            parts.append(f"<Folder><name>{escape(GUARD_RU[g])}</name>")
            for r, lb in rows:
                if r["guard"] != g:
                    continue
                desc = (f"Балл: {r['score'] * 100:.0f}/100<br/>Тип: {escape(TYPE_RU.get(r['kind'], r['kind']))}<br/>"
                        f"Охрана: {escape(GUARD_RU[g])} — {escape(_guard_text(r))}<br/>"
                        f"Причины: {escape(_reasons_text(r))}<br/>"
                        f"Источники: {escape(', '.join(db.loads(r['sources'], [])))}<br/>"
                        f"<a href=\"{escape(google_maps_url(r['lat'], r['lon']))}\">Google Maps</a>")
                name = f"{r['score'] * 100:.0f} {TYPE_RU.get(r['kind'], r['kind'])}"
                parts.append(f"<Placemark><name>{escape(name)}</name><styleUrl>#{g}</styleUrl>"
                             f"<description><![CDATA[{desc}]]></description>"
                             f"<Point><coordinates>{r['lon']:.7f},{r['lat']:.7f},0</coordinates></Point></Placemark>")
            parts.append("</Folder>")
        parts.append("</Document></kml>")
        path.write_text("\n".join(parts), encoding="utf-8")
    return path
