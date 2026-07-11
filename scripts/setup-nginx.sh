#!/usr/bin/env sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${KOALA_PORT:-8999}"
PUBLIC_HOST="${KOALA_PUBLIC_HOST:-chat.justmrkoalaai.nl}"

run() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

set_env() {
  key="$1"
  value="$2"
  if [ -f .env ] && grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

SERVER_IP="${KOALA_TLS_SAN_IP:-}"
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

if [ -z "$SERVER_IP" ]; then
  echo "ERROR: Could not detect server IP."
  exit 1
fi

set_env KOALA_ENV production
set_env KOALA_BEHIND_PROXY 1
set_env KOALA_BIND 0.0.0.0
set_env KOALA_PORT "$PORT"
set_env KOALA_TLS_SAN_IP "$SERVER_IP"
set_env KOALA_ALLOW_SELF_SIGNED 1
set_env KOALA_PUBLIC_HOST "$PUBLIC_HOST"

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

if npm_detected; then
  echo "Nginx Proxy Manager detected skipping standalone nginx install."
  echo ""
  echo "NPM Proxy Host (http://127.0.0.1:81):"
  echo "  Domain: ${PUBLIC_HOST}"
  echo "  Scheme: http"
  echo "  Forward Hostname/IP: ${SERVER_IP} (or 127.0.0.1)"
  echo "  Forward Port: ${PORT}"
  echo "  Websockets Support: enabled"
  echo ""
  echo "Cloudflare DNS (dashboard only no tunnels):"
  echo "  Remove any CNAME to *.cfargotunnel.com for ${PUBLIC_HOST}"
  echo "  Add A record: ${PUBLIC_HOST} -> your server public IP"
  echo "  Proxy status: proxied (orange cloud) or DNS only both work with NPM"
  echo ""
  echo "Upstream must be http://${SERVER_IP}:${PORT}, not https."
  exit 0
fi

if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
  echo "ERROR: Run as root or with sudo."
  exit 1
fi

HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "")"

if ! command -v nginx >/dev/null 2>&1; then
  echo "Installing nginx..."
  if command -v apt-get >/dev/null 2>&1; then
    run apt-get update
    run apt-get install -y nginx openssl
  elif command -v dnf >/dev/null 2>&1; then
    run dnf install -y nginx openssl
  else
    echo "ERROR: Install nginx and openssl manually, then re-run."
    exit 1
  fi
  run systemctl enable nginx
fi

CONF_SRC="$ROOT/deploy/nginx-koalachat.conf"
CONF_DST="/etc/nginx/sites-available/koalachat"
CONF_LINK="/etc/nginx/sites-enabled/koalachat"

run cp "$CONF_SRC" "$CONF_DST"
run ln -sf "$CONF_DST" "$CONF_LINK"
run rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

OPENSSL_CFG="/tmp/koalachat-nginx-openssl.cnf"
cat > "$OPENSSL_CFG" <<EOF
[req]
default_bits = 4096
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = ${SERVER_IP}
O = KoalaChat
C = US

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = ${SERVER_IP}
EOF

if [ -n "$HOSTNAME_FQDN" ] && [ "$HOSTNAME_FQDN" != "localhost" ]; then
  echo "DNS.2 = ${HOSTNAME_FQDN}" >> "$OPENSSL_CFG"
fi

run mkdir -p /etc/ssl/private
run openssl req -x509 -nodes -newkey rsa:4096 -days 365 \
  -keyout /etc/ssl/private/koalachat.key \
  -out /etc/ssl/certs/koalachat.crt \
  -config "$OPENSSL_CFG" \
  -extensions v3_req
rm -f "$OPENSSL_CFG"

run nginx -t
run systemctl restart nginx
run systemctl enable nginx 2>/dev/null || true

echo "Nginx configured for https://${SERVER_IP}"