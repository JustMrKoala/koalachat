import os
import time
import hashlib
import secrets
from typing import Optional
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class RelayKeyManager:
    ROTATION_INTERVAL = 300

    def __init__(self):
        self._keys: dict[str, tuple[bytes, float]] = {}
        self._master_seed = secrets.token_bytes(32)

    def _derive_key(self, session_id: str, epoch: int) -> bytes:
        material = self._master_seed + session_id.encode() + epoch.to_bytes(8, "big")
        return hashlib.sha256(material).digest()

    def get_current_epoch(self) -> int:
        return int(time.time()) // self.ROTATION_INTERVAL

    def get_key(self, session_id: str) -> bytes:
        epoch = self.get_current_epoch()
        cache_key = f"{session_id}:{epoch}"
        if cache_key not in self._keys:
            key = self._derive_key(session_id, epoch)
            self._keys[cache_key] = (key, time.time())
            self._prune_old_keys()
        return self._keys[cache_key][0]

    def _prune_old_keys(self):
        now = time.time()
        stale = [k for k, (_, ts) in self._keys.items() if now - ts > self.ROTATION_INTERVAL * 3]
        for k in stale:
            key_bytes = self._keys[k][0]
            self._keys[k] = (b"\x00" * 32, 0)
            del self._keys[k]
            del key_bytes

    def wipe(self):
        for k in list(self._keys.keys()):
            self._keys[k] = (b"\x00" * 32, 0)
            del self._keys[k]
        self._master_seed = b"\x00" * 32
        self._master_seed = secrets.token_bytes(32)


class ServerEnvelope:
    def __init__(self, key_manager: RelayKeyManager):
        self._km = key_manager

    def encrypt(self, session_id: str, payload: bytes) -> dict:
        key = self._km.get_key(session_id)
        nonce = os.urandom(12)
        epoch = self._km.get_current_epoch()
        aad = f"{session_id}:{epoch}".encode()
        ciphertext = AESGCM(key).encrypt(nonce, payload, aad)
        return {
            "envelope": ciphertext.hex(),
            "nonce": nonce.hex(),
            "epoch": epoch,
            "session_id": session_id,
        }

    def decrypt(self, session_id: str, envelope_hex: str, nonce_hex: str, epoch: int) -> Optional[bytes]:
        try:
            key = self._derive_key_for_epoch(session_id, epoch)
            nonce = bytes.fromhex(nonce_hex)
            ciphertext = bytes.fromhex(envelope_hex)
            aad = f"{session_id}:{epoch}".encode()
            return AESGCM(key).decrypt(nonce, ciphertext, aad)
        except Exception:
            return None

    def _derive_key_for_epoch(self, session_id: str, epoch: int) -> bytes:
        material = self._km._master_seed + session_id.encode() + epoch.to_bytes(8, "big")
        return hashlib.sha256(material).digest()