"""SQLite storage: tile/HTTP cache (cache.sqlite) and application data (app.sqlite)."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

import numpy as np

from .config import DATA_DIR

_local = threading.local()
_write_lock = threading.RLock()

CACHE_SCHEMA = """
CREATE TABLE IF NOT EXISTS tiles(
    provider TEXT, z INTEGER, x INTEGER, y INTEGER,
    status INTEGER,            -- 200 ok, 404 missing, 204 placeholder ("no data")
    data BLOB, ts REAL,
    PRIMARY KEY(provider, z, x, y));
CREATE TABLE IF NOT EXISTS http_cache(
    key TEXT PRIMARY KEY, data BLOB, ts REAL);
"""

APP_SCHEMA = """
CREATE TABLE IF NOT EXISTS areas(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, geojson TEXT, created REAL);
CREATE TABLE IF NOT EXISTS runs(
    id INTEGER PRIMARY KEY AUTOINCREMENT, area_id INTEGER, name TEXT, geojson TEXT,
    status TEXT, started REAL, finished REAL, params TEXT, stats TEXT);
CREATE TABLE IF NOT EXISTS candidates(
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER,
    lat REAL, lon REAL, kind TEXT, title TEXT, footprint TEXT,
    sources TEXT, tags TEXT, features TEXT,
    score REAL, reasons TEXT, guard TEXT, guard_reasons TEXT,
    stage INTEGER DEFAULT 1, updated REAL);
CREATE INDEX IF NOT EXISTS idx_cand_run ON candidates(run_id);
CREATE TABLE IF NOT EXISTS labels(
    id INTEGER PRIMARY KEY AUTOINCREMENT, lat REAL, lon REAL, label INTEGER,
    note TEXT, run_id INTEGER, candidate_id INTEGER, features TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS emb(
    key TEXT PRIMARY KEY, dim INTEGER, data BLOB, ts REAL);
CREATE TABLE IF NOT EXISTS models(
    name TEXT PRIMARY KEY, data BLOB, meta TEXT, ts REAL);
"""


def _connect(path: Path, schema: str) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=60, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(schema)
    return con


def cache_con() -> sqlite3.Connection:
    con = getattr(_local, "cache", None)
    if con is None:
        con = _connect(DATA_DIR / "cache.sqlite", CACHE_SCHEMA)
        _local.cache = con
    return con


def app_con() -> sqlite3.Connection:
    con = getattr(_local, "app", None)
    if con is None:
        con = _connect(DATA_DIR / "app.sqlite", APP_SCHEMA)
        con.row_factory = sqlite3.Row
        _local.app = con
    return con


def write(con: sqlite3.Connection, sql: str, params=()):
    with _write_lock:
        cur = con.execute(sql, params)
        con.commit()
        return cur


def write_many(con: sqlite3.Connection, sql: str, rows):
    with _write_lock:
        con.executemany(sql, rows)
        con.commit()


# ---------------------------------------------------------------- tile cache
def tile_get(provider: str, z: int, x: int, y: int):
    row = cache_con().execute(
        "SELECT status, data FROM tiles WHERE provider=? AND z=? AND x=? AND y=?",
        (provider, z, x, y)).fetchone()
    return row  # (status, data) or None


def tile_put(provider: str, z: int, x: int, y: int, status: int, data: bytes | None):
    write(cache_con(),
          "INSERT OR REPLACE INTO tiles(provider,z,x,y,status,data,ts) VALUES(?,?,?,?,?,?,?)",
          (provider, z, x, y, status, data, time.time()))


def tiles_cached(provider: str, z: int, xys) -> set:
    con = cache_con()
    have = set()
    xys = list(xys)
    for i in range(0, len(xys), 500):
        chunk = xys[i:i + 500]
        q = " OR ".join(["(x=? AND y=?)"] * len(chunk))
        params = [provider, z] + [v for xy in chunk for v in xy]
        for r in con.execute(f"SELECT x,y FROM tiles WHERE provider=? AND z=? AND ({q})", params):
            have.add((r[0], r[1]))
    return have


# ---------------------------------------------------------------- http cache
def http_cache_get(key: str, max_age_s: float | None = None):
    row = cache_con().execute("SELECT data, ts FROM http_cache WHERE key=?", (key,)).fetchone()
    if row is None:
        return None
    if max_age_s is not None and time.time() - row[1] > max_age_s:
        return None
    return row[0]


def http_cache_put(key: str, data: bytes):
    write(cache_con(), "INSERT OR REPLACE INTO http_cache(key,data,ts) VALUES(?,?,?)",
          (key, data, time.time()))


# ---------------------------------------------------------------- embeddings
def emb_get(key: str):
    row = app_con().execute("SELECT dim, data FROM emb WHERE key=?", (key,)).fetchone()
    if row is None:
        return None
    return np.frombuffer(row[1], dtype=np.float16).astype(np.float32)


def emb_get_many(keys: list[str]) -> dict:
    out = {}
    con = app_con()
    for i in range(0, len(keys), 500):
        chunk = keys[i:i + 500]
        q = ",".join("?" * len(chunk))
        for r in con.execute(f"SELECT key, data FROM emb WHERE key IN ({q})", chunk):
            out[r[0]] = np.frombuffer(r[1], dtype=np.float16).astype(np.float32)
    return out


def emb_put_many(items: dict):
    rows = [(k, int(v.shape[0]), np.asarray(v, dtype=np.float16).tobytes(), time.time())
            for k, v in items.items()]
    if rows:
        write_many(app_con(), "INSERT OR REPLACE INTO emb(key,dim,data,ts) VALUES(?,?,?,?)", rows)


# ---------------------------------------------------------------- json helpers
def dumps(o) -> str:
    return json.dumps(o, ensure_ascii=False, default=_default)


def _default(o):
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, set):
        return sorted(o)
    raise TypeError(type(o))


def loads(s, default=None):
    if s is None:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default
