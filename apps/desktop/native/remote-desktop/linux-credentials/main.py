#!/usr/bin/python3
"""Private stdio endpoint. Main sees descriptors, ciphertext and fixed errors only."""
import asyncio
import ctypes
import os
from pathlib import Path
import resource
import signal
import stat
import sys

# -I disables cwd, PYTHONPATH and user-site imports. Only these packaged sibling
# modules are added; the profile directory is never a Python import location.
sys.path.insert(0, str(Path(__file__).resolve().parent))


def harden():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    libc = ctypes.CDLL(None)
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        raise RuntimeError()
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise RuntimeError()


async def serve(directory, parent, executable):
    from channel import Error, MAX_PACKET, decode, encode, require
    from host import Host
    from platform_linux import account, lock_state, verify_and_unlock
    from storage import load_identity

    def caller():
        require(os.getppid() == parent and Path(f"/proc/{parent}").stat().st_uid == os.getuid(), "CANCELLED")
        require(Path(f"/proc/{parent}/exe").resolve() == Path(executable).resolve(), "CANCELLED")
    caller()
    require(stat.S_ISFIFO(os.fstat(0).st_mode) or stat.S_ISSOCK(os.fstat(0).st_mode), "UNAVAILABLE")
    require(Path(executable).name.lower() in ("electron", "cindy", "cindydev"), "UNAVAILABLE")
    require(os.getuid() > 0 and os.geteuid() == os.getuid(), "UNAVAILABLE")
    host = Host(directory, load_identity, account, lock_state, verify_and_unlock)
    reader = asyncio.StreamReader(limit=MAX_PACKET)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    jobs = set()

    async def process(line):
        request_id = ""
        try:
            caller()
            value = decode(line)
            require(isinstance(value, dict) and isinstance(value.get("id"), str) and len(value["id"]) <= 128)
            request_id = value["id"]
            result = await host.call(value)
            caller()
            reply = {"id": request_id, "result": result}
        except asyncio.CancelledError:
            reply = {"id": request_id, "error": "CREDENTIAL_CANCELLED"}
        except Exception as error:
            reply = {"id": request_id, "error": str(error) if isinstance(error, Error) else "CREDENTIAL_UNAVAILABLE"}
        sys.stdout.buffer.write(encode(reply) + b"\n")
        sys.stdout.buffer.flush()

    owner = asyncio.current_task()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, owner.cancel)
    try:
        while line := await reader.readline():
            caller()
            require(len(line) <= MAX_PACKET and len(jobs) < 16, "UNAVAILABLE")
            job = asyncio.create_task(process(line))
            jobs.add(job)
            job.add_done_callback(jobs.discard)
    finally:
        transport.close()
        host.close_all()
        for job in list(jobs):
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)


if __name__ == "__main__":
    try:
        original_parent = os.getppid()
        harden()
        if os.getppid() != original_parent:
            raise RuntimeError()
        if sys.argv[1:] == ["--lock-state"]:
            from platform_linux import lock_state
            print(asyncio.run(lock_state()))
        elif sys.argv[1:] == ["--pam"]:
            from platform_linux import pam_verify
            pam_verify(sys.stdin.buffer.read(4097))
        elif len(sys.argv) == 5 and sys.argv[1] == "--serve":
            if int(sys.argv[3]) != original_parent:
                raise RuntimeError()
            asyncio.run(serve(sys.argv[2], original_parent, sys.argv[4]))
        else:
            raise RuntimeError()
    except BaseException:
        if sys.argv[1:] == ["--lock-state"]:
            print("unavailable")
        else:
            sys.exit(77)
