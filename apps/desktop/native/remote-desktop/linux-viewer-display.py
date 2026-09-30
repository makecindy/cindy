#!/usr/bin/python3
"""One lease's temporary Hyprland mirror; restore on EOF, timeout or termination.

No config files, shell evaluation, screenshots, credentials or persisted geometry.
The child outlives a crashing Electron parent long enough to undo its own changes.
"""
import json
import os
import re
import select
import signal
import subprocess
import sys
import time
import uuid


def command(*args):
    result = subprocess.run(["/usr/bin/hyprctl", *args], capture_output=True,
                            timeout=3, check=True, text=True)
    if len(result.stdout) > 128000:
        raise RuntimeError("response too large")
    return result.stdout


class ViewerDisplay:
    """Own only the generated output and the source's temporary mirror rule."""
    def __init__(self, source, run=command):
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", source):
            raise ValueError("invalid source")
        self.run = run
        self.source = source
        self.name = "CindyRemote-" + uuid.uuid4().hex[:16]
        self.original = None
        self.created = False
        self.mirrored = False
        try:
            self.lua = self.run("eval", 'assert(type(hl.monitor) == "function")').strip() == "ok"
        except Exception:
            self.lua = False

    def monitors(self):
        return json.loads(self.run("-j", "monitors", "all"))

    def rule(self, monitor, mirror=None):
        value = (f"{monitor['name']},{monitor['width']}x{monitor['height']}@{monitor['refreshRate']},"
                 f"{monitor['x']}x{monitor['y']},{monitor['scale']},transform,{monitor['transform']}")
        if mirror:
            value += f",mirror,{mirror}"
        if "vrr" in monitor:
            value += ",vrr," + ("1" if monitor["vrr"] else "0")
        if self.lua:
            # Every string here is an enumerated/validated output or a generated
            # numeric mode. No remote code or arbitrary Lua is accepted.
            fields = {"output": monitor["name"], "mode": f"{monitor['width']}x{monitor['height']}@{monitor['refreshRate']}",
                      "position": f"{monitor['x']}x{monitor['y']}", "scale": monitor["scale"],
                      "transform": monitor["transform"], "mirror": mirror or ""}
            # hl.monitor merges an existing named rule. Omit unrelated color,
            # HDR and VRR fields so a temporary mirror never replaces them.
            code = "hl.monitor({" + ",".join(k + "=" + json.dumps(v) for k, v in fields.items()) + "})"
            result = self.run("eval", code)
        else:
            result = self.run("keyword", "monitor", value)
        if result.strip() != "ok":
            raise RuntimeError("monitor rejected")

    def move_workspaces(self, source, target):
        workspaces = json.loads(self.run("-j", "workspaces"))
        if len(workspaces) > 128:
            raise RuntimeError("too many workspaces")
        for workspace in workspaces:
            ident = workspace.get("id")
            name = workspace.get("name", "")
            if workspace.get("monitor") == source and type(ident) is int and ident != 0:
                if not isinstance(name, str) or name.startswith("special:"):
                    continue
                selector = ident if ident > 0 else "name:" + name
                if ident < 0 and (not name or any(ord(c) < 32 for c in name) or
                                  (any(c.isspace() for c in name) and not self.lua)):
                    raise RuntimeError("workspace name unavailable")
                if self.lua:
                    result = self.run("eval", f"hl.dispatch(hl.dsp.workspace.move({{workspace={json.dumps(selector, ensure_ascii=False)},monitor={json.dumps(target)}}}))")
                else:
                    result = self.run("dispatch", "moveworkspacetomonitor", f"{selector} {target}")
                if result.strip() != "ok":
                    raise RuntimeError("workspace rejected")

    def resize(self, width, height):
        if (type(width) is not int or type(height) is not int or
                not 320 <= width <= 4096 or not 320 <= height <= 4096 or width * height > 8388608):
            raise ValueError("invalid dimensions")
        if self.original is None:
            self.original = next(m for m in self.monitors() if m["name"] == self.source)
            if self.original.get("mirrorOf", "none") != "none" or self.original.get("specialWorkspace", {}).get("id", 0):
                raise RuntimeError("source unavailable")
        if not self.created:
            # Record intent before invoking the compositor: an interrupted reply
            # must still remove this unique output during cleanup.
            self.created = True
            if self.run("output", "create", "headless", self.name).strip() != "ok":
                raise RuntimeError("output rejected")
        monitors = self.monitors()
        right = max(m["x"] + round((m["height"] if m["transform"] % 2 else m["width"]) / m["scale"])
                    for m in monitors if m["name"] != self.name)
        self.rule({"name": self.name, "width": width, "height": height, "refreshRate": 60,
                   "x": right, "y": 0, "scale": 1, "transform": 0})
        if not self.mirrored:
            self.move_workspaces(self.source, self.name)
            self.mirrored = True
            self.rule(self.original, self.name)
        for _ in range(40):
            monitor = next((m for m in self.monitors() if m["name"] == self.name), None)
            if monitor and monitor["width"] == width and monitor["height"] == height:
                return {"id": "hyprland:" + self.name, "name": self.name, "width": width, "height": height}
            time.sleep(0.05)
        raise RuntimeError("output did not settle")

    def restore(self):
        if not self.created:
            return
        monitors = self.monitors()
        if any(m["name"] == self.source for m in monitors):
            if self.mirrored:
                self.rule(self.original)
                self.mirrored = False
            self.move_workspaces(self.name, self.source)
        if any(m["name"] == self.name for m in monitors):
            if self.run("output", "remove", self.name).strip() != "ok":
                raise RuntimeError("output removal rejected")
        self.created = False


def main():
    if len(sys.argv) != 2:
        return 2
    owner = ViewerDisplay(sys.argv[1])
    def terminate(_signum, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    buffer = b""
    try:
        while select.select([sys.stdin], [], [], 6)[0]:
            chunk = os.read(sys.stdin.fileno(), 1024)
            if not chunk:
                break
            buffer += chunk
            if len(buffer) > 8192:
                raise ValueError("input too large")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                value = json.loads(line)
                if value.get("op") == "ping":
                    continue
                result = owner.resize(value.get("width"), value.get("height"))
                print(json.dumps(result), flush=True)
    except Exception:
        # Diagnostics may contain compositor state. Return a fixed error only.
        try:
            print('{"error":"DESKTOP_VIEWER_DISPLAY_UNAVAILABLE"}', flush=True)
        except BrokenPipeError:
            pass
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        # Keep the in-memory snapshot alive through temporary compositor errors.
        # A vanished compositor socket means its temporary outputs vanished too.
        socket = os.path.join(os.environ.get("XDG_RUNTIME_DIR", ""), "hypr",
                              os.environ.get("HYPRLAND_INSTANCE_SIGNATURE", ""), ".socket.sock")
        attempt = 0
        while True:
            try:
                owner.restore()
                return 0
            except Exception:
                if not os.path.exists(socket):
                    return 0
                attempt += 1
                time.sleep(min(5, 0.2 * attempt))


if __name__ == "__main__":
    sys.exit(main())
