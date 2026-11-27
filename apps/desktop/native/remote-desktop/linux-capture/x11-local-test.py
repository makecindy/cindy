"""Explicit X11 local-only window test: python3 x11-local-test.py <capture-helper> [--wm]
Requires Xvfb and gdk-pixbuf; `--wm` also requires xfwm4 and runs under its
compositor. Uses its own authenticated private X display; never reads the
user's real desktop.

Basis: Cindy's controlled-desktop notice is shown locally on X11 only while
capture keeps it out of the viewer's picture (x11.h, `exclude:` argument).
Covers: the local-check probe, malformed or non-X11 exclusion arguments, the
notice's area rebuilt from the windows beneath it while a window above it
stays, the window-manager frame (or a reparented parent) removed with it,
following a moved notice, a destroyed notice, and the unexcluded control.
"""
import base64
import ctypes as C
import os
from pathlib import Path
import json
import select
import struct
import subprocess
import sys
import tempfile
import time

X = C.CDLL('libX11.so.6')
GP = C.CDLL('libgdk_pixbuf-2.0.so.0')
D = C.c_void_p
U = C.c_ulong
def api(lib, name, result, args):
    f = getattr(lib, name); f.restype = result; f.argtypes = args; return f
api(X, 'XOpenDisplay', D, [C.c_char_p]); api(X, 'XCloseDisplay', C.c_int, [D])
api(X, 'XDefaultRootWindow', U, [D])
api(X, 'XCreateSimpleWindow', U, [D, U, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, U, U])
api(X, 'XMapWindow', C.c_int, [D, U]); api(X, 'XSync', C.c_int, [D, C.c_int])
api(X, 'XMoveWindow', C.c_int, [D, U, C.c_int, C.c_int])
api(X, 'XDestroyWindow', C.c_int, [D, U])
api(X, 'XRaiseWindow', C.c_int, [D, U])
class Attributes(C.Structure):
    _fields_ = [('background_pixmap', U), ('background_pixel', U), ('border_pixmap', U),
                ('border_pixel', U), ('bit_gravity', C.c_int), ('win_gravity', C.c_int),
                ('backing_store', C.c_int), ('backing_planes', U), ('backing_pixel', U),
                ('save_under', C.c_int), ('event_mask', C.c_long),
                ('do_not_propagate_mask', C.c_long), ('override_redirect', C.c_int),
                ('colormap', U), ('cursor', U)]
api(X, 'XChangeWindowAttributes', C.c_int, [D, U, U, C.POINTER(Attributes)])
api(GP, 'gdk_pixbuf_new_from_file', D, [C.c_char_p, D])
for name in ('width', 'height', 'rowstride', 'n_channels'):
    api(GP, 'gdk_pixbuf_get_' + name, C.c_int, [D])
api(GP, 'gdk_pixbuf_get_pixels', C.POINTER(C.c_ubyte), [D])
api(GP, 'g_object_unref', None, [D])
CW_OVERRIDE_REDIRECT = 1 << 9
RED, GREEN, BLUE, WHITE = (0xcc, 0x33, 0x33), (0x33, 0xaa, 0x33), (0x33, 0x33, 0xcc), (0xff, 0xff, 0xff)
WM = '--wm' in sys.argv[2:]
def field(b): return struct.pack('>H', len(b)) + b
def rgb(c): return (c[0] << 16) | (c[1] << 8) | c[2]

with tempfile.TemporaryDirectory(prefix='cindy-x11-local-test-') as temp:
    auth = Path(temp) / 'authority'
    auth.write_bytes(struct.pack('>H', 65535) + field(b'') + field(b'') +
                     field(b'MIT-MAGIC-COOKIE-1') + field(os.urandom(16)))
    auth.chmod(0o600)
    r, w = os.pipe()
    server = subprocess.Popen(['Xvfb', '-displayfd', str(w), '-auth', str(auth), '-nolisten', 'tcp',
                               '-screen', '0', '800x600x24'], pass_fds=[w],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    os.close(w)
    display = None
    wm = None
    try:
        assert select.select([r], [], [], 8)[0], 'Xvfb did not start'
        number = os.read(r, 128).decode().strip(); os.close(r)
        assert number.isdigit(), server.stderr.read().decode()
        os.environ.update(DISPLAY=':' + number, XAUTHORITY=str(auth), XDG_SESSION_TYPE='x11')
        os.environ.pop('WAYLAND_DISPLAY', None)
        display = X.XOpenDisplay(None); assert display
        root = X.XDefaultRootWindow(display)
        if WM:
            wm = subprocess.Popen(['xfwm4', '--compositor=on', '--sm-client-disable'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(1.5); assert wm.poll() is None, 'xfwm4 did not start'
        def window(x, y, width, height, color, parent=None, unmanaged=True):
            win = X.XCreateSimpleWindow(display, parent or root, x, y, width, height, 0, 0, rgb(color))
            if unmanaged and not parent:
                attrs = Attributes(override_redirect=1)
                X.XChangeWindowAttributes(display, win, CW_OVERRIDE_REDIRECT, C.byref(attrs))
            X.XMapWindow(display, win)
            return win
        def settle():
            X.XSync(display, False); time.sleep(0.6 if WM else 0.05)
        window(0, 0, 400, 600, RED)
        window(400, 0, 400, 600, GREEN)
        if WM:
            # A managed window: xfwm4 reparents it into a decorated frame.
            holder = notice = window(300, 250, 200, 100, WHITE, unmanaged=False)
        else:
            # Without a window manager, stand in for its frame by hand.
            holder = window(290, 240, 220, 120, WHITE)
            notice = window(10, 10, 200, 100, WHITE, parent=holder)
        settle()
        above = window(450, 280, 100, 40, BLUE)
        X.XRaiseWindow(display, above)
        settle()
        binary = str(Path(sys.argv[1]).resolve())

        result = subprocess.run([binary, '--x11-local-check'], capture_output=True, timeout=3)
        assert result.returncode == 0 and result.stdout == b'ready\n', result
        for args in (['exclude:'], ['exclude:0'], ['exclude:1,'], ['exclude:a'], ['exclude:-1'],
                     ['exclude:1,2,3,4,5'], ['exclude:4294967296'], ['exclude:+1'],
                     ['exclude: 1'], ['1']):
            bad = subprocess.run([binary, 'cursor-overlay', '1', '65', 'x11:0,0,800,600', *args],
                                 input=b'f', capture_output=True, timeout=3)
            assert bad.returncode != 0 and not bad.stdout, (args, bad)
        other = subprocess.run([binary, 'cursor-overlay', '1', '65', 'DP-1', f'exclude:{notice}'],
                               input=b'f', capture_output=True, timeout=3)
        assert other.returncode == 2 and not other.stdout, other

        def helper(*extra):
            return subprocess.Popen([binary, 'cursor-overlay', '1', '65', 'x11:0,0,800,600', *extra],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        def frame(process):
            process.stdin.write(b'f'); process.stdin.flush()
            line = process.stdout.readline(); assert line, 'helper exited'
            path = Path(temp) / 'frame.jpg'; path.write_bytes(base64.b64decode(json.loads(line)['jpeg']))
            image = GP.gdk_pixbuf_new_from_file(str(path).encode(), None); assert image
            stride, channels = GP.gdk_pixbuf_get_rowstride(image), GP.gdk_pixbuf_get_n_channels(image)
            data = bytes(GP.gdk_pixbuf_get_pixels(image)[:stride * GP.gdk_pixbuf_get_height(image)])
            GP.g_object_unref(image)
            return lambda x, y: tuple(data[y * stride + x * channels: y * stride + x * channels + 3])
        def near(actual, expected): return all(abs(a - b) <= 24 for a, b in zip(actual, expected))
        def expect(pixel, points):
            for (x, y), color in points:
                assert near(pixel(x, y), color), ((x, y), pixel(x, y), color)

        control = helper()
        expect(frame(control), [((320, 270), WHITE), ((480, 330), WHITE), ((500, 300), BLUE)])
        control.stdin.close(); assert control.wait(timeout=3) == 0

        local = helper(f'exclude:{notice}')
        # Notice (and its frame) gone, both halves beneath it intact, the window above kept.
        expect(frame(local), [((320, 270), RED), ((350, 330), RED), ((480, 330), GREEN),
                              ((480, 260), GREEN), ((480, 244), GREEN), ((500, 300), BLUE),
                              ((200, 300), RED)])
        X.XMoveWindow(display, holder, 100, 400); settle()
        moved = frame(local)
        expect(moved, [((320, 270), RED), ((480, 330), GREEN), ((150, 450), RED), ((280, 470), RED)])
        X.XDestroyWindow(display, holder if not WM else notice); settle()
        expect(frame(local), [((150, 450), RED), ((500, 300), BLUE)])
        local.stdin.close()
        assert local.wait(timeout=3) == 0, 'EOF did not exit cleanly'
        print('PASS' + (' (xfwm4 compositor)' if WM else '') + ': local-check probe, invalid '
              'exclusions, notice rebuilt from windows beneath, window above kept, frame removed, '
              'moved notice followed, destroyed notice, unexcluded control')
    finally:
        if wm: wm.terminate(); wm.wait(timeout=3)
        if display: X.XCloseDisplay(display)
        server.terminate(); server.wait(timeout=3)
