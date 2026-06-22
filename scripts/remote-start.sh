#!/usr/bin/env sh
set -eu

PORT="${KOALA_PORT:-8999}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HEALTH_URL="https://127.0.0.1:${PORT}/health"
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
    if curl -skf "$HEALTH_URL" >/dev/null 2>&1; then
      echo "Health check passed: ${HEALTH_URL}"
      return 0
    fi
    attempt=$((attempt + 1))
    echo "Waiting for KoalaChat to become healthy (${attempt}/${MAX_HEALTH_ATTEMPTS})..."
    sleep "$HEALTH_INTERVAL"
  done
  echo "ERROR: KoalaChat did not pass /health within $((MAX_HEALTH_ATTEMPTS * HEALTH_INTERVAL)) seconds."
  return 1
}

echo "Stopping existing KoalaChat stack..."
if ! dc down --remove-orphans --timeout 30; then
  echo "WARNING: docker compose down returned a non-zero exit code."
fi

wait_for_port_free

echo "Building and starting KoalaChat..."
if dc up --help 2>&1 | grep -q -- '--wait'; then
  if ! dc up -d --build --remove-orphans --wait; then
    echo "ERROR: docker compose up --wait failed."
    dc ps -a 2>/dev/null || true
    dc logs --tail 80 2>/dev/null || true
    exit 1
  fi
elif ! dc up -d --build --remove-orphans; then
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

echo "KoalaChat is running on port ${PORT}."