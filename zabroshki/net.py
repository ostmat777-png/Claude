"""HTTP with per-host rate limiting, retries and back-off."""
from __future__ import annotations

import logging
import threading
import time
from urllib.parse import urlparse

import requests

from .config import USER_AGENT, settings

log = logging.getLogger(__name__)


class RateLimiter:
    """Simple thread-safe 'minimum interval' limiter per host."""

    def __init__(self):
        self._lock = threading.Lock()
        self._next: dict[str, float] = {}
        self._penalty: dict[str, float] = {}

    def wait(self, host: str, rps: float):
        interval = 1.0 / max(rps, 0.1)
        with self._lock:
            now = time.monotonic()
            t = max(now, self._next.get(host, 0.0))
            pen = self._penalty.get(host, 0.0)
            self._next[host] = t + interval + pen
        delay = t - time.monotonic()
        if delay > 0:
            time.sleep(delay)

    def backoff(self, host: str, seconds: float):
        with self._lock:
            self._next[host] = max(self._next.get(host, 0.0), time.monotonic() + seconds)
            self._penalty[host] = min(self._penalty.get(host, 0.0) + 0.05, 1.0)

    def relax(self, host: str):
        with self._lock:
            if self._penalty.get(host):
                self._penalty[host] = max(0.0, self._penalty[host] - 0.01)


batch_limiter = RateLimiter()
ui_limiter = RateLimiter()

_session_local = threading.local()


def session() -> requests.Session:
    s = getattr(_session_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = USER_AGENT
        adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=16)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        _session_local.s = s
    return s


def host_rps(host: str) -> float:
    rl = settings()["rate_limits"]
    return float(rl.get(host, rl.get("default", 4)))


class HttpError(Exception):
    def __init__(self, status, msg=""):
        super().__init__(f"HTTP {status} {msg}")
        self.status = status


def request(method: str, url: str, *, interactive=False, retries=4, timeout=40,
            ok_statuses=(200,), **kw) -> requests.Response:
    host = urlparse(url).netloc
    limiter = ui_limiter if interactive else batch_limiter
    # interactive map browsing behaves like a normal web map viewer
    rps = max(host_rps(host) * 1.5, 10.0) if interactive else host_rps(host)
    last_exc = None
    for attempt in range(retries + 1):
        limiter.wait(host, rps)
        try:
            r = session().request(method, url, timeout=timeout, **kw)
        except requests.RequestException as e:
            last_exc = e
            wait = min(2 ** attempt, 30)
            log.debug("net error %s %s, retry in %ss", url, e, wait)
            limiter.backoff(host, wait)
            continue
        if r.status_code in ok_statuses:
            limiter.relax(host)
            return r
        if r.status_code in (429, 502, 503, 504, 500):
            ra = r.headers.get("Retry-After")
            try:
                wait = float(ra) if ra else min(2 ** (attempt + 1), 60)
            except ValueError:
                wait = min(2 ** (attempt + 1), 60)
            log.info("%s from %s, backing off %.0fs", r.status_code, host, wait)
            limiter.backoff(host, wait)
            last_exc = HttpError(r.status_code, url)
            continue
        raise HttpError(r.status_code, url)
    if isinstance(last_exc, HttpError):
        raise last_exc
    raise HttpError(0, f"{url}: {last_exc}")


def get(url, **kw):
    return request("GET", url, **kw)


def post(url, **kw):
    return request("POST", url, **kw)
