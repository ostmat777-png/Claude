"""Single background job runner with progress, pause/resume and cancel."""
from __future__ import annotations

import logging
import threading
import time
import traceback

log = logging.getLogger(__name__)


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, name: str, fn, *args, **kw):
        self.name = name
        self.fn = fn
        self.args = args
        self.kw = kw
        self.state = "pending"     # pending | running | paused | done | error | cancelled
        self.stage = ""
        self.stage_index = 0
        self.stage_count = 1
        self.done = 0
        self.total = 0
        self.message = ""
        self.error = None
        self.result = None
        self.run_id = kw.get("run_id")
        self.log: list[str] = []
        self.started = time.time()
        self.stage_started = time.time()
        self._resume = threading.Event()
        self._resume.set()
        self._cancel = False
        self.thread: threading.Thread | None = None

    # ------------------------------------------------------------ control
    def pause(self):
        if self.state == "running":
            self._resume.clear()
            self.state = "paused"
            self.info("Пауза")

    def resume(self):
        if self.state == "paused":
            self.state = "running"
            self._resume.set()
            self.info("Продолжение")

    def cancel(self):
        self._cancel = True
        self._resume.set()

    def checkpoint(self):
        """Called often from worker code: blocks while paused, raises when cancelled."""
        if self._cancel:
            raise Cancelled()
        if not self._resume.is_set():
            self._resume.wait()
            if self._cancel:
                raise Cancelled()

    # ------------------------------------------------------------ progress
    def set_stage(self, index: int, count: int, name: str):
        self.stage_index, self.stage_count, self.stage = index, count, name
        self.done, self.total = 0, 0
        self.stage_started = time.time()
        self.info(f"[{index}/{count}] {name}")

    def progress(self, done, total, message=None):
        self.done, self.total = done, total
        if message is not None:
            self.message = message

    def info(self, msg: str):
        log.info(msg)
        self.message = msg
        self.log.append(time.strftime("%H:%M:%S ") + msg)
        if len(self.log) > 300:
            self.log = self.log[-300:]

    def status(self) -> dict:
        frac_stage = (self.done / self.total) if self.total else 0.0
        overall = ((self.stage_index - 1) + frac_stage) / max(self.stage_count, 1) if self.stage_index else 0.0
        eta = None
        if self.total and self.done and self.state == "running":
            el = time.time() - self.stage_started
            eta = el / self.done * (self.total - self.done)
        return {
            "name": self.name, "state": self.state, "stage": self.stage,
            "stage_index": self.stage_index, "stage_count": self.stage_count,
            "done": self.done, "total": self.total, "overall": round(overall, 4),
            "message": self.message, "error": self.error, "run_id": self.run_id,
            "eta_s": eta, "log": self.log[-40:], "elapsed_s": time.time() - self.started,
        }

    # ------------------------------------------------------------ run
    def start(self):
        def target():
            self.state = "running"
            try:
                self.result = self.fn(self, *self.args, **self.kw)
                self.state = "done"
                self.info("Готово")
            except Cancelled:
                self.state = "cancelled"
                self.info("Отменено")
            except Exception as e:  # pragma: no cover - surfaced to UI
                self.state = "error"
                self.error = f"{type(e).__name__}: {e}"
                self.info("Ошибка: " + self.error)
                log.error(traceback.format_exc())
        self.thread = threading.Thread(target=target, name=f"job-{self.name}", daemon=True)
        self.thread.start()
        return self


class JobManager:
    def __init__(self):
        self.current: Job | None = None
        self.lock = threading.Lock()

    def busy(self) -> bool:
        return self.current is not None and self.current.state in ("pending", "running", "paused")

    def start(self, job: Job) -> Job:
        with self.lock:
            if self.busy():
                raise RuntimeError("Уже выполняется задача: " + self.current.name)
            self.current = job
            return job.start()


manager = JobManager()
