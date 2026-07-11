#!/bin/sh
set -e

CERT_DIR="/certs"
SAN_MARKER="$CERT_DIR/generated.san"
mkdir -p "$CERT_DIR"

TLS_SUBJECT="${TLS_SUBJECT:-/CN=koalachat.local/O=KoalaChat/C=US}"
KOALA_HOST="${KOALA_HOST:-0.0.0.0}"
KOALA_PORT="${KOALA_PORT:-8999}"
KOALA_LOG_LEVEL="${KOALA_LOG_LEVEL:-info}"
TLS_SAN_IP="${TLS_SAN_IP:-}"
KOALA_TLS_HOST="${KOALA_TLS_HOST:-}"

build_desired_san() {
  desired="dns:koalachat.local,dns:localhost"
  if [ -n "$KOALA_TLS_HOST" ]; then
    desired="${desired},dns:${KOALA_TLS_HOST}"
  fi
  if [ -n "$TLS_SAN_IP" ]; then
    desired="${desired},ip:${TLS_SAN_IP}"
  fi
  echo "$desired"
}

cert_needs_regen() {
  if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
    return 0
  fi
  desired="$(build_desired_san)"
  if [ ! -f "$SAN_MARKER" ]; then
    return 0
  fi
  current="$(cat "$SAN_MARKER" 2>/dev/null || echo "")"
  [ "$current" != "$desired" ]
}

generate_cert() {
  desired="$(build_desired_san)"
  echo "Generating self-signed TLS certificate for ${desired}..."
  OPENSSL_CFG="$CERT_DIR/openssl.cnf"
  cat > "$OPENSSL_CFG" <<EOF
[req]
default_bits = 4096
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = koalachat.local
O = KoalaChat
C = US

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = koalachat.local
DNS.2 = localhost
EOF
  dns_idx=3
  if [ -n "$KOALA_TLS_HOST" ]; then
    echo "DNS.${dns_idx} = ${KOALA_TLS_HOST}" >> "$OPENSSL_CFG"
    dns_idx=$((dns_idx + 1))
  fi
  if [ -n "$TLS_SAN_IP" ]; then
    echo "IP.1 = ${TLS_SAN_IP}" >> "$OPENSSL_CFG"
  fi
  openssl req -x509 -newkey rsa:4096 \
    -keyout "$CERT_DIR/key.pem" \
    -out "$CERT_DIR/cert.pem" \
    -days 365 -nodes \
    -config "$OPENSSL_CFG" \
    -extensions v3_req
  rm -f "$OPENSSL_CFG"
  echo "$desired" > "$SAN_MARKER"
}

if [ "$KOALA_ENV" = "production" ] && [ -z "$KOALA_ALLOW_SELF_SIGNED" ]; then
  if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
    echo "ERROR: Production requires TLS certificates mounted at $CERT_DIR"
    exit 1
  fi
elif cert_needs_regen; then
  rm -f "$CERT_DIR/cert.pem" "$CERT_DIR/key.pem" "$SAN_MARKER"
  generate_cert
fi

chown -R koala:koala "$CERT_DIR"

cd /app/backend

case "${KOALA_BEHIND_PROXY:-}" in
  1|true|TRUE|yes|YES) ;;
  *)
    KOALA_BEHIND_PROXY=""
    ;;
esac

if [ -n "$KOALA_BEHIND_PROXY" ]; then
  exec su -s /bin/sh koala -c "exec uvicorn main:app \
    --host $KOALA_HOST \
    --port $KOALA_PORT \
    --log-level $KOALA_LOG_LEVEL \
    --proxy-headers \
    --forwarded-allow-ips='*' \
    --ws-ping-interval 20 \
    --ws-ping-timeout 20 \
    --no-access-log"
fi

exec su -s /bin/sh koala -c "exec uvicorn main:app \
  --host $KOALA_HOST \
  --port $KOALA_PORT \
  --ssl-certfile $SSL_CERT \
  --ssl-keyfile $SSL_KEY \
  --log-level $KOALA_LOG_LEVEL \
  --ws-ping-interval 20 \
  --ws-ping-timeout 20 \
  --no-access-log"