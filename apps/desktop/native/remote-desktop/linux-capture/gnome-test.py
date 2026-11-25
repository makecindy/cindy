"""Explicit GNOME (Mutter) Wayland integration test:
    python3 gnome-test.py <gnome-capture-helper> <input-helper>
Requires gnome-shell (46+), dbus-daemon, a running user PipeWire, python3-gi
and gdk-pixbuf. Starts its own headless GNOME Shell on a private session bus,
so it never records or drives the user's real desktop.

Covers: probes without creating a session, monitor enumeration, cursor-free
monitor video (with an embedded-cursor control that must differ), cursor
position/hotspot/shape from stream metadata, absolute pointer input, keyboard
text, Chinese text pasted through the clipboard with the user's clipboard
restored (also after the helper exits), wheel, clean EOF teardown of both
helpers, and helper exit when the compositor goes away.
"""
import base64
import ctypes as C
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

from gi.repository import Gio, GLib

GP = C.CDLL('libgdk_pixbuf-2.0.so.0')
def api(name, result, args):
    f = getattr(GP, name); f.restype = result; f.argtypes = args; return f
api('gdk_pixbuf_new_from_file', C.c_void_p, [C.c_char_p, C.c_void_p])
for name in ('width', 'height', 'rowstride', 'n_channels'):
    api('gdk_pixbuf_get_' + name, C.c_int, [C.c_void_p])
api('gdk_pixbuf_get_pixels', C.POINTER(C.c_ubyte), [C.c_void_p])
api('g_object_unref', None, [C.c_void_p])

capture_binary, input_binary = (str(Path(p).resolve()) for p in sys.argv[1:3])
with tempfile.TemporaryDirectory(prefix='cindy-gnome-test-') as temp:
    bus = subprocess.Popen(['dbus-daemon', '--session', '--nofork', '--print-address=1'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    address = bus.stdout.readline().strip()
    display = 'cindy-test-%d' % os.getpid()
    env = {**os.environ, 'DBUS_SESSION_BUS_ADDRESS': address, 'XDG_SESSION_TYPE': 'wayland',
           'XDG_CURRENT_DESKTOP': 'GNOME', 'WAYLAND_DISPLAY': display}
    env.pop('DISPLAY', None)
    shell = subprocess.Popen(['gnome-shell', '--headless', '--wayland', '--no-x11',
                              '--virtual-monitor', '1280x800', '--wayland-display', display],
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    helpers = []
    try:
        connection = Gio.DBusConnection.new_for_address_sync(
            address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
            Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            owned = connection.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                                         'org.freedesktop.DBus', 'NameHasOwner',
                                         GLib.Variant('(s)', ('org.gnome.Mutter.RemoteDesktop',)),
                                         None, 0, -1, None).unpack()[0]
            if owned: break
            time.sleep(0.2)
        assert owned, 'headless GNOME Shell did not start'
        time.sleep(2)  # let the shell finish its startup animation

        for args in ([capture_binary, '--check'], [input_binary, '--gnome', '--check']):
            result = subprocess.run(args, env=env, capture_output=True, timeout=5)
            assert result.returncode == 0 and result.stdout == b'ready\n', (args, result)
        x11 = subprocess.run([capture_binary, '--check'], capture_output=True, timeout=5,
                             env={**env, 'XDG_SESSION_TYPE': 'x11', 'WAYLAND_DISPLAY': ''})
        assert x11.returncode != 0 and not x11.stdout, 'X11 session probe accepted'
        monitors = json.loads(subprocess.run([capture_binary, '--monitors'], env=env,
                                             capture_output=True, timeout=5).stdout)
        assert len(monitors) == 1 and monitors[0]['width'] == 1280 and monitors[0]['height'] == 800, monitors
        connector = monitors[0]['id']
        for bad in ('gnome:', 'gnome:a b', 'gnome:../x', 'hyprland:Meta-0'):
            result = subprocess.run([capture_binary, 'cursor-overlay', '1', '65', bad], env=env,
                                    input=b'f', capture_output=True, timeout=5)
            assert result.returncode == 2 and not result.stdout, (bad, result)

        # Another application's clipboard, which pasting must leave in place.
        RD = 'org.gnome.Mutter.RemoteDesktop'; RDS = RD + '.Session'
        def rd(path, iface, method, args=None, fds=None):
            if fds is not None:
                return connection.call_with_unix_fd_list_sync(RD, path, iface, method, args,
                                                              None, 0, -1, fds, None)
            return connection.call_sync(RD, path, iface, method, args, None, 0, -1, None)
        owner = rd('/org/gnome/Mutter/RemoteDesktop', RD, 'CreateSession').unpack()[0]
        rd(owner, RDS, 'Start')
        rd(owner, RDS, 'EnableClipboard', GLib.Variant('(a{sv})', ({},)))
        def serve(conn, sender, path, iface, signal, params):
            serial = params.unpack()[1]
            reply, fds = rd(owner, RDS, 'SelectionWrite', GLib.Variant('(u)', (serial,)),
                            Gio.UnixFDList.new())
            fd = fds.get(reply.unpack()[0]); os.write(fd, 'copied before'.encode()); os.close(fd)
            rd(owner, RDS, 'SelectionWriteDone', GLib.Variant('(ub)', (serial, True)))
        connection.signal_subscribe(RD, RDS, 'SelectionTransfer', owner, None, 0, serve)
        rd(owner, RDS, 'SetSelection', GLib.Variant('(a{sv})', (
            {'mime-types': GLib.Variant('as', ['text/plain;charset=utf-8'])},)))
        context = GLib.MainContext.default()
        def pump(seconds):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                while context.iteration(False): pass
                time.sleep(0.005)
        def clipboard():
            reply, fds = rd(owner, RDS, 'SelectionRead',
                            GLib.Variant('(s)', ('text/plain;charset=utf-8',)), Gio.UnixFDList.new())
            fd = fds.get(reply.unpack()[0]); os.set_blocking(fd, False)
            data, end = b'', time.monotonic() + 2
            while time.monotonic() < end:
                pump(0.02)
                try:
                    chunk = os.read(fd, 65536)
                    if not chunk: break
                    data += chunk
                except BlockingIOError:
                    pass
            os.close(fd)
            return data.decode()
        pump(0.3)

        def start(*args):
            p = subprocess.Popen(list(args), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            helpers.append(p); return p
        pointer = start(input_binary, '--gnome', connector)
        assert pointer.stdout.readline() == b'ready\n'
        def send(events):
            pointer.stdin.write((json.dumps(events, ensure_ascii=False) + '\n').encode())
            pointer.stdin.flush()
            reply = []
            reader = threading.Thread(target=lambda: reply.append(pointer.stdout.readline()))
            reader.start()
            while reader.is_alive(): pump(0.02)  # the clipboard owner keeps serving
            assert reply == [b'ok\n'], events
            pump(0.3)  # one compositor frame for the cursor and damage
        overlay = start(capture_binary, 'cursor-overlay', '1', '65', 'gnome:' + connector)
        embedded = start(capture_binary, 'video', '1', '65', 'gnome:' + connector)
        def frame(helper):
            helper.stdin.write(b'f'); helper.stdin.flush()
            line = helper.stdout.readline(); assert line, 'helper exited'
            return json.loads(line) if line.startswith(b'{') else {'jpeg': line.strip().decode()}
        def pixels(jpeg):
            path = Path(temp) / 'frame.jpg'; path.write_bytes(base64.b64decode(jpeg))
            image = GP.gdk_pixbuf_new_from_file(str(path).encode(), None); assert image
            size = (GP.gdk_pixbuf_get_width(image), GP.gdk_pixbuf_get_height(image))
            stride, channels = GP.gdk_pixbuf_get_rowstride(image), GP.gdk_pixbuf_get_n_channels(image)
            data = bytes(GP.gdk_pixbuf_get_pixels(image)[:stride * size[1]])
            GP.g_object_unref(image)
            return size, lambda x, y: data[y * stride + x * channels: y * stride + x * channels + 3]
        def region_difference(a, b, x0, y0):
            return max(abs(p - q) for y in range(y0, y0 + 20) for x in range(x0, x0 + 14)
                       for p, q in zip(a(x, y), b(x, y)))

        # Empty overview background at A; the pointer then leaves for B.
        A, B = (0.05, 0.5), (0.95, 0.93)
        send([{'kind': 'move', 'x': A[0], 'y': A[1]}])
        at_a = frame(overlay); embedded_at_a = frame(embedded)
        cursor = at_a['cursor']
        assert cursor['visible'] is True and cursor['shape'] == 'default', cursor
        assert abs(cursor['x'] - A[0]) < 0.002 and abs(cursor['y'] - A[1]) < 0.002, cursor
        assert cursor['png'].startswith('iVBORw0KGgo') and 0 < cursor['width'] <= 256, cursor
        send([{'kind': 'move', 'x': B[0], 'y': B[1]}])
        at_b = frame(overlay); embedded_at_b = frame(embedded)
        size, before = pixels(at_a['jpeg']); _, after = pixels(at_b['jpeg'])
        assert size == (1280, 800), size
        x0, y0 = round(A[0] * 1279), round(A[1] * 799)
        assert region_difference(before, after, x0, y0) <= 24, 'cursor drawn into video'
        # Control: the embedded-cursor stream must show the pointer at A.
        _, with_cursor = pixels(embedded_at_a['jpeg']); _, without = pixels(embedded_at_b['jpeg'])
        assert region_difference(with_cursor, without, x0, y0) > 60, 'control saw no cursor'

        # The search entry shows a text cursor; ASCII text types into it.
        send([{'kind': 'move', 'x': 0.5, 'y': 0.078}])
        assert frame(overlay)['cursor']['shape'] == 'text'
        send([{'kind': 'text', 'text': 'cindy'}])
        _, typed = pixels(frame(overlay)['jpeg'])
        send([{'kind': 'text', 'text': '中文'}])
        _, pasted = pixels(frame(overlay)['jpeg'])
        # The pasted glyphs appear right after "cindy" in the search entry.
        assert region_difference(typed, pasted, 545, 52) > 60, 'Chinese text not pasted'
        assert clipboard() == 'copied before', 'pasting replaced the clipboard'

        send([{'kind': 'button', 'x': 0.5, 'y': 0.5, 'button': 0, 'down': True},
              {'kind': 'button', 'x': 0.5, 'y': 0.5, 'button': 0, 'down': False},
              {'kind': 'scroll', 'dx': 0, 'dy': 80},
              {'kind': 'key', 'code': 'Escape', 'down': True},
              {'kind': 'key', 'code': 'Escape', 'down': False}])

        for helper in (pointer, overlay, embedded):
            helper.stdin.close()
            assert helper.wait(timeout=5) == 0, 'EOF did not exit cleanly'
        pump(1.0)
        assert clipboard() == 'copied before', 'clipboard lost when the helper exited'
        # Without the compositor the helper exits instead of serving stale frames.
        orphan = start(capture_binary, 'cursor-overlay', '1', '65', 'gnome:' + connector)
        frame(orphan)
        shell.terminate(); shell.wait(timeout=10)
        try:
            orphan.stdin.write(b'f'); orphan.stdin.flush()
        except BrokenPipeError:
            pass
        assert orphan.wait(timeout=5) != 0, 'helper survived its compositor'
        print('PASS: probes, monitors, cursor-free video with embedded control, cursor '
              'position/shape, pointer/text/wheel/keys, Chinese paste with clipboard restored, '
              'EOF teardown, compositor exit')
    finally:
        for p in helpers:
            if p.poll() is None: p.kill(); p.wait(timeout=3)
        if shell.poll() is None: shell.terminate(); shell.wait(timeout=10)
        bus.terminate(); bus.wait(timeout=3)
