"""Test-only process loading the actual C ABI (never part of the application)."""
import base64
import ctypes
import json
import sys

library = ctypes.CDLL(sys.argv[1])
library.cindy_agent_net_create.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
library.cindy_agent_net_create.restype = ctypes.c_void_p
library.cindy_agent_net_command.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
library.cindy_agent_net_command.restype = ctypes.c_void_p
library.cindy_agent_net_free_string.argtypes = [ctypes.c_void_p]
library.cindy_agent_net_destroy.argtypes = [ctypes.c_void_p]
library.cindy_agent_net_io.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
library.cindy_agent_net_io.restype = ctypes.c_void_p
library.cindy_agent_net_free_bytes.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
library.cindy_agent_net_pump.argtypes = [ctypes.c_void_p]
library.cindy_agent_net_pump.restype = ctypes.c_int64

handle = None
try:
    for line in sys.stdin:
        request = json.loads(line)
        if request["op"] == "create":
            if handle:
                raise RuntimeError("one handle per test peer")
            payload = json.dumps(request["value"], separators=(",", ":")).encode()
            handle = library.cindy_agent_net_create(payload, len(payload))
            response = {"ok": bool(handle), "value": None}
        elif request["op"] == "io":
            # Bytes travel base64 over this test pipe only; the C ABI gets and returns raw frames.
            frame = base64.b64decode(request["value"])
            length = ctypes.c_size_t(0)
            pointer = library.cindy_agent_net_io(handle, frame, len(frame), ctypes.byref(length))
            if not pointer:
                raise RuntimeError("missing C ABI result")
            try:
                response = {"ok": True, "value": base64.b64encode(ctypes.string_at(pointer, length.value)).decode()}
            finally:
                library.cindy_agent_net_free_bytes(pointer, length.value)
        elif request["op"] == "pump":
            response = {"ok": True, "value": library.cindy_agent_net_pump(handle)}
        else:
            payload = json.dumps(request["value"], separators=(",", ":")).encode()
            pointer = library.cindy_agent_net_command(handle, payload, len(payload))
            if not pointer:
                raise RuntimeError("missing C ABI result")
            try:
                response = json.loads(ctypes.string_at(pointer))
            finally:
                library.cindy_agent_net_free_string(pointer)
        print(json.dumps({"id": request["id"], **response}, separators=(",", ":")), flush=True)
finally:
    if handle:
        library.cindy_agent_net_destroy(handle)
