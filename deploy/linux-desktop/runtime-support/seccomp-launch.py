#!/usr/bin/python3
import ctypes
import json
import os
import platform
import sys


class Comparison(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]


def install_filter(profile):
    status = dict(line.split(":", 1) for line in open("/proc/self/status") if ":" in line)
    architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
    if os.getuid() != 10001 or int(status["CapEff"].strip(), 16) != 0:
        raise ValueError()
    if not architecture or profile.get("defaultAction") != "SCMP_ACT_ERRNO":
        raise ValueError()
    library = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    library.seccomp_release.restype = None
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_syscall_resolve_name.restype = ctypes.c_int
    library.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                              ctypes.c_uint, ctypes.POINTER(Comparison)]
    library.seccomp_rule_add_array.restype = ctypes.c_int
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_load.restype = ctypes.c_int
    context = library.seccomp_init(0x00050001)
    if not context:
        raise ValueError()
    try:
        kernel = tuple(int(part) for part in platform.release().split("-", 1)[0].split(".")[:2])
        for rule in profile["syscalls"]:
            includes, excludes = rule.get("includes") or {}, rule.get("excludes") or {}
            if set(includes) - {"arches", "caps", "minKernel"} or set(excludes) - {"arches", "caps"}:
                raise ValueError()
            if includes.get("caps") or (includes.get("arches") and architecture not in includes["arches"]):
                continue
            if architecture in excludes.get("arches", []):
                continue
            if includes.get("minKernel") and kernel < tuple(int(part) for part in includes["minKernel"].split(".")):
                continue
            if rule["action"] != "SCMP_ACT_ALLOW":
                raise ValueError()
            comparisons = []
            for argument in rule.get("args") or []:
                operation = {"SCMP_CMP_EQ": 4, "SCMP_CMP_MASKED_EQ": 7}.get(argument["op"])
                if operation is None or argument["index"] not in range(6):
                    raise ValueError()
                comparisons.append(Comparison(argument["index"], operation, argument["value"], argument.get("valueTwo", 0)))
            array = (Comparison * len(comparisons))(*comparisons)
            for name in rule["names"]:
                number = library.seccomp_syscall_resolve_name(name.encode("ascii"))
                if number == -1:
                    raise ValueError()
                result = library.seccomp_rule_add_array(context, 0x7FFF0000, number, len(array), array)
                if result not in (0, -17):
                    raise ValueError()
        # ENOSYS (not EPERM) makes libc fall back to the allowed older calls. Under
        # EPERM, glibc access checks with AT_EACCESS fail, so `test -x` is false.
        for name in (b"clone3", b"faccessat2"):
            number = library.seccomp_syscall_resolve_name(name)
            if number == -1 or library.seccomp_rule_add_array(context, 0x00050026, number, 0, None) != 0:
                raise ValueError()
        if library.seccomp_load(context) != 0:
            raise ValueError()
    finally:
        library.seccomp_release(context)
    status = dict(line.split(":", 1) for line in open("/proc/self/status") if ":" in line)
    if status["Seccomp"].strip() != "2" or status["NoNewPrivs"].strip() != "1":
        raise ValueError()


def main():
    try:
        if len(sys.argv) < 2 or not os.path.isabs(sys.argv[1]):
            raise ValueError()
        with open("/usr/local/lib/cindy/seccomp.json", encoding="utf8") as source:
            install_filter(json.load(source))
        os.execv(sys.argv[1], sys.argv[1:])
    except Exception:
        sys.stderr.write("INSTANCE_SECCOMP_UNAVAILABLE\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
