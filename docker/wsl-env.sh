#!/usr/bin/env bash
# WSL side environment helpers for llm-test docker setup.
# Usage: bash /mnt/d/AI/llm-test/docker/wsl-env.sh <command>
set -euo pipefail

# Windows host NAT gateway IP (proxy lives there)
GW=$(ip route show default | awk '/default/ {print $3}' | head -1)
export WSL_WIN_GW="$GW"
export HTTP_PROXY="http://$GW:12000"
export HTTPS_PROXY="http://$GW:12000"
export http_proxy="http://$GW:12000"
export https_proxy="http://$GW:12000"
export NO_PROXY="localhost,127.0.0.1,172.16.0.0/12,192.168.0.0/16"
export no_proxy="$NO_PROXY"

case "${1:-status}" in
  status)
    echo "gateway=$GW"
    curl -s -o /dev/null -w "wsl_proxy_hf:%{http_code}\n" -x "$HTTP_PROXY" --max-time 20 https://huggingface.co/
    curl -s -o /dev/null -w "wsl_proxy_dh:%{http_code}\n" -x "$HTTP_PROXY" --max-time 20 https://download.docker.com/
    ;;
  *)
    shift
    bash -c "$*"
    ;;
esac
