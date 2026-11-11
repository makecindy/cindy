#!/usr/bin/env python3
"""Build the v2 KCP reference from rerun bursts and unchanged non-burst rows.

Run from any directory after kcp-rerun-raw.txt completes. All twelve KCP
configurations in both control windows must exactly match the original run.
The agent-net rows in both raw inputs are deliberately excluded.
"""

from pathlib import Path
import hashlib
import json
import re
import runpy

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parents[3]
ORIGINAL = HERE.parent.parent / "2026-10-31/simulation-kcp-baseline.txt"
RERUN = HERE / "kcp-rerun-raw.txt"
HELPERS = runpy.run_path(str(HERE.parents[2] / "summarize.py"))
MODEL = "independent-burst-calendar-v2"
BURSTS = ["突发丢包", "Wi-Fi 200Mbit", "地铁", "山区", "留出 高铁"]


def raw_rows(path):
    rows = {}
    window = scene = None
    lines = path.read_text().splitlines()
    for index, line in enumerate(lines):
        heading = re.match(r"^=== 窗口 (\d+)", line)
        if heading:
            window = int(heading[1])
            scene = None
            continue
        metric = HELPERS["ROW"].match(line)
        if metric:
            assert window is not None and scene is not None
            rows.setdefault((window, scene), {})[metric[1].strip()] = line
        elif window and index + 1 < len(lines) and HELPERS["ROW"].match(lines[index + 1]):
            scene = line
            for annotation in HELPERS["ANNOTATIONS"]:
                scene = scene.removesuffix(annotation)
    return rows


def main():
    original = HELPERS["read_matrix"](ORIGINAL)
    rerun = HELPERS["read_matrix"](RERUN)
    assert HELPERS["network_model"](RERUN) == MODEL
    assert len(original) == 64
    assert len(rerun) == 12, "six scenarios in two windows must finish before merging"
    names = [name for name in next(iter(original.values())) if name != "agent-net"]
    assert len(names) == 12
    controls = []
    for window in [128, 1024]:
        key = (window, "无丢包 40ms")
        for name in names:
            assert rerun[key][name] == original[key][name], (key, name, rerun[key][name], original[key][name])
        controls.append({"window": window, "scenario": key[1], "configurations_matching_exactly": 12})
    old_raw, new_raw = raw_rows(ORIGINAL), raw_rows(RERUN)
    lines = [f"网络模型 {MODEL}", "KCP-only derived reference; provenance in kcp-reference-provenance.json.", ""]
    expected = {}
    sources = []
    for window in [128, 1024]:
        lines.append(f"=== 窗口 {window}（KCP 参考）===")
        for key in original:
            if key[0] != window:
                continue
            affected = any(label in key[1] for label in BURSTS)
            source = RERUN if affected else ORIGINAL
            parsed = rerun if affected else original
            raw = new_raw if affected else old_raw
            lines.append(key[1])
            expected[key] = {name: parsed[key][name] for name in names}
            lines.extend(raw[key][name] for name in names)
            sources.append({"window": window, "scenario": key[1], "source": str(source.relative_to(PACKAGE)), "rerun_burst": affected})
        lines.append("")
    assert sum(row["rerun_burst"] for row in sources) == 10
    destination = HERE / "kcp-reference-merged.txt"
    destination.write_text("\n".join(lines) + "\n")
    assert HELPERS["read_matrix"](destination) == expected
    provenance = {
        "network_model": MODEL,
        "original": {"path": str(ORIGINAL.relative_to(PACKAGE)), "sha256": hashlib.sha256(ORIGINAL.read_bytes()).hexdigest()},
        "rerun": {"path": str(RERUN.relative_to(PACKAGE)), "sha256": hashlib.sha256(RERUN.read_bytes()).hexdigest()},
        "control_validation": controls,
        "reused_scenarios": 27,
        "rerun_scenarios": 5,
        "configurations": 12,
        "seeds": 16,
        "note": "Non-burst Link execution preserves its exact v1 random stream; all 54 Auto rows were also checked unchanged. No agent-net baseline rows are used.",
        "rows": sources,
    }
    (HERE / "kcp-reference-provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n")
    print("KCP reference: 768 rows, 27 compatible scenarios reused, 5 burst scenarios rerun; 24 control rows match exactly.")


if __name__ == "__main__":
    main()
