# KoalaChat

Privacy-first, end-to-end encrypted instant messaging. Anonymous accounts, ephemeral messages, and a blind server relay with layered encryption.

## Features

- **Client-side E2EE** — AES-256-GCM with the KoalaMix protocol (ratcheted keys, padded packets, blind tokens)
- **Server envelope encryption** — outer layer on E2EE payloads at rest; server never sees plaintext
- **Separate IDs** — 16-digit account ID (private) and 10-digit friend code (shareable)
- **Ephemeral messages** — configurable TTL with automatic wipe
- **Koala Purge** — one-tap irreversible local and server buffer wipe
- **PWA** — installable on iOS and Android with fullscreen standalone mode
- **Anti-tamper** — screenshot/recording mitigations, blur on tab switch
- **Tor-friendly** — works via Tor Browser or system proxy

## Architecture

```
Browser (E2EE + KoalaMix)
        |
        |  WSS / HTTPS
        v
FastAPI relay (port 8999)
  - WebSocket blind forwarding
  - Server envelope encryption at rest
  - Ephemeral in-memory storage (auto-purged)
```

| Component | Path |
|-----------|------|
| Backend | `backend/` — FastAPI, WebSockets, crypto relay |
| Frontend | `frontend/` — PWA, Web Crypto API, KoalaMix |
| Docker | `docker/` — production image and entrypoint |

## Quick Start (Docker)

**Requirements:** Docker 24+ with Compose plugin

```bash
git clone https://github.com/your-org/koalachat.git
cd koalachat
cp .env.example .env
docker compose up -d --build
```

Open **https://localhost:8999** (accept the self-signed certificate on first run).

```bash
docker compose logs -f        # view logs
docker compose down         # stop
curl -sk https://localhost:8999/health
```

## Local Development

**Requirements:** Python 3.12+

```bash
make install
make dev
```

Open **http://127.0.0.1:8999** (no TLS in dev mode).

API docs available at `/docs` when `KOALA_ENV` is not `production`.

## Production Deployment

### Environment

Copy and edit the example config:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `KOALA_ENV` | `production` | Set to `production` to disable API docs |
| `KOALA_PORT` | `8999` | Host port mapping |
| `KOALA_ALLOWED_ORIGINS` | empty | Comma-separated CORS origins |
| `KOALA_ALLOW_SELF_SIGNED` | `1` | Allow auto-generated certs; set `0` in production |
| `TLS_SUBJECT` | `/CN=koalachat.local/...` | Subject for self-signed cert generation |
| `SSL_CERT` / `SSL_KEY` | `/certs/cert.pem` | Mount real certificates for production |

### TLS with real certificates

Mount your certificate volume or bind-mount files:

```yaml
volumes:
  - ./certs/cert.pem:/certs/cert.pem:ro
  - ./certs/key.pem:/certs/key.pem:ro
```

Set `KOALA_ALLOW_SELF_SIGNED=0` so the container refuses to start without valid certs.

### Remote deploy

**Linux / macOS:**

```bash
export KOALA_REMOTE_HOST=your-server.example
export KOALA_REMOTE_USER=server
make deploy
```

**Windows:**

```bat
set KOALA_REMOTE_HOST=your-server.example
deploy.bat
```

Both scripts SCP the project and run `docker compose up -d --build` on the remote host.

### Health checks

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness — returns `{"status":"ok"}` |
| `GET /ready` | Readiness — includes active connection count |

## Usage

1. **Create Account** — generates keys locally; receive account ID + friend code
2. **Share friend code** — QR scan or manual entry (never share your account ID)
3. **Accept requests** — mutual approval required
4. **Chat** — messages are E2EE with disappearing TTL
5. **Koala Purge** — Settings → emergency wipe

## Security Model

| Credential | Digits | Share? | Purpose |
|------------|--------|--------|---------|
| Account ID | 16 | Never | WebSocket session credential |
| Friend Code | 10 | Yes | Add contacts via QR or manual entry |

Private keys never leave the browser. The server relays encrypted blobs only.

See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy.

## Project Structure

```
koalachat/
├── backend/
│   ├── main.py              # FastAPI app and WebSocket handlers
│   ├── config.py            # Environment configuration
│   ├── middleware.py        # Security headers
│   ├── crypto/              # Server envelope encryption
│   └── storage/             # Ephemeral in-memory store
├── frontend/
│   ├── index.html           # PWA shell
│   ├── js/crypto/           # E2EE + KoalaMix (client)
│   ├── css/                 # WhatsApp-style dark UI
│   ├── manifest.json        # PWA manifest
│   └── sw.js                # Service worker
├── docker/
│   ├── Dockerfile
│   └── entrypoint.sh
├── docker-compose.yml
├── deploy.sh / deploy.bat
├── Makefile
└── .github/workflows/ci.yml
```

## Development Commands

```bash
make help          # list all targets
make test          # backend smoke test
make icons         # sync logo.png to frontend/icons/
make docker-up     # build and start container
```

## CI

GitHub Actions runs on every push and pull request:

- Backend import and `/health` endpoint test
- Docker image build and container health check

## Publishing to GitHub

```bash
git init
git add .
git commit -m "Initial commit: KoalaChat v1.0"
git branch -M main
git remote add origin https://github.com/your-org/koalachat.git
git push -u origin main
```

Update the `org.opencontainers.image.source` label in `docker/Dockerfile` and clone URLs in this README with your repository path.

## License

[MIT](LICENSE)