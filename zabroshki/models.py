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


# ===================================================================== compute backends
# NVIDIA (CUDA, any generation the installed wheel supports), AMD on Linux (ROCm, exposed as "cuda"),
# AMD / Intel / any DirectX-12 GPU on Windows (DirectML), Intel Arc / Core Ultra (XPU), Apple Silicon (MPS), CPU.
_backend_cache: dict = {}


def _try_directml():
    try:
        import torch_directml  # noqa: F401
        if torch_directml.device_count() > 0:
            return torch_directml
    except Exception:
        pass
    return None


def backend() -> str:
    """'cuda' | 'rocm' | 'directml' | 'xpu' | 'mps' | 'cpu' (respecting settings['device'])."""
    if "name" in _backend_cache:
        return _backend_cache["name"]
    import torch
    want = str(settings().get("device", "auto")).lower()
    found = "cpu"
    cands = ["cuda", "xpu", "directml", "mps"] if want == "auto" else [want]
    for b in cands:
        try:
            if b in ("cuda", "rocm") and torch.cuda.is_available():
                found = "rocm" if getattr(torch.version, "hip", None) else "cuda"
            elif b == "xpu" and hasattr(torch, "xpu") and torch.xpu.is_available():
                found = "xpu"
            elif b == "directml" and _try_directml():
                found = "directml"
            elif b == "mps" and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                found = "mps"
        except Exception:
            continue
        if found != "cpu":
            break
    _backend_cache["name"] = found
    return found


def force_cpu(reason: str):
    """Called when the accelerator fails at run time: everything continues on the CPU."""
    log.warning("GPU недоступен (%s) — переключаюсь на процессор", reason)
    _backend_cache["name"] = "cpu"
    _backend_cache["fallback_reason"] = reason


def device():
    import torch
    b = backend()
    if b in ("cuda", "rocm"):
        return torch.device("cuda")
    if b == "xpu":
        return torch.device("xpu")
    if b == "mps":
        return torch.device("mps")
    if b == "directml":
        return _try_directml().device()
    return torch.device("cpu")


def accelerated() -> bool:
    try:
        return backend() != "cpu"
    except Exception:
        return False


def vram_gb():
    """Dedicated GPU memory in GB if the backend can tell, else None."""
    try:
        import torch
        b = backend()
        if b in ("cuda", "rocm"):
            return torch.cuda.get_device_properties(0).total_memory / 2 ** 30
        if b == "xpu":
            return torch.xpu.get_device_properties(0).total_memory / 2 ** 30
    except Exception:
        pass
    return None


def use_half() -> bool:
    """fp16 only where it is fast and safe: NVIDIA Volta+ / ROCm."""
    try:
        import torch
        b = backend()
        if b == "cuda":
            return torch.cuda.get_device_capability(0) >= (7, 0)
        return b == "rocm"
    except Exception:
        return False


def default_batch() -> int:
    b = backend()
    v = vram_gb()
    if b in ("cuda", "rocm", "xpu") and v is not None:
        return 32 if v >= 12 else 16 if v >= 6 else 8 if v >= 3 else 4
    return {"mps": 16, "directml": 8, "xpu": 16}.get(b, 8)


def device_info() -> str:
    try:
        import torch
    except Exception:
        return "PyTorch не установлен — работают только OSM и классические признаки"
    try:
        import os
        b = backend()
        extra = f" (переключено на CPU: {_backend_cache['fallback_reason']})" if _backend_cache.get("fallback_reason") else ""
        if b == "cuda":
            p = torch.cuda.get_device_properties(0)
            cap = torch.cuda.get_device_capability(0)
            return (f"NVIDIA CUDA: {p.name} ({p.total_memory / 2**30:.0f} ГБ, sm_{cap[0]}{cap[1]}), "
                    f"torch {torch.__version__}, CUDA {torch.version.cuda}")
        if b == "rocm":
            p = torch.cuda.get_device_properties(0)
            return f"AMD ROCm: {p.name} ({p.total_memory / 2**30:.0f} ГБ), torch {torch.__version__}, HIP {torch.version.hip}"
        if b == "xpu":
            p = torch.xpu.get_device_properties(0)
            return f"Intel XPU: {p.name} ({p.total_memory / 2**30:.0f} ГБ), torch {torch.__version__}"
        if b == "directml":
            dml = _try_directml()
            return f"DirectML (AMD/Intel/любая DX12 видеокарта): {dml.device_name(0)}, torch {torch.__version__}"
        if b == "mps":
            return f"Apple Metal (MPS), torch {torch.__version__}"
        return (f"CPU, {os.cpu_count()} потоков (torch {torch.__version__}; видеокарта не используется — "
                f"будет медленнее){extra}")
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


def _is_oom(e: Exception) -> bool:
    s = str(e).lower()
    return "out of memory" in s or "outofmemory" in type(e).__name__.lower() or "not enough memory" in s


def _empty_cache():
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if hasattr(torch, "xpu") and torch.xpu.is_available():
            torch.xpu.empty_cache()
    except Exception:
        pass


class _Runner:
    """Shared logic: preprocessing on CPU (works on every backend), adaptive batch size on OOM,
    automatic fallback to CPU if the accelerator fails."""

    def _setup(self, model):
        import torch
        self.torch = torch
        self.dev = device()
        self.half = use_half()
        self.model = model.to(self.dev).eval()
        if self.half:
            self.model = self.model.half()
        self.batch = default_batch()

    def _to_cpu(self, reason):
        force_cpu(reason)
        self.dev = self.torch.device("cpu")
        self.half = False
        self.model = self.model.float().to(self.dev)
        self.batch = 8

    def _run_batches(self, n, make_input, forward):
        """make_input(i, j) -> CPU float tensor; forward(x_on_device) -> list of numpy outputs."""
        torch = self.torch
        outs = []
        i = 0
        while i < n:
            j = min(n, i + self.batch)
            x = make_input(i, j)
            try:
                with torch.inference_mode():
                    xd = x.to(self.dev)
                    if self.half:
                        xd = xd.half()
                    outs.append(forward(xd))
                i = j
            except Exception as e:  # OOM -> smaller batches; anything else -> CPU
                if _is_oom(e) and self.batch > 1:
                    _empty_cache()
                    self.batch = max(1, self.batch // 2)
                    log.info("мало видеопамяти — пачка уменьшена до %d", self.batch)
                elif self.dev.type != "cpu":
                    self._to_cpu(f"{type(e).__name__}: {str(e)[:120]}")
                else:
                    raise
        return outs


class Dino(_Runner):
    def __init__(self, name: str, size: int):
        _hf_home()
        import torch
        from transformers import AutoModel
        self._setup(AutoModel.from_pretrained(name))
        self.size = size
        self.grid = size // 14
        self.name = name
        self.dim = self.model.config.hidden_size
        self.mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
        self.std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)

    def _prep(self, imgs):
        torch = self.torch
        x = torch.from_numpy(np.ascontiguousarray(imgs)).permute(0, 3, 1, 2).float() / 255.0
        x = torch.nn.functional.interpolate(x, size=(self.size, self.size), mode="bilinear",
                                            antialias=True, align_corners=False)
        return (x - self.mean) / self.std

    def tokens(self, imgs: np.ndarray, batch=None) -> np.ndarray:
        """imgs (B,H,W,3) uint8 -> patch tokens (B, G, G, D) float32 and CLS (B, D)."""
        if batch:
            self.batch = batch
        G = self.grid

        def fwd(x):
            h = self.model(pixel_values=x).last_hidden_state
            tok = h[:, -G * G:, :].reshape(h.shape[0], G, G, -1)
            return tok.float().cpu().numpy(), h[:, 0, :].float().cpu().numpy()
        res = self._run_batches(len(imgs), lambda i, j: self._prep(imgs[i:j]), fwd)
        return np.concatenate([r[0] for r in res]), np.concatenate([r[1] for r in res])


class Siglip(_Runner):
    def __init__(self, name: str):
        _hf_home()
        from transformers import AutoModel, AutoProcessor
        self._setup(AutoModel.from_pretrained(name))
        self.proc = AutoProcessor.from_pretrained(name)
        self.name = name
        cfg = getattr(self.model.config, "vision_config", None)
        self.size = getattr(cfg, "image_size", 224) or 224
        self.scale = float(self.model.logit_scale.exp().item()) if hasattr(self.model, "logit_scale") else 100.0
        self.bias = float(self.model.logit_bias.item()) if hasattr(self.model, "logit_bias") else 0.0
        self.text = {k: self._text(v) for k, v in ZS_PROMPTS.items()}

    def _text(self, prompts):
        torch = self.torch
        inp = self.proc(text=prompts, padding="max_length", return_tensors="pt")
        inp = {k: v for k, v in inp.items() if k in ("input_ids", "attention_mask")}
        for attempt in range(2):
            try:
                with torch.inference_mode():
                    t = _features(self.model.get_text_features(**{k: v.to(self.dev) for k, v in inp.items()})).float()
                break
            except Exception as e:
                if attempt or self.dev.type == "cpu":
                    raise
                self._to_cpu(f"{type(e).__name__}: {str(e)[:120]}")
        t = t / t.norm(dim=-1, keepdim=True)
        return t.cpu().numpy()

    def _prep(self, imgs):
        torch = self.torch
        x = torch.from_numpy(np.ascontiguousarray(imgs)).permute(0, 3, 1, 2).float() / 255.0
        x = torch.nn.functional.interpolate(x, size=(self.size, self.size), mode="bicubic",
                                            antialias=True, align_corners=False).clamp(0, 1)
        return (x - 0.5) / 0.5

    def image_embeddings(self, imgs: np.ndarray, batch=None, tta: bool = False) -> np.ndarray:
        """L2-normalised embeddings. tta=True averages the 4 rotations (top-down imagery has no 'up'),
        which makes the scores of single crops much less noisy."""
        if tta:
            embs = [self.image_embeddings(np.ascontiguousarray(np.rot90(imgs, k, axes=(1, 2))), batch) for k in range(4)]
            e = np.mean(embs, axis=0)
            return e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-8)
        if batch:
            self.batch = batch

        def fwd(x):
            e = _features(self.model.get_image_features(pixel_values=x)).float()
            e = e / e.norm(dim=-1, keepdim=True)
            return e.cpu().numpy()
        return np.concatenate(self._run_batches(len(imgs), lambda i, j: self._prep(imgs[i:j]), fwd))

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


def use_tta() -> bool:
    v = settings().get("tta", "auto")
    if v == "auto":
        try:
            b = backend()
            return b in ("cuda", "rocm", "mps") or (b == "xpu" and (vram_gb() or 0) >= 8)
        except Exception:
            return False
    return bool(v)


def dino_input_size() -> int:
    v = settings()["dino_input"]
    if v == "auto":
        try:
            b = backend()
            if b in ("cuda", "rocm", "xpu"):
                return 448 if (vram_gb() or 0) >= 4 else 224
            return 448 if b == "mps" else 224   # DirectML (often integrated GPUs) and CPU: 224
        except Exception:
            return 224
    return int(v)


def get_dino() -> Dino:
    name = settings()["dino_model"]
    size = dino_input_size()
    key = ("dino", name, size)
    with _lock:
        if key not in _cache:
            log.info("loading %s @%d on %s", name, size, backend())
            _cache[key] = Dino(name, size)
        return _cache[key]


def get_siglip() -> Siglip:
    name = settings()["siglip_model"]
    key = ("siglip", name)
    with _lock:
        if key not in _cache:
            log.info("loading %s on %s", name, backend())
            _cache[key] = Siglip(name)
        return _cache[key]


def prefetch_models():
    print(device_info())
    d = get_dino()
    print("DINOv2:", d.name, "input", d.size, "batch", d.batch, "fp16" if d.half else "fp32")
    s = get_siglip()
    print("SigLIP:", s.name)
    # quick self-test on the chosen device (falls back to CPU automatically if the GPU path fails)
    d.tokens(np.zeros((2, 256, 256, 3), np.uint8))
    s.image_embeddings(np.zeros((2, 256, 256, 3), np.uint8))
    print("Самопроверка моделей: OK —", device_info())
    return 0
