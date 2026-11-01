"""Linux integration/measurement harness; only fresh, unauthenticated profiles.

Usage: python3 measure-headless.py /absolute/dist/cli.js /absolute/report.json
No inference, login, service installation, or existing profile access.
"""
import json
import os
import pathlib
import pty
import select
import signal
import subprocess
import sys
import tempfile
import time

cli = str(pathlib.Path(sys.argv[1]).resolve())
report_path = pathlib.Path(sys.argv[2]).resolve()
measure_resources = "--lifecycle-only" not in sys.argv[3:]
root = pathlib.Path(tempfile.mkdtemp(prefix="cindy-headless-measure-"))
print("Isolated diagnostics: " + str(root), flush=True)
env = {**os.environ, "HOME": str(root), "XDG_STATE_HOME": str(root / "state"),
       "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
       "TERM": "xterm-256color"}
node = os.environ.get("CINDY_MEASURE_NODE", "node")
command = [node, cli, "--profile", "measure"]
report = {"cli": cli, "node": subprocess.check_output([node, "--version"], text=True).strip(),
          "profile": "fresh unauthenticated", "samples": [], "pty": []}

if "--cli-only" in sys.argv[3:]:
    report["cli_samples"] = []
    for option in ("--version", "--help"):
        for _ in range(3):
            start = time.monotonic()
            pid = os.fork()
            if pid == 0:
                os.chdir(root)
                output = os.open(os.devnull, os.O_WRONLY)
                os.dup2(output, 1)
                os.dup2(output, 2)
                os.execvpe(node, command + [option], env)
            _, code, usage = os.wait4(pid, 0)
            report["cli_samples"].append({"command": option,
                "exit_code": os.waitstatus_to_exitcode(code), "peak_RSS_KiB": usage.ru_maxrss,
                "cpu_seconds": usage.ru_utime + usage.ru_stime, "wall_seconds": time.monotonic() - start})
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    sys.exit(0)


def memory(pid):
    values = {}
    for line in pathlib.Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in ("Pss", "Rss", "Swap"):
            values[key + "_KiB"] = int(value.split()[0])
    stat = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    values["ticks"] = int(stat[11]) + int(stat[12])
    return values


def sample(pid, label):
    before = memory(pid)
    start = time.monotonic()
    time.sleep(10)
    after = memory(pid)
    seconds = time.monotonic() - start
    report["samples"].append({"label": label, **after, "seconds": seconds,
                              "cpu_percent_one_core": (after["ticks"] - before["ticks"]) /
                              os.sysconf("SC_CLK_TCK") / seconds * 100})


def status():
    result = subprocess.run(command + ["status", "--json"], env=env, cwd=root,
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError("status failed: " + result.stderr[:500])
    value = json.loads(result.stdout)
    if value.get("ok") is False:
        raise RuntimeError("status rejected: " + result.stdout[:500])
    return value


def wait_child(pid, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        child, code = os.waitpid(pid, os.WNOHANG)
        if child:
            return os.waitstatus_to_exitcode(code)
        time.sleep(.05)
    return None


def terminal(mode, measure=False):
    if mode == "eof":
        master, slave = pty.openpty()
        pid = os.fork()
        if pid == 0:
            os.setsid()
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            os.close(master)
            os.close(slave)
        else:
            os.close(slave)
    else:
        pid, master = pty.fork()
    if pid == 0:
        os.chdir(root)
        diagnostics = os.open(root / (mode + ".stderr"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.dup2(diagnostics, 2)
        os.close(diagnostics)
        # SSH clients can inherit ignored HUP. EOF must also release resources.
        if mode == "hangup-ignored":
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
        os.execvpe(command[0], command, env)
    exited = False
    try:
        received = b""
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], .2)
            if readable:
                received += os.read(master, 65536)
            if b"\x1b[?1049h" in received or len(received) > 100:
                break
        if not received:
            raise RuntimeError("TUI did not render")
        # Drain terminal output during settling so a full PTY cannot skew CPU.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                os.read(master, 65536)
        if measure:
            sample(pid, "tui")
        if mode == "normal":
            os.write(master, b"\x11")  # Ctrl-Q
        elif mode == "term":
            os.kill(pid, signal.SIGTERM)
        else:
            os.close(master)
            master = None
        code = wait_child(pid, 5)
        exited = code is not None
        report["pty"].append({"mode": mode, "exited": exited, "exit_code": code,
                              "stderr": (root / (mode + ".stderr")).read_text()[-2000:]})
    finally:
        if master is not None:
            os.close(master)
        if not exited:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)


with (root / "service.log").open("w") as log:
    service = subprocess.Popen(command + ["serve"], env=env, cwd=root, stdout=log, stderr=log)
    try:
        endpoint = root / "state/CindyTerminal/profiles/measure/service.json"
        deadline = time.monotonic() + 40
        while not endpoint.exists():
            if service.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("Service startup failed; diagnostics: " + str(root / "service.log"))
            time.sleep(.1)
        status()
        if service.poll() is not None:
            raise RuntimeError("Measured service exited: " + (root / "service.log").read_text()[-1500:])
        if measure_resources:
            for _ in range(3):
                sample(service.pid, "service-before-tui")
        terminal("hangup-ignored", measure=measure_resources)
        for mode in ("eof", "hangup", "term", "normal"):
            terminal(mode)
            status()
        if measure_resources:
            sample(service.pid, "service-after-tui")
        report["service_survived"] = service.poll() is None
    finally:
        service.terminate()
        try:
            service.wait(timeout=15)
        except subprocess.TimeoutExpired:
            service.kill()
            service.wait()
        report_path.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
