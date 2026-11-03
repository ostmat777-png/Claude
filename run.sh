#!/usr/bin/env bash
# Linux/macOS launcher (development). On Windows use run.bat.
set -e
cd "$(dirname "$0")"
if [ ! -f .venv/.installed ]; then
  command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  uv venv .venv --python 3.12
  if command -v nvidia-smi >/dev/null; then IDX=https://download.pytorch.org/whl/cu128; else IDX=https://download.pytorch.org/whl/cpu; fi
  uv pip install --python .venv/bin/python torch torchvision --index-url "$IDX"
  uv pip install --python .venv/bin/python -r requirements.txt
  .venv/bin/python -m zabroshki prefetch-models || true
  touch .venv/.installed
fi
exec .venv/bin/python -m zabroshki "$@"
