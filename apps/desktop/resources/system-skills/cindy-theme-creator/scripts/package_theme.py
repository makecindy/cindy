#!/usr/bin/env python3
"""Validate and package a data-only Cindy theme; never install or change settings."""

import argparse
import io
import json
from pathlib import Path
import sys
import zipfile

from validate_theme import is_package_path, package_file, validate_themes


def build_package(root: Path) -> bytes:
    files: dict[str, bytes] = {}
    total = 0

    def read(relative: str, limit: int) -> bytes:
        nonlocal total
        if relative in files:
            if len(files[relative]) > limit:
                raise ValueError(f"File is too large: {relative}")
            return files[relative]
        with package_file(root, relative).open("rb") as source:
            content = source.read(limit + 1)
        if not content or len(content) > limit:
            raise ValueError(f"File is empty or too large: {relative}")
        total += len(content)
        if total > 256 * 1024 * 1024:
            raise ValueError("Theme package exceeds 256 MiB uncompressed.")
        files[relative] = content
        return content

    manifest = json.loads(read("cindy.json", 256 * 1024))
    if not isinstance(manifest, dict) or type(manifest.get("formatVersion")) is not int or manifest["formatVersion"] != 1 or manifest.get("type") != "theme":
        raise ValueError("Expected cindy.json with formatVersion: 1 and type: theme.")
    names = manifest.get("themes")
    if not isinstance(names, list) or not 1 <= len(names) <= 256 or not all(is_package_path(name) for name in names) or len(set(names)) != len(names):
        raise ValueError("themes must list 1–256 unique portable JSON paths.")
    documents = [json.loads(read(name, 1024 * 1024)) for name in names]
    report = validate_themes([package_file(root, name) for name in names], root)
    if not report["ok"]:
        raise ValueError("\n".join(report["errors"]))
    for name, document in zip(names, documents):
        # Validation reads source files too; do not package a concurrently edited document.
        if package_file(root, name).read_bytes() != files[name]:
            raise ValueError(f"Theme changed during validation: {name}")
        brand = document.get("brand")
        if isinstance(brand, dict):
            for role in ("icon", "logo"):
                asset = brand.get(role)
                if isinstance(asset, str) and asset.strip():
                    read(asset.strip(), 20 * 1024 * 1024)
    if len(files) > 2048 or "ghost.json" in files or len({name.lower() for name in files}) != len(files):
        raise ValueError("Theme files conflict with each other or the plugin manifest.")
    for name in files:
        parts = name.split("/")
        if any("/".join(parts[:i]) in files for i in range(1, len(parts))):
            raise ValueError(f"File also used as a directory: {name}")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    result = output.getvalue()
    if len(result) > 128 * 1024 * 1024:
        raise ValueError("Theme archive exceeds 128 MiB.")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="Folder containing cindy.json and the theme sources.")
    parser.add_argument("output", type=Path, help="New .cindy output file; existing files are never overwritten.")
    args = parser.parse_args()
    try:
        if args.output.suffix.lower() != ".cindy":
            raise ValueError("Output must have the .cindy suffix.")
        content = build_package(args.root)
        with args.output.open("xb") as target:
            target.write(content)
        print(json.dumps({"ok": True, "path": str(args.output), "bytes": len(content)}))
        return 0
    except (OSError, ValueError, TypeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
