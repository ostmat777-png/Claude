#!/usr/bin/env bash
# Linux / macOS launcher. On Windows use run.bat.
# Picks the PyTorch build automatically: NVIDIA (CUDA), AMD (ROCm), Intel Arc (XPU), Apple Silicon (MPS) or CPU.
# Override: ZAB_BACKEND=cu128|cu126|cu118|rocm6.4|xpu|cpu ./run.sh      Reinstall: ./run.sh --reinstall
set -e
cd "$(dirname "$0")"
ARGS=()
for a in "$@"; do
  if [ "$a" = "--reinstall" ]; then rm -f .venv/.installed; else ARGS+=("$a"); fi
done

detect_backend() {
  if [ -n "$ZAB_BACKEND" ]; then echo "$ZAB_BACKEND"; return; fi
  if [ "$(uname)" = "Darwin" ]; then echo "mac"; return; fi
  if command -v nvidia-smi >/dev/null 2>&1; then
    local q cc drv
    q=$(nvidia-smi --query-gpu=compute_cap,driver_version --format=csv,noheader 2>/dev/null | head -1)
    cc=$(echo "$q" | cut -d, -f1 | tr -d ' '); drv=$(echo "$q" | cut -d, -f2 | tr -d ' ' | cut -d. -f1)
    if [ -n "$drv" ]; then
      if awk "BEGIN{exit !($cc >= 12.0)}" 2>/dev/null; then echo cu128; return; fi
      if [ "$drv" -ge 570 ] 2>/dev/null && awk "BEGIN{exit !($cc >= 7.5)}" 2>/dev/null; then echo cu128; return; fi
      if [ "$drv" -ge 560 ] 2>/dev/null; then echo cu126; return; fi
      if [ "$drv" -ge 520 ] 2>/dev/null; then echo cu118; return; fi
    fi
  fi
  if [ -e /dev/kfd ] || command -v rocminfo >/dev/null 2>&1; then echo rocm6.4; return; fi
  if command -v lspci >/dev/null 2>&1 && lspci | grep -iE "VGA|Display" | grep -qiE "Intel.*(Arc|DG2|Battlemage)"; then echo xpu; return; fi
  echo cpu
}

if [ ! -f .venv/.installed ]; then
  command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  B=$(detect_backend)
  echo "PyTorch build: $B"
  rm -rf .venv
  uv venv .venv --python 3.12
  if [ "$B" = "mac" ]; then
    uv pip install --python .venv/bin/python torch torchvision || B=cpu
  else
    uv pip install --python .venv/bin/python torch torchvision --index-url "https://download.pytorch.org/whl/$B" || {
      echo "PyTorch for $B failed - installing the CPU version"; B=cpu
      uv pip install --python .venv/bin/python torch torchvision --index-url https://download.pytorch.org/whl/cpu || true; }
  fi
  uv pip install --python .venv/bin/python -r requirements.txt
  echo "$B" > .venv/backend.txt
  touch .venv/.installed
  .venv/bin/python -m zabroshki prefetch-models || true
fi
exec .venv/bin/python -m zabroshki "${ARGS[@]}"
