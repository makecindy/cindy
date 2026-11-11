"""Private host identity in the desktop Secret Service; disk holds only a pin.

Never unlock a locked collection, fall back to plaintext, or replace a missing
key behind an existing pin. Linux Secret Service protects storage, not against
other compromised applications running as the same OS user.
"""
import fcntl
import hashlib
import os
from pathlib import Path

from channel import jwk, public, encode, require


def load_identity(directory, realm):
    import gi
    gi.require_version("Secret", "1")
    from gi.repository import Secret

    directory = Path(directory)
    require(directory.is_absolute() and not directory.is_symlink(), "UNAVAILABLE")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(directory.stat().st_uid == os.getuid() and directory.stat().st_mode & 0o077 == 0, "UNAVAILABLE")
    scope = hashlib.sha256(str(directory.resolve()).encode()).hexdigest()
    schema = Secret.Schema.new("org.makecindy.RemoteCredentials", Secret.SchemaFlags.NONE,
                               {"profile": Secret.SchemaAttributeType.STRING,
                                "realm": Secret.SchemaAttributeType.STRING})
    attrs = {"profile": scope, "realm": realm}
    lock = os.open(directory / "identity.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION, None)
        items = service.search_sync(schema, attrs, Secret.SearchFlags.ALL | Secret.SearchFlags.LOAD_SECRETS, None)
        require(len(items) <= 1, "UNAVAILABLE")
        marker = directory / (realm + ".public-sha256")
        require(not marker.is_symlink(), "UNAVAILABLE")
        if items:
            require(not items[0].get_locked(), "UNAVAILABLE")
            secret = items[0].get_secret()
            require(secret is not None, "UNAVAILABLE")
            key = jwk.JWK.from_json(secret.get_text())
            require(key.has_private and key.get("kty") == "EC" and key.get("crv") == "P-256", "UNAVAILABLE")
        else:
            require(not marker.exists(), "INVALID_IDENTITY")
            collection = Secret.Collection.for_alias_sync(service, "default", Secret.CollectionFlags.NONE, None)
            require(collection is not None and not collection.get_locked(), "UNAVAILABLE")
            key = jwk.JWK.generate(kty="EC", crv="P-256")
            require(Secret.password_store_sync(schema, attrs, "default", "Cindy remote desktop identity",
                                                key.export_private(), None), "UNAVAILABLE")
        fingerprint = hashlib.sha256(encode(public(key))).hexdigest()
        if marker.exists():
            require(marker.read_text() == fingerprint, "INVALID_IDENTITY")
        else:
            fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(fingerprint)
                stream.flush()
                os.fsync(stream.fileno())
        return key
    finally:
        os.close(lock)
