#!/usr/bin/python3
"""GNOME Shell (Mutter) Wayland remote-desktop clipboard helper.

Uses Mutter's org.gnome.Mutter.RemoteDesktop.Session clipboard D-Bus API so an
unfocused Cindy process can read, write and version-track portable clipboard
contents during an authorized remote-desktop control session, gated by
org.gnome.ScreenSaver.GetActive() and Mutter's session Closed signal on lock.

No files, history, credentials or clipboard logging.
  --check  Verify GNOME Wayland + Mutter RemoteDesktop + ScreenSaver without
           creating a session or showing GNOME's sharing indicator.
  (none)   Serve JSON-line requests over private stdin/stdout until EOF/Closed.
"""
import base64
import binascii
import ctypes
import errno
import json
import os
import re
import resource
import secrets
import select
import signal
import struct
import sys
import time

RD_NAME = "org.gnome.Mutter.RemoteDesktop"
RD_PATH = "/org/gnome/Mutter/RemoteDesktop"
RD_SESSION = "org.gnome.Mutter.RemoteDesktop.Session"
SCREENSAVER_NAME = "org.gnome.ScreenSaver"
SCREENSAVER_PATH = "/org/gnome/ScreenSaver"
DBUS_PROPS = "org.freedesktop.DBus.Properties"

MAX_FORMATS = 64
MAX_FORMAT_LEN = 256
MAX_TEXT_CHARS = 512_000
MAX_TEXT_BYTES = 2 * 1024 * 1024
IMAGE_PIXELS = 24_000_000
IMAGE_BYTES = 16 * 1024 * 1024
MAX_LINE_BYTES = 34 * 1024 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
PNG_IHDR_PREFIX = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"
FILE_BACKED_RE = re.compile(
    r"file-url|filenames|hdrop|filecontents|filegroupdescriptor|uri-list",
    re.IGNORECASE,
)
TEXT_MIMES = ("text/plain;charset=utf-8", "text/plain", "UTF8_STRING")
HTML_MIMES = ("text/html",)
RTF_MIMES = ("text/rtf", "application/rtf")
BOOKKEEPING_MIMES = frozenset(("TARGETS", "MULTIPLE", "TIMESTAMP", "SAVE_TARGETS"))


class ClipboardError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def harden():
    """Disable core dumps and follow parent exit on Linux."""
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except Exception:
        pass
    if sys.platform != "linux":
        return
    try:
        libc = ctypes.CDLL(None)
        libc.prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE
        libc.prctl(1, signal.SIGTERM, 0, 0, 0)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def is_gnome_wayland_env(env=None):
    env = os.environ if env is None else env
    if env.get("HYPRLAND_INSTANCE_SIGNATURE"):
        return False
    wayland = env.get("XDG_SESSION_TYPE") == "wayland" or bool(env.get("WAYLAND_DISPLAY"))
    if not wayland:
        return False
    desktops = (env.get("XDG_CURRENT_DESKTOP") or "").upper().split(":")
    return "GNOME" in desktops


def unwrap_mime_types(raw):
    """GNOME 46 wraps SelectionOwnerChanged mime-types as (as); accept both."""
    if raw is None:
        return []
    if isinstance(raw, tuple) and len(raw) == 1 and isinstance(raw[0], (list, tuple)):
        raw = raw[0]
    if not isinstance(raw, (list, tuple)):
        return []
    return [item for item in raw if isinstance(item, str)]


def validate_png(data):
    if len(data) > IMAGE_BYTES:
        raise ClipboardError("CLIPBOARD_TOO_LONG")
    if len(data) < 33 or not data.startswith(PNG_IHDR_PREFIX):
        raise ClipboardError("CLIPBOARD_UNSUPPORTED")
    width, height = struct.unpack(">II", data[16:24])
    if width <= 0 or height <= 0 or width > IMAGE_PIXELS // height:
        raise ClipboardError("CLIPBOARD_TOO_LONG")


def decode_incoming_content(content):
    """Validate incoming portable clipboard content and return (items, formats, clean)."""
    if not isinstance(content, dict):
        raise ClipboardError("DESKTOP_CLIPBOARD_WRITE_FAILED")
    clean = {}
    items = {}
    formats = []

    text = content.get("text")
    if not text and isinstance(content.get("url"), str) and content["url"]:
        text = content["url"]
    if text is not None:
        if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
            raise ClipboardError("CLIPBOARD_TOO_LONG" if isinstance(text, str) else "DESKTOP_CLIPBOARD_WRITE_FAILED")
        if text:
            encoded = text.encode("utf-8")
            if len(encoded) > MAX_TEXT_BYTES:
                raise ClipboardError("CLIPBOARD_TOO_LONG")
            clean["text"] = text
            for mime in TEXT_MIMES:
                items[mime] = encoded
            formats.append("text/plain;charset=utf-8")

    html = content.get("html")
    if html is not None:
        if not isinstance(html, str) or len(html) > MAX_TEXT_CHARS:
            raise ClipboardError("CLIPBOARD_TOO_LONG" if isinstance(html, str) else "DESKTOP_CLIPBOARD_WRITE_FAILED")
        if html:
            encoded = html.encode("utf-8")
            if len(encoded) > MAX_TEXT_BYTES:
                raise ClipboardError("CLIPBOARD_TOO_LONG")
            clean["html"] = html
            items["text/html"] = encoded
            formats.append("text/html")

    rtf = content.get("rtf")
    if rtf is not None:
        if not isinstance(rtf, str) or len(rtf) > MAX_TEXT_CHARS:
            raise ClipboardError("CLIPBOARD_TOO_LONG" if isinstance(rtf, str) else "DESKTOP_CLIPBOARD_WRITE_FAILED")
        if rtf:
            encoded = rtf.encode("utf-8")
            if len(encoded) > MAX_TEXT_BYTES:
                raise ClipboardError("CLIPBOARD_TOO_LONG")
            clean["rtf"] = rtf
            for mime in RTF_MIMES:
                items[mime] = encoded
            formats.append("text/rtf")

    png_b64 = content.get("png")
    if png_b64 is not None:
        if not isinstance(png_b64, str):
            raise ClipboardError("DESKTOP_CLIPBOARD_WRITE_FAILED")
        if len(png_b64) > ((IMAGE_BYTES + 2) // 3) * 4:
            raise ClipboardError("CLIPBOARD_TOO_LONG")
        try:
            raw_png = base64.b64decode(png_b64, validate=True)
        except (ValueError, binascii.Error):
            raise ClipboardError("CLIPBOARD_UNSUPPORTED")
        validate_png(raw_png)
        clean["png"] = png_b64
        items["image/png"] = raw_png
        formats.append("image/png")

    if not items:
        raise ClipboardError("DESKTOP_CLIPBOARD_WRITE_FAILED")
    return items, sorted(formats), clean


class GnomeClipboardSession:
    """Protocol-level GNOME Mutter RemoteDesktop clipboard session.

    Backend calls are injectable for unit tests without a running compositor.
    """

    def __init__(self, backend):
        self.backend = backend
        self.closed = False
        self.session_is_owner = False
        self.owner_types = []
        self.owned_items = {}
        self.owned_formats = []
        self.owned_content = {}
        self.epoch = str(secrets.randbelow(900_000_000_000) + 100_000_000_000)
        self.generation = 1
        self.owner_events = 0
        self.active_writes = {}

    def version_token(self):
        return f"{self.epoch}{self.generation:06d}"

    def on_closed(self):
        self.closed = True
        self.session_is_owner = False

    def on_owner_changed(self, options):
        self.owner_events += 1
        ours = bool(options.get("session-is-owner", False))
        self.session_is_owner = ours
        self.generation += 1
        if not ours:
            self.owner_types = [
                mime for mime in unwrap_mime_types(options.get("mime-types"))
                if mime not in BOOKKEEPING_MIMES
            ]
            self.owned_items = {}
            self.owned_formats = []
            self.owned_content = {}

    def on_transfer(self, mime_type, serial):
        data = self.owned_items.get(mime_type) if self.session_is_owner else None
        if data is None:
            self.backend.selection_write_done(serial, False)
            return
        fd = self.backend.selection_write(serial)
        if fd is None or fd < 0:
            self.backend.selection_write_done(serial, False)
            return
        try:
            os.set_blocking(fd, False)
        except OSError:
            try:
                os.close(fd)
            except OSError:
                pass
            self.backend.selection_write_done(serial, False)
            return
        self.active_writes[serial] = {
            "fd": fd,
            "view": memoryview(data),
            "offset": 0,
            "deadline": time.monotonic() + 3.0,
        }
        self.step_writes()

    def step_writes(self):
        """Advance all pending non-blocking SelectionWrite transfers."""
        now = time.monotonic()
        finished = []
        for serial, state in list(self.active_writes.items()):
            fd = state["fd"]
            view = state["view"]
            offset = state["offset"]
            if now >= state["deadline"]:
                finished.append((serial, fd, False))
                continue
            try:
                while offset < len(view):
                    end = min(offset + 65536, len(view))
                    written = os.write(fd, view[offset:end])
                    if written <= 0:
                        finished.append((serial, fd, False))
                        break
                    offset += written
                else:
                    finished.append((serial, fd, True))
                state["offset"] = offset
            except BlockingIOError:
                state["offset"] = offset
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR):
                    state["offset"] = offset
                else:
                    finished.append((serial, fd, False))
        for serial, fd, ok in finished:
            self.active_writes.pop(serial, None)
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                self.backend.selection_write_done(serial, ok)
            except Exception:
                pass

    def active_write_fds(self):
        return [state["fd"] for state in self.active_writes.values()]

    def pump(self, duration_sec):
        deadline = time.monotonic() + duration_sec
        while not self.closed:
            self.backend.pump_events()
            self.step_writes()
            left = deadline - time.monotonic()
            if left <= 0:
                break
            write_fds = self.active_write_fds()
            wait = min(left, 0.01)
            if write_fds:
                try:
                    select.select([], write_fds, write_fds, wait)
                except OSError:
                    pass
                self.step_writes()
            else:
                time.sleep(wait)

    def assert_unlocked(self):
        self.backend.pump_events()
        self.step_writes()
        if self.closed:
            raise ClipboardError("DESKTOP_CLIPBOARD_UNAVAILABLE")
        try:
            active = self.backend.screensaver_active()
        except Exception:
            raise ClipboardError("DESKTOP_CLIPBOARD_UNAVAILABLE")
        if active is not False:
            raise ClipboardError("DESKTOP_CLIPBOARD_UNAVAILABLE")

    def read_mime(self, mime_type, limit, timeout_sec=2.0):
        fd = self.backend.selection_read(mime_type)
        if fd is None or fd < 0:
            raise ClipboardError("DESKTOP_CLIPBOARD_UNAVAILABLE")
        try:
            os.set_blocking(fd, False)
            chunks = bytearray()
            deadline = time.monotonic() + timeout_sec
            while not self.closed:
                try:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        return bytes(chunks)
                    chunks.extend(chunk)
                    if len(chunks) > limit:
                        raise ClipboardError("CLIPBOARD_TOO_LONG")
                    continue
                except BlockingIOError:
                    pass
                except OSError as exc:
                    if exc.errno == errno.EINTR:
                        continue
                    if exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                        raise ClipboardError("DESKTOP_CLIPBOARD_UNAVAILABLE")
                left = deadline - time.monotonic()
                if left <= 0:
                    raise ClipboardError("DESKTOP_CLIPBOARD_UNAVAILABLE")
                self.backend.pump_events()
                self.step_writes()
                write_fds = self.active_write_fds()
                try:
                    select.select([fd], write_fds, [], min(left, 0.02))
                except OSError:
                    raise ClipboardError("DESKTOP_CLIPBOARD_UNAVAILABLE")
            raise ClipboardError("DESKTOP_CLIPBOARD_UNAVAILABLE")
        finally:
            try:
                os.close(fd)
            except OSError:
                pass

    def handle_version(self):
        self.assert_unlocked()
        return {"version": self.version_token()}

    def handle_read(self):
        self.assert_unlocked()
        if self.session_is_owner:
            formats = list(self.owned_formats)
            content = dict(self.owned_content)
            self.assert_unlocked()
            return {"formats": formats, "content": content}

        start_generation = self.generation
        formats = sorted(set(self.owner_types))
        if len(formats) > MAX_FORMATS or any(len(f) > MAX_FORMAT_LEN for f in formats):
            raise ClipboardError("CLIPBOARD_UNSUPPORTED")
        if not formats:
            self.assert_unlocked()
            if self.generation != start_generation:
                raise ClipboardError("DESKTOP_CLIPBOARD_CHANGED")
            return {"formats": [], "content": {}}

        file_backed = any(FILE_BACKED_RE.search(f) for f in formats)
        content = {}
        if not file_backed:
            for key, candidates in (
                ("text", TEXT_MIMES),
                ("html", HTML_MIMES),
                ("rtf", RTF_MIMES),
            ):
                mime = next((m for m in candidates if m in formats), None)
                if not mime:
                    continue
                raw = self.read_mime(mime, MAX_TEXT_BYTES)
                try:
                    value = raw.decode("utf-8")
                except UnicodeDecodeError:
                    value = raw.decode("utf-8", errors="replace")
                if len(value) > MAX_TEXT_CHARS:
                    raise ClipboardError("CLIPBOARD_TOO_LONG")
                if value:
                    content[key] = value
                if self.generation != start_generation:
                    raise ClipboardError("DESKTOP_CLIPBOARD_CHANGED")

        if "image/png" in formats:
            raw_png = self.read_mime("image/png", IMAGE_BYTES)
            validate_png(raw_png)
            content["png"] = base64.b64encode(raw_png).decode("ascii")

        self.assert_unlocked()
        if self.generation != start_generation:
            raise ClipboardError("DESKTOP_CLIPBOARD_CHANGED")
        return {"formats": formats, "content": content}

    def handle_write(self, raw_content):
        self.assert_unlocked()
        items, formats, clean = decode_incoming_content(raw_content)
        prev_items = self.owned_items
        prev_formats = self.owned_formats
        prev_content = self.owned_content
        self.owned_items = items
        self.owned_formats = formats
        self.owned_content = clean
        before_events = self.owner_events
        before_generation = self.generation
        was_owner = self.session_is_owner
        mime_list = list(items.keys())
        if not self.backend.set_selection(mime_list):
            self.owned_items = prev_items
            self.owned_formats = prev_formats
            self.owned_content = prev_content
            raise ClipboardError("DESKTOP_CLIPBOARD_WRITE_FAILED")
        # Wait for Mutter to confirm session ownership and service eager clipboard manager reads.
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline and not self.closed:
            self.backend.pump_events()
            self.step_writes()
            if self.owner_events > before_events:
                break
            if was_owner and self.session_is_owner and (deadline - time.monotonic()) <= 0.45:
                break
            time.sleep(0.01)
        if not self.session_is_owner:
            self.owned_items = {}
            self.owned_formats = []
            self.owned_content = {}
            raise ClipboardError("DESKTOP_CLIPBOARD_WRITE_FAILED")
        if self.generation == before_generation:
            self.generation += 1
        # Brief grace period for Mutter's clipboard manager to cache the offer.
        self.pump(0.03)
        self.assert_unlocked()
        if not self.session_is_owner:
            raise ClipboardError("DESKTOP_CLIPBOARD_CHANGED")
        return {"ok": True, "version": self.version_token()}

    def handle_request(self, payload):
        req_id = payload.get("id")
        op = payload.get("op")
        try:
            if op == "version":
                result = self.handle_version()
            elif op == "read":
                result = self.handle_read()
            elif op == "write":
                result = self.handle_write(payload.get("content"))
            else:
                raise ClipboardError("DESKTOP_CLIPBOARD_UNAVAILABLE")
            return {"id": req_id, **result}
        except ClipboardError as exc:
            return {"id": req_id, "error": exc.code}
        except Exception:
            return {"id": req_id, "error": "DESKTOP_CLIPBOARD_UNAVAILABLE"}

    def shutdown(self):
        # Allow any in-flight clipboard-manager transfer to complete briefly before stopping.
        if self.active_writes and not self.closed:
            deadline = time.monotonic() + 0.3
            while self.active_writes and time.monotonic() < deadline and not self.closed:
                self.pump(0.02)
        for serial, state in list(self.active_writes.items()):
            try:
                os.close(state["fd"])
            except OSError:
                pass
            try:
                self.backend.selection_write_done(serial, False)
            except Exception:
                pass
        self.active_writes.clear()
        self.owned_items = {}
        self.owned_formats = []
        self.owned_content = {}
        if not self.closed:
            try:
                self.backend.stop()
            except Exception:
                pass


class GioMutterBackend:
    """Real GIO/D-Bus backend for GNOME Shell (Mutter) RemoteDesktop clipboard."""

    def __init__(self, Gio, GLib):
        self.Gio = Gio
        self.GLib = GLib
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.context = GLib.MainContext.default()
        self.session_path = None
        self.subs = []

    def _call(self, name, path, iface, method, args=None, reply_type=None, timeout_ms=3000):
        return self.bus.call_sync(
            name,
            path,
            iface,
            method,
            args,
            self.GLib.VariantType(reply_type) if reply_type else None,
            self.Gio.DBusCallFlags.NONE,
            timeout_ms,
            None,
        )

    def _fd_call(self, method, args, timeout_ms=3000):
        reply, fds = self.bus.call_with_unix_fd_list_sync(
            RD_NAME,
            self.session_path,
            RD_SESSION,
            method,
            args,
            self.GLib.VariantType("(h)"),
            self.Gio.DBusCallFlags.NONE,
            timeout_ms,
            self.Gio.UnixFDList.new(),
            None,
        )
        if not reply or not fds:
            return -1
        index = reply.unpack()[0]
        return fds.get(index)

    def probe(self):
        # Verify Mutter RemoteDesktop and GNOME ScreenSaver exist without starting a session.
        props = self._call(
            RD_NAME,
            RD_PATH,
            DBUS_PROPS,
            "Get",
            self.GLib.Variant("(ss)", (RD_NAME, "SupportedDeviceTypes")),
            "(v)",
        )
        supported = props.unpack()[0]
        if not isinstance(supported, int) or (supported & 3) != 3:
            return False
        active = self.screensaver_active()
        return isinstance(active, bool)

    def screensaver_active(self):
        reply = self._call(
            SCREENSAVER_NAME,
            SCREENSAVER_PATH,
            SCREENSAVER_NAME,
            "GetActive",
            None,
            "(b)",
            timeout_ms=1000,
        )
        return bool(reply.unpack()[0])

    def start(self, session):
        reply = self._call(RD_NAME, RD_PATH, RD_NAME, "CreateSession", None, "(o)")
        self.session_path = reply.unpack()[0]
        self.subs.append(
            self.bus.signal_subscribe(
                RD_NAME, RD_SESSION, "Closed", self.session_path, None, 0,
                lambda *_args: session.on_closed(),
            )
        )
        self.subs.append(
            self.bus.signal_subscribe(
                RD_NAME, RD_SESSION, "SelectionOwnerChanged", self.session_path, None, 0,
                lambda _c, _s, _p, _i, _sig, params: session.on_owner_changed(params.unpack()[0]),
            )
        )
        self.subs.append(
            self.bus.signal_subscribe(
                RD_NAME, RD_SESSION, "SelectionTransfer", self.session_path, None, 0,
                lambda _c, _s, _p, _i, _sig, params: session.on_transfer(*params.unpack()),
            )
        )
        self._call(RD_NAME, self.session_path, RD_SESSION, "Start", None, None)
        self._call(
            RD_NAME,
            self.session_path,
            RD_SESSION,
            "EnableClipboard",
            self.GLib.Variant("(a{sv})", ({},)),
            None,
        )

    def set_selection(self, mime_types):
        try:
            self._call(
                RD_NAME,
                self.session_path,
                RD_SESSION,
                "SetSelection",
                self.GLib.Variant("(a{sv})", ({"mime-types": self.GLib.Variant("as", mime_types)},)),
                None,
            )
            return True
        except Exception:
            return False

    def selection_read(self, mime_type):
        try:
            return self._fd_call("SelectionRead", self.GLib.Variant("(s)", (mime_type,)))
        except Exception:
            return -1

    def selection_write(self, serial):
        try:
            return self._fd_call("SelectionWrite", self.GLib.Variant("(u)", (serial,)))
        except Exception:
            return -1

    def selection_write_done(self, serial, ok):
        try:
            self._call(
                RD_NAME,
                self.session_path,
                RD_SESSION,
                "SelectionWriteDone",
                self.GLib.Variant("(ub)", (serial, bool(ok))),
                None,
            )
        except Exception:
            pass

    def pump_events(self):
        while self.context.iteration(False):
            pass

    def stop(self):
        for sub in self.subs:
            try:
                self.bus.signal_unsubscribe(sub)
            except Exception:
                pass
        self.subs.clear()
        if self.session_path:
            path = self.session_path
            self.session_path = None
            try:
                self._call(RD_NAME, path, RD_SESSION, "Stop", None, None, timeout_ms=1500)
            except Exception:
                pass


def main():
    harden()
    if not is_gnome_wayland_env():
        return 2
    check = len(sys.argv) == 2 and sys.argv[1] == "--check"
    if len(sys.argv) > 1 and not check:
        return 2
    try:
        from gi.repository import Gio, GLib
    except Exception:
        return 2
    try:
        backend = GioMutterBackend(Gio, GLib)
        if check:
            if not backend.probe():
                return 2
            print("ready", flush=True)
            return 0
    except Exception:
        return 2

    stopping = False

    def on_signal(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    session = GnomeClipboardSession(backend)
    try:
        backend.start(session)
        # Allow the initial SelectionOwnerChanged signal to populate owner_types.
        deadline = time.monotonic() + 0.15
        while time.monotonic() < deadline and not session.closed and session.owner_events == 0:
            session.pump(0.01)
        if session.closed:
            return 2
        print("ready", flush=True)
        stdin_fd = sys.stdin.fileno()
        os.set_blocking(stdin_fd, False)
        buf = bytearray()
        while not stopping and not session.closed:
            backend.pump_events()
            session.step_writes()
            if session.closed:
                break
            write_fds = session.active_write_fds()
            try:
                readable, writable, _ = select.select([stdin_fd], write_fds, [], 0.05)
            except InterruptedError:
                continue
            except OSError:
                break
            if writable:
                session.step_writes()
            if not readable:
                continue
            try:
                chunk = os.read(stdin_fd, 65536)
            except BlockingIOError:
                continue
            except OSError:
                break
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > MAX_LINE_BYTES:
                break
            while b"\n" in buf:
                idx = buf.index(b"\n")
                raw_line = bytes(buf[:idx])
                del buf[: idx + 1]
                try:
                    payload = json.loads(raw_line.decode("utf-8"))
                except Exception:
                    return 2
                if not isinstance(payload, dict) or not isinstance(payload.get("id"), int):
                    return 2
                reply = session.handle_request(payload)
                sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
                sys.stdout.flush()
    except Exception:
        return 2
    finally:
        session.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
