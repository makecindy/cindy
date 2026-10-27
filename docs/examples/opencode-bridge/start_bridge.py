"""Start an owned OpenCode server and bridge without modifying the CLI profile."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from opencode_cindy_bridge import opencode_command


def environment(state):
    env = dict(os.environ)
    config_env = env.get("OPENCODE_BRIDGE_CONFIG")
    if config_env:
        resolved_config = Path(config_env).resolve()
    else:
        resolved_config = (Path(env.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "opencode/opencode.json").resolve()
    original_config = str(resolved_config)
    # OpenCode itself reads the selected provider config. Never copy/parse keys.
    if resolved_config.exists():
        env["OPENCODE_CONFIG"] = original_config
    env["OPENCODE_BRIDGE_CONFIG"] = original_config
    db_env = env.get("OPENCODE_BRIDGE_DB")
    if db_env:
        env["OPENCODE_BRIDGE_DB"] = str(Path(db_env).resolve())
    profile = state / "config"
    profile.mkdir(parents=True, exist_ok=True)
    env["XDG_CONFIG_HOME"] = str(profile)
    env["OPENCODE_DISABLE_CLAUDE_CODE"] = "1"
    env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"] = "1"
    env["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"] = "1"
    env["OPENCODE_DISABLE_EXTERNAL_SKILLS"] = "1"
    env["OPENCODE_DISABLE_AUTOCOMPACT"] = "1"
    env["OPENCODE_DISABLE_SHARE"] = "1"
    env["OPENCODE_SHARE"] = "disabled"
    # XDG_DATA_HOME/HOME remain unchanged: native provider auth stays with OpenCode.
    return env


def state_directory():
    custom = os.environ.get("OPENCODE_BRIDGE_STATE")
    if custom:
        path = Path(custom).resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local"))) / "CindyGlobal"
    else:
        base = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "cindy"
    state = (base / "opencode-server").resolve()
    state.mkdir(parents=True, exist_ok=True)
    if hasattr(os, "chmod"):
        try:
            os.chmod(state, 0o700)
        except OSError:
            pass
    return state


def stop_child(child, bridge_port=None, timeout=5):
    if child.poll() is not None:
        return
    # 1. Attempt graceful IPC shutdown if this is the bridge
    if bridge_port is not None:
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{bridge_port}/shutdown", data=b"{}", method="POST")
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=1.0) as resp:
                pass
            child.wait(timeout=timeout)
            return
        except Exception:
            pass

    # 2. Attempt console signal (CTRL_BREAK on Windows if supported, SIGTERM on POSIX)
    try:
        if os.name == "nt" and hasattr(signal, "CTRL_BREAK_EVENT"):
            child.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            child.send_signal(signal.SIGTERM)
        child.wait(timeout=timeout)
        return
    except (subprocess.TimeoutExpired, OSError, ValueError):
        pass

    # 3. Fallback to terminate
    try:
        child.terminate()
        child.wait(timeout=timeout)
        return
    except (subprocess.TimeoutExpired, OSError):
        pass

    # 4. Final fallback to kill
    try:
        child.kill()
        child.wait()
    except OSError:
        pass


def main():
    state = state_directory()
    env = environment(state)
    server_port = int(env.get("OPENCODE_SERVER_PORT", "14782"))
    bridge_port = int(env.get("OPENCODE_BRIDGE_PORT", "11437"))
    for port in (server_port, bridge_port):
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError(f"Port {port} is already in use. Stop its owner or select different bridge/server ports.")
    children = []
    flags = (subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW) if os.name == "nt" else 0
    bridge = None
    try:
        server = subprocess.Popen(opencode_command() + ["serve", "--pure", "--hostname", "127.0.0.1", "--port", str(server_port)],
            cwd=state, env=env, creationflags=flags, stdout=sys.stdout, stderr=sys.stderr)
        children.append(server)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError("The owned OpenCode server exited during startup.")
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{server_port}/global/health")
                if env.get("OPENCODE_SERVER_PASSWORD"):
                    import base64
                    value = env.get("OPENCODE_SERVER_USERNAME", "opencode") + ":" + env["OPENCODE_SERVER_PASSWORD"]
                    req.add_header("Authorization", "Basic " + base64.b64encode(value.encode()).decode())
                with urllib.request.urlopen(req, timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("The owned OpenCode server did not become healthy within 30 seconds.")
        bridge = subprocess.Popen([sys.executable, "-u", str(Path(__file__).with_name("opencode_cindy_bridge.py"))],
            cwd=state, env=env, creationflags=flags, stdout=sys.stdout, stderr=sys.stderr)
        children.append(bridge)
        while all(child.poll() is None for child in children):
            time.sleep(0.2)
        raise RuntimeError("The owned OpenCode server or bridge exited unexpectedly.")
    finally:
        for child in reversed(children):
            if child.poll() is None:
                port = bridge_port if child is bridge else None
                stop_child(child, bridge_port=port, timeout=5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
