#!/usr/bin/env bash
# Run a python file inside WSL with the Windows-gateway proxy env vars set.
set -euo pipefail
GW=$(ip route show default | awk '/default/ {print $3}' | head -1)
export http_proxy="http://$GW:12000" https_proxy="http://$GW:12000"
export HTTP_PROXY="http://$GW:12000" HTTPS_PROXY="http://$GW:12000"
export NO_PROXY="localhost,127.0.0.1,172.16.0.0/12,192.168.0.0/16"
export no_proxy="$NO_PROXY"
export HF_HOME=/mnt/d/AI/llm-test/benchmarks/hf-cache
echo "proxy: $http_proxy"
exec python3 "$@"
