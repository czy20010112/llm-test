#!/usr/bin/env bash
# Build & start the code-judge container, install the host forwarder, smoke-test.
#
# Architecture: the judge container sits on an INTERNAL docker network
# (zero egress, enforced by Docker — no default gateway). Port publishing
# does not work on internal networks, so a socat systemd unit
# (llmtest-judge-proxy.service) forwards 127.0.0.1:8901 -> 172.18.0.2:8901.
# The container IP is pinned in judge-compose.yaml.
#
# Prereq: run ensure-docker.sh as root first (daemon proxy for image pulls).
# Steps 1-2 need root:  sudo bash judge-setup.sh   (or wsl -u root)
set -uo pipefail
cd /mnt/d/AI/llm-test/docker

if [ "$(id -u)" -ne 0 ]; then
  echo "NOTE: running as user; host-forwarder steps (1,2) need root."
fi

echo "== 1/5 install socat + forwarder unit (root) =="
if [ "$(id -u)" -eq 0 ]; then
  dpkg -l socat >/dev/null 2>&1 || {
    GW=$(ip route show default | awk '/default/ {print $3}' | head -1)
    export http_proxy="http://$GW:12000" https_proxy="http://$GW:12000"
    apt-get install -y socat
  }
  cp llmtest-judge-proxy.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable llmtest-judge-proxy
else
  echo "skipped (rerun as root to install the forwarder unit)"
fi

echo "== 2/5 build image =="
docker compose -f judge-compose.yaml build 2>&1 | tail -3

echo "== 3/5 (re)create container =="
docker compose -f judge-compose.yaml up -d 2>&1 | tail -3

echo "== 4/5 start forwarder + wait for health =="
if [ "$(id -u)" -eq 0 ]; then systemctl restart llmtest-judge-proxy; fi
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8901/health >/dev/null 2>&1; then
    echo "judge healthy after ${i}s"; break
  fi
  sleep 1
done
curl -s http://127.0.0.1:8901/health; echo

echo "== 5/5 smoke tests =="
curl -s -X POST http://127.0.0.1:8901/judge -H 'content-type: application/json' -d '{
  "mode": "stdin",
  "code": "import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)",
  "test_pairs": [
    {"input": "1 2", "expected": "3"},
    {"input": "10 20", "expected": "30"},
    {"input": "1 5", "expected": "6"}
  ],
  "timeout": 10
}'; echo
curl -s -X POST http://127.0.0.1:8901/judge -H 'content-type: application/json' -d '{
  "mode": "stdin",
  "code": "while True: pass",
  "test_pairs": [{"input": "x", "expected": "y"}],
  "timeout": 5
}' | head -c 400; echo
