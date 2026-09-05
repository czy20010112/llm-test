#!/usr/bin/env bash
# Idempotent: point the docker daemon at the current Windows NAT gateway proxy,
# (re)start docker, wait for the socket and verify with hello-world.
set -uo pipefail

GW=$(ip route show default | awk '/default/ {print $3}' | head -1)
if [ -z "${GW:-}" ]; then
  echo "ERROR: no default gateway found (not in WSL?)" >&2
  exit 1
fi

mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/proxy.conf <<EOF
[Service]
Environment="HTTP_PROXY=http://${GW}:12000"
Environment="HTTPS_PROXY=http://${GW}:12000"
Environment="NO_PROXY=localhost,127.0.0.1,172.16.0.0/12,192.168.0.0/16"
EOF
echo "proxy drop-in -> http://${GW}:12000"

systemctl daemon-reload
systemctl restart docker

for i in $(seq 1 30); do
  if [ -S /var/run/docker.sock ] && docker info >/dev/null 2>&1; then
    echo "docker socket ready"
    break
  fi
  sleep 1
done

docker version --format 'client {{.Client.Version}} / server {{.Server.Version}}'
if docker image inspect hello-world >/dev/null 2>&1; then
  echo "hello-world image already present"
else
  docker run --rm hello-world >/dev/null 2>&1 && echo "hello-world pull+run OK" || echo "WARN: hello-world pull failed (check proxy)"
fi
docker compose version
