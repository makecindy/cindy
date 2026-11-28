#!/usr/bin/env python3
"""Stage the pinned emoji font into the same image layer as the runtime.

Input is an extracted Debian package, never a user profile or running image.
The caller's image audit must include the returned file manifest.
"""
import argparse
import hashlib
import json
from pathlib import Path

PACKAGE = "fonts-noto-color-emoji_2.042-0+deb12u1_all.deb"
PACKAGE_SHA256 = "a5ab0f69c7938423862320d9aca5dd187b3fd879d6a9a57dd52e17c3fa8d2751"
FILES = {
    "usr/share/fonts/truetype/noto/NotoColorEmoji.ttf":
        "e5899ed38b8ed83e08bd3ac5de09791e9d19d288333a796de1d35ad17396f1ec",
    "usr/share/doc/fonts-noto-color-emoji/copyright":
        "3720722d2046accb40e1696f096b57c658b0b47d74031b3d114cf7545b840b3c",
}


def stage(package_root: Path, layer: Path) -> dict:
    source = package_root.resolve(strict=True)
    target = layer.resolve(strict=True)
    if source == target or source in target.parents or target in source.parents:
        raise ValueError("package and image layer must be separate directories")
    payload = {}
    # Verify every input before writing any output. Include the redistribution license.
    for name, expected in FILES.items():
        path = source / name
        if path.is_symlink() or not path.is_file() or source not in path.resolve().parents:
            raise ValueError("invalid package file: " + name)
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("unexpected emoji font package: " + name)
        dest = target / name
        for part in [dest, *dest.parents]:
            if part == target:
                break
            if part.is_symlink():
                raise ValueError("image layer contains a symlink: " + str(part))
        payload[name] = data
    for name, data in payload.items():
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        dest.chmod(0o644)
        # Explicit distribution modes: do not inherit an operator's umask 077.
        parent = dest.parent
        while parent != target:
            parent.chmod(0o755)
            parent = parent.parent
        target.chmod(0o755)
    return {name: {"sha256": digest, "mode": 0o644} for name, digest in FILES.items()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package_root", type=Path)
    parser.add_argument("layer", type=Path)
    args = parser.parse_args()
    print(json.dumps(stage(args.package_root, args.layer), indent=2))
