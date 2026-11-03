"""Optional refinement of top candidates with a local vision-language model via Ollama (e.g. qwen2.5vl:7b)."""
from __future__ import annotations

import base64
import json
import logging
import re

import requests

from . import tiles

log = logging.getLogger(__name__)

PROMPT = """You are analysing a top-down satellite image (about 110 m across, north up) centred on a building or a site.
Decide whether the object in the centre is ABANDONED (derelict, ruined, unused) or IN USE.
Signs of abandonment: damaged/collapsed/missing roof, holes, roof covered by moss or trees, building overgrown by bushes
or young trees, no paths or tracks, overgrown access road, no cars, ruins/foundations only.
Signs of use: intact clean roof, mowed lawn, garden beds, cars or machinery, fresh tracks, maintained fence.
Also report access/guarding signs: perimeter fence or wall, gate or barrier/boom, guard booth, vehicles in the yard.
Answer ONLY with JSON:
{"abandoned_probability": 0.0-1.0, "roof": "intact|damaged|collapsed|none|unclear", "overgrown": true/false,
 "vehicles": true/false, "fence": true/false, "guard_booth": true/false, "signs_of_use": true/false,
 "explanation": "short reason in Russian"}"""


def available(url: str, model: str, timeout=2.0):
    try:
        r = requests.get(url.rstrip("/") + "/api/tags", timeout=timeout)
        if r.status_code != 200:
            return False, "Ollama не отвечает"
        names = [m.get("name", "") for m in r.json().get("models", [])]
        base = model.split(":")[0]
        if model in names or any(n.split(":")[0] == base for n in names):
            return True, ""
        return False, f"в Ollama нет модели {model} (выполните: ollama pull {model})"
    except Exception:
        return False, "Ollama не запущен (http://127.0.0.1:11434)"


def parse_answer(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except Exception:
        return None
    try:
        p = float(d.get("abandoned_probability"))
        d["abandoned_probability"] = max(0.0, min(1.0, p))
    except Exception:
        return None
    for k in ("overgrown", "vehicles", "fence", "guard_booth", "signs_of_use"):
        v = d.get(k)
        if isinstance(v, str):
            d[k] = v.strip().lower() in ("true", "yes", "да", "1")
    return d


def ask(url, model, jpeg: bytes, timeout=180) -> dict | None:
    payload = {"model": model, "prompt": PROMPT, "images": [base64.b64encode(jpeg).decode()],
               "stream": False, "format": "json", "options": {"temperature": 0}}
    r = requests.post(url.rstrip("/") + "/api/generate", json=payload, timeout=timeout)
    r.raise_for_status()
    return parse_answer(r.json().get("response", ""))


def run(job, cands, opts, force=False):
    url = opts.get("ollama_url", "http://127.0.0.1:11434")
    model = opts.get("ollama_model", "qwen2.5vl:7b")
    ok, why = available(url, model)
    if not ok:
        job.info(f"VLM пропущен: {why}")
        return
    k = int(opts.get("vlm_top_k", 60))
    z = int(opts.get("crop_zoom", 18))
    provider = opts.get("imagery_provider", "esri")
    # the VLM is an independent second opinion: spend it first on strong candidates that are NOT yet confirmed
    pool = [c for c in cands if c["kind"] not in ("deadend",) and c["score"] >= 0.2]
    pool.sort(key=lambda c: ((c["f"].get("confirm_n") or 0) >= 2, -c["score"]))
    sel = pool[:k]
    job.info(f"VLM {model}: проверка {len(sel)} лучших кандидатов")
    for i, c in enumerate(sel):
        job.checkpoint()
        job.progress(i, len(sel), f"VLM: {i}/{len(sel)}")
        img, valid = tiles.crop_lonlat(provider, z, c["lon"], c["lat"], 384)
        if valid < 0.5:
            continue
        try:
            ans = ask(url, model, tiles.to_jpeg(img))
        except Exception as e:
            log.info("vlm failed: %s", e)
            continue
        if ans:
            ans["model"] = model
            c["f"]["vlm"] = ans
            c["stage"] = max(c.get("stage", 1), 3)
