#!/usr/bin/env sh
set -eu

PORT="${KOALA_PORT:-8999}"
PUBLIC_HOST="${KOALA_PUBLIC_HOST:-chat.justmrkoalaai.nl}"
if [ -z "${KOALA_TLS_SAN_IP:-}" ]; then
  KOALA_TLS_SAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
export KOALA_TLS_SAN_IP
export KOALA_PUBLIC_HOST="$PUBLIC_HOST"
export KOALA_BEHIND_PROXY=1

set_env() {
  key="$1"
  value="$2"
  if [ -f .env ] && grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

set_env KOALA_TLS_SAN_IP "$KOALA_TLS_SAN_IP"
set_env KOALA_BEHIND_PROXY 1
set_env KOALA_BIND 0.0.0.0
set_env KOALA_PORT "$PORT"
set_env KOALA_ENV production
set_env KOALA_PUBLIC_HOST "$PUBLIC_HOST"

HEALTH_URL="http://127.0.0.1:${PORT}/health"
MAX_HEALTH_ATTEMPTS=30
HEALTH_INTERVAL=2

dc() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo docker compose version >/dev/null 2>&1; then
    sudo docker compose "$@"
    return
  fi
  echo "ERROR: docker compose is not available. Install Docker Compose or add this user to the docker group."
  exit 1
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -tln | grep -q ":${PORT} "
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | grep -q ":${PORT} "
    return $?
  fi
  return 1
}

wait_for_port_free() {
  attempt=0
  while port_in_use; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 15 ]; then
      echo "Port ${PORT} is still in use after docker compose down."
      if command -v fuser >/dev/null 2>&1; then
        echo "Releasing port ${PORT}..."
        fuser -k "${PORT}/tcp" 2>/dev/null || true
        sleep 2
      fi
      if port_in_use; then
        echo "ERROR: Port ${PORT} is still occupied. Free it manually and redeploy."
        ss -tln 2>/dev/null | grep ":${PORT} " || netstat -tln 2>/dev/null | grep ":${PORT} " || true
        exit 1
      fi
      return
    fi
    sleep 1
  done
}

container_running() {
  state="$(dc ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk '$1=="koalachat"{print $2; exit}')"
  [ "$state" = "running" ]
}

wait_for_health() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "WARNING: curl not found on remote host; skipping HTTP health check."
    return 0
  fi
  attempt=0
  while [ "$attempt" -lt "$MAX_HEALTH_ATTEMPTS" ]; do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      echo "Health check passed: ${HEALTH_URL}"
      return 0
    fi
    if curl -skf "https://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      echo "ERROR: Backend is serving HTTPS on port ${PORT}. Nginx requires HTTP (KOALA_BEHIND_PROXY=1)."
      dc logs --tail 40 2>/dev/null || true
      return 1
    fi
    attempt=$((attempt + 1))
    echo "Waiting for KoalaChat to become healthy (${attempt}/${MAX_HEALTH_ATTEMPTS})..."
    sleep "$HEALTH_INTERVAL"
  done
  echo "ERROR: KoalaChat did not pass /health within $((MAX_HEALTH_ATTEMPTS * HEALTH_INTERVAL)) seconds."
  return 1
}

npm_detected() {
  if command -v docker >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qiE 'nginx-proxy-manager|npm|proxy-manager'; then
      return 0
    fi
  fi
  if curl -sf --max-time 3 http://127.0.0.1/ 2>/dev/null | grep -qi 'nginx proxy manager'; then
    return 0
  fi
  return 1
}

wait_for_proxy() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "WARNING: curl not found; skipping reverse-proxy health check."
    return 0
  fi

  if npm_detected; then
    if curl -sf -H "Host: ${PUBLIC_HOST}" "http://127.0.0.1/health" >/dev/null 2>&1; then
      echo "NPM proxy check passed: http://${PUBLIC_HOST}/health"
      return 0
    fi
    echo "WARNING: NPM proxy host for ${PUBLIC_HOST} is not forwarding yet."
    echo "Configure NPM: scheme http, forward ${KOALA_TLS_SAN_IP}:${PORT}, websockets on."
    return 0
  fi

  attempt=0
  while [ "$attempt" -lt 10 ]; do
    if curl -skf "https://127.0.0.1/health" >/dev/null 2>&1; then
      echo "Nginx health check passed: https://127.0.0.1/health"
      return 0
    fi
    attempt=$((attempt + 1))
    echo "Waiting for nginx to proxy KoalaChat (${attempt}/10)..."
    sleep 2
  done
  echo "ERROR: Nginx is not returning /health on port 443."
  if command -v sudo >/dev/null 2>&1; then
    sudo tail -10 /var/log/nginx/error.log 2>/dev/null || true
  fi
  return 1
}

echo "Stopping existing KoalaChat stack..."
if ! dc down --remove-orphans --timeout 30; then
  echo "WARNING: docker compose down returned a non-zero exit code."
fi

wait_for_port_free

export KOALA_WIPE_ON_START=1

echo "Building KoalaChat image (no cache)..."
if ! KOALA_BEHIND_PROXY=1 dc build --no-cache; then
  echo "ERROR: docker compose build --no-cache failed."
  exit 1
fi

echo "Starting KoalaChat (force recreate)..."
if dc up --help 2>&1 | grep -q -- '--wait'; then
  if ! KOALA_BEHIND_PROXY=1 dc up -d --force-recreate --remove-orphans --wait; then
    echo "ERROR: docker compose up --wait failed."
    dc ps -a 2>/dev/null || true
    dc logs --tail 80 2>/dev/null || true
    exit 1
  fi
elif ! KOALA_BEHIND_PROXY=1 dc up -d --force-recreate --remove-orphans; then
  echo "ERROR: docker compose up failed."
  dc ps -a 2>/dev/null || true
  dc logs --tail 80 2>/dev/null || true
  exit 1
else
  sleep 15
fi

echo "Container status:"
dc ps -a

if ! container_running; then
  echo "ERROR: koalachat container is not running."
  dc logs --tail 80 2>/dev/null || true
  exit 1
fi

if ! wait_for_health; then
  dc logs --tail 80 2>/dev/null || true
  exit 1
fi

echo "Configuring reverse proxy..."
if ! sh "$ROOT/scripts/setup-nginx.sh"; then
  echo "ERROR: reverse-proxy setup failed."
  exit 1
fi

if ! wait_for_proxy; then
  exit 1
fi

if npm_detected; then
  echo "KoalaChat backend: http://${KOALA_TLS_SAN_IP}:${PORT}"
  echo "Public URL: https://${PUBLIC_HOST} (Cloudflare A record -> server, NPM proxy host)"
else
  echo "KoalaChat is running behind nginx on https://${KOALA_TLS_SAN_IP}"
fi