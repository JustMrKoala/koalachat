from dataclasses import dataclass


@dataclass
class RegisterRequest:
    key_fingerprint: str


@dataclass
class RegisterResponse:
    account_id: str
    key_fingerprint: str


@dataclass
class PurgeRequest:
    account_id: str