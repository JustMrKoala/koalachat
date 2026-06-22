#!/bin/sh
set -e

CERT_DIR="/certs"
mkdir -p "$CERT_DIR"

TLS_SUBJECT="${TLS_SUBJECT:-/CN=koalachat.local/O=KoalaChat/C=US}"
KOALA_HOST="${KOALA_HOST:-0.0.0.0}"
KOALA_PORT="${KOALA_PORT:-8999}"
KOALA_LOG_LEVEL="${KOALA_LOG_LEVEL:-info}"

if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
  if [ "$KOALA_ENV" = "production" ] && [ -z "$KOALA_ALLOW_SELF_SIGNED" ]; then
    echo "ERROR: Production requires TLS certificates mounted at $CERT_DIR"
    exit 1
  fi
  echo "Generating self-signed TLS certificate..."
  openssl req -x509 -newkey rsa:4096 \
    -keyout "$CERT_DIR/key.pem" \
    -out "$CERT_DIR/cert.pem" \
    -days 365 -nodes \
    -subj "$TLS_SUBJECT"
fi

chown -R koala:koala "$CERT_DIR"

cd /app/backend
exec su -s /bin/sh koala -c "exec uvicorn main:app \
  --host $KOALA_HOST \
  --port $KOALA_PORT \
  --ssl-certfile $SSL_CERT \
  --ssl-keyfile $SSL_KEY \
  --log-level $KOALA_LOG_LEVEL \
  --no-access-log"