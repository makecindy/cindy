#!/usr/bin/env python3
"""Exact Debian package set of the cloud runtime dependency base.

  capture IMAGE OUTPUT  write a lock from a local image (unstarted network-less run)
  preferences LOCK      print apt preferences pinning every locked version
  manual LOCK           print the manually installed package names
  verify LOCK           compare the installed set and manual marks (inside the image)

The lock is data, not a dependency hint: verification fails on any missing,
extra or different package, architecture, version, install state or mark.
"""

import argparse
import re
import subprocess
import sys

DPKG_FORMAT = "${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}\n"
NAME = re.compile(r"[a-z0-9][a-z0-9+.-]+")
VERSION = re.compile(r"[A-Za-z0-9.+~:-]+")
ARCH = re.compile(r"[a-z0-9-]+")
MARKS = ("manual", "auto")
IMAGE = re.compile(r"(sha256:[a-f0-9]{64}|[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64})")


class LockError(ValueError):
    pass


def parse_installed(dpkg_output, manual_output):
    """Rows from dpkg-query/apt-mark output; only fully installed packages."""
    manual = {line.strip() for line in manual_output.splitlines() if line.strip()}
    rows = {}
    for line in dpkg_output.splitlines():
        if not line:
            continue
        status, name, version, arch = line.split("\t")
        if status != "ii ":
            raise LockError(f"package not fully installed: {name} ({status.strip()})")
        key = (name, arch)
        if key in rows:
            raise LockError(f"duplicate package: {name}:{arch}")
        rows[key] = version
    names = {name for name, _ in rows}
    unknown = {m.split(":")[0] for m in manual} - names
    if unknown:
        raise LockError(f"manual marks for packages that are not installed: {sorted(unknown)}")
    return {key: (version, "manual" if key[0] in manual or f"{key[0]}:{key[1]}" in manual else "auto")
            for key, version in rows.items()}


def format_lock(rows):
    lines = ["# Every installed package, written by base_lock.py capture. The build verifies it exactly.",
             "# package\tversion\tarchitecture\tmark"]
    for (name, arch), (version, mark) in sorted(rows.items()):
        lines.append(f"{name}\t{version}\t{arch}\t{mark}")
    return "\n".join(lines) + "\n"


def read_lock(text):
    rows = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 4:
            raise LockError(f"line {number}: expected 4 tab-separated fields")
        name, version, arch, mark = fields
        if not (NAME.fullmatch(name) and VERSION.fullmatch(version)
                and ARCH.fullmatch(arch) and mark in MARKS):
            raise LockError(f"line {number}: invalid entry")
        if (name, arch) in rows:
            raise LockError(f"line {number}: duplicate {name}:{arch}")
        rows[(name, arch)] = (version, mark)
    if not rows:
        raise LockError("empty lock")
    return rows


def preferences(rows):
    # Priority above 1000 selects exactly this version for every package that
    # apt touches, including dependencies, and never a newer snapshot entry.
    blocks = []
    for (name, _arch), (version, _mark) in sorted(rows.items()):
        blocks.append(f"Package: {name}\nPin: version {version}\nPin-Priority: 1001\n")
    return "\n".join(blocks)


def differences(expected, actual):
    problems = []
    for key in sorted(expected.keys() | actual.keys()):
        name = f"{key[0]}:{key[1]}"
        if key not in actual:
            problems.append(f"missing {name}={expected[key][0]}")
        elif key not in expected:
            problems.append(f"unexpected {name}={actual[key][0]}")
        elif expected[key][0] != actual[key][0]:
            problems.append(f"version {name}: expected {expected[key][0]}, installed {actual[key][0]}")
        elif expected[key][1] != actual[key][1]:
            problems.append(f"mark {name}: expected {expected[key][1]}, installed {actual[key][1]}")
    return problems


def run(*command):
    return subprocess.run(command, check=True, stdout=subprocess.PIPE, text=True).stdout


def capture(image):
    if not IMAGE.fullmatch(image):
        raise LockError("capture requires an image ID or registry digest, not a mutable tag")
    docker = ["docker", "run", "--rm", "--network", "none", "--entrypoint"]
    dpkg = run(*docker, "dpkg-query", image, "-W", "-f=" + DPKG_FORMAT)
    manual = run(*docker, "apt-mark", image, "showmanual")
    return parse_installed(dpkg, manual)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    cap = sub.add_parser("capture")
    cap.add_argument("image")
    cap.add_argument("output")
    for name in ("preferences", "verify"):
        sub.add_parser(name).add_argument("lock")
    man = sub.add_parser("manual")
    man.add_argument("lock")
    man.add_argument("--exclude", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        if args.command == "capture":
            with open(args.output, "x") as handle:
                handle.write(format_lock(capture(args.image)))
            return 0
        with open(args.lock) as handle:
            rows = read_lock(handle.read())
        if args.command == "preferences":
            sys.stdout.write(preferences(rows))
        elif args.command == "manual":
            unknown = set(args.exclude) - {name for name, _ in rows}
            if unknown:
                raise LockError(f"excluded packages are not locked: {sorted(unknown)}")
            names = sorted({name for (name, _), (_, mark) in rows.items()
                            if mark == "manual" and name not in args.exclude})
            sys.stdout.write("\n".join(names) + "\n")
        else:
            actual = parse_installed(run("dpkg-query", "-W", "-f=" + DPKG_FORMAT),
                                     run("apt-mark", "showmanual"))
            problems = differences(rows, actual)
            for problem in problems:
                print(problem, file=sys.stderr)
            if problems:
                print(f"PACKAGE_LOCK_MISMATCH: {len(problems)} difference(s)", file=sys.stderr)
                return 1
            print(f"PACKAGE_LOCK_VERIFIED {len(rows)}")
    except LockError as error:
        print(f"PACKAGE_LOCK_INVALID: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
