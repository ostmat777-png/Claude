"""Headless search from the command line (same pipeline as the GUI)."""
from __future__ import annotations

import json
import time

from .jobs import Job


def headless_scan(bbox: str, name=None, options=None):
    from . import pipeline
    if not bbox:
        raise SystemExit("--bbox S,W,N,E обязателен")
    s, w, n, e = [float(v) for v in bbox.split(",")]
    gj = {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}
    opts = json.loads(options) if options else {}
    run_id = pipeline.create_run(gj, None, name, opts)
    job = Job("search", pipeline.run_search, run_id=run_id)
    job.start()
    last = ""
    while job.thread.is_alive():
        st = job.status()
        line = f"[{st['stage_index']}/{st['stage_count']}] {st['stage']} {st['done']}/{st['total']} {st['message']}"
        if line != last:
            print(line, flush=True)
            last = line
        time.sleep(2)
    st = job.status()
    print("state:", st["state"], st.get("error") or "")
    print("run_id:", run_id)
    print(json.dumps(job.result or {}, ensure_ascii=False, indent=1))
    return 0 if st["state"] == "done" else 1
