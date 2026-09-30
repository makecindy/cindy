"""Hyprlock's documented SIGUSR1 interface, gated by native PAM verification.

No keyboard injection, compositor bypass, root helper or lock-screen configuration
changes. Unknown lockers and ambiguous/inactive sessions are unsupported.
"""
import asyncio
import ctypes
import ctypes.util
import hashlib
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import sys
import time

from channel import Error, decode, require


async def command(*args):
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                              stderr=asyncio.subprocess.DEVNULL)
    try:
        data, _ = await asyncio.wait_for(proc.communicate(), 2)
        require(proc.returncode == 0 and len(data) <= 65536, "UNLOCK_UNAVAILABLE")
        return data.decode()
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


def trusted_file(path):
    value = Path(path).stat()
    require(stat.S_ISREG(value.st_mode) and value.st_uid == 0 and not value.st_mode & 0o022,
            "UNLOCK_UNAVAILABLE")
    return value.st_dev, value.st_ino


def account():
    user = pwd.getpwuid(os.getuid())
    require(os.getuid() > 0 and os.geteuid() == os.getuid(), "UNLOCK_UNAVAILABLE")
    machine = Path("/etc/machine-id").read_text().strip()
    require(re.fullmatch(r"[a-f0-9]{32}", machine), "UNLOCK_UNAVAILABLE")
    record = hashlib.sha256(f"{machine}:{user.pw_uid}:{user.pw_name}".encode()).hexdigest()
    return {"name": user.pw_name, "recordID": record}


async def session():
    session_id = os.environ.get("XDG_SESSION_ID", "")
    require(re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", session_id), "UNLOCK_UNAVAILABLE")
    raw = await command("/usr/bin/loginctl", "show-session", session_id,
                        "-p", "User", "-p", "Active", "-p", "Remote", "-p", "Type", "-p", "LockedHint")
    props = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    require(props.get("User") == str(os.getuid()) and props.get("Active") == "yes"
            and props.get("Remote") == "no" and props.get("Type") == "wayland"
            and props.get("LockedHint") in ("yes", "no"), "UNLOCK_UNAVAILABLE")
    # LockedHint is advisory; some lockers do not publish it. Confirm the actual
    # compositor lock, including a stranded lock whose client has exited.
    trusted_file("/usr/bin/hyprctl")
    monitors = decode(await command("/usr/bin/hyprctl", "-j", "monitors"))
    require(isinstance(monitors, list) and 0 < len(monitors) <= 32, "UNLOCK_UNAVAILABLE")
    blockers = [m.get("solitaryBlockedBy") for m in monitors]
    require(all(isinstance(items, list) and all(isinstance(x, str) for x in items) for items in blockers), "UNLOCK_UNAVAILABLE")
    if any("LOCK" in items for items in blockers):
        return session_id, True
    require(any("WORKSPACE" not in items for items in blockers), "UNLOCK_UNAVAILABLE")
    return session_id, False


def locker_identity(pid):
    proc = Path("/proc") / str(pid)
    require(proc.stat().st_uid == os.getuid(), "UNLOCK_UNAVAILABLE")
    expected = trusted_file("/usr/bin/hyprlock")
    executable = (proc / "exe").stat()
    require((executable.st_dev, executable.st_ino) == expected, "UNLOCK_UNAVAILABLE")
    env = dict(item.split(b"=", 1) for item in (proc / "environ").read_bytes().split(b"\0") if b"=" in item)
    for key in ("XDG_SESSION_ID", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"):
        require(os.environ.get(key) and env.get(key.encode()) == os.environ[key].encode(), "UNLOCK_UNAVAILABLE")
    fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    require(fields[0] not in ("Z", "X"), "UNLOCK_UNAVAILABLE")
    return pid, fields[19], expected


def lockers():
    trusted_file("/usr/bin/hyprlock")
    trusted_file("/etc/pam.d/hyprlock")
    require(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "UNLOCK_UNAVAILABLE")
    matches = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if (entry / "comm").read_text().strip() == "hyprlock":
                matches.append(locker_identity(int(entry.name)))
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    require(len(matches) <= 1, "UNLOCK_UNAVAILABLE")
    return matches


async def snapshot():
    session_id, locked = await session()
    running = lockers()
    # A PID alone does not prove the compositor granted the lock. Require both.
    require(locked == bool(running), "UNLOCK_UNAVAILABLE")
    return session_id, running[0] if running else None


async def lock_state():
    try:
        _, locker = await snapshot()
        return "locked" if locker else "unlocked"
    except Exception:
        return "unavailable"


async def verify_and_unlock(password, current):
    original_account = account()
    original = await snapshot()
    current()
    fd = os.pidfd_open(original[1][0]) if original[1] else None
    proc = None
    try:
        if original[1]:
            require(locker_identity(original[1][0]) == original[1], "UNLOCK_UNAVAILABLE")
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-I", "-B", str(Path(__file__).with_name("main.py")), "--pam",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await asyncio.wait_for(proc.communicate(password), 15)
        current()
        require(proc.returncode == 0, "INVALID_IDENTITY")
        require(account() == original_account, "INVALID_IDENTITY")
        require(await snapshot() == original, "UNLOCK_UNAVAILABLE")
        current()
        if fd is None:
            return  # Explicit setup on an already unlocked session verifies only.
        require(locker_identity(original[1][0]) == original[1], "UNLOCK_UNAVAILABLE")
        # pidfd cannot accidentally signal a new process after PID reuse.
        signal.pidfd_send_signal(fd, signal.SIGUSR1)
        for _ in range(50):
            await asyncio.sleep(.1)
            current()
            try:
                state = await snapshot()
            except Error:
                # Process exit and compositor release are not simultaneous.
                # Keep waiting for proof; never submit the password or signal again.
                continue
            current()
            require(state[0] == original[0] and account() == original_account, "UNLOCK_UNAVAILABLE")
            if state[1] is None:
                return
            require(state == original, "UNLOCK_UNAVAILABLE")
        raise Error("UNLOCK_UNAVAILABLE")
    finally:
        if fd is not None:
            os.close(fd)
        if proc and proc.returncode is None:
            proc.kill()
            await proc.wait()


def pam_verify(password):
    """Only the isolated --pam subprocess accepts bytes from its private pipe."""
    require(0 < len(password) <= 4096 and b"\0" not in password)
    password.decode("utf-8")
    user = account()["name"].encode()
    trusted_file("/etc/pam.d/hyprlock")
    lib = ctypes.CDLL("libpam.so.0")
    libc = ctypes.CDLL(None)

    class Message(ctypes.Structure):
        _fields_ = [("style", ctypes.c_int), ("text", ctypes.c_char_p)]

    class Response(ctypes.Structure):
        _fields_ = [("text", ctypes.c_void_p), ("code", ctypes.c_int)]

    callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int,
                                    ctypes.POINTER(ctypes.POINTER(Message)),
                                    ctypes.POINTER(ctypes.POINTER(Response)), ctypes.c_void_p)
    libc.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
    libc.calloc.restype = ctypes.c_void_p
    libc.strdup.argtypes = [ctypes.c_char_p]
    libc.strdup.restype = ctypes.c_void_p
    libc.free.argtypes = [ctypes.c_void_p]

    @callback_type
    def conversation(count, messages, responses, _data):
        if not 0 < count <= 16:
            return 19  # PAM_CONV_ERR
        allocation = libc.calloc(count, ctypes.sizeof(Response))
        if not allocation:
            return 5
        values = ctypes.cast(allocation, ctypes.POINTER(Response))
        for i in range(count):
            style = messages[i].contents.style
            if style not in (1, 2, 3, 4):
                for j in range(i):
                    libc.free(values[j].text)
                libc.free(allocation)
                return 19
            if style in (1, 2):
                values[i].text = libc.strdup(password if style == 1 else user)
                if not values[i].text:
                    for j in range(i):
                        libc.free(values[j].text)
                    libc.free(allocation)
                    return 5
        responses[0] = values
        return 0

    class Conversation(ctypes.Structure):
        _fields_ = [("callback", callback_type), ("data", ctypes.c_void_p)]

    conv, handle = Conversation(conversation, None), ctypes.c_void_p()
    lib.pam_start.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(Conversation), ctypes.POINTER(ctypes.c_void_p)]
    for name in ("pam_authenticate", "pam_acct_mgmt", "pam_end"):
        getattr(lib, name).argtypes = [ctypes.c_void_p, ctypes.c_int]
    result = lib.pam_start(b"hyprlock", user, ctypes.byref(conv), ctypes.byref(handle))
    require(result == 0, "UNAVAILABLE")
    try:
        result = lib.pam_authenticate(handle, 1)  # PAM_DISALLOW_NULL_AUTHTOK
        if result == 0:
            result = lib.pam_acct_mgmt(handle, 0)
        require(result == 0, "INVALID_IDENTITY")
    finally:
        lib.pam_end(handle, result)
