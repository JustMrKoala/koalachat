import asyncio
import json
import ssl

import httpx
import websockets

FP_A = "a" * 64
FP_B = "b" * 64


async def test_endpoint(base: str, use_ssl: bool):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    async with httpx.AsyncClient(verify=False if use_ssl else True) as client:
        r1 = await client.post(f"{base}/api/register", json={"key_fingerprint": FP_A})
        r2 = await client.post(f"{base}/api/register", json={"key_fingerprint": FP_B})
        a1, a2 = r1.json(), r2.json()
    ws_base = base.replace("https", "wss").replace("http", "ws")
    ssl_ctx = ctx if use_ssl else None
    async with websockets.connect(f"{ws_base}/ws/{a1['account_id']}", ssl=ssl_ctx) as ws1:
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
        resp = json.loads(await asyncio.wait_for(ws1.recv(), timeout=5))
        print(base, "friend_request_sent:", resp.get("type"), resp)
    async with websockets.connect(f"{ws_base}/ws/{a2['account_id']}", ssl=ssl_ctx) as ws2:
        msg = json.loads(await asyncio.wait_for(ws2.recv(), timeout=5))
        print(base, "received:", msg.get("type"))


async def main():
    await test_endpoint("https://192.168.178.111:8999", True)
    await test_endpoint("http://127.0.0.1:8999", False)


if __name__ == "__main__":
    asyncio.run(main())