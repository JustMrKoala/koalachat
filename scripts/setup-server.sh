#!/usr/bin/env sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "$DETECTED_IP" ]; then
  DETECTED_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')"
fi
if [ -z "$DETECTED_IP" ]; then
  echo "ERROR: Could not detect server IP. Set KOALA_TLS_SAN_IP manually in .env"
  exit 1
fi

if [ -f .env ] && grep -q '^KOALA_TLS_SAN_IP=' .env 2>/dev/null; then
  sed -i "s/^KOALA_TLS_SAN_IP=.*/KOALA_TLS_SAN_IP=${DETECTED_IP}/" .env
else
  echo "KOALA_TLS_SAN_IP=${DETECTED_IP}" >> .env
fi

echo "KOALA_TLS_SAN_IP=${DETECTED_IP}"
echo "Regenerating TLS certificate and restarting..."

dc() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  sudo docker compose "$@"
}

dc down --timeout 30
dc up -d --build --force-recreate

sleep 5
if [ -x "$ROOT/scripts/setup-nginx.sh" ]; then
  sh "$ROOT/scripts/setup-nginx.sh"
fi
if command -v curl >/dev/null 2>&1; then
  curl -skf "https://127.0.0.1/health" >/dev/null && echo "Health check passed via nginx."
fi

echo ""
echo "Done. Open https://${DETECTED_IP} and hard-refresh (Ctrl+Shift+R)."
echo "Create a new account if the dot stays orange."