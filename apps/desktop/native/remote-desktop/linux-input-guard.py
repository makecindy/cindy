import ctypes
import json
import os
import re
import select
import signal
import stat
import sys
import time


def identity(socket):
    info = os.stat(socket)
    if not stat.S_ISSOCK(info.st_mode):
        raise ValueError("display unavailable")
    return info.st_dev, info.st_ino, info.st_ctime_ns


class ModifierMap(ctypes.Structure):
    _fields_ = [("max_keypermod", ctypes.c_int), ("modifiermap", ctypes.POINTER(ctypes.c_ubyte))]


class Display:
    def __init__(self):
        self.library = ctypes.CDLL("libX11.so.6")
        self.test = ctypes.CDLL("libXtst.so.6")
        self.typing = ctypes.CDLL("libxdo.so.3")
        pointer = ctypes.c_void_p
        integer = ctypes.c_int
        unsigned = ctypes.c_ulong
        self.library.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.library.XOpenDisplay.restype = pointer
        self.library.XDefaultRootWindow.argtypes = [pointer]
        self.library.XDefaultRootWindow.restype = unsigned
        self.library.XDefaultScreen.argtypes = [pointer]
        self.library.XDisplayWidth.argtypes = [pointer, integer]
        self.library.XDisplayHeight.argtypes = [pointer, integer]
        self.library.XStringToKeysym.argtypes = [ctypes.c_char_p]
        self.library.XStringToKeysym.restype = unsigned
        self.library.XKeysymToKeycode.argtypes = [pointer, unsigned]
        self.library.XKeysymToKeycode.restype = ctypes.c_ubyte
        self.library.XInternAtom.argtypes = [pointer, ctypes.c_char_p, integer]
        self.library.XInternAtom.restype = unsigned
        self.library.XGetWindowProperty.argtypes = [
            pointer, unsigned, unsigned, ctypes.c_long, ctypes.c_long, integer, unsigned,
            ctypes.POINTER(unsigned), ctypes.POINTER(integer), ctypes.POINTER(unsigned),
            ctypes.POINTER(unsigned), ctypes.POINTER(pointer),
        ]
        self.library.XQueryPointer.argtypes = [
            pointer, unsigned, ctypes.POINTER(unsigned), ctypes.POINTER(unsigned),
            *([ctypes.POINTER(integer)] * 4), ctypes.POINTER(ctypes.c_uint),
        ]
        self.library.XGetPointerMapping.argtypes = [pointer, ctypes.POINTER(ctypes.c_ubyte), integer]
        self.library.XGetInputFocus.argtypes = [pointer, ctypes.POINTER(unsigned), ctypes.POINTER(integer)]
        self.library.XQueryTree.argtypes = [pointer, unsigned, ctypes.POINTER(unsigned),
                                           ctypes.POINTER(unsigned), ctypes.POINTER(pointer), ctypes.POINTER(ctypes.c_uint)]
        self.library.XDisplayKeycodes.argtypes = [pointer, ctypes.POINTER(integer), ctypes.POINTER(integer)]
        self.library.XGetKeyboardMapping.argtypes = [pointer, ctypes.c_ubyte, integer, ctypes.POINTER(integer)]
        self.library.XGetKeyboardMapping.restype = ctypes.POINTER(unsigned)
        self.library.XChangeKeyboardMapping.argtypes = [pointer, integer, integer, ctypes.POINTER(unsigned), integer]
        self.library.XQueryKeymap.argtypes = [pointer, ctypes.POINTER(ctypes.c_ubyte)]
        self.library.XGetModifierMapping.argtypes = [pointer]
        self.library.XGetModifierMapping.restype = ctypes.POINTER(ModifierMap)
        self.library.XFreeModifiermap.argtypes = [ctypes.POINTER(ModifierMap)]
        self.library.XkbLockModifiers.argtypes = [pointer, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint]
        self.typing.xdo_new_with_opened_display.argtypes = [pointer, ctypes.c_char_p, integer]
        self.typing.xdo_new_with_opened_display.restype = pointer
        self.typing.xdo_enter_text_window.argtypes = [pointer, unsigned, ctypes.c_char_p, ctypes.c_uint]
        self.typing.xdo_free.argtypes = [pointer]
        self.library.XFree.argtypes = [pointer]
        self.library.XSync.argtypes = [pointer, integer]
        self.library.XCloseDisplay.argtypes = [pointer]
        self.test.XTestQueryExtension.argtypes = [pointer, *([ctypes.POINTER(integer)] * 4)]
        self.test.XTestFakeKeyEvent.argtypes = [pointer, ctypes.c_uint, integer, unsigned]
        self.test.XTestFakeButtonEvent.argtypes = [pointer, ctypes.c_uint, integer, unsigned]
        self.test.XTestFakeMotionEvent.argtypes = [pointer, integer, integer, integer, unsigned]
        self.connection = self.library.XOpenDisplay(None)
        if not self.connection:
            raise ValueError("display unavailable")
        version = [integer() for _ in range(4)]
        if not self.test.XTestQueryExtension(self.connection, *[ctypes.byref(item) for item in version]):
            raise ValueError("input unavailable")
        self.root = self.library.XDefaultRootWindow(self.connection)
        self.screen = self.library.XDefaultScreen(self.connection)
        self.width = self.library.XDisplayWidth(self.connection, self.screen)
        self.height = self.library.XDisplayHeight(self.connection, self.screen)
        # Use the same authenticated display, never a new connection or shell.
        self.text_connection = self.typing.xdo_new_with_opened_display(self.connection, None, False)
        if not self.text_connection:
            raise ValueError("text input unavailable")
        self.text_mappings = {}
        self.keys = set()
        self.buttons = set()

    def property(self, window, name):
        atom = self.library.XInternAtom(self.connection, name.encode(), True)
        actual_type, count, remaining = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_ulong()
        actual_format, data = ctypes.c_int(), ctypes.c_void_p()
        status = self.library.XGetWindowProperty(
            self.connection, window, atom, 0, 1, False, 0, ctypes.byref(actual_type),
            ctypes.byref(actual_format), ctypes.byref(count), ctypes.byref(remaining), ctypes.byref(data),
        )
        try:
            if status != 0 or actual_format.value != 32 or count.value != 1 or not data.value:
                raise ValueError("window unavailable")
            return ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0]
        finally:
            if data.value:
                self.library.XFree(data)

    def key(self, name, down):
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,32}", name):
            raise ValueError("invalid key")
        keycode = self.library.XKeysymToKeycode(self.connection, self.library.XStringToKeysym(name.encode()))
        if not keycode:
            raise ValueError("unsupported key")
        if down:
            self.keys.add(keycode)
        self.test.XTestFakeKeyEvent(self.connection, keycode, down, 0)
        if not down:
            self.keys.discard(keycode)

    def wait_button(self, button, down, deadline):
        # XSync only acknowledges requests. A WM's synchronous passive grab can
        # still freeze/replay pointer events while keyboard events overtake them.
        # Query the logical button state, which lags while input is frozen, before
        # sending the next edge. No clipboard mutation or input replay is needed.
        mapping = (ctypes.c_ubyte * 256)()
        count = self.library.XGetPointerMapping(self.connection, mapping, len(mapping))
        if button > count:
            raise ValueError("button unavailable")
        logical = mapping[button - 1]
        # Core X11 exposes masks only for buttons 1..5 (not horizontal wheel 6/7).
        if not 1 <= logical <= 5:
            return
        root, child = ctypes.c_ulong(), ctypes.c_ulong()
        positions = [ctypes.c_int() for _ in range(4)]
        state = ctypes.c_uint()
        while True:
            same_screen = self.library.XQueryPointer(
                self.connection, self.root, ctypes.byref(root), ctypes.byref(child),
                *[ctypes.byref(value) for value in positions], ctypes.byref(state),
            )
            if not same_screen:
                raise ValueError("pointer unavailable")
            if bool(state.value & (1 << (logical + 7))) == down:
                return
            if time.monotonic() >= deadline:
                raise ValueError("pointer processing timeout")
            time.sleep(0.002)

    def button(self, button, down, deadline=None):
        if button not in range(1, 8):
            raise ValueError("invalid button")
        if down:
            self.buttons.add(button)
        self.test.XTestFakeButtonEvent(self.connection, button, down, 0)
        if deadline is not None:
            self.wait_button(button, down, deadline)
        if not down:
            self.buttons.discard(button)

    def keyboard_mapping(self):
        low, high, width = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
        self.library.XDisplayKeycodes(self.connection, ctypes.byref(low), ctypes.byref(high))
        data = self.library.XGetKeyboardMapping(self.connection, low.value, high.value - low.value + 1,
                                               ctypes.byref(width))
        if not data or not 8 <= low.value <= high.value <= 255 or not 1 <= width.value <= 32:
            raise ValueError("keyboard unavailable")
        try:
            return {code: tuple(data[(code - low.value) * width.value:(code - low.value + 1) * width.value])
                    for code in range(low.value, high.value + 1)}
        finally:
            self.library.XFree(data)

    def prepare_text_mapping(self, text):
        mapping = self.keyboard_mapping()
        needed = {0xff09 if c == "\t" else 0xff0d if c == "\n" else
                  ord(c) if ord(c) < 256 else 0x01000000 | ord(c) for c in text}
        present = {symbol for symbols in mapping.values() for symbol in symbols}
        pressed = (ctypes.c_ubyte * 32)()
        self.library.XQueryKeymap(self.connection, pressed)
        # Keep Unicode mappings across calls. libxdo's temporary single scratch
        # key is removed before a busy Chromium client can resolve its KeyPress,
        # losing characters even though XTest acknowledged the event.
        for code, (symbol, _) in list(self.text_mappings.items()):
            if symbol not in mapping[code] or any(x not in (0, symbol) for x in mapping[code]):
                del self.text_mappings[code]  # another keyboard owner changed it
        for symbol in sorted(needed - present):
            available = [code for code, symbols in mapping.items() if not any(symbols)
                         and not (pressed[code // 8] & (1 << (code % 8)))]
            if available:
                code = available[0]
            else:
                reusable = [(used, code) for code, (old, used) in self.text_mappings.items()
                            if old not in needed and not (pressed[code // 8] & (1 << (code % 8)))]
                if not reusable:
                    raise ValueError("text mapping unavailable")
                used, code = min(reusable)
                # Bound reuse, rather than remapping the key immediately after
                # release. Never take a physical binding or a key still held down.
                remaining = 0.05 - (time.monotonic() - used)
                if remaining > 0:
                    time.sleep(remaining)
            symbols = (ctypes.c_ulong * len(mapping[code]))(*([symbol] * len(mapping[code])))
            self.library.XChangeKeyboardMapping(self.connection, code, len(symbols), symbols, 1)
            mapping[code] = tuple(symbols)
            self.text_mappings[code] = (symbol, time.monotonic())
        for code, (symbol, used) in list(self.text_mappings.items()):
            if symbol in needed:
                self.text_mappings[code] = (symbol, time.monotonic())
        self.library.XSync(self.connection, False)
        # libxdo caches the keyboard layout. Reopen on the same Display so it sees
        # the prepared mappings and never takes its ephemeral-scratch fallback.
        self.typing.xdo_free(self.text_connection)
        self.text_connection = self.typing.xdo_new_with_opened_display(self.connection, None, False)
        if not self.text_connection:
            raise ValueError("text input unavailable")

    def restore_text_mapping(self):
        if not getattr(self, "text_mappings", None):
            return
        mapping = self.keyboard_mapping()
        for code, (symbol, _) in self.text_mappings.items():
            if symbol in mapping[code] and all(x in (0, symbol) for x in mapping[code]):
                empty = (ctypes.c_ulong * len(mapping[code]))()
                self.library.XChangeKeyboardMapping(self.connection, code, len(empty), empty, 1)
        self.text_mappings.clear()

    def validate_text_target(self, window, pid):
        if (self.property(self.root, "_NET_ACTIVE_WINDOW") != window
                or self.property(window, "_NET_WM_PID") != pid):
            raise ValueError("text focus changed")
        focused, revert = ctypes.c_ulong(), ctypes.c_int()
        self.library.XGetInputFocus(self.connection, ctypes.byref(focused), ctypes.byref(revert))
        # A WM can retain _NET_ACTIVE_WINDOW while a popup owns keyboard focus.
        # Only the original client window or one of its descendants may receive text.
        current = focused.value
        for _ in range(64):
            if current == window:
                return
            if current in (0, 1, self.root):
                break
            root, parent, children, count = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p(), ctypes.c_uint()
            try:
                if not self.library.XQueryTree(self.connection, current, ctypes.byref(root),
                                              ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
                    break
                current = parent.value
            finally:
                if children.value:
                    self.library.XFree(children)
        raise ValueError("text focus changed")

    def text_modifiers(self):
        mapping = self.library.XGetModifierMapping(self.connection)
        if not mapping:
            raise ValueError("keyboard unavailable")
        pressed = (ctypes.c_ubyte * 32)()
        try:
            self.library.XQueryKeymap(self.connection, pressed)
            return {code for code in mapping.contents.modifiermap[:8 * mapping.contents.max_keypermod]
                    if code and pressed[code // 8] & (1 << (code % 8))}
        finally:
            self.library.XFreeModifiermap(mapping)

    def caps_locked(self):
        root, child, state = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_uint()
        positions = [ctypes.c_int() for _ in range(4)]
        if not self.library.XQueryPointer(self.connection, self.root, ctypes.byref(root), ctypes.byref(child),
                                         *[ctypes.byref(value) for value in positions], ctypes.byref(state)):
            raise ValueError("keyboard unavailable")
        return state.value & 2

    def text(self, request):
        if not isinstance(request, dict) or set(request) != {"windowId", "pid", "text"}:
            raise ValueError("invalid text")
        window, pid, text = request["windowId"], request["pid"], request["text"]
        if (type(window) is not int or not 1 < window <= 0xffffffff
                or type(pid) is not int or not 0 < pid <= 0x7fffffff
                or not isinstance(text, str) or not 1 <= len(text) <= 32
                or any((ord(c) < 32 and c not in "\t\n") or ord(c) == 127
                       or 0xd800 <= ord(c) <= 0xdfff for c in text)):
            raise ValueError("invalid text")
        deadline = time.monotonic() + 1.0
        self.validate_text_target(window, pid)
        modifiers, caps = self.text_modifiers(), self.caps_locked()
        # Committed text already includes Shift/IME composition. Temporarily clear
        # keyboard modifiers only; never alter pointer buttons or either clipboard.
        try:
            for code in modifiers:
                self.test.XTestFakeKeyEvent(self.connection, code, False, 0)
            if caps:
                self.library.XkbLockModifiers(self.connection, 0x100, 2, 0)
            self.library.XSync(self.connection, False)
            for character in text:
                if time.monotonic() >= deadline:
                    raise ValueError("text processing timeout")
                self.prepare_text_mapping(character)
                self.validate_text_target(window, pid)
                # CURRENTWINDOW=0 forces XTest (not XSendEvent); all symbols have
                # stable bindings prepared above. No CDP or DOM writes.
                if self.typing.xdo_enter_text_window(self.text_connection, 0, character.encode("utf-8"), 12000):
                    raise ValueError("text input unavailable")
            self.validate_text_target(window, pid)
        finally:
            for code in modifiers:
                self.test.XTestFakeKeyEvent(self.connection, code, True, 0)
            if caps:
                self.library.XkbLockModifiers(self.connection, 0x100, 2, caps)
            self.library.XSync(self.connection, False)
        return ""

    def command(self, args):
        if not isinstance(args, list) or len(args) > 2048 or not all(isinstance(arg, str) and len(arg) <= 32 for arg in args):
            raise ValueError("invalid command")
        # Bound the entire batch below the host's 1.5s command timeout.
        deadline = time.monotonic() + 1.0
        offset = 0
        output = []
        while offset < len(args):
            command = args[offset]
            offset += 1
            if command == "getdisplaygeometry":
                output.append(str(self.width) + " " + str(self.height))
            elif command == "getactivewindow":
                output.append(str(self.property(self.root, "_NET_ACTIVE_WINDOW")))
            elif command == "getwindowpid":
                output.append(str(self.property(int(args[offset]), "_NET_WM_PID")))
                offset += 1
            elif command == "mousemove":
                horizontal, vertical = int(args[offset]), int(args[offset + 1])
                if not 0 <= horizontal < self.width or not 0 <= vertical < self.height:
                    raise ValueError("invalid point")
                self.test.XTestFakeMotionEvent(self.connection, self.screen, horizontal, vertical, 0)
                offset += 2
            elif command in ("keydown", "keyup"):
                self.key(args[offset], command == "keydown")
                offset += 1
            elif command in ("mousedown", "mouseup"):
                self.button(int(args[offset]), command == "mousedown", deadline)
                offset += 1
            elif command == "click":
                if args[offset] != "--repeat" or args[offset + 2:offset + 4] != ["--delay", "0"]:
                    raise ValueError("invalid scroll")
                repeat, button = int(args[offset + 1]), int(args[offset + 4])
                if not 1 <= repeat <= 16 or button not in (4, 5, 6, 7):
                    raise ValueError("invalid scroll")
                for _ in range(repeat):
                    self.button(button, True, deadline)
                    self.button(button, False, deadline)
                offset += 5
            else:
                raise ValueError("unsupported command")
        self.library.XSync(self.connection, False)
        return "\n".join(output)

    def close(self):
        for keycode in self.keys:
            self.test.XTestFakeKeyEvent(self.connection, keycode, False, 0)
        for button in list(self.buttons):
            self.button(button, False)
        self.library.XSync(self.connection, False)
        self.restore_text_mapping()
        if getattr(self, "text_connection", None):
            self.typing.xdo_free(self.text_connection)
        self.library.XCloseDisplay(self.connection)


def guard():
    match = re.fullmatch(r":([0-9]{1,5})(?:\.[0-9]{1,2})?", os.environ.get("DISPLAY", ""))
    if not match or os.environ.get("WAYLAND_DISPLAY"):
        return
    socket = "/tmp/.X11-unix/X" + str(int(match.group(1)))
    original = identity(socket)
    display = Display()
    buffered = b""
    deadline = time.monotonic() + 5
    try:
        if identity(socket) != original:
            raise ValueError("display changed")
        print("ready", flush=True)
        if "--check" in sys.argv:
            return
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([sys.stdin], [], [], remaining)[0]:
                break
            chunk = os.read(sys.stdin.fileno(), 4096)
            if not chunk:
                break
            buffered += chunk
            if len(buffered) > 32768:
                break
            while b"\n" in buffered:
                line, buffered = buffered.split(b"\n", 1)
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError("invalid request")
                if "args" in value or "text" in value:
                    identifier = value["id"]
                    if type(identifier) is not int or not 0 < identifier <= 9007199254740991:
                        raise ValueError("invalid request")
                    if identity(socket) != original:
                        raise ValueError("display changed")
                    if "args" in value and "text" in value:
                        raise ValueError("invalid request")
                    output = display.text(value["text"]) if "text" in value else display.command(value["args"])
                    print(json.dumps({"id": identifier, "stdout": output}), flush=True)
                else:
                    if not isinstance(value.get("keys"), list) or not isinstance(value.get("buttons"), list):
                        raise ValueError("invalid heartbeat")
                    if len(value["keys"]) > 128 or len(value["buttons"]) > 3:
                        raise ValueError("invalid heartbeat")
                deadline = time.monotonic() + 5
    finally:
        display.close()


def stop(_signal, _frame):
    raise SystemExit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        guard()
    except Exception:
        sys.exit(1)
