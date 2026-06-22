#!/usr/bin/env sh
set -eu

REMOTE_HOST="${KOALA_REMOTE_HOST:-}"
REMOTE_USER="${KOALA_REMOTE_USER:-deploy}"
REMOTE_DIR="${KOALA_REMOTE_DIR:-/opt/koalachat}"
ARCHIVE="koalachat-deploy.tar.gz"

if [ -z "$REMOTE_HOST" ]; then
  echo "ERROR: Set KOALA_REMOTE_HOST to your server hostname or IP."
  echo "Example: export KOALA_REMOTE_HOST=chat.example.com"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo " KoalaChat Deploy"
echo " Target: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
echo ""

echo "[1/5] Syncing logo assets..."
python scripts/generate_icons.py

echo "[2/5] Creating deployment archive..."
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" \
  --exclude="__pycache__" \
  --exclude="*.pyc" \
  --exclude="terminals" \
  --exclude="certs" \
  --exclude="*.pem" \
  --exclude=".git" \
  --exclude=".venv" \
  --exclude="venv" \
  --exclude=".env" \
  backend frontend docker scripts logo.png docker-compose.yml .dockerignore .env.example LICENSE README.md SECURITY.md

echo "[3/5] Preparing remote directory..."
ssh -o ConnectTimeout=10 "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p ${REMOTE_DIR}"

echo "[4/5] Uploading via SCP..."
scp -o ConnectTimeout=30 "$ARCHIVE" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

echo "[5/5] Stopping old server and starting fresh..."
if ! ssh "${REMOTE_USER}@${REMOTE_HOST}" "cd ${REMOTE_DIR} && tar -xzf ${ARCHIVE} && chmod +x scripts/remote-start.sh && sh scripts/remote-start.sh"; then
  rm -f "$ARCHIVE"
  echo ""
  echo "ERROR: Remote start failed. KoalaChat may not be running on ${REMOTE_HOST}."
  echo "Check logs: ssh ${REMOTE_USER}@${REMOTE_HOST} 'cd ${REMOTE_DIR} && docker compose logs --tail 80'"
  exit 1
fi

rm -f "$ARCHIVE"

echo ""
echo " Deploy complete."
echo " App: https://${REMOTE_HOST}:8999"
echo " Verify: curl -sk https://${REMOTE_HOST}:8999/health"
echo ""