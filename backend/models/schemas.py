from pydantic import BaseModel, Field
from typing import Optional, List


class RegisterRequest(BaseModel):
    key_fingerprint: str = Field(..., min_length=64, max_length=64, pattern=r"^[0-9a-fA-F]{64}$")


class RegisterResponse(BaseModel):
    account_id: str
    friend_code: str
    key_fingerprint: str


class UsernameClaimRequest(BaseModel):
    account_id: str = Field(..., min_length=16, max_length=16)
    username: str = Field(..., min_length=3, max_length=20, pattern=r"^[a-zA-Z0-9_]+$")
    password_hash: str = Field(..., min_length=16, max_length=128)


class UsernameLoginRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=20)
    password_hash: str = Field(..., min_length=16, max_length=128)


class FriendRequestPayload(BaseModel):
    to_id: Optional[str] = Field(None, min_length=16, max_length=16)
    to_friend_code: Optional[str] = Field(None, min_length=10, max_length=10)
    fingerprint: str = Field(..., min_length=64, max_length=64)
    public_key: str = Field(..., min_length=1, max_length=200)


class FriendActionPayload(BaseModel):
    friend_id: str = Field(..., min_length=16, max_length=16)
    public_key: Optional[str] = None
    fingerprint: Optional[str] = None


class MessagePayload(BaseModel):
    recipient_id: str = Field(..., min_length=16, max_length=16)
    envelope: dict
    ttl: int = Field(3600, ge=0, le=86400 * 30)  # max 30 days


class GroupCreatePayload(BaseModel):
    group_id: str = Field(..., min_length=8, max_length=64)
    name: str = Field(..., min_length=1, max_length=64)
    member_ids: List[str] = Field(..., min_items=1, max_items=50)


class GroupMessagePayload(BaseModel):
    group_id: str = Field(..., min_length=8, max_length=64)
    envelope: dict
    ttl: int = Field(3600, ge=0, le=86400 * 30)


class PurgeRequest(BaseModel):
    account_id: str = Field(..., min_length=16, max_length=16)


class SystemWipeRequest(BaseModel):
    confirm: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    service: str
    version: Optional[str] = None


class ReadyResponse(BaseModel):
    status: str
    connections: int