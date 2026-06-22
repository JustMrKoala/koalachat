import asyncio
import json

import httpx
import websockets

BASE = "http://127.0.0.1:8999"
FP_A = "a" * 64
FP_B = "b" * 64


async def register_pair():
    async with httpx.AsyncClient() as client:
        r1 = await client.post(f"{BASE}/api/register", json={"key_fingerprint": FP_A})
        r2 = await client.post(f"{BASE}/api/register", json={"key_fingerprint": FP_B})
        return r1.json(), r2.json()


async def test_live_request():
    a1, a2 = await register_pair()
    received = []

    async with websockets.connect(f"ws://127.0.0.1:8999/ws/{a2['account_id']}") as ws2:
        async def listen():
            async for raw in ws2:
                received.append(json.loads(raw))

        task = asyncio.create_task(listen())
        await asyncio.sleep(0.3)

        async with websockets.connect(f"ws://127.0.0.1:8999/ws/{a1['account_id']}") as ws1:
            await ws1.send(
                json.dumps(
                    {
                        "type": "friend_request",
                        "to_friend_code": a2["friend_code"],
                        "fingerprint": FP_A,
                        "public_key": "cc" * 32,
                    }
                )
            )
            await asyncio.wait_for(ws1.recv(), timeout=3)

        await asyncio.sleep(0.5)
        task.cancel()

    assert any(m.get("type") == "friend_request" for m in received), "live request failed"
    print("live request ok")


async def test_offline_accept():
    a1, a2 = await register_pair()

    async with websockets.connect(f"ws://127.0.0.1:8999/ws/{a1['account_id']}") as ws1:
        await ws1.send(
            json.dumps(
                {
                    "type": "friend_request",
                    "to_friend_code": a2["friend_code"],
                    "fingerprint": FP_A,
                    "public_key": "cc" * 32,
                }
            )
        )
        await asyncio.wait_for(ws1.recv(), timeout=3)

    async with websockets.connect(f"ws://127.0.0.1:8999/ws/{a2['account_id']}") as ws2:
        pending = json.loads(await asyncio.wait_for(ws2.recv(), timeout=3))
        assert pending["type"] == "friend_request"
        await ws2.send(
            json.dumps(
                {
                    "type": "friend_accept",
                    "friend_id": a1["account_id"],
                    "public_key": "dd" * 32,
                    "fingerprint": FP_B,
                }
            )
        )
        await asyncio.wait_for(ws2.recv(), timeout=3)

    async with websockets.connect(f"ws://127.0.0.1:8999/ws/{a1['account_id']}") as ws1:
        accepted = json.loads(await asyncio.wait_for(ws1.recv(), timeout=3))
        assert accepted["type"] == "friend_accepted", accepted
        assert accepted["public_key"] == "dd" * 32
    print("offline accept ok")


async def main():
    await test_live_request()
    await test_offline_accept()
    print("all friend request tests passed")


if __name__ == "__main__":
    asyncio.run(main())