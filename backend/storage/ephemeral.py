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
    group_id: Optional[str] = None
    created_at: float = field(default_factory=time.time)

    @property
    def expired(self) -> bool:
        if self.ttl <= 0:
            return False
        return time.time() - self.created_at > self.ttl


@dataclass
class Group:
    id: str
    name: str
    creator_id: str
    members: set[str] = field(default_factory=set)
    created_at: float = field(default_factory=time.time)


class EphemeralStore:
    def __init__(self):
        self._messages: dict[str, EphemeralMessage] = {}
        self._messages_by_recipient: dict[str, set[str]] = {}  # recipient -> set of msg ids (for fast lookup)
        self._accounts: dict[str, dict] = {}
        self._friend_codes: dict[str, str] = {}
        self._friends: dict[str, set[str]] = {}
        self._pending_friends: dict[str, list[dict]] = {}
        self._pending_accepts: dict[str, list[dict]] = {}
        self._groups: dict[str, Group] = {}
        self._account_groups: dict[str, set[str]] = {}
        self._pending_group_events: dict[str, list[dict]] = {}
        self._usernames: dict[str, dict] = {}          # lower_username -> {account_id, password_hash, claimed_at}
        self._account_usernames: dict[str, str] = {}   # account_id -> lower_username
        self._interactions: dict[str, set[str]] = {}   # account_id -> set of accounts ever communicated with (for purge reach)
        self._pending_purges: dict[str, list[str]] = {}  # account_id -> list of purged account_ids to notify on connect
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
            self._record_interaction(msg.sender_id, msg.recipient_id)
            self._messages[msg.id] = msg
            if msg.recipient_id not in self._messages_by_recipient:
                self._messages_by_recipient[msg.recipient_id] = set()
            self._messages_by_recipient[msg.recipient_id].add(msg.id)

    def get_pending_messages(self, recipient_id: str) -> list[EphemeralMessage]:
        with self._lock:
            ids = self._messages_by_recipient.get(recipient_id, set())
            result = []
            to_remove = []
            for mid in list(ids):
                m = self._messages.get(mid)
                if not m or m.expired:
                    to_remove.append(mid)
                else:
                    result.append(m)
            for mid in to_remove:
                ids.discard(mid)
                self._messages.pop(mid, None)
            if not ids:
                self._messages_by_recipient.pop(recipient_id, None)
            return result

    def create_group(self, group_id: str, name: str, creator_id: str, member_ids: list[str]) -> bool:
        with self._lock:
            if group_id in self._groups:
                return False
            members = set(member_ids)
            members.add(creator_id)
            group = Group(id=group_id, name=name, creator_id=creator_id, members=members)
            self._groups[group_id] = group
            for mid in members:
                if mid not in self._account_groups:
                    self._account_groups[mid] = set()
                self._account_groups[mid].add(group_id)
            # Record interactions for purge propagation
            member_list = list(members)
            for i, mid in enumerate(member_list):
                for j in range(i + 1, len(member_list)):
                    self._record_interaction(mid, member_list[j])
            return True

    def get_group(self, group_id: str) -> Optional[Group]:
        with self._lock:
            return self._groups.get(group_id)

    def is_group_member(self, account_id: str, group_id: str) -> bool:
        with self._lock:
            group = self._groups.get(group_id)
            return group is not None and account_id in group.members

    def get_group_members(self, group_id: str) -> list[str]:
        with self._lock:
            group = self._groups.get(group_id)
            return list(group.members) if group else []

    def get_account_groups(self, account_id: str) -> list[str]:
        with self._lock:
            return list(self._account_groups.get(account_id, set()))

    def add_pending_group_event(self, account_id: str, event: dict):
        with self._lock:
            if account_id not in self._pending_group_events:
                self._pending_group_events[account_id] = []
            self._pending_group_events[account_id].append(event)

    def get_pending_group_events(self, account_id: str) -> list[dict]:
        with self._lock:
            return list(self._pending_group_events.get(account_id, []))

    def clear_pending_group_events(self, account_id: str):
        with self._lock:
            self._pending_group_events[account_id] = []

    def leave_group(self, account_id: str, group_id: str) -> bool:
        with self._lock:
            group = self._groups.get(group_id)
            if not group or account_id not in group.members:
                return False
            group.members.discard(account_id)
            self._account_groups.get(account_id, set()).discard(group_id)
            to_delete = [
                mid for mid, m in self._messages.items()
                if m.group_id == group_id
                and (m.sender_id == account_id or m.recipient_id == account_id)
            ]
            for mid in to_delete:
                m = self._messages.pop(mid, None)
                if m:
                    recips = self._messages_by_recipient.get(m.recipient_id)
                    if recips:
                        recips.discard(mid)
                        if not recips:
                            self._messages_by_recipient.pop(m.recipient_id, None)
            if len(group.members) == 0:
                del self._groups[group_id]
                for aid in self._account_groups:
                    self._account_groups[aid].discard(group_id)
            return True

    def delete_message(self, msg_id: str):
        with self._lock:
            m = self._messages.pop(msg_id, None)
            if m:
                recips = self._messages_by_recipient.get(m.recipient_id)
                if recips:
                    recips.discard(msg_id)
                    if not recips:
                        self._messages_by_recipient.pop(m.recipient_id, None)

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
            self._record_interaction(account_id, friend_id)
            return True

    def get_friends(self, account_id: str) -> list[str]:
        with self._lock:
            return list(self._friends.get(account_id, set()))

    def are_friends(self, a: str, b: str) -> bool:
        with self._lock:
            return b in self._friends.get(a, set())

    def remove_friend(self, account_id: str, friend_id: str) -> bool:
        with self._lock:
            if friend_id not in self._friends.get(account_id, set()):
                return False
            self._friends[account_id].discard(friend_id)
            if friend_id in self._friends:
                self._friends[friend_id].discard(account_id)
            to_delete = [
                mid for mid, m in self._messages.items()
                if (m.sender_id == account_id and m.recipient_id == friend_id)
                or (m.sender_id == friend_id and m.recipient_id == account_id)
            ]
            for mid in to_delete:
                m = self._messages.pop(mid, None)
                if m:
                    recips = self._messages_by_recipient.get(m.recipient_id)
                    if recips:
                        recips.discard(mid)
                        if not recips:
                            self._messages_by_recipient.pop(m.recipient_id, None)
            self._pending_friends[account_id] = [
                r for r in self._pending_friends.get(account_id, [])
                if r["from_id"] != friend_id
            ]
            self._pending_friends[friend_id] = [
                r for r in self._pending_friends.get(friend_id, [])
                if r["from_id"] != account_id
            ]
            return True

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

    def add_pending_purge(self, account_id: str, purged_id: str):
        with self._lock:
            if account_id not in self._pending_purges:
                self._pending_purges[account_id] = []
            if purged_id not in self._pending_purges[account_id]:
                self._pending_purges[account_id].append(purged_id)

    def get_pending_purges(self, account_id: str) -> list[str]:
        with self._lock:
            return list(self._pending_purges.get(account_id, []))

    def clear_pending_purges(self, account_id: str):
        with self._lock:
            self._pending_purges[account_id] = []

    # --- Username claim / login support ---

    def _normalize_username(self, username: str) -> str:
        return (username or "").strip().lower()

    def username_exists(self, username: str) -> bool:
        with self._lock:
            u = self._normalize_username(username)
            return u in self._usernames

    def get_username_for_account(self, account_id: str) -> Optional[str]:
        with self._lock:
            return self._account_usernames.get(account_id)

    def claim_username(self, account_id: str, username: str, password_hash: str) -> bool:
        with self._lock:
            if account_id not in self._accounts:
                return False
            u = self._normalize_username(username)
            if not u or len(u) < 3 or len(u) > 20:
                return False
            # Basic allowed chars: a-z 0-9 _
            if not all(c.isalnum() or c == "_" for c in u):
                return False
            if u in self._usernames:
                # already claimed by someone (could be same account)
                existing = self._usernames[u]
                if existing.get("account_id") != account_id:
                    return False
            # release any previous username this account had
            old_u = self._account_usernames.get(account_id)
            if old_u and old_u in self._usernames:
                del self._usernames[old_u]
            self._usernames[u] = {
                "account_id": account_id,
                "password_hash": password_hash,
                "claimed_at": time.time(),
            }
            self._account_usernames[account_id] = u
            return True

    def release_username_for_account(self, account_id: str):
        with self._lock:
            u = self._account_usernames.pop(account_id, None)
            if u and u in self._usernames:
                del self._usernames[u]

    def authenticate_username(self, username: str, password_hash: str) -> Optional[str]:
        with self._lock:
            u = self._normalize_username(username)
            entry = self._usernames.get(u)
            if not entry:
                return None
            if entry.get("password_hash") == password_hash:
                # Verify the account still exists
                if entry["account_id"] in self._accounts:
                    return entry["account_id"]
                else:
                    # stale, clean up
                    del self._usernames[u]
                    self._account_usernames.pop(entry["account_id"], None)
            return None

    def _record_interaction(self, a: str, b: str):
        if not a or not b or a == b:
            return
        if a not in self._interactions:
            self._interactions[a] = set()
        if b not in self._interactions:
            self._interactions[b] = set()
        self._interactions[a].add(b)
        self._interactions[b].add(a)

    def _purge_expired(self):
        # Assumes caller holds self._lock
        expired = [mid for mid, m in list(self._messages.items()) if m.expired]
        for mid in expired:
            m = self._messages.pop(mid, None)
            if m:
                recips = self._messages_by_recipient.get(m.recipient_id)
                if recips:
                    recips.discard(mid)
                    if not recips:
                        self._messages_by_recipient.pop(m.recipient_id, None)

    def purge_expired(self):
        """Public method that acquires the lock and purges expired messages."""
        with self._lock:
            self._purge_expired()

    def wipe_account(self, account_id: str):
        with self._lock:
            # Collect everyone this account has ever interacted with (friends, group members, message recipients)
            # so we can notify them to purge messages even if they are currently offline.
            audience: set[str] = set()
            audience.update(self._friends.get(account_id, set()))
            for gid in list(self._account_groups.get(account_id, set())):
                g = self._groups.get(gid)
                if g:
                    audience.update(g.members)
            audience.update(self._interactions.get(account_id, set()))
            audience.discard(account_id)

            to_delete = [
                mid for mid, m in self._messages.items()
                if m.sender_id == account_id or m.recipient_id == account_id
            ]
            for mid in to_delete:
                m = self._messages.pop(mid, None)
                if m:
                    recips = self._messages_by_recipient.get(m.recipient_id)
                    if recips:
                        recips.discard(mid)
                        if not recips:
                            self._messages_by_recipient.pop(m.recipient_id, None)
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
            for gid in list(self._account_groups.get(account_id, set())):
                group = self._groups.get(gid)
                if group:
                    group.members.discard(account_id)
                    if len(group.members) == 0:
                        del self._groups[gid]
            self._account_groups.pop(account_id, None)
            self._pending_group_events.pop(account_id, None)

            # Clean interactions
            self._interactions.pop(account_id, None)
            for other in list(self._interactions.keys()):
                self._interactions[other].discard(account_id)

            # Clean any pending purges referencing this account (they will be notified live instead)
            for aid in list(self._pending_purges.keys()):
                self._pending_purges[aid] = [p for p in self._pending_purges[aid] if p != account_id]

            # Release any claimed username
            self.release_username_for_account(account_id)
            acc = self._accounts.pop(account_id, None)
            if acc:
                self._friend_codes.pop(acc.get("friend_code", ""), None)

            return audience  # return so caller can notify live connections + queue pendings

    def purge_all(self):
        with self._lock:
            self._messages.clear()
            self._accounts.clear()
            self._friend_codes.clear()
            self._friends.clear()
            self._pending_friends.clear()
            self._pending_accepts.clear()
            self._groups.clear()
            self._account_groups.clear()
            self._pending_group_events.clear()
            self._usernames.clear()
            self._account_usernames.clear()
            self._interactions.clear()
            self._pending_purges.clear()
            self._messages_by_recipient.clear()

    def secure_wipe_buffers(self):
        with self._lock:
            self._messages.clear()
            self._messages_by_recipient.clear()