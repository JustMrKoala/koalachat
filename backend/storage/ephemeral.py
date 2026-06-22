import time
import threading
from typing import Optional
from dataclasses import dataclass, field


@dataclass
class EphemeralMessage:
    id: str
    sender_id: str
    recipient_id: str
    envelope: dict
    ttl: int
    created_at: float = field(default_factory=time.time)

    @property
    def expired(self) -> bool:
        return time.time() - self.created_at > self.ttl


class EphemeralStore:
    def __init__(self):
        self._messages: dict[str, EphemeralMessage] = {}
        self._accounts: dict[str, dict] = {}
        self._friend_codes: dict[str, str] = {}
        self._friends: dict[str, set[str]] = {}
        self._pending_friends: dict[str, list[dict]] = {}
        self._pending_accepts: dict[str, list[dict]] = {}
        self._lock = threading.Lock()

    def register_account(self, account_id: str, friend_code: str, key_fingerprint: str) -> bool:
        with self._lock:
            if account_id in self._accounts or friend_code in self._friend_codes:
                return False
            self._accounts[account_id] = {
                "friend_code": friend_code,
                "key_fingerprint": key_fingerprint,
                "created_at": time.time(),
            }
            self._friend_codes[friend_code] = account_id
            self._friends[account_id] = set()
            self._pending_friends[account_id] = []
            self._pending_accepts[account_id] = []
            return True

    def resolve_friend_code(self, friend_code: str) -> Optional[str]:
        with self._lock:
            return self._friend_codes.get(friend_code)

    def get_friend_code(self, account_id: str) -> Optional[str]:
        with self._lock:
            acc = self._accounts.get(account_id)
            return acc["friend_code"] if acc else None

    def friend_code_exists(self, friend_code: str) -> bool:
        with self._lock:
            return friend_code in self._friend_codes

    def account_exists(self, account_id: str) -> bool:
        with self._lock:
            return account_id in self._accounts

    def get_fingerprint(self, account_id: str) -> Optional[str]:
        with self._lock:
            acc = self._accounts.get(account_id)
            return acc["key_fingerprint"] if acc else None

    def store_message(self, msg: EphemeralMessage):
        with self._lock:
            self._purge_expired()
            self._messages[msg.id] = msg

    def get_pending_messages(self, recipient_id: str) -> list[EphemeralMessage]:
        with self._lock:
            self._purge_expired()
            return [
                m for m in self._messages.values()
                if m.recipient_id == recipient_id and not m.expired
            ]

    def delete_message(self, msg_id: str):
        with self._lock:
            if msg_id in self._messages:
                del self._messages[msg_id]

    def add_friend_request(self, from_id: str, to_id: str, fingerprint: str, public_key: str = "", from_friend_code: str = "") -> bool:
        with self._lock:
            if to_id not in self._pending_friends:
                self._pending_friends[to_id] = []
            for req in self._pending_friends[to_id]:
                if req["from_id"] == from_id:
                    req.update({
                        "from_friend_code": from_friend_code,
                        "fingerprint": fingerprint,
                        "public_key": public_key,
                        "timestamp": time.time(),
                    })
                    return False
            self._pending_friends[to_id].append({
                "from_id": from_id,
                "from_friend_code": from_friend_code,
                "fingerprint": fingerprint,
                "public_key": public_key,
                "timestamp": time.time(),
            })
            return True

    def get_pending_friend_requests(self, account_id: str) -> list[dict]:
        with self._lock:
            return list(self._pending_friends.get(account_id, []))

    def clear_pending_friend_requests(self, account_id: str):
        with self._lock:
            self._pending_friends[account_id] = []

    def remove_pending_friend_request(self, account_id: str, from_id: str):
        with self._lock:
            self._pending_friends[account_id] = [
                r for r in self._pending_friends.get(account_id, [])
                if r["from_id"] != from_id
            ]

    def get_pending_public_key(self, account_id: str, friend_id: str) -> Optional[str]:
        with self._lock:
            for req in self._pending_friends.get(account_id, []):
                if req["from_id"] == friend_id:
                    return req.get("public_key", "")
            return None

    def reject_friend_request(self, account_id: str, friend_id: str):
        with self._lock:
            self._pending_friends[account_id] = [
                r for r in self._pending_friends.get(account_id, [])
                if r["from_id"] != friend_id
            ]

    def accept_friend(self, account_id: str, friend_id: str) -> bool:
        with self._lock:
            if account_id not in self._friends or friend_id not in self._accounts:
                return False
            self._friends[account_id].add(friend_id)
            self._friends[friend_id].add(account_id)
            self._pending_friends[account_id] = [
                r for r in self._pending_friends.get(account_id, [])
                if r["from_id"] != friend_id
            ]
            return True

    def get_friends(self, account_id: str) -> list[str]:
        with self._lock:
            return list(self._friends.get(account_id, set()))

    def are_friends(self, a: str, b: str) -> bool:
        with self._lock:
            return b in self._friends.get(a, set())

    def add_pending_friend_accept(self, to_id: str, friend_id: str, friend_code: str, public_key: str, fingerprint: str = ""):
        with self._lock:
            if to_id not in self._pending_accepts:
                self._pending_accepts[to_id] = []
            for item in self._pending_accepts[to_id]:
                if item["friend_id"] == friend_id:
                    item.update({
                        "friend_code": friend_code,
                        "public_key": public_key,
                        "fingerprint": fingerprint,
                        "timestamp": time.time(),
                    })
                    return
            self._pending_accepts[to_id].append({
                "friend_id": friend_id,
                "friend_code": friend_code,
                "public_key": public_key,
                "fingerprint": fingerprint,
                "timestamp": time.time(),
            })

    def get_pending_friend_accepts(self, account_id: str) -> list[dict]:
        with self._lock:
            return list(self._pending_accepts.get(account_id, []))

    def clear_pending_friend_accepts(self, account_id: str):
        with self._lock:
            self._pending_accepts[account_id] = []

    def _purge_expired(self):
        expired = [mid for mid, m in self._messages.items() if m.expired]
        for mid in expired:
            del self._messages[mid]

    def wipe_account(self, account_id: str):
        with self._lock:
            to_delete = [
                mid for mid, m in self._messages.items()
                if m.sender_id == account_id or m.recipient_id == account_id
            ]
            for mid in to_delete:
                del self._messages[mid]
            if account_id in self._friends:
                for friend in self._friends[account_id]:
                    self._friends.get(friend, set()).discard(account_id)
                del self._friends[account_id]
            self._pending_friends.pop(account_id, None)
            self._pending_accepts.pop(account_id, None)
            for aid in self._pending_friends:
                self._pending_friends[aid] = [
                    r for r in self._pending_friends[aid]
                    if r["from_id"] != account_id
                ]
            acc = self._accounts.pop(account_id, None)
            if acc:
                self._friend_codes.pop(acc.get("friend_code", ""), None)

    def purge_all(self):
        with self._lock:
            self._messages.clear()
            for aid in list(self._pending_friends.keys()):
                self._pending_friends[aid].clear()
            for aid in list(self._pending_accepts.keys()):
                self._pending_accepts[aid].clear()

    def secure_wipe_buffers(self):
        with self._lock:
            self._messages.clear()