FROM python:3.12-slim

LABEL org.opencontainers.image.title="KoalaChat" \
      org.opencontainers.image.description="Privacy-first end-to-end encrypted messaging relay" \
      org.opencontainers.image.source="https://github.com/your-org/koalachat" \
      org.opencontainers.image.version="1.6.2"

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r koala -g 1000 \
    && useradd -r -u 1000 -g koala -d /app -s /sbin/nologin koala

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY logo.png ./logo.png
RUN mkdir -p frontend/icons && cp logo.png frontend/icons/logo.png
COPY docker/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh \
    && chown -R koala:koala /app

ENV SSL_CERT=/certs/cert.pem \
    SSL_KEY=/certs/key.pem \
    PYTHONPATH=/app/backend \
    KOALA_ENV=production \
    KOALA_HOST=0.0.0.0 \
    KOALA_PORT=8999 \
    KOALA_FRONTEND_DIR=/app/frontend

EXPOSE 8999

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8999/health')"

ENTRYPOINT ["/entrypoint.sh"]