#!/usr/bin/env bash
# Software verification environment, separate from the product installer.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container=spektralab-wine10
if ! docker container inspect "$container" >/dev/null 2>&1; then
  proxy_address="$(getent ahostsv4 proxy | awk 'NR==1 {print $1}')"
  test -n "$proxy_address"
  docker run -d --name "$container" \
    --add-host "proxy:$proxy_address" \
    --mount "type=bind,src=$repo,dst=/work" \
    --mount type=bind,src=/etc/ssl/certs/ca-certificates.crt,dst=/run/task-ca.pem,readonly \
    -e SSL_CERT_FILE=/run/task-ca.pem -e CURL_CA_BUNDLE=/run/task-ca.pem \
    debian:trixie-slim sleep infinity
else
  docker start "$container" >/dev/null
fi
docker exec "$container" sh -c '
  set -eu
  apt-get -o Acquire::https::CaInfo=/run/task-ca.pem update
  DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::https::CaInfo=/run/task-ca.pem install -y --no-install-recommends wine64 mesa-vulkan-drivers libvulkan1 xvfb xauth python3 nsis
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  /usr/lib/wine/wine64 --version
'
