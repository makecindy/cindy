#!/usr/bin/env python3
"""Compare one agent-net matrix with each KCP configuration on time and extra protocol bytes together.

A cell counts as "agent-net no worse" when both metrics are better or within 1%; "KCP no worse" is the
mirror case; everything else is a trade-off. This complements summarize.py, whose per-metric envelope
picks the best KCP configuration separately for every metric.

usage: dominance.py KCP_REFERENCE AGENT_NET_MATRIX [OLD_AGENT_NET_MATRIX]
"""
import re
import sys
from pathlib import Path

ROW = re.compile(r"^  (.*?)\s+用时\s*(\S+)ms 开销\s*(\S+)% p50\s*(\S+) p95\s*(\S+) p99\s*(\S+)ms 交互字节\s*(\S+)K")
NOTES = ["（未参与本轮调参；历史已测）", "（留出，未用于调参）"]


def parse(path):
    rows, window, scene = {}, None, None
    for line in Path(path).read_text().splitlines():
        heading = re.match(r"^=== 窗口 (\d+)", line)
        if heading:
            window = int(heading[1])
            continue
        match = ROW.match(line)
        if match:
            rows.setdefault((window, scene), {})[match[1].strip()] = [float(x) for x in match.groups()[1:]]
        elif line and not line.startswith((" ", "=", "胜", "和", "落后", "本次", "agent-net 策略", "网络模型", "KCP-only")):
            scene = line
            for note in NOTES:
                scene = scene.removesuffix(note)
    return rows


def compare(mine, theirs):
    return -1 if mine < theirs * 0.99 else 0 if mine <= theirs * 1.01 else 1


def table(kcp, candidate):
    configs = sorted({name for peers in kcp.values() for name in peers})
    result = {}
    for window in (128, 1024):
        for config in configs:
            counts = [0, 0, 0]
            for (w, scene), peers in candidate.items():
                if w != window or (w, scene) not in kcp:
                    continue
                mine, theirs = peers["agent-net"], kcp[(w, scene)][config]
                time, extra = compare(mine[0], theirs[0]), compare(mine[1], theirs[1])
                counts[0 if time <= 0 and extra <= 0 else 1 if time >= 0 and extra >= 0 else 2] += 1
            result[(window, config)] = counts
    return configs, result


kcp = parse(sys.argv[1])
configs, now = table(kcp, parse(sys.argv[2]))
before = table(kcp, parse(sys.argv[3]))[1] if len(sys.argv) > 3 else None
print(f"# 与每种 KCP 配置同时比较用时与额外协议字节\n\n输入：`{Path(sys.argv[2]).name}`" + (f"，对照 `{sys.argv[3]}`" if before else "") + "。")
print("\n每格为 agent-net 两项都不差 / KCP 两项都不差 / 各有胜负，差距 1% 内算不差；每种窗口 32 个场景。\n")
for window in (128, 1024):
    print(f"## 窗口 {window}\n\n| KCP 配置 | 本版 | " + ("上一版 |" if before else "") + "\n| --- | --- | " + ("--- |" if before else ""))
    for config in configs:
        cell = "/".join(map(str, now[(window, config)]))
        old = " " + "/".join(map(str, before[(window, config)])) + " |" if before else ""
        print(f"| {config} | {cell} |{old}")
    print()
