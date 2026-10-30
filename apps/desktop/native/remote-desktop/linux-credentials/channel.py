"""Existing Cindy v1 credential wire protocol; secrets stay in this helper.

JOSE primitives come from JWCrypto, not an application cryptography implementation.
See packages/remote-credentials-native/{NativeChannel,SealedMessage}.swift.
"""
import base64
import hashlib
import json
import time
import uuid

from jwcrypto import jwk, jwe, jws

MAX_PACKET = 8 * 1024 * 1024
TYPE = "cindy-remote-desktop-v1"
OFFER_TYPE = "cindy-remote-desktop-offer-v1"
PURPOSES = {"ready", "authenticate", "authentication-result", "authentication-status",
            "request", "response", "revoke"}


class Error(Exception):
    def __init__(self, code="INVALID_MESSAGE"):
        super().__init__("CREDENTIAL_" + code)


def require(condition, code="INVALID_MESSAGE"):
    if not condition:
        raise Error(code)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def decode(value):
    def unique(pairs):
        result = {}
        for key, item in pairs:
            require(key not in result)
            result[key] = item
        return result
    return json.loads(value, object_pairs_hook=unique)


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64(value):
    require(isinstance(value, str) and 0 < len(value) <= MAX_PACKET)
    data = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    require(b64(data) == value)
    return data


def identity(value):
    return isinstance(value, str) and 0 < len(value.encode()) <= 512


def public(key):
    return decode(key.export_public())


def public_key(value, ephemeral=False):
    require(isinstance(value, dict))
    allowed = {"kty", "crv", "x", "y"} | ({"kid"} if ephemeral else set())
    require(set(value) <= allowed and value.get("kty") == "EC" and value.get("crv") == "P-256")
    require(len(unb64(value.get("x"))) == 32 and len(unb64(value.get("y"))) == 32)
    if "kid" in value:
        uuid.UUID(value["kid"])
    result = jwk.JWK(**{k: value[k] for k in ("kty", "crv", "x", "y")})
    result.get_op_key("verify")  # validate that the coordinates are on the curve
    return result


def header(packet, count):
    require(isinstance(packet, str) and len(packet) <= MAX_PACKET and len(packet.split(".")) == count)
    first = packet.split(".", 1)[0]
    require(len(first) <= 4096)
    value = decode(unb64(first))
    require(isinstance(value, dict))
    return value


def sign(body, key, offer=False):
    fields = {"alg": "ES256", "typ": OFFER_TYPE if offer else TYPE}
    if not offer:
        fields["cty"] = "JWE"
    signed = jws.JWS(body)
    signed.add_signature(key, protected=encode(fields).decode())
    return signed.serialize(compact=True)


def verify(packet, key, offer=False):
    expected = {"alg": "ES256", "typ": OFFER_TYPE if offer else TYPE}
    if not offer:
        expected["cty"] = "JWE"
    require(header(packet, 3) == expected)
    signed = jws.JWS()
    signed.allowed_algs = ["ES256"]
    signed.deserialize(packet)
    signed.verify(key, alg="ES256")
    return signed.payload


def seal(body, sender, recipient):
    require(len(body) <= MAX_PACKET // 2)
    encrypted = jwe.JWE(body, protected=encode({"alg": "ECDH-ES", "enc": "A256GCM", "typ": TYPE}).decode(),
                        algs=["ECDH-ES", "A256GCM"], recipient=recipient)
    return sign(encrypted.serialize(compact=True).encode(), sender)


def open_sealed(packet, sender, recipient):
    compact = verify(packet, sender).decode("ascii")
    fields = header(compact, 5)
    require(set(fields) == {"alg", "enc", "typ", "epk"})
    require(fields["alg"] == "ECDH-ES" and fields["enc"] == "A256GCM" and fields["typ"] == TYPE)
    public_key(fields["epk"], ephemeral=True)
    require(compact.split(".")[1] == "")
    encrypted = jwe.JWE(algs=["ECDH-ES", "A256GCM"])
    encrypted.deserialize(compact, key=recipient)
    require(len(encrypted.payload) <= MAX_PACKET // 2)
    return encrypted.payload


class Channel:
    def __init__(self, local, remote, key):
        require(local["realm"] in ("global", "cn") and local["realm"] == remote["realm"], "INVALID_IDENTITY")
        require(local["membership"] == remote["membership"] and identity(local["membership"]), "INVALID_IDENTITY")
        require(identity(local["device"]) and identity(remote["device"]) and local["device"] != remote["device"], "INVALID_IDENTITY")
        require(public(key) == local["publicKey"], "INVALID_IDENTITY")
        self.local, self.remote, self.key = local, remote, key
        self.remote_key = public_key(remote["publicKey"])
        self.ephemeral = jwk.JWK.generate(kty="EC", crv="P-256")
        self.deadline, self.wall_deadline = time.monotonic() + 1800, time.time() + 1800
        self.local_offer = {"domain": "cindy.remote-desktop.offer.v1", "realm": local["realm"],
                            "membership": local["membership"], "from": local["device"], "to": remote["device"],
                            "nonce": str(uuid.uuid4()), "ephemeral": public(self.ephemeral),
                            "expiresAt": int((time.time() + 60) * 1000)}
        self.remote_offer = None
        self.session = None
        self.confirmed = False
        self.outgoing = self.high = 0
        self.received = set()

    def active(self):
        require(self.key is not None and time.monotonic() < self.deadline and time.time() < self.wall_deadline, "EXPIRED")

    def offer(self):
        self.active()
        return sign(encode(self.local_offer), self.key, offer=True)

    def accept(self, packet):
        self.active()
        require(self.remote_offer is None and len(packet) <= 4096)
        value = decode(verify(packet, self.remote_key, offer=True))
        require(set(value) == set(self.local_offer))
        for field in ("domain", "realm", "membership"):
            require(value[field] == self.local_offer[field], "INVALID_IDENTITY")
        require(value["from"] == self.remote["device"] and value["to"] == self.local["device"], "INVALID_IDENTITY")
        now = time.time() * 1000
        require(type(value["expiresAt"]) is int and now < value["expiresAt"] <= now + 120000
                and self.local_offer["expiresAt"] > now and identity(value["nonce"]), "INVALID_IDENTITY")
        public_key(value["ephemeral"])
        self.session = b64(hashlib.sha256(encode(sorted([self.local_offer, value], key=lambda o: o["from"]))).digest())
        self.remote_offer = value

    def send(self, purpose, body):
        self.active()
        require(self.session is not None and purpose in PURPOSES and (purpose == "ready" or self.confirmed))
        self.outgoing += 1
        require(self.outgoing < 2 ** 64)
        return seal(encode({"domain": "cindy.remote-desktop.packet.v1", "session": self.session,
                            "from": self.local["device"], "to": self.remote["device"], "sequence": self.outgoing,
                            "purpose": purpose, "body": base64.b64encode(encode(body)).decode()}),
                    self.key, public_key(self.remote_offer["ephemeral"]))

    def receive(self, packet):
        self.active()
        require(self.session is not None)
        value = decode(open_sealed(packet, self.remote_key, self.ephemeral))
        require(value["domain"] == "cindy.remote-desktop.packet.v1" and value["session"] == self.session
                and value["from"] == self.remote["device"] and value["to"] == self.local["device"])
        sequence, purpose = value["sequence"], value["purpose"]
        require(type(sequence) is int and 0 < sequence < 2 ** 64 and sequence not in self.received
                and sequence > self.high - 256 and purpose in PURPOSES and (purpose == "ready" or self.confirmed))
        self.high = max(self.high, sequence)
        self.received = {x for x in self.received if self.high - x < 256} | {sequence}
        if purpose == "ready":
            self.confirmed = True
        body = base64.b64decode(value["body"], validate=True)
        return purpose, body

    def close(self):
        self.key = self.ephemeral = self.session = self.remote_offer = None
        self.confirmed = False
        self.received.clear()
