#!/usr/bin/env bash
# Clone SWE-bench harness (shallow) and install into a WSL venv.
set -uo pipefail

GW=$(ip route show default | awk '/default/ {print $3}' | head -1)
export http_proxy="http://$GW:12000" https_proxy="http://$GW:12000"
export HTTP_PROXY="http://$GW:12000" HTTPS_PROXY="http://$GW:12000"
export NO_PROXY="localhost,127.0.0.1,172.16.0.0/12,192.168.0.0/16"
export no_proxy="$NO_PROXY"
echo "proxy: http://$GW:12000"

REPO_DIR=/mnt/d/AI/llm-test/swe
VENV=~/venvs/swe

echo "== 1/3 shallow clone SWE-bench -> $REPO_DIR =="
if [ -d "$REPO_DIR/.git" ]; then
  echo "already cloned, fetching"
  git -C "$REPO_DIR" fetch --depth 1 origin || echo "WARN fetch failed (offline?)"
else
  git clone --depth 1 https://github.com/SWE-bench/SWE-bench "$REPO_DIR" || {
    echo "WARN: SWE-bench org failed, trying princeton-nlp"
    git clone --depth 1 https://github.com/princeton-nlp/SWE-bench "$REPO_DIR"
  }
fi
git -C "$REPO_DIR" log --oneline -1

echo "== 2/3 create venv $VENV =="
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q -U pip

echo "== 3/3 pip install -e (SWE-bench harness) =="
"$VENV/bin/pip" install -e "$REPO_DIR" 2>&1 | tail -5

echo "== verify =="
"$VENV/bin/python" -c "import swebench; print('swebench import OK', swebench.__file__)"
