"""Fake OS backend for the independent Node JOSE interoperability test only."""
import asyncio
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from channel import decode, encode, jwk, require
from host import Host


async def run():
    key = jwk.JWK.generate(kty="EC", crv="P-256")
    locked = True
    async def state():
        return "locked" if locked else "unlocked"
    async def unlock(password, current):
        nonlocal locked
        current()
        require(password == b"fake-interop-password", "INVALID_IDENTITY")
        locked = False
    host = Host("/unused", lambda *_: key, lambda: {"name": "fake-user", "recordID": "fake-record"}, state, unlock)
    for line in sys.stdin.buffer:
        value = decode(line)
        try:
            result = await host.call(value)
            print(encode({"id": value["id"], "result": result}).decode(), flush=True)
        except Exception:
            print(encode({"id": value["id"], "error": "rejected"}).decode(), flush=True)


asyncio.run(run())
