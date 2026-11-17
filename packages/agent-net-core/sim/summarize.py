#!/usr/bin/env python3
"""Compare saved deterministic matrices against every KCP configuration.

No simulation is rerun. Keep the input files and their source versions with the
report. Each metric is compared to its best KCP value independently; that is an
envelope of twelve configurations, not one realizable KCP configuration.
"""

import argparse
import json
import math
import re
from pathlib import Path

METRICS = ["用时 ms", "额外协议字节 %", "p50 ms", "p95 ms", "p99 ms"]
ROW = re.compile(
    r"^  (.*?)\s+用时\s*(\S+)ms 开销\s*(\S+)% "
    r"p50\s*(\S+) p95\s*(\S+) p99\s*(\S+)ms 交互字节\s*(\S+)K"
)
ANNOTATIONS = ["（留出，未用于调参）", "（未参与本轮调参；历史已测）"]


def network_model(path):
    match = re.search(r"^网络模型 (\S+)", path.read_text(), re.MULTILINE)
    return match[1] if match else "shared-burst-rng-v1"


def read_matrix(path):
    rows = {}
    window = scene = None
    for line in path.read_text().splitlines():
        heading = re.match(r"^=== 窗口 (\d+)", line)
        if heading:
            window = int(heading[1])
            scene = None
            continue
        match = ROW.match(line)
        if match:
            if window is None or scene is None:
                raise ValueError(f"{path}: metric row without a scenario: {line}")
            key = (window, scene)
            name = match[1].strip()
            values = [float(x) for x in match.groups()[1:]]
            if any(math.isnan(x) for x in values):
                raise ValueError(f"{path}: NaN result: {line}")
            if name in rows.setdefault(key, {}):
                raise ValueError(f"{path}: duplicate row {key}/{name}")
            rows[key][name] = values
        elif "用时" in line and line.startswith("  ") and "ms 开销" in line:
            raise ValueError(f"{path}: unparsed metric row: {line}")
        elif line and not line.startswith((" ", "=", "胜", "和", "落后", "本次", "agent-net 策略")):
            scene = line
            for annotation in ANNOTATIONS:
                scene = scene.removesuffix(annotation)
    return rows


def compare(baseline, candidate):
    records = []
    for (window, scene), peers in candidate.items():
        if set(peers) != {"agent-net"}:
            raise ValueError("candidate must be an agent-net-only matrix (AGENT_NET_KCP=none)")
        references = baseline.get((window, scene), {})
        kcp = {name: values for name, values in references.items() if name != "agent-net"}
        if len(kcp) != 12:
            raise ValueError(f"expected twelve KCP rows for {window}/{scene}, got {len(kcp)}")
        mine = peers["agent-net"]
        if not all(math.isfinite(value) for value in mine[:5]):
            raise ValueError(f"unfinished or non-finite candidate result for {window}/{scene}")
        for index, metric in enumerate(METRICS):
            name, values = min(kcp.items(), key=lambda item: item[1][index])
            best = values[index]
            verdict = "win" if mine[index] < best * 0.99 else "tie" if mine[index] <= best * 1.01 else "loss"
            records.append(dict(window=window, scene=scene, metric=metric, ours=mine[index],
                                kcp=best, kcp_config=name, verdict=verdict))
    if not records:
        raise ValueError("empty candidate matrix")
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True, help="Markdown file; JSON goes beside it")
    args = parser.parse_args()
    model = network_model(args.baseline)
    for path in args.candidate:
        if network_model(path) != model:
            raise ValueError(f"network model mismatch: {args.baseline} uses {model}, {path} uses {network_model(path)}")
    baseline = read_matrix(args.baseline)
    reports = {str(path): compare(baseline, read_matrix(path)) for path in args.candidate}
    lines = ["# 与 KCP 十二种配置的逐项最好值比较", "", f"网络模型：`{model}`。", "",
             "顺序为胜 / 平 / 负，差距 1% 内算平。各指标独立取 KCP 最好值，不能合成一套 KCP 配置。", "",
             "按保存的表格精度计算：用时 1 ms，其余指标 0.1 单位；接近 1% 边界时需要更高精度复核。", "",
             "| 输入 | 窗口 | 场景数 | " + " | ".join(METRICS) + " |",
             "| --- | --- | --- | " + " | ".join(["---"] * len(METRICS)) + " |"]
    for path, records in reports.items():
        for window in sorted({row["window"] for row in records}):
            subset = [row for row in records if row["window"] == window]
            counts = ["/".join(str(sum(row["metric"] == metric and row["verdict"] == result for row in subset))
                               for result in ["win", "tie", "loss"]) for metric in METRICS]
            lines.append(f"| {Path(path).name} | {window} | {len(subset) // 5} | " + " | ".join(counts) + " |")
    summary_end = len(lines)
    for path, records in reports.items():
        lines += ["", f"## {Path(path).name} 的全部落后项", "",
                  "| 窗口 | 场景 | 指标 | agent-net | KCP 最好值 | KCP 配置 |",
                  "| --- | --- | --- | --- | --- | --- |"]
        lines += [f"| {r['window']} | {r['scene']} | {r['metric']} | {r['ours']:g} | {r['kcp']:g} | {r['kcp_config']} |"
                  for r in records if r["verdict"] == "loss"]
    args.output.write_text("\n".join(lines) + "\n")
    args.output.with_suffix(".json").write_text(json.dumps(dict(network_model=model, baseline=str(args.baseline), rounded_input=True, reports=reports), ensure_ascii=False, indent=2) + "\n")
    print("\n".join(lines[:summary_end]))


if __name__ == "__main__":
    main()
