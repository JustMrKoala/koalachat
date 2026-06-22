import json
import secrets
import asyncio
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from middleware import SecurityHeadersMiddleware
from crypto.server_crypto import RelayKeyManager, ServerEnvelope
from storage.ephemeral import EphemeralStore, EphemeralMessage


FRONTEND_DIR = settings.frontend_dir
PORT = settings.port

store = EphemeralStore()
key_manager = RelayKeyManager()
envelope_crypto = ServerEnvelope(key_manager)
connections: dict[str, WebSocket] = {}


def generate_account_id() -> str:
    return str(secrets.randbelow(9000000000000000) + 1000000000000000)


def generate_friend_code() -> str:
    return str(secrets.randbelow(9000000000) + 1000000000)


async def cleanup_loop():
    while True:
        await asyncio.sleep(30)
        store._purge_expired()


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(cleanup_loop())
    yield
    task.cancel()
    key_manager.wipe()
    store.purge_all()


app = FastAPI(
    title="KoalaChat",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None if settings.is_production else "/redoc",
    openapi_url=None if settings.is_production else "/openapi.json",
)

app.add_middleware(SecurityHeadersMiddleware)
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )


@app.get("/health")
async def health():
    return {"status": "ok", "service": "koalachat"}


@app.get("/ready")
async def ready():
    return {"status": "ready", "connections": len(connections)}


@app.post("/api/register")
async def register(body: dict):
    fingerprint = body.get("key_fingerprint", "")
    if len(fingerprint) != 64:
        raise HTTPException(status_code=400, detail="Invalid fingerprint")
    for _ in range(20):
        account_id = generate_account_id()
        friend_code = generate_friend_code()
        if store.register_account(account_id, friend_code, fingerprint):
            return {
                "account_id": account_id,
                "friend_code": friend_code,
                "key_fingerprint": fingerprint,
            }
    raise HTTPException(status_code=503, detail="Registration failed")


@app.get("/api/account/{account_id}/exists")
async def account_exists(account_id: str):
    return {"exists": store.account_exists(account_id)}


@app.get("/api/account/{account_id}/friendcode")
async def get_account_friend_code(account_id: str):
    code = store.get_friend_code(account_id)
    if not code:
        raise HTTPException(status_code=404, detail="Account not found")
    return {"friend_code": code}


@app.get("/api/account/{account_id}/fingerprint")
async def get_fingerprint(account_id: str):
    fp = store.get_fingerprint(account_id)
    if not fp:
        raise HTTPException(status_code=404, detail="Account not found")
    return {"fingerprint": fp}


@app.get("/api/friendcode/{friend_code}/exists")
async def friend_code_exists(friend_code: str):
    return {"exists": store.friend_code_exists(friend_code)}


@app.get("/api/friendcode/{friend_code}")
async def lookup_friend_code(friend_code: str):
    account_id = store.resolve_friend_code(friend_code)
    if not account_id:
        raise HTTPException(status_code=404, detail="Friend code not found")
    fp = store.get_fingerprint(account_id)
    return {"friend_code": friend_code, "fingerprint": fp}


@app.get("/api/account/{account_id}/friends")
async def get_friends(account_id: str):
    if not store.account_exists(account_id):
        raise HTTPException(status_code=404, detail="Account not found")
    return {"friends": store.get_friends(account_id)}


@app.post("/api/purge")
async def koala_purge(body: dict):
    account_id = body.get("account_id", "")
    if not account_id:
        raise HTTPException(status_code=400, detail="Missing account_id")
    store.wipe_account(account_id)
    store.secure_wipe_buffers()
    if account_id in connections:
        try:
            await connections[account_id].send_json({"type": "purge_ack"})
        except Exception:
            pass
    return {"status": "purged"}


@app.websocket("/ws/{account_id}")
async def websocket_endpoint(ws: WebSocket, account_id: str):
    if not store.account_exists(account_id):
        await ws.close(code=4001, reason="Account not found")
        return

    await ws.accept()
    old = connections.get(account_id)
    if old:
        try:
            await old.close(code=4002, reason="Replaced")
        except Exception:
            pass
    connections[account_id] = ws

    pending = store.get_pending_messages(account_id)
    for msg in pending:
        client_envelope = unwrap_server_envelope(msg.sender_id, account_id, msg.envelope)
        if client_envelope:
            await ws.send_json({
                "type": "message",
                "id": msg.id,
                "sender_id": msg.sender_id,
                "envelope": client_envelope,
                "ttl": msg.ttl,
                "created_at": msg.created_at,
            })
        store.delete_message(msg.id)

    pending_friends = store.get_pending_friend_requests(account_id)
    for fr in pending_friends:
        await ws.send_json({
            "type": "friend_request",
            "from_id": fr["from_id"],
            "from_friend_code": fr.get("from_friend_code", ""),
            "fingerprint": fr["fingerprint"],
            "public_key": fr.get("public_key", ""),
        })

    try:
        while True:
            raw = await ws.receive_text()
            data = json.loads(raw)
            await handle_ws_message(account_id, data, ws)
    except WebSocketDisconnect:
        pass
    finally:
        if connections.get(account_id) is ws:
            del connections[account_id]


def unwrap_server_envelope(sender_id: str, recipient_id: str, server_envelope: dict) -> Optional[dict]:
    session_id = f"{sender_id}:{recipient_id}"
    payload = envelope_crypto.decrypt(
        session_id,
        server_envelope["envelope"],
        server_envelope["nonce"],
        server_envelope["epoch"],
    )
    if payload:
        return json.loads(payload.decode())
    return None


async def handle_ws_message(account_id: str, data: dict, ws: WebSocket):
    msg_type = data.get("type")

    if msg_type == "ping":
        await ws.send_json({"type": "pong"})
        return

    if msg_type == "friend_request":
        to_id = data.get("to_id")
        to_friend_code = data.get("to_friend_code", "")
        fingerprint = data.get("fingerprint")
        if to_friend_code and not to_id:
            to_id = store.resolve_friend_code(to_friend_code)
        if not to_id or not fingerprint:
            return
        if to_id == account_id:
            await ws.send_json({"type": "error", "message": "Cannot add yourself"})
            return
        if not store.account_exists(to_id):
            await ws.send_json({"type": "error", "message": "Friend code not found"})
            return
        public_key = data.get("public_key", "")
        from_friend_code = store.get_friend_code(account_id) or ""
        store.add_friend_request(account_id, to_id, fingerprint, public_key, from_friend_code)
        recipient_ws = connections.get(to_id)
        if recipient_ws:
            await recipient_ws.send_json({
                "type": "friend_request",
                "from_id": account_id,
                "from_friend_code": from_friend_code,
                "fingerprint": fingerprint,
                "public_key": public_key,
            })
        await ws.send_json({"type": "friend_request_sent", "to_friend_code": to_friend_code or store.get_friend_code(to_id)})
        return

    if msg_type == "friend_reject":
        friend_id = data.get("friend_id")
        if friend_id:
            store.reject_friend_request(account_id, friend_id)
        return

    if msg_type == "friend_accept":
        friend_id = data.get("friend_id")
        public_key = data.get("public_key", "")
        if not friend_id:
            return
        if store.accept_friend(account_id, friend_id):
            friend_ws = connections.get(friend_id)
            if friend_ws:
                await friend_ws.send_json({
                    "type": "friend_accepted",
                    "friend_id": account_id,
                    "friend_code": store.get_friend_code(account_id) or "",
                    "public_key": public_key,
                    "fingerprint": data.get("fingerprint", ""),
                })
            pending_pk = store.get_pending_public_key(account_id, friend_id)
            await ws.send_json({
                "type": "friend_accepted",
                "friend_id": friend_id,
                "friend_code": store.get_friend_code(friend_id) or "",
                "public_key": pending_pk or "",
            })
        return

    if msg_type == "message":
        recipient_id = data.get("recipient_id")
        client_envelope = data.get("envelope")
        ttl = data.get("ttl", 3600)
        if not recipient_id or not client_envelope:
            return
        if not store.are_friends(account_id, recipient_id):
            await ws.send_json({"type": "error", "message": "Not friends"})
            return

        payload_bytes = json.dumps(client_envelope).encode()
        session_id = f"{account_id}:{recipient_id}"
        server_envelope = envelope_crypto.encrypt(session_id, payload_bytes)

        msg_id = str(uuid.uuid4())
        msg = EphemeralMessage(
            id=msg_id,
            sender_id=account_id,
            recipient_id=recipient_id,
            envelope=server_envelope,
            ttl=ttl,
        )

        client_envelope = json.loads(payload_bytes.decode())
        recipient_ws = connections.get(recipient_id)
        if recipient_ws:
            await recipient_ws.send_json({
                "type": "message",
                "id": msg_id,
                "sender_id": account_id,
                "envelope": client_envelope,
                "ttl": ttl,
                "created_at": msg.created_at,
            })
        else:
            store.store_message(msg)

        await ws.send_json({"type": "message_sent", "id": msg_id})
        return

    if msg_type == "purge":
        store.wipe_account(account_id)
        store.secure_wipe_buffers()
        await ws.send_json({"type": "purge_ack"})
        return


@app.get("/manifest.json")
async def manifest():
    return FileResponse(FRONTEND_DIR / "manifest.json", media_type="application/manifest+json")


@app.get("/sw.js")
async def service_worker():
    return FileResponse(FRONTEND_DIR / "sw.js", media_type="application/javascript")


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    async def index():
        return FileResponse(FRONTEND_DIR / "index.html")

    @app.get("/{path:path}")
    async def spa_fallback(path: str):
        file_path = FRONTEND_DIR / path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(FRONTEND_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        ssl_certfile=settings.ssl_cert or None,
        ssl_keyfile=settings.ssl_key or None,
        workers=settings.workers if not settings.ssl_cert else 1,
        log_level=settings.log_level,
        reload=False,
    )