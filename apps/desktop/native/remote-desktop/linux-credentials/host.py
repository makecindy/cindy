import asyncio
import base64
import hashlib
import time
import uuid

from channel import Channel, Error, decode, encode, identity, public, require


class Host:
    def __init__(self, directory, load_key, read_account, read_state, unlock):
        self.directory, self.load_key = directory, load_key
        self.read_account, self.read_state, self.unlock = read_account, read_state, unlock
        self.owner = self.key = None
        self.sessions, self.active, self.candidates = {}, {}, {}
        self.attempts = []
        self.verifying = False

    def close_handle(self, handle):
        state = self.sessions.pop(handle, None)
        if not state:
            return
        state["channel"].close()
        job = state.get("job")
        if job and job is not asyncio.current_task():
            job.cancel()
        for mapping in (self.active, self.candidates):
            if mapping.get(state["peer"]) == handle:
                del mapping[state["peer"]]

    def close_all(self):
        for handle in list(self.sessions):
            self.close_handle(handle)

    def current(self, handle, peer):
        state = self.sessions.get(handle)
        require(state is not None and state["peer"] == peer, "CANCELLED")
        state["channel"].active()
        require(self.read_account() == state["account"], "INVALID_IDENTITY")
        require(state["authorization"] is not None or time.monotonic() < state["until"], "EXPIRED")
        return state

    async def status(self):
        result = {}
        state = await self.read_state()
        for handle, item in list(self.sessions.items()):
            try:
                self.current(handle, item["peer"])
                if item["authorization"]:
                    require(state == "unlocked", "UNLOCK_UNAVAILABLE")
                    if self.active.get(item["peer"]) == handle:
                        result[item["peer"]] = item["authorization"]
            except Error:
                self.close_handle(handle)
        return result

    async def call(self, value):
        method = value["method"]
        if method == "configure":
            owner = tuple(value[x] for x in ("realm", "membership", "authDevice"))
            require(owner[0] in ("global", "cn") and identity(owner[1]) and identity(owner[2]), "INVALID_IDENTITY")
            require(await self.read_state() in ("locked", "unlocked"), "UNLOCK_UNAVAILABLE")
            if owner != self.owner:
                self.close_all()
                self.owner = self.key = None
                # No password operation here; Secret Service must already be available.
                key = self.load_key(self.directory, owner[0])
                self.owner, self.key = owner, key
            return encode(self.descriptor()).decode()
        if method == "updateToken":
            require(self.owner is not None and (value["realm"], value["membership"]) == self.owner[:2], "CANCELLED")
            return True
        if method == "status":
            return await self.status()
        if method in ("closeAll", "reset"):
            self.close_all()
            if method == "reset":
                self.owner = self.key = None
            return True
        if method == "close":
            peer = value["peer"]
            for handle in (self.active.get(peer), self.candidates.get(peer)):
                self.close_handle(handle)
            return True
        require(self.owner is not None, "INVALID_IDENTITY")
        if method == "begin":
            await self.status()
            peer = value["peer"]
            require(identity(peer) and len(value["descriptor"]) <= 4096, "INVALID_IDENTITY")
            descriptor = decode(value["descriptor"])
            require(descriptor["version"] == 1 and descriptor["device"] == peer
                    and descriptor["realm"] == self.owner[0] and descriptor["membership"] == self.owner[1], "INVALID_IDENTITY")
            old = self.sessions.get(self.candidates.get(peer))
            if old and old["offer"] == value["offer"]:
                return {"handle": self.candidates[peer], "offer": old["channel"].offer()}
            require(len({s["peer"] for s in self.sessions.values()}) < 8 or peer in self.candidates or peer in self.active, "UNAVAILABLE")
            require(await self.read_state() in ("locked", "unlocked"), "UNLOCK_UNAVAILABLE")
            channel = Channel(self.descriptor(), descriptor, self.key)
            channel.accept(value["offer"])
            self.close_handle(self.candidates.get(peer))
            handle = str(uuid.uuid4())
            self.sessions[handle] = {"peer": peer, "offer": value["offer"], "channel": channel,
                                     "account": self.read_account(), "until": time.monotonic() + 120,
                                     "authorization": None, "completed": {}, "pending": set()}
            self.candidates[peer] = handle
            return {"handle": handle, "offer": channel.offer()}
        state = self.current(value["handle"], value["peer"])
        channel = state["channel"]
        if method == "response":
            require(state["authorization"] and value["requestId"] in state["pending"], "INVALID_IDENTITY")
            require(await self.read_state() == "unlocked", "UNLOCK_UNAVAILABLE")
            self.current(value["handle"], value["peer"])
            state["pending"].remove(value["requestId"])
            return channel.send("response", {"id": value["requestId"], "payload": base64.b64encode(value["body"].encode()).decode(),
                                              "success": value["success"] is True})
        require(method == "receive")
        purpose, body = channel.receive(value["ciphertext"])
        if purpose == "revoke":
            self.close_handle(value["handle"])
            return {"kind": "closed"}
        if purpose == "ready":
            return {"kind": "reply", "ciphertext": channel.send("ready", state["account"])}
        if purpose == "authenticate":
            require(len(body) <= 8192)
            attempt = decode(body)
            require(str(uuid.UUID(attempt["id"])) == attempt["id"] and attempt["account"] == state["account"])
            password = base64.b64decode(attempt["password"], validate=True)
            require(0 < len(password) <= 4096 and b"\0" not in password)
            password.decode("utf-8")
            digest = hashlib.sha256(body).digest()
            completed = state["completed"].get(attempt["id"])
            if completed:
                require(completed[0] == digest)
                return {"kind": "reply", "ciphertext": channel.send("authentication-result", completed[1])}
            require(not self.verifying and not state["authorization"] and len(state["completed"]) < 5, "UNAVAILABLE")
            now = time.monotonic()
            self.attempts = [x for x in self.attempts if now - x < 60]
            require(len(self.attempts) < 5, "UNAVAILABLE")
            self.attempts.append(now)
            def current():
                self.current(value["handle"], value["peer"])
                require(self.candidates.get(value["peer"]) == value["handle"], "CANCELLED")
            current()
            result = {"id": attempt["id"], "account": state["account"], "accepted": False}
            self.verifying = True
            state["job"] = asyncio.current_task()
            try:
                await self.unlock(password, current)
                current()
                require(await self.read_state() == "unlocked", "UNLOCK_UNAVAILABLE")
                current()
                result["accepted"] = True
            except Error as error:
                if str(error) != "CREDENTIAL_INVALID_IDENTITY":
                    result["failure"] = str(error)
            except Exception:
                result["failure"] = "CREDENTIAL_UNAVAILABLE"
            finally:
                password = body = attempt = None
                self.verifying = False
                state.pop("job", None)
            current()
            state["completed"][result["id"]] = digest, result
            if result["accepted"]:
                self.close_handle(self.active.get(value["peer"]))
                state["authorization"] = str(uuid.uuid4())
                self.active[value["peer"]] = value["handle"]
                del self.candidates[value["peer"]]
            return {"kind": "reply", "ciphertext": channel.send("authentication-result", result)}
        if purpose == "authentication-status":
            require(len(body) <= 256)
            completed = state["completed"].get(decode(body)["id"])
            require(completed is not None)
            return {"kind": "reply", "ciphertext": channel.send("authentication-result", completed[1])}
        require(purpose == "request" and state["authorization"], "INVALID_IDENTITY")
        require(await self.read_state() == "unlocked", "UNLOCK_UNAVAILABLE")
        self.current(value["handle"], value["peer"])
        request = decode(body)
        require(identity(request["id"]) and request["id"] not in state["pending"] and len(state["pending"]) < 64)
        payload = base64.b64decode(request["payload"], validate=True).decode("utf-8")
        state["pending"].add(request["id"])
        return {"kind": "command", "id": request["id"], "body": payload, "authenticationSession": state["authorization"]}

    def descriptor(self):
        return {"version": 1, "realm": self.owner[0], "membership": self.owner[1],
                "device": self.owner[2], "publicKey": public(self.key)}
