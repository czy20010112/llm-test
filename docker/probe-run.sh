#!/usr/bin/env bash
set -euo pipefail
GW=$(ip route show default | awk '/default/ {print $3}' | head -1)
export http_proxy="http://$GW:12000" https_proxy="http://$GW:12000"
export HTTP_PROXY="http://$GW:12000" HTTPS_PROXY="http://$GW:12000"
export HF_ENDPOINT="https://huggingface.co"

PY=python3
$PY -m pip install --quiet --break-system-packages --upgrade pip >/dev/null 2>&1 || true
for pkg in datasets "huggingface_hub" pandas pyarrow; do
  if ! $PY -c "import ${pkg//huggingface_hub/huggingface_hub}" >/dev/null 2>&1; then
    echo "installing $pkg ..."
    $PY -m pip install --quiet --break-system-packages "$pkg"
  fi
done
$PY -c "import datasets, huggingface_hub, pandas, pyarrow; print('deps ok', datasets.__version__, huggingface_hub.__version__)"
$PY /mnt/d/AI/llm-test/scripts/probe_benchmarks.py
