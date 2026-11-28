"""Fixed Host GitHub device-login helper. Only metadata phases cross stdout.

Official gh performs OAuth in a private tmpfs HOME + DBus + encrypted keyring.
Only an explicit current Host commit installs the result in the original keyring.
No plugin/caller command, path, credential, or provider URL is accepted.
"""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

GH = "/usr/local/bin/gh"
URL = "https://github.com/login/device"


def require(value):
    if not value:
        raise ValueError("GITHUB_AUTH_UNAVAILABLE")


def ensure_config_parent(home):
    """A fresh cloud HOME has no .config; create only that private directory.

    Anchor creation to the owned HOME descriptor and reject symlinks, another
    owner, or writable shared directories. Existing metadata is never reset.
    """
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    home_fd = os.open(home, flags)
    try:
        hs = os.fstat(home_fd)
        require(hs.st_uid == os.getuid() and not hs.st_mode & 0o022)
        created = False
        try:
            os.mkdir(".config", mode=0o700, dir_fd=home_fd)
            created = True
        except FileExistsError:
            pass
        config_fd = os.open(".config", flags, dir_fd=home_fd)
        try:
            cs = os.fstat(config_fd)
            require(cs.st_uid == os.getuid() and not cs.st_mode & 0o022)
            if created:
                os.fsync(config_fd)
                os.fsync(home_fd)
        finally:
            os.close(config_fd)
        return home / ".config"
    finally:
        os.close(home_fd)


def metadata(directory, missing=False):
    if not directory.exists():
        require(missing and not directory.is_symlink())
        return {}
    require(not directory.is_symlink() and directory.is_dir())
    s = directory.stat()
    require(s.st_uid == os.getuid() and not s.st_mode & 0o077)
    values = {}
    for p in directory.iterdir():
        require(p.name in ("hosts.yml", "config.yml") and not p.is_symlink())
        s = p.stat()
        require(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid()
                and s.st_nlink == 1 and not s.st_mode & 0o077 and s.st_size < 65536)
        value = p.read_bytes()
        require(not re.search(rb"(?im)^\s*oauth_token\s*:|gh[pousr]_|github_pat_", value))
        values[p.name] = value
    return values


def emit(phase, **values):
    print(json.dumps({"phase": phase, **values}), flush=True)


def atomic_write(directory, name, value):
    fd, filename = tempfile.mkstemp(prefix=".cindy-auth-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(filename, directory / name)
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


class Keyring:
    """Pinned gh 2.100 uses login collection and service/username attributes.

    Address the already-running unique owner, never autostart/unlock a shared
    daemon. SetSecret updates the existing item without a plaintext fallback.
    """
    def __init__(self, address, dbus):
        self.dbus = dbus
        self.bus = dbus.bus.BusConnection(address)
        self.owner = self.bus.get_name_owner("org.freedesktop.secrets")
        self.service = self.interface("/org/freedesktop/secrets", "Service")
        self.collection_path = "/org/freedesktop/secrets/collection/login"
        require(str(self.service.ReadAlias("default", timeout=3)) == self.collection_path)
        self.collection = self.interface(self.collection_path, "Collection")
        require(not self.prop(self.collection_path, "Collection", "Locked"))
        _, self.session = self.service.OpenSession("plain", dbus.String("", variant_level=1), timeout=3)

    def interface(self, path, name):
        return self.dbus.Interface(self.bus.get_object(self.owner, path, introspect=False),
                                   "org.freedesktop.Secret." + name)

    def prop(self, path, name, prop):
        props = self.dbus.Interface(self.bus.get_object(self.owner, path, introspect=False),
                                    "org.freedesktop.DBus.Properties")
        return props.Get("org.freedesktop.Secret." + name, prop, timeout=3)

    def item(self, username):
        values = self.collection.SearchItems(
            self.dbus.Dictionary({"service": "gh:github.com", "username": username}, signature="ss"), timeout=3)
        require(len(values) <= 1)
        if not values:
            return None
        require(not self.prop(values[0], "Item", "Locked"))
        return self.interface(values[0], "Item")

    def get(self, username):
        item = self.item(username)
        return bytes(item.GetSecret(self.session, timeout=3)[2]) if item else None

    def set(self, username, token):
        secret = self.dbus.Struct((self.session, self.dbus.ByteArray(b""),
                                  self.dbus.ByteArray(token), "text/plain; charset=utf8"), signature="oayays")
        item = self.item(username)
        if item:
            item.SetSecret(secret, timeout=3)
        else:
            props = self.dbus.Dictionary({
                "org.freedesktop.Secret.Item.Label": "GitHub CLI",
                "org.freedesktop.Secret.Item.Attributes": self.dbus.Dictionary(
                    {"service": "gh:github.com", "username": username}, signature="ss")}, signature="sv")
            _, prompt = self.collection.CreateItem(props, secret, True, timeout=3)
            require(str(prompt) == "/")
        require(self.get(username) == token)

    def restore(self, username, old, expected):
        # Never clobber a different concurrent writer's value while recovering.
        require(self.get(username) == expected)
        if old is not None:
            self.set(username, old)
        else:
            item = self.item(username)
            if item:
                require(str(item.Delete(timeout=3)) == "/")


def commit(target, baseline, keyring, username, token, old_active, yaml):
    require(metadata(target, missing=True) == baseline and keyring.get("") == old_active)
    old_named = keyring.get(username)
    hosts = yaml.safe_load(baseline.get("hosts.yml", b"{}")) or {}
    require(isinstance(hosts, dict))
    host = hosts.setdefault("github.com", {})
    require(isinstance(host, dict))
    users = host.setdefault("users", {})
    require(isinstance(users, dict))
    users.setdefault(username, {})
    host["user"] = username
    host.setdefault("git_protocol", "https")
    value = yaml.safe_dump(hosts, sort_keys=False).encode()
    require(not re.search(rb"(?im)^\s*oauth_token\s*:|gh[pousr]_|github_pat_", value))
    changed = []
    # A short local commit holds the Host owner lease. Defer TERM until it either
    # commits or rolls back; there is no network exchange in this critical section.
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
    try:
        for user, previous in ((username, old_named), ("", old_active)):
            changed.append((user, previous))
            keyring.set(user, token)
        require(metadata(target, missing=True) == baseline)
        if not target.exists():
            target.mkdir(mode=0o700)
        atomic_write(target, "hosts.yml", value)
        require(keyring.get("") == token and keyring.get(username) == token)
    except BaseException:
        # rename may have succeeded even when the following directory fsync fails.
        current = target / "hosts.yml"
        if current.is_file() and not current.is_symlink() and current.read_bytes() == value:
            if "hosts.yml" in baseline:
                atomic_write(target, "hosts.yml", baseline["hosts.yml"])
            else:
                (target / "hosts.yml").unlink()
        for user, previous in reversed(changed):
            if keyring.get(user) != previous:
                keyring.restore(user, previous, token)
        raise
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)


def main():
    require(sys.argv[1:] == ["--device-login-v1"] and os.getuid() == 10001)
    os.umask(0o077)
    # Host death stops this helper; it never becomes an orphaned login poller.
    parent = os.getppid()
    require(ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0) == 0 and os.getppid() == parent and parent != 1)
    def cancelled(*_):
        # selectors retries InterruptedError (PEP 475); use a distinct exception
        # so TERM/parent death really unwinds the polling loop and reaps children.
        raise RuntimeError("GITHUB_AUTH_CANCELLED")
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    import dbus
    import yaml
    require(os.environ.get("HOME") == "/home/cindy")
    require(not any(os.environ.get(k) for k in ("GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR")))
    require(any(p.split()[1:3] == ["/dev/shm", "tmpfs"] for p in Path("/proc/mounts").read_text().splitlines()))
    original = {k: os.environ[k] for k in ("HOME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS") if k in os.environ}
    require(original.get("DBUS_SESSION_BUS_ADDRESS"))
    keyring = Keyring(original["DBUS_SESSION_BUS_ADDRESS"], dbus)
    config_parent = ensure_config_parent(Path("/home/cindy"))
    target = config_parent / "gh"
    baseline = metadata(target, missing=True)
    old_active = keyring.get("")
    # One login per OS identity, also across multiple Host processes.
    lock_fd = os.open("/dev/shm/cindy-github-device-login-10001.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    lock_stat = os.fstat(lock_fd)
    require(lock_stat.st_uid == os.getuid() and lock_stat.st_nlink == 1 and not lock_stat.st_mode & 0o077)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    scratch = Path(tempfile.mkdtemp(prefix="cindy-github-device-", dir="/dev/shm"))
    children = []
    poller = selectors.DefaultSelector()
    deadline = time.monotonic() + 300
    def run(args, env, **kwargs):
        result = subprocess.run(args, env=env, capture_output=True, timeout=20, **kwargs)
        require(result.returncode == 0)
        return result.stdout
    def start(args, env, **kwargs):
        p = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
        children.append(p)
        return p
    def wait_command(expected):
        while time.monotonic() < deadline:
            for key, _ in poller.select(0.2):
                require(key.fileobj == sys.stdin)
                line = sys.stdin.buffer.readline(1024)
                require(line and len(line) < 1024 and json.loads(line) == {"op": expected})
                return
            require(all(p.poll() is None for p in children[:2]))
        raise TimeoutError()
    try:
        private = {**original, "HOME": str(scratch), "XDG_RUNTIME_DIR": str(scratch),
                   "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + str(scratch / "bus"),
                   "GH_CONFIG_DIR": str(scratch / "gh"), "GH_BROWSER": "/usr/bin/true",
                   "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1", "LC_ALL": "C.UTF-8"}
        (scratch / "gh").mkdir(mode=0o700)
        bus = start(["/usr/bin/dbus-daemon", "--session", "--nofork", "--address=" + private["DBUS_SESSION_BUS_ADDRESS"]], private)
        for _ in range(50):
            require(bus.poll() is None)
            if (scratch / "bus").is_socket():
                break
            time.sleep(0.1)
        daemon = start(["/usr/bin/gnome-keyring-daemon", "--foreground", "--unlock", "--components=secrets",
                        "--control-directory=" + str(scratch / "control")], private, stdin=subprocess.PIPE)
        daemon.stdin.write(os.urandom(32).hex().encode() + b"\n")
        daemon.stdin.close()
        staging = None
        for _ in range(50):
            require(bus.poll() is None and daemon.poll() is None)
            try:
                staging = Keyring(private["DBUS_SESSION_BUS_ADDRESS"], dbus)
                break
            except Exception:
                time.sleep(0.1)
        require(staging is not None)
        cli = subprocess.Popen([GH, "auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https", "--skip-ssh-key"],
                               env=private, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        children.append(cli)
        poller.register(cli.stdout, selectors.EVENT_READ)
        poller.register(sys.stdin, selectors.EVENT_READ)
        output = b""
        announced = False
        opened = False
        while time.monotonic() < deadline:
            require(bus.poll() is None and daemon.poll() is None)
            for key, _ in poller.select(0.2):
                if key.fileobj == sys.stdin:
                    require(announced and not opened)
                    line = sys.stdin.buffer.readline(1024)
                    require(line and len(line) < 1024 and json.loads(line) == {"op": "opened"})
                    opened = True
                else:
                    chunk = os.read(cli.stdout.fileno(), 4096)
                    if not chunk:
                        poller.unregister(cli.stdout)
                    output += chunk
                    require(len(output) <= 65536)
            if not announced:
                code = re.search(rb"one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})", output)
                url = re.search(rb"Open this URL to continue in your web browser:\s*(https://\S+)", output)
                if code and url:
                    require(url.group(1).decode() == URL)
                    emit("challenge", url=URL, userCode=code.group(1).decode())
                    announced = True
            if cli.poll() is not None:
                break
        require(cli.poll() == 0 and announced and opened)
        if cli.stdout in [k.fileobj for k in poller.get_map().values()]:
            poller.unregister(cli.stdout)
        require(b"saved in plain text" not in output.lower())
        metadata(scratch / "gh")
        token = staging.get("")
        require(token and len(token) < 8192)
        account = json.loads(run([GH, "api", "user", "--jq", "{id:.id,login:.login}"], private))
        require(isinstance(account.get("id"), int) and account["id"] > 0
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", account.get("login", "")))
        require(run([GH, "auth", "token", "--hostname", "github.com"], private).strip() == token)
        emit("ready")
        wait_command("commit")
        require(time.monotonic() < deadline)
        commit(target, baseline, keyring, account["login"], token, old_active, yaml)
        require(run([GH, "auth", "token", "--hostname", "github.com"], original).strip() == token)
        metadata(target)
        emit("done")
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        for p in reversed(children):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=2)
        poller.close()
        shutil.rmtree(scratch)
        os.close(lock_fd)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Never print exception text, CLI output, tokens, usernames or device codes.
        emit("failed")
        sys.exit(1)
