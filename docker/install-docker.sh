#!/usr/bin/env bash
# Install Docker Engine + compose plugin in WSL Ubuntu 24.04, all traffic via the Windows proxy.
# Safe to re-run (idempotent).
set -euo pipefail
source /mnt/d/AI/llm-test/docker/wsl-env.sh status >/dev/null 2>&1 || true
# re-export proxy vars (wsl-env.sh only exports inside its own shell, so do it here)
GW=$(ip route show default | awk '/default/ {print $3}' | head -1)
export DEBIAN_FRONTEND=noninteractive
export http_proxy="http://$GW:12000" https_proxy="http://$GW:12000"
export HTTP_PROXY="http://$GW:12000" HTTPS_PROXY="http://$GW:12000"

if command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1; then
  echo "docker already installed: $(docker --version)"
else
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/ubuntu/gpg" -o /tmp/docker.gpg
  gpg --dearmor < /tmp/docker.gpg > /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  CODENAME=$(lsb_release -cs)
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Ensure docker group + current user can use it without sudo (WSL often runs as root).
id -n
if [ "$(id -u)" = "0" ]; then
  echo "running as root, docker usable directly"
fi

# Start the daemon (systemd present in this WSL) and enable it.
systemctl enable docker
systemctl start docker
sleep 3
docker version
docker info | sed -n '1,25p'
docker compose version
