#!/usr/bin/env python3
"""Clamp a staged filesystem before caching, matching BuildKit timestamp rewriting.

Only use on a private staging tree, never a running container root or user HOME.
Symlinks are updated without following them; older mtimes and all bytes/modes
remain unchanged. SOURCE_DATE_EPOCH is mandatory so callers cannot accidentally
cache a wall-clock-dependent layer.
"""
import argparse
import os
import stat
from pathlib import Path


def normalize(root, epoch):
    root = Path(root)
    if root.is_symlink() or not root.is_dir() or root.resolve() == Path('/'):
        raise ValueError('STAGED_DIRECTORY_REQUIRED')
    if epoch < 0:
        raise ValueError('INVALID_SOURCE_DATE_EPOCH')
    ceiling = epoch * 1_000_000_000
    device = root.stat().st_dev
    changed = 0
    pending = [root]
    while pending:
        path = pending.pop()
        info = path.lstat()
        if info.st_dev != device:
            raise ValueError('NESTED_MOUNT_NOT_ALLOWED:' + str(path))
        if stat.S_ISDIR(info.st_mode):
            with os.scandir(path) as entries:
                pending.extend(Path(e.path) for e in entries)
        if info.st_mtime_ns > ceiling:
            os.utime(path, ns=(info.st_atime_ns, ceiling), follow_symlinks=False)
            changed += 1
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    epoch = os.environ.get('SOURCE_DATE_EPOCH', '')
    if not epoch.isdecimal():
        parser.error('SOURCE_DATE_EPOCH must be a nonnegative integer')
    print('TIMESTAMPS_NORMALIZED', normalize(args.root, int(epoch)))


if __name__ == '__main__':
    main()
