"""Test-only process loading the actual C ABI (never part of the application)."""
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

handle = None
try:
    for line in sys.stdin:
        request = json.loads(line)
        payload = json.dumps(request["value"], separators=(",", ":")).encode()
        if request["op"] == "create":
            if handle:
                raise RuntimeError("one handle per test peer")
            handle = library.cindy_agent_net_create(payload, len(payload))
            response = {"ok": bool(handle), "value": None}
        else:
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
