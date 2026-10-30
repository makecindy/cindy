"""In-memory tests only: no personal keyring, real password or screen lock."""
import asyncio
import base64
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch
import uuid
import tempfile
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from channel import Channel, Error, b64, decode, encode, jwk, open_sealed, public, seal, sign
from host import Host
import platform_linux as platform


def peer(name, key, realm="global"):
    return {"version": 1, "device": name, "membership": "test-account", "realm": realm, "publicKey": public(key)}


class ChannelTests(unittest.TestCase):
    def setUp(self):
        a, b = jwk.JWK.generate(kty="EC", crv="P-256"), jwk.JWK.generate(kty="EC", crv="P-256")
        self.a = Channel(peer("phone", a), peer("host", b), a)
        self.b = Channel(peer("host", b), peer("phone", a), b)
        self.a.accept(self.b.offer())
        self.b.accept(self.a.offer())

    def test_ready_replay_and_password_roundtrip(self):
        packet = self.a.send("ready", {})
        self.b.receive(packet)
        with self.assertRaises(Error):
            self.b.receive(packet)
        self.a.receive(self.b.send("ready", {}))
        purpose, body = self.b.receive(self.a.send("authenticate", {"password": "fake"}))
        self.assertEqual((purpose, decode(body)), ("authenticate", {"password": "fake"}))

    def test_unconfirmed_cannot_send_password(self):
        with self.assertRaises(Error):
            self.a.send("authenticate", {})

    def test_foreign_signer_rejected(self):
        key = jwk.JWK.generate(kty="EC", crv="P-256")
        with self.assertRaises(Exception):
            self.b.receive(sign(b"fake", key))

    def test_forbidden_header_rejected(self):
        from jwcrypto import jws
        token = jws.JWS(b"fake")
        token.add_signature(self.a.key, protected=json.dumps({"alg": "ES256", "typ": "cindy-remote-desktop-v1", "cty": "JWE", "jku": "https://invalid.test"}))
        with self.assertRaises(Error):
            self.b.receive(token.serialize(compact=True))

    def test_closed_and_expired_channels(self):
        self.a.deadline = time.monotonic() - 1
        with self.assertRaisesRegex(Error, "EXPIRED"):
            self.a.offer()
        self.b.close()
        with self.assertRaisesRegex(Error, "EXPIRED"):
            self.b.offer()

    def test_realm_and_account_binding(self):
        key = jwk.JWK.generate(kty="EC", crv="P-256")
        for field, value in [("realm", "cn"), ("membership", "other"), ("device", "host")]:
            remote = peer("phone", self.a.key)
            remote[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(Error, "INVALID_IDENTITY"):
                Channel(peer("host", key), remote, key)

    def test_tamper_does_not_consume_sequence(self):
        packet = self.a.send("ready", {})
        parts = packet.split(".")
        parts[1] = b64(b"altered")
        with self.assertRaises(Exception):
            self.b.receive(".".join(parts))
        self.assertEqual(self.b.receive(packet)[0], "ready")

    def test_noncanonical_and_duplicate_json(self):
        from channel import unb64
        with self.assertRaises(Exception):
            unb64("YWJj=")
        with self.assertRaises(Error):
            decode('{"alg":"ES256","alg":"none"}')


class HostTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.account = {"name": "test-user", "recordID": "test-record"}
        self.key = jwk.JWK.generate(kty="EC", crv="P-256")
        self.state = "locked"
        self.calls = 0
        self.reject = False

        async def unlock(password, current):
            self.calls += 1
            current()
            self.assertEqual(password, b"fake-test-password")
            if self.reject:
                raise Error("INVALID_IDENTITY")
            self.state = "unlocked"

        async def read_state():
            return self.state
        self.host = Host("/unused-test-directory", lambda *_: self.key, lambda: self.account.copy(), read_state, unlock)
        self.descriptor = decode(await self.host.call({"method": "configure", "realm": "global", "membership": "test-account", "authDevice": "host"}))
        await self.connect()

    async def connect(self):
        key = jwk.JWK.generate(kty="EC", crv="P-256")
        descriptor = peer("phone", key)
        self.phone = Channel(descriptor, self.descriptor, key)
        opened = await self.host.call({"method": "begin", "peer": "phone", "offer": self.phone.offer(), "descriptor": encode(descriptor).decode()})
        self.handle = opened["handle"]
        self.phone.accept(opened["offer"])
        self.assertEqual(await self.host.status(), {})
        reply = await self.exchange("ready", {})
        self.phone.receive(reply["ciphertext"])

    async def exchange(self, purpose, body):
        return await self.host.call({"method": "receive", "handle": self.handle, "peer": "phone", "ciphertext": self.phone.send(purpose, body)})

    def attempt(self):
        return {"id": str(uuid.uuid4()), "account": self.account.copy(), "password": base64.b64encode(b"fake-test-password").decode()}

    async def test_success_deduplication_and_authorized_command(self):
        attempt = self.attempt()
        for _ in range(2):
            result = await self.exchange("authenticate", attempt)
            self.assertTrue(decode(self.phone.receive(result["ciphertext"])[1])["accepted"])
        self.assertEqual(self.calls, 1)
        self.assertIn("phone", await self.host.status())
        result = await self.exchange("request", {"id": "test-command", "payload": base64.b64encode(b'{"op":"capabilities"}').decode()})
        self.assertEqual(result["kind"], "command")
        self.assertNotIn("password", json.dumps(result))

    async def test_wrong_password_and_attempt_status(self):
        self.reject = True
        attempt = self.attempt()
        result = await self.exchange("authenticate", attempt)
        self.assertFalse(decode(self.phone.receive(result["ciphertext"])[1])["accepted"])
        result = await self.exchange("authentication-status", {"id": attempt["id"]})
        self.assertFalse(decode(self.phone.receive(result["ciphertext"])[1])["accepted"])
        self.assertEqual(await self.host.status(), {})
        self.assertEqual(self.calls, 1)

    async def test_reconnect_does_not_reset_attempt_budget(self):
        self.reject = True
        for _ in range(5):
            await self.exchange("authenticate", self.attempt())
            await self.connect()
        with self.assertRaisesRegex(Error, "UNAVAILABLE"):
            await self.exchange("authenticate", self.attempt())
        self.assertEqual(self.calls, 5)

    async def test_cancellation_revokes_inflight_password_operation(self):
        started = asyncio.Event()
        async def waiting(password, current):
            started.set()
            await asyncio.Event().wait()
        self.host.unlock = waiting
        job = asyncio.create_task(self.exchange("authenticate", self.attempt()))
        await started.wait()
        await self.host.call({"method": "close", "peer": "phone"})
        with self.assertRaises(asyncio.CancelledError):
            await job
        self.assertFalse(self.host.verifying)
        self.assertEqual(await self.host.status(), {})

    async def test_relock_invalidates_authorization(self):
        await self.exchange("authenticate", self.attempt())
        self.state = "locked"
        self.assertEqual(await self.host.status(), {})
        self.assertNotIn(self.handle, self.host.sessions)

    async def test_unknown_locker_never_loads_key(self):
        self.state = "unavailable"
        self.host.load_key = lambda *_: self.fail("key accessed for unsupported locker")
        with self.assertRaisesRegex(Error, "UNLOCK_UNAVAILABLE"):
            await self.host.call({"method": "configure", "realm": "global", "membership": "new", "authDevice": "host"})

    async def test_forged_account_and_pre_auth_commands(self):
        attempt = self.attempt()
        attempt["account"] = {"recordID": "other", "name": "root"}
        with self.assertRaises(Error):
            await self.exchange("authenticate", attempt)
        with self.assertRaises(Error):
            await self.exchange("request", {"id": "fake", "payload": "e30="})
        self.assertEqual(self.calls, 0)


class PlatformTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.target = (123, "456", (1, 2))
        self.original = ("test-session", self.target)
        self.proc = Mock(returncode=0, communicate=AsyncMock(return_value=(b"", b"")), wait=AsyncMock())
        self.patches = [patch.object(platform, "account", return_value={"name": "fake", "recordID": "fake"}),
                        patch.object(platform, "snapshot", AsyncMock(side_effect=[self.original, self.original, ("test-session", None)])),
                        patch.object(platform, "locker_identity", return_value=self.target),
                        patch.object(platform.os, "pidfd_open", return_value=999),
                        patch.object(platform.os, "close"),
                        patch.object(platform.signal, "pidfd_send_signal"),
                        patch.object(platform.asyncio, "create_subprocess_exec", AsyncMock(return_value=self.proc)),
                        patch.object(platform.asyncio, "sleep", AsyncMock())]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    async def test_signal_follows_pam_and_confirmed_same_locker(self):
        await platform.verify_and_unlock(b"fake-password", lambda: None)
        self.proc.communicate.assert_awaited_once_with(b"fake-password")
        self.assertNotIn("fake-password", repr(platform.asyncio.create_subprocess_exec.call_args))
        platform.signal.pidfd_send_signal.assert_called_once_with(999, platform.signal.SIGUSR1)
        platform.os.close.assert_called_once_with(999)

    async def test_rejected_password_never_signals(self):
        self.proc.returncode = 1
        with self.assertRaisesRegex(Error, "INVALID_IDENTITY"):
            await platform.verify_and_unlock(b"fake-password", lambda: None)
        platform.signal.pidfd_send_signal.assert_not_called()

    async def test_replaced_locker_never_signals(self):
        platform.snapshot.side_effect = [self.original, ("test-session", (124, "new", (1, 2)))]
        with self.assertRaisesRegex(Error, "UNLOCK_UNAVAILABLE"):
            await platform.verify_and_unlock(b"fake-password", lambda: None)
        platform.signal.pidfd_send_signal.assert_not_called()

    async def test_revocation_after_pam_never_signals(self):
        current = Mock(side_effect=[None, Error("CANCELLED")])
        with self.assertRaisesRegex(Error, "CANCELLED"):
            await platform.verify_and_unlock(b"fake-password", current)
        platform.signal.pidfd_send_signal.assert_not_called()

    async def test_cancelled_pam_worker_is_killed(self):
        self.proc.returncode = None
        self.proc.communicate.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await platform.verify_and_unlock(b"fake-password", lambda: None)
        self.proc.kill.assert_called_once()
        self.proc.wait.assert_awaited_once()
        platform.signal.pidfd_send_signal.assert_not_called()

    async def test_verified_password_without_unlock_does_not_succeed(self):
        platform.snapshot.side_effect = None
        platform.snapshot.return_value = self.original
        with self.assertRaisesRegex(Error, "UNLOCK_UNAVAILABLE"):
            await platform.verify_and_unlock(b"fake-password", lambda: None)
        platform.signal.pidfd_send_signal.assert_called_once()

    async def test_unlocked_setup_does_not_signal(self):
        platform.snapshot.side_effect = [("test-session", None), ("test-session", None)]
        await platform.verify_and_unlock(b"fake-password", lambda: None)
        platform.signal.pidfd_send_signal.assert_not_called()
        platform.os.pidfd_open.assert_not_called()

    async def test_lock_state_requires_both_logind_and_known_locker(self):
        # Exercise the real composition rather than the unlock operation fixture.
        self.patches[1].stop()
        target = (123, "456", (1, 2))
        for hint, found, expected in [(False, [], "unlocked"), (True, [target], "locked"),
                                      (True, [], "unavailable"), (False, [target], "unavailable")]:
            with patch.object(platform, "session", AsyncMock(return_value=("test", hint))), patch.object(platform, "lockers", return_value=found):
                self.assertEqual(await platform.lock_state(), expected)

    async def test_unknown_locker_is_unavailable(self):
        with patch.object(platform, "snapshot", AsyncMock(side_effect=Error("UNLOCK_UNAVAILABLE"))):
            self.assertEqual(await platform.lock_state(), "unavailable")


class StorageTests(unittest.TestCase):
    def setUp(self):
        from storage import load_identity
        self.load = load_identity
        self.temp = tempfile.TemporaryDirectory(prefix="cindy-credential-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.items = []
        self.secret = None
        self.locked = False
        def store(_schema, _attrs, _collection, _label, value, _cancel):
            self.secret = value
            self.items[:] = [SimpleNamespace(get_locked=lambda: self.locked, get_secret=lambda: SimpleNamespace(get_text=lambda: self.secret))]
            return True
        service = SimpleNamespace(search_sync=lambda *_: self.items)
        secret_api = SimpleNamespace(Schema=SimpleNamespace(new=lambda *_: object()), SchemaFlags=SimpleNamespace(NONE=0),
                                     SchemaAttributeType=SimpleNamespace(STRING=0), ServiceFlags=SimpleNamespace(OPEN_SESSION=1),
                                     SearchFlags=SimpleNamespace(ALL=1, LOAD_SECRETS=2), CollectionFlags=SimpleNamespace(NONE=0),
                                     Service=SimpleNamespace(get_sync=lambda *_: service),
                                     Collection=SimpleNamespace(for_alias_sync=lambda *_: SimpleNamespace(get_locked=lambda: self.locked)),
                                     password_store_sync=Mock(side_effect=store))
        self.api = secret_api
        modules = {"gi": SimpleNamespace(require_version=lambda *_: None), "gi.repository": SimpleNamespace(Secret=secret_api)}
        context = patch.dict(sys.modules, modules)
        context.start()
        self.addCleanup(context.stop)

    def test_identity_reloads_and_only_public_pin_reaches_disk(self):
        first = self.load(self.directory, "global")
        self.assertEqual(public(self.load(self.directory, "global")), public(first))
        self.api.password_store_sync.assert_called_once()
        for item in self.directory.iterdir():
            self.assertNotIn(first.get("d"), item.read_text())

    def test_locked_key_is_not_replaced(self):
        self.load(self.directory, "global")
        self.locked = True
        with self.assertRaisesRegex(Error, "UNAVAILABLE"):
            self.load(self.directory, "global")
        self.api.password_store_sync.assert_called_once()

    def test_missing_pinned_key_is_not_recreated(self):
        self.load(self.directory, "global")
        self.items.clear()
        with self.assertRaisesRegex(Error, "INVALID_IDENTITY"):
            self.load(self.directory, "global")
        self.api.password_store_sync.assert_called_once()

    def test_locked_collection_cannot_create_first_identity(self):
        self.locked = True
        with self.assertRaisesRegex(Error, "UNAVAILABLE"):
            self.load(self.directory, "global")
        self.api.password_store_sync.assert_not_called()

    def test_changed_identity_is_not_silently_accepted(self):
        self.load(self.directory, "global")
        self.secret = jwk.JWK.generate(kty="EC", crv="P-256").export_private()
        with self.assertRaisesRegex(Error, "INVALID_IDENTITY"):
            self.load(self.directory, "global")


if __name__ == "__main__":
    unittest.main()
