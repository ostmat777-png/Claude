"""Application settings, stored as JSON in the data directory."""
from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("ZABROSHKI_DATA", ROOT / "data")).resolve()
EXAMPLES_DIR = Path(os.environ.get("ZABROSHKI_EXAMPLES", ROOT / "examples")).resolve()
STATIC_DIR = Path(__file__).resolve().parent / "static"

# Neural model weights are cached inside the data folder (must be set before transformers is imported).
os.environ.setdefault("HF_HOME", str(DATA_DIR / "models"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")  # plain HTTPS download: the Xet client can hang on Windows
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

USER_AGENT = "Zabroshki/1.0 (desktop research tool)"


def user_agent() -> str:
    """Tile/Overpass servers like a way to contact heavy users; add one in settings.json ("contact")."""
    contact = (settings().get("contact") or "").strip()
    return f"{USER_AGENT[:-1]}; {contact})" if contact else USER_AGENT

DEFAULTS: dict = {
    # --- imagery -----------------------------------------------------------
    "imagery_provider": "esri",
    # Extra providers can be added here: {"id": {"name":..., "url":..., "max_zoom":..., "kind": "sat"|"map"}}
    "custom_providers": {},
    "scan_zoom": 17,          # dense scan zoom (≈0.58 m/px at 60°N)
    "crop_zoom": 18,          # precise check zoom (≈0.29 m/px at 60°N)
    # --- network politeness -------------------------------------------------
    "rate_limits": {          # requests per second per host (batch work); UI browsing has its own budget
        "server.arcgisonline.com": 8,
        "services.arcgisonline.com": 8,
        "wayback.maptiles.arcgis.com": 6,
        "metadata.maptiles.arcgis.com": 4,
        "tile.openstreetmap.org": 2,
        "query.wikidata.org": 1,
        "ru.wikipedia.org": 2, "en.wikipedia.org": 2, "fi.wikipedia.org": 2,
        "commons.wikimedia.org": 2,
        "api.panoramax.xyz": 2,
        "default": 4,
    },
    "download_threads": 6,
    "overpass_urls": [
        "https://overpass-api.de/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
    ],
    "osm_cache_days": 14,
    # --- pipeline -----------------------------------------------------------
    "use_imagery": True,
    "use_footprints": True,
    "use_models": True,
    "use_wayback": True,
    "use_vlm": "auto",        # "auto" = use if Ollama is reachable, True/False to force
    "stage_b_top_k": 1500,    # candidates that get a z18 crop + SigLIP
    "stage_b_min_score": 0.08,
    "wayback_top_k": 400,     # candidates that get the year-by-year comparison
    "wayback_max_minutes": 40,  # time budget of the Wayback stage (skipped/cut if the server is slow)
    "vlm_top_k": 150,
    "min_score_keep": 0.05,   # recall first: almost everything is kept
    "merge_radius_m": 18,
    # --- models -------------------------------------------------------------
    "device": "auto",          # auto | cuda (NVIDIA/ROCm) | directml (AMD/Intel on Windows) | xpu | mps | cpu
    "dino_model": "facebook/dinov2-small",
    "dino_input": "auto",      # auto -> 448 on GPU, 224 on CPU
    "siglip_model": "google/siglip-base-patch16-224",
    "tta": "auto",             # average 4 rotations in the precise check (auto = on GPU)
    "ollama_url": "http://127.0.0.1:11434",
    "ollama_model": "qwen2.5vl:7b",
    # --- training -----------------------------------------------------------
    "use_osm_weak_positives": True,
    "negatives_per_positive": 6,
    "min_negatives": 80,
    # optional contact (e-mail or URL) appended to the User-Agent for tile/Overpass server operators
    "contact": "",
    # --- server -------------------------------------------------------------
    "port": 0,                 # 0 = pick a free port
}


class Settings:
    def __init__(self, path: Path | None = None):
        self.path = path or (DATA_DIR / "settings.json")
        self._lock = threading.Lock()
        self.data = copy.deepcopy(DEFAULTS)
        if self.path.exists():
            try:
                user = json.loads(self.path.read_text(encoding="utf-8"))
                for k, v in user.items():
                    if isinstance(v, dict) and isinstance(self.data.get(k), dict):
                        self.data[k].update(v)
                    else:
                        self.data[k] = v
            except Exception:
                pass

    def __getitem__(self, key):
        return self.data[key]

    def get(self, key, default=None):
        return self.data.get(key, default)

    def update(self, values: dict):
        with self._lock:
            for k, v in values.items():
                if k in DEFAULTS:
                    self.data[k] = v
            self.save()

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")


_settings: Settings | None = None


def settings() -> Settings:
    global _settings
    if _settings is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _settings = Settings()
    return _settings
