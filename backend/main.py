import json
import os
import secrets
import asyncio
import uuid
import time
import logging
from contextlib import asynccontextmanager
from typing import Optional, Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from config import settings
from middleware import SecurityHeadersMiddleware
from crypto.server_crypto import RelayKeyManager, ServerEnvelope
from storage.ephemeral import EphemeralStore, EphemeralMessage
from models.schemas import (
    RegisterRequest, RegisterResponse,
    UsernameClaimRequest, UsernameLoginRequest,
    FriendRequestPayload, FriendActionPayload,
    MessagePayload, GroupCreatePayload, GroupMessagePayload,
    PurgeRequest, SystemWipeRequest,
    HealthResponse, ReadyResponse,
)


FRONTEND_DIR = settings.frontend_dir
PORT = settings.port

store = EphemeralStore()
key_manager = RelayKeyManager()
envelope_crypto = ServerEnvelope(key_manager)
connections: dict[str, WebSocket] = {}

# Simple in-memory rate limiter for production hardening
class RateLimiter:
    def __init__(self, max_requests: int = 30, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window = window_seconds
        self._buckets: Dict[str, list] = {}
        self._lock = asyncio.Lock()

    async def allow(self, key: str) -> bool:
        now = time.time()
        async with self._lock:
            bucket = self._buckets.setdefault(key, [])
            # prune old
            cutoff = now - self.window
            bucket[:] = [t for t in bucket if t > cutoff]
            if len(bucket) >= self.max_requests:
                return False
            bucket.append(now)
            return True

# Rate limiters tuned for chat use
rl_register = RateLimiter(max_requests=5, window_seconds=300)   # 5 regs / 5min
rl_friend = RateLimiter(max_requests=20, window_seconds=60)     # friend ops
rl_message = RateLimiter(max_requests=120, window_seconds=60)   # 2/sec avg
rl_purge = RateLimiter(max_requests=3, window_seconds=60)

async def check_rate(rl: RateLimiter, key: str):
    if not await rl.allow(key):
        raise HTTPException(status_code=429, detail="Too many requests. Please slow down.")


async def notify_account_purged(purged_id: str, audience: set[str] | None = None):
    """Notify everyone the purged account has ever interacted with (1:1 + groups + historical messages).
    Sends to live connections immediately and queues for offline ones via pending_purges.
    """
    if audience is None:
        # Fallback (should not normally happen after changes)
        audience = set(store.get_friends(purged_id))
        # Best effort groups
        for gid in store.get_account_groups(purged_id):
            audience.update(store.get_group_members(gid))

    payload_peer = {"type": "peer_purged", "friend_id": purged_id}
    payload_account = {"type": "account_purged", "account_id": purged_id}

    for fid in audience:
        if fid == purged_id:
            continue
        friend_ws = connections.get(fid)
        if friend_ws:
            try:
                # Send both for compatibility with old/new clients
                await friend_ws.send_json(payload_peer)
                await friend_ws.send_json(payload_account)
            except Exception:
                if connections.get(fid) is friend_ws:
                    connections.pop(fid, None)
        else:
            # Queue so they get it on next connect
            store.add_pending_purge(fid, purged_id)


async def send_presence_snapshot(ws: WebSocket, account_id: str):
    friends = store.get_friends(account_id)
    online = [fid for fid in friends if fid in connections]
    await ws.send_json({"type": "presence_snapshot", "online": online})


async def broadcast_presence(account_id: str, status: str):
    friends = store.get_friends(account_id)
    payload = {"type": "presence", "friend_id": account_id, "status": status}
    for fid in friends:
        friend_ws = connections.get(fid)
        if friend_ws:
            try:
                await friend_ws.send_json(payload)
            except Exception:
                # Remove dead connection to prevent leaks and future slowdowns
                if connections.get(fid) is friend_ws:
                    connections.pop(fid, None)


def generate_account_id() -> str:
    return str(secrets.randbelow(9000000000000000) + 1000000000000000)


def generate_friend_code() -> str:
    return str(secrets.randbelow(9000000000) + 1000000000)


async def cleanup_loop():
    while True:
        await asyncio.sleep(30)
        try:
            store.purge_expired()
        except Exception as exc:
            logger.debug(f"cleanup purge error: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"KoalaChat starting (env={settings.env}, port={settings.port})")
    if os.environ.get("KOALA_WIPE_ON_START", "").strip() in ("1", "true", "yes"):
        key_manager.wipe()
        store.purge_all()
        connections.clear()
        logger.warning("Wipe on start executed")
    task = asyncio.create_task(cleanup_loop())
    yield
    task.cancel()
    key_manager.wipe()
    store.purge_all()
    connections.clear()
    logger.info("KoalaChat shutdown complete")


app = FastAPI(
    title="KoalaChat",
    version="1.6.2",
    lifespan=lifespan,
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None if settings.is_production else "/redoc",
    openapi_url=None if settings.is_production else "/openapi.json",
)

# Structured logging for production
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("koalachat")

app.add_middleware(SecurityHeadersMiddleware)
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

# Global exception handler for clean production errors
@app.exception_handler(HTTPException)
async def http_exc_handler(request: Request, exc: HTTPException):
    logger.warning(f"HTTP {exc.status_code}: {exc.detail} path={request.url.path}")
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

@app.exception_handler(Exception)
async def unhandled_exc_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled error: {type(exc).__name__}: {exc} path={request.url.path}", exc_info=settings.is_production is False)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/health", response_model=HealthResponse)
async def health():
    return {"status": "ok", "service": "koalachat", "version": app.version}


@app.get("/ready", response_model=ReadyResponse)
async def ready():
    return {"status": "ready", "connections": len(connections)}


@app.post("/api/register", response_model=RegisterResponse)
async def register(req: RegisterRequest):
    await check_rate(rl_register, "global:register")
    fingerprint = req.key_fingerprint
    for _ in range(20):
        account_id = generate_account_id()
        friend_code = generate_friend_code()
        if store.register_account(account_id, friend_code, fingerprint):
            logger.info(f"New account registered (masked): ...{account_id[-4:]}")
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


@app.get("/api/account/{account_id}/username")
async def get_account_username(account_id: str):
    if not store.account_exists(account_id):
        raise HTTPException(status_code=404, detail="Account not found")
    username = store.get_username_for_account(account_id)
    return {"username": username}


@app.get("/api/username/{username}/available")
async def username_available(username: str):
    u = (username or "").strip().lower()
    exists = store.username_exists(u)
    return {"available": not exists, "username": u}


@app.post("/api/username/claim")
async def claim_username(req: UsernameClaimRequest):
    await check_rate(rl_friend, f"username:{req.account_id}")
    ok = store.claim_username(req.account_id, req.username, req.password_hash)
    if not ok:
        raise HTTPException(status_code=409, detail="Username already taken or invalid")
    return {
        "status": "claimed",
        "username": store.get_username_for_account(req.account_id),
    }


@app.post("/api/username/login")
async def username_login(req: UsernameLoginRequest):
    await check_rate(rl_friend, f"login:{req.username}")
    account_id = store.authenticate_username(req.username, req.password_hash)
    if not account_id:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    friend_code = store.get_friend_code(account_id)
    fingerprint = store.get_fingerprint(account_id)
    return {
        "account_id": account_id,
        "friend_code": friend_code,
        "fingerprint": fingerprint,
        "username": store.get_username_for_account(account_id),
    }


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


@app.post("/api/system/wipe")
async def system_wipe(req: Optional[SystemWipeRequest] = None):
    # Admin-only like endpoint; rate limited heavily in practice by deployment
    await check_rate(rl_purge, "system:wipe")
    for ws in list(connections.values()):
        try:
            await ws.close(code=4001, reason="Server wiped")
        except Exception:
            pass
    connections.clear()
    key_manager.wipe()
    store.purge_all()
    logger.warning("SYSTEM WIPE executed")
    return {"status": "wiped"}


@app.post("/api/purge")
async def koala_purge(req: PurgeRequest):
    await check_rate(rl_purge, f"purge:{req.account_id}")
    account_id = req.account_id
    # wipe_account now collects the full historical audience and returns it
    audience = store.wipe_account(account_id)
    await notify_account_purged(account_id, audience)
    store.secure_wipe_buffers()
    if account_id in connections:
        try:
            await connections[account_id].send_json({"type": "purge_ack"})
        except Exception:
            pass
    logger.info(f"Account purged (masked): ...{account_id[-4:]}")
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

    # Deliver pending purges first so clients can scrub before seeing any historical data
    pending_purges = store.get_pending_purges(account_id)
    for purged_id in pending_purges:
        try:
            await ws.send_json({"type": "peer_purged", "friend_id": purged_id})
            await ws.send_json({"type": "account_purged", "account_id": purged_id})
        except Exception:
            pass
    if pending_purges:
        store.clear_pending_purges(account_id)

    pending = store.get_pending_messages(account_id)
    for msg in pending:
        if msg.group_id:
            client_envelope = unwrap_group_envelope(msg.group_id, account_id, msg.envelope)
            if client_envelope:
                await ws.send_json({
                    "type": "group_message",
                    "id": msg.id,
                    "group_id": msg.group_id,
                    "sender_id": msg.sender_id,
                    "envelope": client_envelope,
                    "ttl": msg.ttl,
                    "created_at": msg.created_at,
                })
        else:
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

    pending_groups = store.get_pending_group_events(account_id)
    for event in pending_groups:
        await ws.send_json(event)
    if pending_groups:
        store.clear_pending_group_events(account_id)

    pending_friends = store.get_pending_friend_requests(account_id)
    for fr in pending_friends:
        await ws.send_json({
            "type": "friend_request",
            "from_id": fr["from_id"],
            "from_friend_code": fr.get("from_friend_code", ""),
            "fingerprint": fr["fingerprint"],
            "public_key": fr.get("public_key", ""),
        })
    if pending_friends:
        store.clear_pending_friend_requests(account_id)

    pending_accepts = store.get_pending_friend_accepts(account_id)
    for fa in pending_accepts:
        await ws.send_json({
            "type": "friend_accepted",
            "friend_id": fa["friend_id"],
            "friend_code": fa.get("friend_code", ""),
            "public_key": fa.get("public_key", ""),
            "fingerprint": fa.get("fingerprint", ""),
        })
    if pending_accepts:
        store.clear_pending_friend_accepts(account_id)

    await send_presence_snapshot(ws, account_id)
    await broadcast_presence(account_id, "online")

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > 512 * 1024:  # 512KB hard cap on wire text
                await ws.send_json({"type": "error", "message": "Payload too large"})
                continue
            data = json.loads(raw)
            await handle_ws_message(account_id, data, ws)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.debug(f"WS error for account ...{account_id[-4:]}: {exc}")
    finally:
        if connections.get(account_id) is ws:
            del connections[account_id]
            await broadcast_presence(account_id, "offline")


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


def unwrap_group_envelope(group_id: str, recipient_id: str, server_envelope: dict) -> Optional[dict]:
    session_id = f"group:{group_id}:{recipient_id}"
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
        try:
            payload = FriendRequestPayload(**data)
        except ValidationError:
            await ws.send_json({"type": "error", "message": "Invalid friend request"})
            return
        to_id = payload.to_id
        to_friend_code = payload.to_friend_code or ""
        fingerprint = payload.fingerprint
        public_key = payload.public_key or ""
        if to_friend_code and not to_id:
            to_id = store.resolve_friend_code(to_friend_code)
        if not to_id:
            await ws.send_json({"type": "error", "message": "Friend code not found"})
            return
        if not fingerprint or not public_key:
            await ws.send_json({"type": "error", "message": "Missing encryption keys"})
            return
        if to_id == account_id:
            await ws.send_json({"type": "error", "message": "Cannot add yourself"})
            return
        if not store.account_exists(to_id):
            await ws.send_json({"type": "error", "message": "Friend code not found"})
            return
        if store.are_friends(account_id, to_id):
            await ws.send_json({"type": "error", "message": "Already friends"})
            return
        # Rate limit friend requests
        if not await rl_friend.allow(f"fr:{account_id}"):
            await ws.send_json({"type": "error", "message": "Too many requests"})
            return
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
            store.remove_pending_friend_request(to_id, account_id)
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
        pending_pk = store.get_pending_public_key(account_id, friend_id)
        if store.accept_friend(account_id, friend_id):
            accept_payload = {
                "type": "friend_accepted",
                "friend_id": account_id,
                "friend_code": store.get_friend_code(account_id) or "",
                "public_key": public_key,
                "fingerprint": data.get("fingerprint", ""),
            }
            friend_ws = connections.get(friend_id)
            if friend_ws:
                await friend_ws.send_json(accept_payload)
                await friend_ws.send_json({
                    "type": "presence",
                    "friend_id": account_id,
                    "status": "online",
                })
            else:
                store.add_pending_friend_accept(
                    friend_id,
                    account_id,
                    accept_payload["friend_code"],
                    public_key,
                    accept_payload["fingerprint"],
                )
            await ws.send_json({
                "type": "friend_accepted",
                "friend_id": friend_id,
                "friend_code": store.get_friend_code(friend_id) or "",
                "public_key": pending_pk or "",
            })
            if connections.get(friend_id):
                await ws.send_json({
                    "type": "presence",
                    "friend_id": friend_id,
                    "status": "online",
                })
        return

    if msg_type == "friend_remove":
        friend_id = data.get("friend_id")
        if not friend_id:
            return
        if store.remove_friend(account_id, friend_id):
            friend_ws = connections.get(friend_id)
            if friend_ws:
                await friend_ws.send_json({
                    "type": "friend_removed",
                    "friend_id": account_id,
                })
        return

    if msg_type == "typing":
        recipient_id = data.get("recipient_id")
        if not recipient_id:
            return
        if not store.are_friends(account_id, recipient_id):
            return
        recipient_ws = connections.get(recipient_id)
        if recipient_ws:
            await recipient_ws.send_json({
                "type": "typing",
                "from_id": account_id,
                "active": bool(data.get("active")),
            })
        return

    if msg_type == "message":
        try:
            payload = MessagePayload(**data)
        except ValidationError:
            await ws.send_json({"type": "error", "message": "Invalid message"})
            return
        recipient_id = payload.recipient_id
        client_envelope = payload.envelope
        ttl = payload.ttl
        if not recipient_id or not client_envelope:
            return
        if not store.are_friends(account_id, recipient_id):
            await ws.send_json({"type": "error", "message": "Not friends"})
            return
        if not await rl_message.allow(f"msg:{account_id}"):
            await ws.send_json({"type": "error", "message": "Rate limited"})
            return

        # Enforce reasonable envelope size (~256KB max)
        try:
            env_size = len(json.dumps(client_envelope))
            if env_size > 256 * 1024:
                await ws.send_json({"type": "error", "message": "Message too large"})
                return
        except Exception:
            pass

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

    if msg_type == "group_create":
        try:
            payload = GroupCreatePayload(**data)
        except ValidationError:
            await ws.send_json({"type": "error", "message": "Invalid group"})
            return
        group_id = payload.group_id
        name = payload.name.strip()[:64]
        member_ids = payload.member_ids or []
        if not group_id or not name or len(member_ids) < 1:
            await ws.send_json({"type": "error", "message": "Invalid group"})
            return
        valid_members = []
        for mid in member_ids:
            if mid == account_id:
                continue
            if not store.are_friends(account_id, mid):
                await ws.send_json({"type": "error", "message": "All members must be friends"})
                return
            valid_members.append(mid)
        if not valid_members:
            await ws.send_json({"type": "error", "message": "Add at least one friend"})
            return
        if not await rl_friend.allow(f"groupcreate:{account_id}"):
            await ws.send_json({"type": "error", "message": "Too many requests"})
            return
        if not store.create_group(group_id, name, account_id, valid_members):
            await ws.send_json({"type": "error", "message": "Group already exists"})
            return
        members = store.get_group_members(group_id)
        created_payload = {
            "type": "group_created",
            "group_id": group_id,
            "name": name,
            "creator_id": account_id,
            "members": members,
        }
        await ws.send_json(created_payload)
        for mid in members:
            if mid == account_id:
                continue
            member_ws = connections.get(mid)
            if member_ws:
                await member_ws.send_json(created_payload)
            else:
                store.add_pending_group_event(mid, created_payload)
        return

    if msg_type == "group_message":
        try:
            payload = GroupMessagePayload(**data)
        except ValidationError:
            await ws.send_json({"type": "error", "message": "Invalid group message"})
            return
        group_id = payload.group_id
        client_envelope = payload.envelope
        ttl = payload.ttl
        if not group_id or not client_envelope:
            return
        if not store.is_group_member(account_id, group_id):
            await ws.send_json({"type": "error", "message": "Not a group member"})
            return
        if not await rl_message.allow(f"gmsg:{account_id}"):
            await ws.send_json({"type": "error", "message": "Rate limited"})
            return
        try:
            if len(json.dumps(client_envelope)) > 256 * 1024:
                await ws.send_json({"type": "error", "message": "Message too large"})
                return
        except Exception:
            pass
        members = store.get_group_members(group_id)
        payload_bytes = json.dumps(client_envelope).encode()
        msg_id = str(uuid.uuid4())
        for mid in members:
            if mid == account_id:
                continue
            session_id = f"group:{group_id}:{mid}"
            server_envelope = envelope_crypto.encrypt(session_id, payload_bytes)
            msg = EphemeralMessage(
                id=str(uuid.uuid4()),
                sender_id=account_id,
                recipient_id=mid,
                envelope=server_envelope,
                ttl=ttl,
                group_id=group_id,
            )
            recipient_ws = connections.get(mid)
            if recipient_ws:
                await recipient_ws.send_json({
                    "type": "group_message",
                    "id": msg.id,
                    "group_id": group_id,
                    "sender_id": account_id,
                    "envelope": client_envelope,
                    "ttl": ttl,
                    "created_at": msg.created_at,
                })
            else:
                store.store_message(msg)
        await ws.send_json({"type": "message_sent", "id": msg_id})
        return

    if msg_type == "group_leave":
        group_id = data.get("group_id")
        if not group_id:
            return
        if store.leave_group(account_id, group_id):
            members = store.get_group_members(group_id)
            payload = {
                "type": "group_member_left",
                "group_id": group_id,
                "member_id": account_id,
                "members": members,
            }
            for mid in members:
                member_ws = connections.get(mid)
                if member_ws:
                    await member_ws.send_json(payload)
                else:
                    store.add_pending_group_event(mid, payload)
        return

    if msg_type == "purge":
        audience = store.wipe_account(account_id)
        await notify_account_purged(account_id, audience)
        store.secure_wipe_buffers()
        await ws.send_json({"type": "purge_ack"})
        return


NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}


@app.get("/manifest.json")
async def manifest():
    return FileResponse(
        FRONTEND_DIR / "manifest.json",
        media_type="application/manifest+json",
        headers=NO_CACHE,
    )


@app.get("/sw.js")
async def service_worker():
    return FileResponse(
        FRONTEND_DIR / "sw.js",
        media_type="application/javascript",
        headers=NO_CACHE,
    )


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/")
    async def index():
        return FileResponse(FRONTEND_DIR / "index.html", headers=NO_CACHE)

    @app.get("/{path:path}")
    async def spa_fallback(path: str):
        if path == "ws" or path.startswith("ws/"):
            raise HTTPException(status_code=404, detail="Not found")
        file_path = FRONTEND_DIR / path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(FRONTEND_DIR / "index.html", headers=NO_CACHE)


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