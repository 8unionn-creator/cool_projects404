#!/usr/bin/env bash
# Installs Wan2.2 and downloads the TI2V-5B model (about 34 GB).
# Needs Linux, an NVIDIA GPU with 24 GB+ of memory (e.g. RTX 4090), CUDA and Python 3.10-3.12.
set -euo pipefail
cd "$(dirname "$0")"

WAN_COMMIT=1ea34ff48f87168174e12956e200b1d908b1c5ff

if [ ! -d Wan2.2 ]; then
  git clone https://github.com/Wan-Video/Wan2.2 Wan2.2
fi
git -C Wan2.2 fetch -q origin "$WAN_COMMIT" 2>/dev/null || true
git -C Wan2.2 checkout -q "$WAN_COMMIT"

python3 -m venv .venv
PIP=.venv/bin/pip
$PIP install -q --upgrade pip setuptools wheel
$PIP install torch torchvision torchaudio
# flash_attn needs torch already installed to build, so it goes last.
grep -v '^flash_attn' Wan2.2/requirements.txt > .requirements-no-flash.txt
$PIP install -r .requirements-no-flash.txt "huggingface_hub[cli]"
rm .requirements-no-flash.txt
if ! $PIP install flash_attn --no-build-isolation; then
  echo "flash_attn failed to install. Wan2.2 needs it. Check that CUDA and nvcc are installed, then rerun." >&2
  exit 1
fi

if [ ! -d Wan2.2-TI2V-5B ]; then
  .venv/bin/hf download Wan-AI/Wan2.2-TI2V-5B --local-dir Wan2.2-TI2V-5B
fi

echo "Done. Now run: ./make_story.sh"
