"""Explicit native integration test. Requires Xvfb and the built helper argument.
Uses an authenticated, private X display; never drives the user's real desktop.
"""
import ctypes as C
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import tempfile
import time

X = C.CDLL('libX11.so.6')
D = C.c_void_p
U = C.c_ulong
class Key(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', U), ('send_event', C.c_int),
        ('display', D), ('window', U), ('root', U), ('subwindow', U), ('time', U),
        ('x', C.c_int), ('y', C.c_int), ('x_root', C.c_int), ('y_root', C.c_int),
        ('state', C.c_uint), ('keycode', C.c_uint), ('same_screen', C.c_int)]
class Event(C.Union):
    _fields_ = [('type', C.c_int), ('key', Key), ('pad', C.c_long * 24)]
def api(name, result, args):
    f = getattr(X, name); f.restype = result; f.argtypes = args; return f
api('XOpenDisplay', D, [C.c_char_p]); api('XCloseDisplay', C.c_int, [D])
api('XDefaultRootWindow', U, [D]); api('XCreateSimpleWindow', U, [D,U,C.c_int,C.c_int,C.c_uint,C.c_uint,C.c_uint,U,U])
api('XMapWindow', C.c_int, [D,U]); api('XSelectInput', C.c_int, [D,U,C.c_long])
api('XSetInputFocus', C.c_int, [D,U,C.c_int,U]); api('XSync', C.c_int, [D,C.c_int])
api('XPending', C.c_int, [D]); api('XNextEvent', C.c_int, [D,C.POINTER(Event)])
api('XRefreshKeyboardMapping', C.c_int, [C.POINTER(Event)])
api('XLookupKeysym', U, [C.POINTER(Key),C.c_int])
api('XQueryKeymap', C.c_int, [D,C.c_void_p])
api('XQueryPointer', C.c_int, [D,U,C.POINTER(U),C.POINTER(U),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_uint)])
api('XGetKeyboardMapping', C.POINTER(U), [D,C.c_ubyte,C.c_int,C.POINTER(C.c_int)])
api('XFree', C.c_int, [D])
def field(b): return struct.pack('>H', len(b)) + b
with tempfile.TemporaryDirectory(prefix='cindy-x11-test-') as temp:
    auth = Path(temp)/'authority'
    auth.write_bytes(struct.pack('>H',65535)+field(b'')+field(b'')+field(b'MIT-MAGIC-COOKIE-1')+field(os.urandom(16)))
    auth.chmod(0o600)
    r,w = os.pipe()
    server = subprocess.Popen(['Xvfb','-displayfd',str(w),'-auth',str(auth),'-nolisten','tcp','-screen','0','800x600x24'],pass_fds=[w],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    os.close(w)
    helpers=[]; display=None
    try:
        assert select.select([r],[],[],8)[0], 'Xvfb did not start'
        number=os.read(r,128).decode().strip(); os.close(r)
        assert number.isdigit(), server.stderr.read().decode()
        os.environ.update(DISPLAY=':'+number, XAUTHORITY=str(auth), XDG_SESSION_TYPE='x11')
        os.environ.pop('WAYLAND_DISPLAY',None)
        display=X.XOpenDisplay(None); assert display
        root=X.XDefaultRootWindow(display)
        win=X.XCreateSimpleWindow(display,root,0,0,800,600,0,0,0)
        X.XSelectInput(display,win,1|2|4|8|64)
        X.XMapWindow(display,win); X.XSetInputFocus(display,win,1,0); X.XSync(display,False)
        def drain():
            out=[]
            while X.XPending(display):
                e=Event(); X.XNextEvent(display,C.byref(e))
                if e.type==34: X.XRefreshKeyboardMapping(C.byref(e))
                elif e.type in (2,3): out.append((e.type, X.XLookupKeysym(C.byref(e.key),0)))
                elif e.type in (4,5): out.append((e.type,e.key.keycode))
            return out
        def mapping():
            n=C.c_int(); ptr=X.XGetKeyboardMapping(display,8,248,C.byref(n))
            data=C.string_at(ptr,248*n.value*C.sizeof(U)); X.XFree(ptr); return data
        def keys():
            b=C.create_string_buffer(32); X.XQueryKeymap(display,b); return b.raw
        def pointer():
            root_out=U();child=U();rx=C.c_int();ry=C.c_int();x=C.c_int();y=C.c_int();mask=C.c_uint()
            X.XQueryPointer(display,root,C.byref(root_out),C.byref(child),C.byref(rx),C.byref(ry),C.byref(x),C.byref(y),C.byref(mask))
            return rx.value,ry.value,mask.value
        binary=str(Path(sys.argv[1]).resolve())
        before=mapping(); drain()
        result=subprocess.run([binary,'--x11','--check'],capture_output=True,timeout=3)
        assert result.returncode==0 and result.stdout==b'ready\n',result
        assert before==mapping() and not drain(), 'probe changed desktop'
        def start():
            p=subprocess.Popen([binary,'--x11','100','50','400','300'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            helpers.append(p); assert p.stdout.readline()==b'ready\n'; return p
        def send(p,events):
            import json
            p.stdin.write((json.dumps(events,ensure_ascii=False)+'\n').encode());p.stdin.flush()
            observed=[]; until=time.monotonic()+4
            while time.monotonic()<until:
                observed+=drain()
                if select.select([p.stdout],[],[],0.002)[0]:
                    assert p.stdout.readline()==b'ok\n',p.stderr.read()
                    X.XSync(display,False);observed+=drain();return observed
            raise AssertionError('helper acknowledgement timed out')
        p=start()
        send(p,[dict(kind='move',x=1,y=1)])
        assert pointer()[:2]==(499,349),pointer()
        send(p,[dict(kind='button',x=0,y=0,button=0,down=True),dict(kind='key',code='ShiftLeft',down=True)])
        assert pointer()[2] & 256 and any(keys())
        send(p,[dict(kind='release')]); assert not any(keys()) and not(pointer()[2]&256)
        seen=send(p,[dict(kind='scroll',dx=40,dy=-40)])
        assert (4,7) in seen and (4,4) in seen,seen
        seen=send(p,[dict(kind='text',text='a中🙂')])
        assert [v for t,v in seen if t==2]==[97,0x1004e2d,0x101f642],seen
        assert before==mapping(), 'text changed persistent keymap'
        send(p,[dict(kind='key',code='ControlLeft',down=True)])
        p.stdin.close();assert p.wait(timeout=3)==0;assert not any(keys()),'EOF left key held'
        p=start();send(p,[dict(kind='key',code='AltLeft',down=True),dict(kind='button',x=0,y=0,button=2,down=True)])
        p.send_signal(signal.SIGTERM);assert p.wait(timeout=3)==0
        assert not any(keys()) and not(pointer()[2]&1024),'SIGTERM left input held'
        p=start(); old=pointer()[:2]
        p.stdin.write(b'[{"kind":"move","x":1,"y":1},{"kind":"key","code":"Invalid","down":true}]\n');p.stdin.flush()
        assert p.wait(timeout=3)==2 and pointer()[:2]==old,'invalid batch partly injected'
        p=start();send(p,[dict(kind='key',code='ShiftLeft',down=True)])
        assert p.wait(timeout=8)==0 and not any(keys()),'heartbeat timeout left key held'
        wrong=subprocess.run([binary,'--x11','--check'],env={**os.environ,'XDG_SESSION_TYPE':'wayland'},capture_output=True,timeout=3)
        assert wrong.returncode==2,'XWayland probe accepted'
        print('PASS: XTest probe, monitor coordinates, click, wheel, Unicode, keymap restore, EOF/SIGTERM/heartbeat release, atomic rejection, Wayland refusal')
    finally:
        for p in helpers:
            if p.poll() is None: p.terminate();p.wait(timeout=3)
        if display: X.XCloseDisplay(display)
        server.terminate();server.wait(timeout=3)
