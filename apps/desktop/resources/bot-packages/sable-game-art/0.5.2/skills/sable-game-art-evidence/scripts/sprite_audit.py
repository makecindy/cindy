#!/usr/bin/env python3
"""Original offline helper; Python 3.10+ standard library, stdin/stdout only."""
import sys
import json
import math
import hashlib
from datetime import date
from urllib.parse import urlsplit, urlunsplit

def require(ok, message):
    if not ok:
        raise ValueError(message)

def record(value, fields):
    require(isinstance(value, dict) and set(value) == set(fields.split()), "unexpected or missing fields")
    return value

def text(value):
    require(isinstance(value, str) and bool(value.strip()), "nonempty text required")
    return value.strip()

def items(value):
    require(isinstance(value, list) and len(value) <= 10000, "bounded array required")
    return value

def indexed(value):
    result = {}
    for row in items(value):
        require(isinstance(row, dict), "record required")
        key = text(row.get("id"))
        require(key not in result, "duplicate id: " + key)
        result[key] = row
    return result

def day(value):
    return date.fromisoformat(text(value))

def number(value):
    require(type(value) in (float, int) and math.isfinite(value), "finite number required")
    return value

def unique_object(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, "duplicate JSON key")
        out[key] = value
    return out

import base64
import re
import struct
import zlib

MAX_PIXELS = 1048576
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")

def parse_hex(value):
    require(isinstance(value, str) and HEX.match(value) is not None, "palette entries must be #RRGGBB")
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))

def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)

def decode_png(encoded):
    require(isinstance(encoded, str) and len(encoded) <= 800000, "png must be base64 text of at most 800000 characters")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ValueError("png is not valid base64")
    require(raw[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG (signature)")
    pos, header, palette, trns, idat, ended = 8, None, None, None, [], False
    while pos < len(raw):
        require(pos + 12 <= len(raw), "truncated PNG chunk")
        length, kind = struct.unpack(">I4s", raw[pos:pos + 8])
        body = raw[pos + 8:pos + 8 + length]
        require(len(body) == length and pos + 12 + length <= len(raw), "truncated PNG chunk")
        crc = struct.unpack(">I", raw[pos + 8 + length:pos + 12 + length])[0]
        require(zlib.crc32(kind + body) & 0xffffffff == crc, "PNG chunk CRC mismatch")
        if kind == b"IHDR":
            require(header is None and length == 13, "bad IHDR")
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            palette = body
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            ended = True
            break
        pos += 12 + length
    require(header is not None and ended and idat, "incomplete PNG")
    width, height, depth, ctype, comp, filt, interlace = header
    require(depth == 8 and ctype in CHANNELS and comp == 0 and filt == 0 and interlace == 0,
            "unsupported PNG (8-bit non-interlaced grayscale, RGB, palette, gray+alpha or RGBA only)")
    require(width > 0 and height > 0 and width * height <= MAX_PIXELS, "PNG larger than 1048576 pixels")
    require(ctype != 3 or (palette is not None and len(palette) % 3 == 0), "palette PNG without PLTE")
    # tRNS: a palette PNG carries one alpha per index; grayscale and RGB PNGs carry one fully transparent colour (a 16-bit
    # sample per channel; at 8 bits the high byte is 0). RGBA and gray+alpha images have their own alpha channel and no tRNS.
    key = None
    if trns is not None and ctype == 0:
        require(len(trns) == 2 and trns[0] == 0, "invalid tRNS chunk for a grayscale PNG")
        key = (trns[1],)
    elif trns is not None and ctype == 2:
        require(len(trns) == 6 and trns[0] == 0 and trns[2] == 0 and trns[4] == 0, "invalid tRNS chunk for an RGB PNG")
        key = (trns[1], trns[3], trns[5])
    channels = CHANNELS[ctype]
    stride = width * channels
    expected = (stride + 1) * height
    inflater = zlib.decompressobj()
    data = inflater.decompress(b"".join(idat), expected + 1)
    require(len(data) == expected and not inflater.unconsumed_tail, "PNG pixel data has the wrong length")
    pixels, previous = [], bytearray(stride)
    for y in range(height):
        mode, line = data[y * (stride + 1)], bytearray(data[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        require(mode <= 4, "bad PNG filter")
        for i in range(stride):
            left = line[i - channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i - channels] if i >= channels else 0
            if mode == 1:
                line[i] = (line[i] + left) & 255
            elif mode == 2:
                line[i] = (line[i] + up) & 255
            elif mode == 3:
                line[i] = (line[i] + ((left + up) >> 1)) & 255
            elif mode == 4:
                line[i] = (line[i] + paeth(left, up, corner)) & 255
        pixels.append(line)
        previous = line
    def rgba(x, y):
        line, i = pixels[y], x * channels
        if ctype == 6:
            return line[i], line[i + 1], line[i + 2], line[i + 3]
        if ctype == 2:
            return line[i], line[i + 1], line[i + 2], 0 if key == (line[i], line[i + 1], line[i + 2]) else 255
        if ctype == 0:
            return line[i], line[i], line[i], 0 if key == (line[i],) else 255
        if ctype == 4:
            return line[i], line[i], line[i], line[i + 1]
        index = line[i]
        require(index * 3 + 3 <= len(palette), "palette index out of range")
        alpha = trns[index] if trns is not None and index < len(trns) else 255
        return palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2], alpha
    return width, height, ctype, rgba

def nearest(color, palette):
    best = None
    for hex_value, rgb in palette:
        distance = max(abs(a - b) for a, b in zip(color, rgb))
        if best is None or distance < best[1] or (distance == best[1] and hex_value < best[0]):
            best = (hex_value, distance)
    return best

def compute(data):
    record(data, "palette tolerance canvas grid images")
    palette = [(value.lower(), parse_hex(value)) for value in items(data["palette"])]
    require(len(palette) <= 256, "palette is limited to 256 colours")
    tolerance = data["tolerance"]
    require(type(tolerance) is int and 0 <= tolerance <= 64, "tolerance must be an integer 0..64")
    canvas = None if data["canvas"] is None else record(data["canvas"], "width height")
    grid = None if data["grid"] is None else record(data["grid"], "cellWidth cellHeight")
    for block in (canvas, grid):
        for value in (block or {}).values():
            require(type(value) is int and value > 0, "canvas and grid sizes must be positive integers")
    reports = []
    for key, row in indexed(data["images"]).items():
        record(row, "id png")
        width, height, ctype, rgba = decode_png(row["png"])
        counts, semi, filled = {}, 0, set()
        cols = (width // grid["cellWidth"]) if grid else 0
        for y in range(height):
            for x in range(width):
                r, g, b, a = rgba(x, y)
                if a == 0:
                    continue
                if a != 255:
                    semi += 1
                counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
                if grid and width % grid["cellWidth"] == 0 and height % grid["cellHeight"] == 0:
                    filled.add((y // grid["cellHeight"]) * cols + x // grid["cellWidth"])
        issues = []
        off = None
        if palette:
            offenders = []
            for color, pixels in counts.items():
                hex_value, distance = nearest(color, palette)
                if distance > tolerance:
                    offenders.append({"hex": "#%02x%02x%02x" % color, "pixels": pixels, "nearest": hex_value, "distance": distance})
            offenders.sort(key=lambda o: (-o["pixels"], o["hex"]))
            off = {"colors": len(offenders), "pixels": sum(o["pixels"] for o in offenders), "top": offenders[:10]}
            if offenders:
                issues.append("OFF_PALETTE")
        if semi:
            issues.append("SEMI_TRANSPARENT_PIXELS")
        canvas_report = None
        if canvas:
            canvas_report = {"expected": [canvas["width"], canvas["height"]], "actual": [width, height],
                             "match": (canvas["width"], canvas["height"]) == (width, height)}
            if not canvas_report["match"]:
                issues.append("CANVAS_MISMATCH")
        grid_report, plan = None, None
        if grid:
            wr, hr = width % grid["cellWidth"], height % grid["cellHeight"]
            grid_report = {"cellWidth": grid["cellWidth"], "cellHeight": grid["cellHeight"], "widthRemainder": wr, "heightRemainder": hr,
                           "divisible": wr == 0 and hr == 0}
            if wr or hr:
                issues.append("GRID_NOT_DIVISIBLE")
            else:
                rows = height // grid["cellHeight"]
                plan, empty = [], []
                for r in range(rows):
                    for c in range(cols):
                        name = "%s_r%02dc%02d" % (key, r, c)
                        plan.append({"name": name, "x": c * grid["cellWidth"], "y": r * grid["cellHeight"],
                                     "width": grid["cellWidth"], "height": grid["cellHeight"]})
                        if r * cols + c not in filled:
                            empty.append(name)
                grid_report["frames"] = len(plan)
                grid_report["emptyFrames"] = empty
                if empty:
                    issues.append("EMPTY_FRAMES")
        reports.append({"id": key, "width": width, "height": height, "colorType": ctype, "uniqueColors": len(counts),
                        "semiTransparentPixels": semi, "offPalette": off if palette else "NOT_CHECKED_NO_PALETTE",
                        "canvas": canvas_report if canvas else "NOT_CHECKED", "grid": grid_report if grid else "NOT_CHECKED",
                        "slicePlan": plan, "issues": issues})
    return {"images": reports, "issueCount": sum(len(r["issues"]) for r in reports),
            "pixelsEdited": False, "filesWritten": False, "mode": "AUDIT_AND_PLAN_ONLY"}

if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(1048577)
        require(len(raw) <= 1048576, "input exceeds 1 MiB")
        data = json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
        print(json.dumps(compute(data), ensure_ascii=False, sort_keys=True, allow_nan=False))
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        print("INVALID_INPUT: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
