#!/usr/bin/env python3
"""Read-only authoring checks for Cindy local theme JSON and brand assets."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys


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


def validate_themes(paths: list[Path], package_root: Path | None = None) -> dict:
    report = {"ok": True, "files": [], "errors": [], "warnings": []}
    ids: set[str] = set()
    variants: set[tuple[str, str]] = set()
    for path in paths:
        errors: list[str] = []
        warnings: list[str] = []
        unchecked = ["CSS expression/alias resolution and registered token names", "Image decoding and actual app rendering"]
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
                        package_file(package_root, value.strip())
                    except (OSError, ValueError) as error:
                        errors.append(f"brand.{role}: {error}")
                elif not Path(value.strip()).is_absolute():
                    errors.append(f"brand.{role}: use an absolute path on the target computer.")
                elif not Path(value.strip()).is_file():
                    errors.append(f"brand.{role}: referenced file is missing: {value}")
        elif brand is not None:
            warnings.append("Non-object brand is ignored by Cindy.")
        unknown = sorted(set(data) - {"id", "name", "type", "family", "colors", "brand"})
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
    parser.add_argument("--package-root", type=Path, help="Validate portable brand paths relative to this theme package root.")
    args = parser.parse_args()
    report = validate_themes(args.themes, args.package_root)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
