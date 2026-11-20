#!/usr/bin/env python3
"""Read-only authoring checks for Cindy theme definitions and packaged resources."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import struct
import sys
import unicodedata

sys.dont_write_bytecode = True
RESOURCE_LIMITS = {"font": 10 * 1024 * 1024, "image": 20 * 1024 * 1024, "video": 100 * 1024 * 1024}


def hex_rgb(value: str | None) -> tuple[float, float, float] | None:
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return None
    return tuple(int(value[index:index + 2], 16) / 255 for index in (1, 3, 5))


def luminance(rgb: tuple[float, float, float]) -> float:
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in rgb]
    return sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722)))


def is_package_path(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 4096 and not re.search(r'[\\:<>"|?*\x00-\x1f]', value) and all(
        part not in ("", ".", "..") and not part.endswith((".", " "))
        and not re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.IGNORECASE)
        for part in value.split("/")
    )


def package_file(root: Path, relative: str) -> Path:
    if not is_package_path(relative):
        raise ValueError(f"Invalid package path: {relative}")
    current = root.resolve(strict=True)
    for part in relative.split("/"):
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Package files cannot be symbolic links: {relative}")
    current.resolve(strict=True).relative_to(root.resolve(strict=True))
    if not current.is_file():
        raise ValueError(f"Package file is missing: {relative}")
    return current


def validate_manifest(value: object) -> dict:
    if not isinstance(value, dict) or type(value.get("formatVersion")) is not int or value["formatVersion"] not in (1, 2) or value.get("type") != "theme":
        raise ValueError("Expected cindy.json with formatVersion: 1 or 2 and type: theme.")
    names = value.get("themes")
    if not isinstance(names, list) or not 1 <= len(names) <= 256 or not all(is_package_path(name) for name in names) or len(set(names)) != len(names):
        raise ValueError("themes must list 1–256 unique portable JSON paths.")
    resources = value.get("resources", [])
    if ("resources" in value and value["formatVersion"] != 2) or not isinstance(resources, list) or len(resources) > 256:
        raise ValueError("Only v2 supports resources (at most 256).")
    ids = set()
    for resource in resources:
        if not isinstance(resource, dict) or set(resource) != {"id", "kind", "path"} or not isinstance(resource["id"], str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", resource["id"]):
            raise ValueError("Each resource needs only id, kind and path; id must be 1–64 letters, digits, _ or -.")
        if resource["id"] in ids or resource["kind"] not in RESOURCE_LIMITS or not is_package_path(resource["path"]):
            raise ValueError("Resource IDs must be unique, kind must be font/image/video, and paths must be portable.")
        ids.add(resource["id"])
    return value


def validate_resource_bytes(content: bytes, kind: str) -> None:
    if not content or len(content) > RESOURCE_LIMITS[kind]:
        raise ValueError(f"Empty or oversized {kind} resource.")
    if kind == "font":
        if len(content) < 12 or content[:4] not in (b"\x00\x01\x00\x00", b"OTTO"):
            raise ValueError("Font must be a TTF/OTF SFNT file, not WOFF/WOFF2 or a renamed image.")
        tables = int.from_bytes(content[4:6], "big")
        end = 12 + tables * 16
        if not 1 <= tables <= 256 or end > len(content):
            raise ValueError("Invalid font table directory.")
        tags = set()
        for start in range(12, end, 16):
            tag, _, offset, length = struct.unpack_from(">4sIII", content, start)
            if tag in tags or offset < end or offset + length > len(content):
                raise ValueError("Invalid or truncated font table.")
            tags.add(tag)
        if not {b"head", b"maxp", b"cmap", b"name"} <= tags:
            raise ValueError("Font is missing required tables.")
    elif kind == "image":
        if not (content.startswith(b"\x89PNG\r\n\x1a\n") or content.startswith(b"\xff\xd8\xff") or
                (content.startswith(b"RIFF") and content[8:12] == b"WEBP")):
            raise ValueError("Wallpaper image must be PNG, JPEG or WebP.")
    else:
        if len(content) < 16 or content[4:8] != b"ftyp":
            raise ValueError("Video must have an MP4 ftyp box.")
        size = int.from_bytes(content[:4], "big")
        if size < 16 or size > len(content) or (size - 16) % 4:
            raise ValueError("Invalid MP4 ftyp box.")
        brands = [content[8:12], *[content[i:i + 4] for i in range(16, size, 4)]]
        supported = {b"3gp4", b"3gp5", b"3gp6", b"3gp7", b"3gp8", b"3gp9", b"avc1", b"av01", b"dash",
                     b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"iso8", b"iso9", b"isom", b"M4V ",
                     b"mmp4", b"MP4 ", b"mp41", b"mp42", b"MSNV"}
        if any(brand in {b"qt  ", b"M4A ", b"M4B ", b"M4P ", b"F4A ", b"F4B "} for brand in brands) or not supported.intersection(brands):
            raise ValueError("Unsupported MP4 video brand (audio-only and QuickTime are not wallpapers).")


def closed_object(value: object, fields: set[str], name: str) -> dict:
    if not isinstance(value, dict) or not value or set(value) - fields:
        raise ValueError(f"{name}: expected a nonempty object containing only {', '.join(sorted(fields))}.")
    return value


def number(value: object, low: float, high: float, name: str) -> None:
    if type(value) not in (int, float) or not low <= value <= high or not math.isfinite(value):
        raise ValueError(f"{name}: expected a finite number in {low}–{high}.")


def validate_appearance(value: object, resources: dict[str, dict]) -> None:
    if not isinstance(value, dict) or set(value) - {"uiFont", "codeFont", "bodyFont", "terminalFont", "wallpaper", "reading", "contentStyle", "density", "motion"}:
        raise ValueError("appearance contains unsupported fields; arbitrary CSS and plugin declarations are not supported.")

    def reference(raw: object, kinds: set[str], name: str) -> None:
        if not isinstance(raw, str) or not re.fullmatch(r"asset:[a-zA-Z0-9_-]{1,64}", raw):
            raise ValueError(f"{name}: use asset:<declared id>, never a host path, Library or media URL.")
        resource = resources.get(raw[6:])
        if not resource or resource["kind"] not in kinds:
            raise ValueError(f"{name}: missing resource or incompatible kind.")

    for role, bounds in {"uiFont": (12, 24), "codeFont": (10, 24), "bodyFont": (12, 28), "terminalFont": (10, 24)}.items():
        if role not in value:
            continue
        fields = {"family", "size", "resource"} | (set() if role == "terminalFont" else {"weight", "style"})
        font = closed_object(value[role], fields, role)
        if "family" in font:
            family = font["family"]
            if not isinstance(family, str) or len(family) > 256 or any(not (c in " _.,'\"-" or unicodedata.category(c)[0] in "LN") for c in family):
                raise ValueError(f"{role}.family: invalid font family.")
        if "size" in font:
            number(font["size"], *bounds, f"{role}.size")
        if "resource" in font:
            if "family" in font:
                raise ValueError(f"{role}: specify family or resource, not both.")
            reference(font["resource"], {"font"}, f"{role}.resource")
        if "weight" in font:
            number(font["weight"], 100, 900, f"{role}.weight")
            if int(font["weight"]) != font["weight"]:
                raise ValueError(f"{role}.weight: expected an integer.")
        if "style" in font and font["style"] not in ("normal", "italic"):
            raise ValueError(f"{role}.style: expected normal or italic.")
    if "wallpaper" in value:
        wallpaper = closed_object(value["wallpaper"], {"resource", "fallbackResource", "visibility", "blur", "motion"}, "wallpaper")
        if "resource" in wallpaper:
            reference(wallpaper["resource"], {"image", "video"}, "wallpaper.resource")
        if "fallbackResource" in wallpaper:
            if "resource" not in wallpaper:
                raise ValueError("wallpaper.fallbackResource requires resource.")
            reference(wallpaper["fallbackResource"], {"image"}, "wallpaper.fallbackResource")
        for field, bounds in {"visibility": (0, 1), "blur": (0, 20)}.items():
            if field in wallpaper:
                number(wallpaper[field], *bounds, f"wallpaper.{field}")
        if "motion" in wallpaper and wallpaper["motion"] not in ("static", "dynamic"):
            raise ValueError("wallpaper.motion: expected static or dynamic.")
    for section, limits in {"reading": {"bodyLineHeight": (1.2, 2.4), "codeLineHeight": (1.1, 2.4), "maxWidth": (320, 1400)},
                            "contentStyle": {"messageGap": (0, 48), "messagePadding": (0, 32), "messageRadius": (0, 32)}}.items():
        if section in value:
            fields = closed_object(value[section], set(limits), section)
            for field, n in fields.items():
                number(n, *limits[field], f"{section}.{field}")
    for field, bounds in {"density": (0.75, 1.25), "motion": (0, 2)}.items():
        if field in value:
            number(value[field], *bounds, field)


def validate_themes(paths: list[Path], package_root: Path | None = None) -> dict:
    report = {"ok": True, "files": [], "errors": [], "warnings": []}
    manifest = None
    resources: dict[str, dict] = {}
    if package_root is not None:
        try:
            manifest_file = package_file(package_root, "cindy.json")
            if manifest_file.stat().st_size > 256 * 1024:
                raise ValueError("Manifest exceeds 256 KiB.")
            manifest = validate_manifest(json.loads(manifest_file.read_text(encoding="utf-8")))
            for resource in manifest.get("resources", []):
                resources[resource["id"]] = resource
                with package_file(package_root, resource["path"]).open("rb") as source:
                    validate_resource_bytes(source.read(RESOURCE_LIMITS[resource["kind"]] + 1), resource["kind"])
        except (OSError, ValueError, TypeError) as error:
            report["errors"].append(f"cindy.json/resources: {error}")
    ids: set[str] = set()
    variants: set[tuple[str, str]] = set()
    for path in paths:
        errors: list[str] = []
        warnings: list[str] = []
        unchecked = ["CSS expression/alias resolution and registered token names", "Complete image/video decoding, browser font loading and actual app rendering"]
        entry = {"path": str(path), "errors": errors, "warnings": warnings, "unchecked": unchecked, "contrast": []}
        report["files"].append(entry)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            errors.append(str(error))
            continue
        if not isinstance(data, dict):
            errors.append("Theme must be a JSON object.")
            continue
        for field in ("id", "name"):
            if not isinstance(data.get(field), str) or not data[field].strip():
                errors.append(f"{field}: expected a nonempty string.")
        theme_id = data.get("id")
        if isinstance(theme_id, str):
            if theme_id in ids:
                errors.append(f"Duplicate theme id: {theme_id}")
            ids.add(theme_id)
        mode = data.get("type")
        if mode not in ("light", "dark"):
            errors.append("type: expected light or dark.")
        family = data.get("family")
        if isinstance(family, str) and family.strip() and mode in ("light", "dark"):
            pair = (family.strip(), mode)
            if pair in variants:
                errors.append(f"Duplicate {mode} variant in family: {pair[0]}")
            variants.add(pair)
        elif family is not None:
            warnings.append("Empty or non-string family is ignored by Cindy.")
        colors = data.get("colors")
        if not isinstance(colors, dict):
            errors.append("colors: expected an object of string values.")
        else:
            for key, value in colors.items():
                if not isinstance(value, str):
                    errors.append(f"colors.{key}: expected a string.")
            for foreground, background in (("text-primary", "surface"), ("text-secondary", "surface")):
                fg, bg = hex_rgb(colors.get(foreground)), hex_rgb(colors.get(background))
                if fg is None or bg is None:
                    unchecked.append(f"Contrast for {foreground}/{background}: requires resolved #RRGGBB values.")
                    continue
                light, dark = sorted((luminance(fg), luminance(bg)), reverse=True)
                ratio = (light + 0.05) / (dark + 0.05)
                entry["contrast"].append({"foreground": foreground, "background": background, "ratio": round(ratio, 2)})
                if ratio < 4.5:
                    warnings.append(f"{foreground}/{background}: contrast {ratio:.2f}:1 is below 4.5:1 for ordinary text.")
        brand = data.get("brand")
        if isinstance(brand, dict):
            for role in ("icon", "logo"):
                value = brand.get(role)
                if value is None or value == "":
                    continue
                if not isinstance(value, str) or not value.strip():
                    warnings.append(f"brand.{role}: ignored because it is not a nonempty path.")
                elif package_root is not None:
                    try:
                        if package_file(package_root, value.strip()).stat().st_size > 20 * 1024 * 1024:
                            raise ValueError("Brand image exceeds 20 MiB.")
                    except (OSError, ValueError) as error:
                        errors.append(f"brand.{role}: {error}")
                elif not Path(value.strip()).is_absolute():
                    errors.append(f"brand.{role}: use an absolute path on the target computer.")
                elif not Path(value.strip()).is_file():
                    errors.append(f"brand.{role}: referenced file is missing: {value}")
        elif brand is not None:
            warnings.append("Non-object brand is ignored by Cindy.")
        if "appearance" in data:
            try:
                if manifest and manifest["formatVersion"] == 1:
                    raise ValueError("appearance requires formatVersion: 2.")
                validate_appearance(data["appearance"], resources)
            except (ValueError, TypeError) as error:
                errors.append(f"appearance: {error}")
        unknown = sorted(set(data) - {"id", "name", "type", "family", "colors", "brand", "appearance"})
        if unknown:
            warnings.append("Fields outside the current local theme contract: " + ", ".join(unknown))
    for entry in report["files"]:
        report["errors"].extend(f"{entry['path']}: {error}" for error in entry["errors"])
        report["warnings"].extend(f"{entry['path']}: {warning}" for warning in entry["warnings"])
    report["ok"] = not report["errors"]
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("themes", type=Path, nargs="+", help="Local theme JSON files; no settings are changed.")
    parser.add_argument("--package-root", type=Path, help="Validate cindy.json, declared appearance resources and portable asset paths.")
    args = parser.parse_args()
    report = validate_themes(args.themes, args.package_root)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
