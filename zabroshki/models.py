"""Neural models (lazy): DINOv2 patch tokens and SigLIP image/text embeddings."""
from __future__ import annotations

import logging
import threading

import numpy as np

from .config import DATA_DIR, settings

log = logging.getLogger(__name__)
_lock = threading.Lock()
_cache: dict = {}

ZS_PROMPTS = {
    "abandoned": [
        "satellite photo of an abandoned ruined building with a collapsed roof",
        "aerial view of an overgrown abandoned house surrounded by bushes and trees",
        "aerial photo of the ruins of a building in a forest",
        "aerial view of a derelict industrial building with a damaged roof",
        "top-down satellite image of a roofless brick ruin overgrown with vegetation",
        "aerial view of an abandoned farm building with holes in the roof",
    ],
    "maintained": [
        "satellite photo of a well-maintained house with a neat garden",
        "aerial view of a house with cars parked in the driveway",
        "aerial view of an active industrial site with trucks and a paved yard",
        "aerial photo of a new building with a clean intact roof",
        "top-down satellite image of a residential street with houses and lawns",
        "aerial view of a cottage with a mowed lawn and paths",
    ],
    "nobuilding": [
        "satellite image of dense forest canopy without any buildings",
        "aerial view of a green meadow",
        "aerial photo of a lake surface",
        "aerial view of an asphalt road and a parking lot",
    ],
    "cars": [
        "aerial view of cars and trucks parked in a yard",
        "satellite image of a parking lot with many vehicles",
    ],
    "nocars": [
        "aerial view of an empty yard without vehicles",
        "satellite image of grass and trees with no cars",
    ],
}


def torch_available() -> bool:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        return True
    except Exception:
        return False


def device():
    import torch
    s = settings()["device"]
    if s == "cpu":
        return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def device_info() -> str:
    try:
        import torch
    except Exception:
        return "PyTorch не установлен — работают только OSM и классические признаки"
    try:
        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            cap = torch.cuda.get_device_capability(0)
            return (f"CUDA: {p.name} ({p.total_memory / 2**30:.0f} ГБ, sm_{cap[0]}{cap[1]}), "
                    f"torch {torch.__version__}, CUDA {torch.version.cuda}")
        return f"CPU (torch {torch.__version__}; GPU не найден — будет медленнее)"
    except Exception as e:
        return f"torch {torch.__version__}: {e}"


def _hf_home():
    import os
    os.environ.setdefault("HF_HOME", str(DATA_DIR / "models"))


def _features(out):
    """transformers 4.x returns tensors, 5.x returns ModelOutput objects."""
    import torch
    if isinstance(out, torch.Tensor):
        return out
    for attr in ("pooler_output", "image_embeds", "text_embeds"):
        v = getattr(out, attr, None)
        if v is not None:
            return v
    return out[0]


class Dino:
    def __init__(self, name: str, size: int):
        _hf_home()
        import torch
        from transformers import AutoModel
        self.torch = torch
        self.dev = device()
        self.model = AutoModel.from_pretrained(name).to(self.dev).eval()
        self.half = self.dev.type == "cuda"
        if self.half:
            self.model = self.model.half()
        self.size = size
        self.grid = size // 14
        self.name = name
        self.dim = self.model.config.hidden_size
        self.mean = torch.tensor([0.485, 0.456, 0.406], device=self.dev).view(1, 3, 1, 1)
        self.std = torch.tensor([0.229, 0.224, 0.225], device=self.dev).view(1, 3, 1, 1)

    def tokens(self, imgs: np.ndarray, batch=None) -> np.ndarray:
        """imgs (B,H,W,3) uint8 -> patch tokens (B, G, G, D) float32 and CLS (B, D)."""
        torch = self.torch
        batch = batch or (32 if self.dev.type == "cuda" else 8)
        outs, cls = [], []
        G = self.grid
        with torch.inference_mode():
            for i in range(0, len(imgs), batch):
                x = torch.from_numpy(np.ascontiguousarray(imgs[i:i + batch])).to(self.dev)
                x = x.permute(0, 3, 1, 2).float() / 255.0
                x = torch.nn.functional.interpolate(x, size=(self.size, self.size), mode="bilinear",
                                                    antialias=True, align_corners=False)
                x = (x - self.mean) / self.std
                if self.half:
                    x = x.half()
                h = self.model(pixel_values=x).last_hidden_state
                tok = h[:, -G * G:, :].reshape(h.shape[0], G, G, -1)
                outs.append(tok.float().cpu().numpy())
                cls.append(h[:, 0, :].float().cpu().numpy())
        return np.concatenate(outs), np.concatenate(cls)


class Siglip:
    def __init__(self, name: str):
        _hf_home()
        import torch
        from transformers import AutoModel, AutoProcessor
        self.torch = torch
        self.dev = device()
        self.model = AutoModel.from_pretrained(name).to(self.dev).eval()
        self.proc = AutoProcessor.from_pretrained(name)
        self.name = name
        self.half = self.dev.type == "cuda"
        if self.half:
            self.model = self.model.half()
        cfg = getattr(self.model.config, "vision_config", None)
        self.size = getattr(cfg, "image_size", 224) or 224
        self.scale = float(self.model.logit_scale.exp().item()) if hasattr(self.model, "logit_scale") else 100.0
        self.bias = float(self.model.logit_bias.item()) if hasattr(self.model, "logit_bias") else 0.0
        self.text = {k: self._text(v) for k, v in ZS_PROMPTS.items()}

    def _text(self, prompts):
        torch = self.torch
        inp = self.proc(text=prompts, padding="max_length", return_tensors="pt")
        inp = {k: v.to(self.dev) for k, v in inp.items() if k in ("input_ids", "attention_mask")}
        with torch.inference_mode():
            t = _features(self.model.get_text_features(**inp)).float()
        t = t / t.norm(dim=-1, keepdim=True)
        return t.cpu().numpy()

    def image_embeddings(self, imgs: np.ndarray, batch=None) -> np.ndarray:
        torch = self.torch
        batch = batch or (32 if self.dev.type == "cuda" else 8)
        outs = []
        with torch.inference_mode():
            for i in range(0, len(imgs), batch):
                x = torch.from_numpy(np.ascontiguousarray(imgs[i:i + batch])).to(self.dev)
                x = x.permute(0, 3, 1, 2).float() / 255.0
                x = torch.nn.functional.interpolate(x, size=(self.size, self.size), mode="bicubic",
                                                    antialias=True, align_corners=False).clamp(0, 1)
                x = (x - 0.5) / 0.5
                if self.half:
                    x = x.half()
                e = _features(self.model.get_image_features(pixel_values=x)).float()
                e = e / e.norm(dim=-1, keepdim=True)
                outs.append(e.cpu().numpy())
        return np.concatenate(outs)

    def zero_shot(self, emb: np.ndarray) -> dict:
        """Probabilities from prompt groups (softmax over group log-sum-exp of scaled logits)."""
        def group_logit(name):
            lg = emb @ self.text[name].T * self.scale + self.bias
            m = lg.max(axis=1, keepdims=True)
            return (m + np.log(np.exp(lg - m).sum(axis=1, keepdims=True)))[:, 0]
        a, mnt, nb = group_logit("abandoned"), group_logit("maintained"), group_logit("nobuilding")
        c, nc = group_logit("cars"), group_logit("nocars")
        m = np.maximum(np.maximum(a, mnt), nb)
        ea, em, en = np.exp(a - m), np.exp(mnt - m), np.exp(nb - m)
        p_ab = ea / (ea + em + en)
        p_cars = 1 / (1 + np.exp(-(c - nc)))
        return {"abandoned": p_ab, "cars": p_cars, "nobuilding": en / (ea + em + en)}


def dino_input_size() -> int:
    v = settings()["dino_input"]
    if v == "auto":
        try:
            return 448 if device().type == "cuda" else 224
        except Exception:
            return 224
    return int(v)


def get_dino() -> Dino:
    name = settings()["dino_model"]
    size = dino_input_size()
    key = ("dino", name, size)
    with _lock:
        if key not in _cache:
            log.info("loading %s @%d", name, size)
            _cache[key] = Dino(name, size)
        return _cache[key]


def get_siglip() -> Siglip:
    name = settings()["siglip_model"]
    key = ("siglip", name)
    with _lock:
        if key not in _cache:
            log.info("loading %s", name)
            _cache[key] = Siglip(name)
        return _cache[key]


def prefetch_models():
    print(device_info())
    d = get_dino()
    print("DINOv2:", d.name, "input", d.size)
    s = get_siglip()
    print("SigLIP:", s.name)
    return 0
