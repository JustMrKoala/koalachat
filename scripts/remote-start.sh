#!/usr/bin/env sh
set -eu

PORT="${KOALA_PORT:-8999}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Stopping existing KoalaChat processes on port ${PORT}..."

docker compose down --remove-orphans 2>/dev/null || true

if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti ":${PORT}" 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null || true
  fi
fi

sleep 1

echo "Building and starting KoalaChat..."
if ! docker compose up -d --build --wait 2>/dev/null; then
  docker compose up -d --build
  sleep 15
fi

docker compose ps

if command -v curl >/dev/null 2>&1; then
  if curl -skf "https://127.0.0.1:${PORT}/health" >/dev/null; then
    echo "Health check passed."
    exit 0
  fi
  echo "WARNING: Container is up but /health did not respond. Check: docker compose logs"
  exit 1
fi

echo "Started. Verify at https://$(hostname -f 2>/dev/null || hostname):${PORT}"