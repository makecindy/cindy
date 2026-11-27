"""Unit tests for linux-gnome-clipboard.py without a running GNOME compositor.

Covers: GNOME 46 (as) vs as mime-types, ScreenSaver lock gating before/after
operations, file-backed path filtering, PNG IHDR/pixel/byte bounds, non-blocking
SelectionTransfer writes larger than pipe capacity, mid-read owner change, and
clean EOF shutdown.
"""
import base64
import importlib.util
import os
import pathlib
import struct
import sys
import threading
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "gnome_clipboard", pathlib.Path(__file__).with_name("linux-gnome-clipboard.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def make_png(width=16, height=16, extra=b""):
    header = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR" + struct.pack(">II", width, height) + b"\x08\x06\x00\x00\x00" + b"\x00\x00\x00\x00"
    return header + extra


class FakeBackend:
    def __init__(self):
        self.locked = False
        self.stopped = False
        self.read_data = {}
        self.offered = None
        self.write_pipes = {}
        self.write_done = []
        self.on_set_selection = None
        self.on_pump = None

    def screensaver_active(self):
        return self.locked

    def pump_events(self):
        if self.on_pump:
            self.on_pump()

    def set_selection(self, mime_types):
        self.offered = list(mime_types)
        if self.on_set_selection:
            return self.on_set_selection(mime_types)
        return True

    def selection_read(self, mime_type):
        if mime_type not in self.read_data:
            return -1
        r_fd, w_fd = os.pipe()
        payload = self.read_data[mime_type]

        def writer():
            try:
                view = memoryview(payload)
                offset = 0
                while offset < len(view):
                    offset += os.write(w_fd, view[offset : offset + 65536])
            finally:
                os.close(w_fd)

        threading.Thread(target=writer, daemon=True).start()
        return r_fd

    def selection_write(self, serial):
        r_fd, w_fd = os.pipe()
        self.write_pipes[serial] = r_fd
        return w_fd

    def selection_write_done(self, serial, ok):
        self.write_done.append((serial, ok))

    def stop(self):
        self.stopped = True


class GnomeClipboardTests(unittest.TestCase):
    def test_environment_and_gnome46_tuple_mime_types(self):
        self.assertTrue(
            module.is_gnome_wayland_env(
                {"XDG_SESSION_TYPE": "wayland", "XDG_CURRENT_DESKTOP": "ubuntu:GNOME"}
            )
        )
        self.assertFalse(
            module.is_gnome_wayland_env(
                {"XDG_SESSION_TYPE": "x11", "XDG_CURRENT_DESKTOP": "ubuntu:GNOME"}
            )
        )
        self.assertFalse(
            module.is_gnome_wayland_env(
                {
                    "WAYLAND_DISPLAY": "wayland-1",
                    "XDG_CURRENT_DESKTOP": "GNOME",
                    "HYPRLAND_INSTANCE_SIGNATURE": "sig",
                }
            )
        )
        self.assertEqual(
            module.unwrap_mime_types((["text/plain;charset=utf-8", "text/html"],)),
            ["text/plain;charset=utf-8", "text/html"],
        )
        self.assertEqual(
            module.unwrap_mime_types(["text/plain"]),
            ["text/plain"],
        )

    def test_reads_portable_alternatives_and_filters_file_paths(self):
        backend = FakeBackend()
        session = module.GnomeClipboardSession(backend)
        session.on_owner_changed(
            {
                "session-is-owner": False,
                "mime-types": (["TARGETS", "text/plain;charset=utf-8", "text/html", "text/rtf"],),
            }
        )
        backend.read_data = {
            "text/plain;charset=utf-8": "中文 ⇄ GNOME".encode("utf-8"),
            "text/html": b"<b>hi</b>",
            "text/rtf": b"{\\rtf1 hi}",
        }
        reply = session.handle_request({"id": 1, "op": "read"})
        self.assertEqual(
            reply["content"],
            {"text": "中文 ⇄ GNOME", "html": "<b>hi</b>", "rtf": "{\\rtf1 hi}"},
        )
        self.assertNotIn("TARGETS", reply["formats"])

        # File-backed copy must never leak local paths disguised as text/HTML.
        png = make_png(10, 10)
        session.on_owner_changed(
            {
                "session-is-owner": False,
                "mime-types": ["text/uri-list", "text/plain", "image/png"],
            }
        )
        backend.read_data = {"text/plain": b"/secret/path.png", "image/png": png}
        reply2 = session.handle_request({"id": 2, "op": "read"})
        self.assertEqual(reply2["content"], {"png": base64.b64encode(png).decode("ascii")})

    def test_refuses_when_locked_or_closed(self):
        backend = FakeBackend()
        session = module.GnomeClipboardSession(backend)
        backend.locked = True
        self.assertEqual(
            session.handle_request({"id": 1, "op": "version"}),
            {"id": 1, "error": "DESKTOP_CLIPBOARD_UNAVAILABLE"},
        )
        self.assertEqual(
            session.handle_request({"id": 2, "op": "read"}),
            {"id": 2, "error": "DESKTOP_CLIPBOARD_UNAVAILABLE"},
        )
        self.assertEqual(
            session.handle_request({"id": 3, "op": "write", "content": {"text": "x"}}),
            {"id": 3, "error": "DESKTOP_CLIPBOARD_UNAVAILABLE"},
        )
        self.assertIsNone(backend.offered)

        backend.locked = False
        session.on_closed()
        self.assertEqual(
            session.handle_request({"id": 4, "op": "version"}),
            {"id": 4, "error": "DESKTOP_CLIPBOARD_UNAVAILABLE"},
        )

    def test_enforces_png_pixel_and_byte_bounds(self):
        backend = FakeBackend()
        session = module.GnomeClipboardSession(backend)
        session.on_owner_changed({"session-is-owner": False, "mime-types": ["image/png"]})
        backend.read_data = {"image/png": make_png(6001, 4000)}
        self.assertEqual(
            session.handle_request({"id": 1, "op": "read"}),
            {"id": 1, "error": "CLIPBOARD_TOO_LONG"},
        )
        backend.read_data = {"image/png": b"not-a-png" * 10}
        self.assertEqual(
            session.handle_request({"id": 2, "op": "read"}),
            {"id": 2, "error": "CLIPBOARD_UNSUPPORTED"},
        )

    def test_detects_owner_change_mid_read(self):
        backend = FakeBackend()
        session = module.GnomeClipboardSession(backend)
        session.on_owner_changed({"session-is-owner": False, "mime-types": ["text/plain"]})
        backend.read_data = {"text/plain": b"stale"}
        original_read = session.read_mime

        def mutate_mid_read(mime, limit, timeout_sec=2.0):
            data = original_read(mime, limit, timeout_sec)
            session.on_owner_changed({"session-is-owner": False, "mime-types": ["text/plain"]})
            return data

        session.read_mime = mutate_mid_read
        self.assertEqual(
            session.handle_request({"id": 1, "op": "read"}),
            {"id": 1, "error": "DESKTOP_CLIPBOARD_CHANGED"},
        )

    def test_writes_offer_serves_large_nonblocking_transfer_and_reads_back_without_deadlock(self):
        backend = FakeBackend()
        session = module.GnomeClipboardSession(backend)
        # > 256 KiB payload exceeds OS pipe buffer, verifying non-blocking writes.
        big_png = make_png(100, 100, extra=b"\x01" * (300 * 1024))
        big_b64 = base64.b64encode(big_png).decode("ascii")

        def confirm_owner(_mimes):
            session.on_owner_changed({"session-is-owner": True})
            return True

        backend.on_set_selection = confirm_owner
        reply = session.handle_request(
            {"id": 1, "op": "write", "content": {"text": "hello", "png": big_b64}}
        )
        self.assertTrue(reply.get("ok"))
        self.assertRegex(reply["version"], r"^\d{1,128}$")
        self.assertIn("text/plain;charset=utf-8", backend.offered)
        self.assertIn("image/png", backend.offered)

        # Read-back while we own selection returns owned content without self-pipe deadlock.
        read_back = session.handle_request({"id": 2, "op": "read"})
        self.assertEqual(read_back["content"], {"text": "hello", "png": big_b64})

        # Another app pastes the 300 KiB PNG while we pump non-blocking writes.
        session.on_transfer("image/png", 7)
        read_fd = backend.write_pipes[7]
        received = bytearray()

        def reader():
            try:
                while True:
                    chunk = os.read(read_fd, 16384)
                    if not chunk:
                        break
                    received.extend(chunk)
            finally:
                os.close(read_fd)

        t = threading.Thread(target=reader)
        t.start()
        session.pump(0.5)
        t.join(timeout=2)
        self.assertEqual(bytes(received), big_png)
        self.assertIn((7, True), backend.write_done)

        session.shutdown()
        self.assertTrue(backend.stopped)


if __name__ == "__main__":
    unittest.main()
