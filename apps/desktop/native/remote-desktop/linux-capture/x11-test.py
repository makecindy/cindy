"""Explicit X11 capture integration test: python3 x11-test.py <capture-helper>.
Requires Xvfb and gdk-pixbuf. Uses its own authenticated private X display;
never reads the user's real desktop.

Covers: probe and XWayland refusal, cursor-free root pixels around the pointer,
XFIXES cursor position/hotspot/size in desktop points, theme-name shape hints
(named, renamed and unnamed cursors), leaving the captured rectangle, malformed
or out-of-root geometry, and clean EOF exit.
"""
import base64
import ctypes as C
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile

X = C.CDLL('libX11.so.6')
XF = C.CDLL('libXfixes.so.3')
GP = C.CDLL('libgdk_pixbuf-2.0.so.0')
D = C.c_void_p
U = C.c_ulong
def api(lib, name, result, args):
    f = getattr(lib, name); f.restype = result; f.argtypes = args; return f
api(X, 'XOpenDisplay', D, [C.c_char_p]); api(X, 'XCloseDisplay', C.c_int, [D])
api(X, 'XDefaultRootWindow', U, [D])
api(X, 'XCreateSimpleWindow', U, [D, U, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, U, U])
api(X, 'XMapWindow', C.c_int, [D, U]); api(X, 'XSync', C.c_int, [D, C.c_int])
api(X, 'XCreateFontCursor', U, [D, C.c_uint]); api(X, 'XDefineCursor', C.c_int, [D, U, U])
api(X, 'XWarpPointer', C.c_int, [D, U, U, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_int, C.c_int])
api(XF, 'XFixesSetCursorName', None, [D, U, C.c_char_p])
api(GP, 'gdk_pixbuf_new_from_file', D, [C.c_char_p, D])
for name in ('width', 'height', 'rowstride', 'n_channels'):
    api(GP, 'gdk_pixbuf_get_' + name, C.c_int, [D])
api(GP, 'gdk_pixbuf_get_pixels', C.POINTER(C.c_ubyte), [D])
api(GP, 'g_object_unref', None, [D])
XC_WATCH, XC_XTERM = 150, 152
BACKGROUND = (0x33, 0x66, 0xcc)
def field(b): return struct.pack('>H', len(b)) + b

with tempfile.TemporaryDirectory(prefix='cindy-x11-capture-test-') as temp:
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
    try:
        assert select.select([r], [], [], 8)[0], 'Xvfb did not start'
        number = os.read(r, 128).decode().strip(); os.close(r)
        assert number.isdigit(), server.stderr.read().decode()
        # No cursor theme: Xlib keeps core font cursors, which carry no name
        # until the test assigns one, so every shape assertion is deterministic.
        os.environ.update(DISPLAY=':' + number, XAUTHORITY=str(auth), XDG_SESSION_TYPE='x11',
                          XCURSOR_PATH=temp, XCURSOR_THEME='cindy-none')
        os.environ.pop('WAYLAND_DISPLAY', None)
        display = X.XOpenDisplay(None); assert display
        root = X.XDefaultRootWindow(display)
        color = (BACKGROUND[0] << 16) | (BACKGROUND[1] << 8) | BACKGROUND[2]
        win = X.XCreateSimpleWindow(display, root, 0, 0, 800, 600, 0, 0, color)
        X.XMapWindow(display, win)
        text = X.XCreateFontCursor(display, XC_XTERM)
        XF.XFixesSetCursorName(display, text, b'xterm')
        X.XDefineCursor(display, win, text)
        X.XWarpPointer(display, 0, root, 0, 0, 0, 0, 250, 200)
        X.XSync(display, False)
        binary = str(Path(sys.argv[1]).resolve())

        result = subprocess.run([binary, '--x11-check'], capture_output=True, timeout=3)
        assert result.returncode == 0 and result.stdout == b'ready\n', result
        wrong = subprocess.run([binary, '--x11-check'], capture_output=True, timeout=3,
                               env={**os.environ, 'XDG_SESSION_TYPE': 'wayland'})
        assert wrong.returncode == 1 and not wrong.stdout, 'XWayland probe accepted'
        for geometry in ('x11:500,400,400,300', 'x11:1,2,3', 'x11:0,0,400,300x', 'x11:-1,0,10,10'):
            bad = subprocess.run([binary, 'cursor-overlay', '1', '65', geometry], input=b'f',
                                 capture_output=True, timeout=3)
            assert bad.returncode != 0 and not bad.stdout, (geometry, bad)

        helper = subprocess.Popen([binary, 'cursor-overlay', '2', '65', 'x11:100,50,400,300'],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        def frame():
            helper.stdin.write(b'f'); helper.stdin.flush()
            line = helper.stdout.readline(); assert line, 'helper exited'
            return json.loads(line)
        def pixels(jpeg):
            path = Path(temp) / 'frame.jpg'; path.write_bytes(base64.b64decode(jpeg))
            image = GP.gdk_pixbuf_new_from_file(str(path).encode(), None); assert image
            size = (GP.gdk_pixbuf_get_width(image), GP.gdk_pixbuf_get_height(image))
            stride, channels = GP.gdk_pixbuf_get_rowstride(image), GP.gdk_pixbuf_get_n_channels(image)
            data = bytes(GP.gdk_pixbuf_get_pixels(image)[:stride * size[1]])
            GP.g_object_unref(image)
            return size, lambda x, y: data[y * stride + x * channels: y * stride + x * channels + 3]

        first = frame()
        size, pixel = pixels(first['jpeg'])
        assert size == (400, 300), size
        # The pointer is at (150, 150) inside the rectangle. A cursor drawn into
        # the picture would put black/white glyph pixels around its hotspot.
        for y in range(130, 171, 2):
            for x in range(130, 171, 2):
                assert all(abs(a - b) <= 16 for a, b in zip(pixel(x, y), BACKGROUND)), (x, y, pixel(x, y))
        cursor = first['cursor']
        assert cursor['visible'] is True and cursor['shape'] == 'text', cursor
        assert abs(cursor['x'] - 150 / 399) < 1e-4 and abs(cursor['y'] - 150 / 299) < 1e-4, cursor
        assert cursor['png'].startswith('iVBORw0KGgo') and len(cursor['png']) <= 65536
        # Desktop points: the helper was told the display scale is 2.
        assert 0 < cursor['width'] <= 128 and cursor['hotX'] <= cursor['width'], cursor

        X.XWarpPointer(display, 0, root, 0, 0, 0, 0, 20, 20); X.XSync(display, False)
        outside = frame()['cursor']
        assert outside['visible'] is False and outside['x'] == 0 and outside['y'] == 0, outside

        X.XWarpPointer(display, 0, root, 0, 0, 0, 0, 300, 300)
        busy = X.XCreateFontCursor(display, XC_WATCH)
        X.XDefineCursor(display, win, busy); X.XSync(display, False)
        unnamed = frame()['cursor']
        assert unnamed['visible'] is True and 'shape' not in unnamed, unnamed
        XF.XFixesSetCursorName(display, busy, b'watch')
        X.XDefineCursor(display, win, text); X.XSync(display, False); frame()
        X.XDefineCursor(display, win, busy); X.XSync(display, False)
        assert frame()['cursor']['shape'] == 'wait'

        helper.stdin.close()
        assert helper.wait(timeout=3) == 0, 'EOF did not exit cleanly'
        print('PASS: probe, XWayland refusal, cursor-free pixels, cursor position/size/shape, '
              'outside rectangle, unnamed cursor, invalid geometry, EOF exit')
    finally:
        if display: X.XCloseDisplay(display)
        server.terminate(); server.wait(timeout=3)
