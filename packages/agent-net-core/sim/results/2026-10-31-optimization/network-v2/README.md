# 独立突发日程模型的最终对照

核心指纹 `bc94b7e56a6d26a8264d0eb5629b032fb7035806`，网络模型 `independent-burst-calendar-v2`。
协议核心未因模型修正而改变。突发的开始、结束使用独立随机数流，发包数量不再移动后续断网时段。

## 结果入口

- [`comparison.md`](comparison.md)：三种策略、32 场景、窗口 128 / 1024，五项指标的胜平负及全部落后项。
- `comparison.json`：同一结果的结构化数据。输入保留的精度为用时 1 ms、其余 0.1 单位，边界结果需高精度复核。
- `simulation-auto.txt`、`simulation-lean.txt`、`simulation-fast.txt`：每场景 16 种子的 192 行自研结果；`policy-matrices.json` 记录执行状态。
- `kcp-rerun-raw.txt`：五个突发场景与一个无突发控制场景，十二种 KCP 配置、两种窗口，含自研行共 156 行原始结果。
- `kcp-reference-merged.txt` / `kcp-reference-provenance.json`：只保留 768 行 KCP 数据的完整参考及逐场景来源。

无突发路径的随机序列未变：自研的 54 行结果相同，KCP 控制的 24 行结果也在保存精度内逐项相同。
因此兼容复用 27 个非突发场景，仅替换五个受影响场景。运行 `python3 <本目录>/merge-reference.py` 可重建参考。
旧原始对照中的自研行不用于 KCP 参考。五个历史保留场景也纳入最终表，但不是新的盲测。

Fast 在窗口 1024 下的 32 项用时胜出已经额外考虑每个输入 ±0.5 ms 的舍入误差，仍全部满足 1% 胜出门槛；
逐项检查在 `time-rounding-check.json`。这只说明固定模拟矩阵的用时，不代表全部指标或所有真实网络。

## 验证

- `validation.json` / `tests.txt` / `check.txt`：43 项通过、1 个原有 profiling 忽略；包含默认 10000 种子、三种策略各 1000 种子和历史失败种子，workspace 用时 96.34 秒。
- `fresh-validation.json` 与 `fresh-*.txt`：模型冻结后再次验证 300000 起的 1000 个种子，默认策略和三策略矩阵均通过。
- `model-mismatch-rejection.txt`：汇总工具在写报告前拒绝不同模型的输入。
- `idle-retirement-causal-*`：在同一组断网日程下，仅移除回收调用的 p99 为 1933.437 ms，启用为 1908.008 ms；两者都通过 2 秒断言。

突发参数是间隔和持续时间的随机均值，不是精确固定时长。模拟时间不包含真实编解码 CPU 耗时，协议字节不含 UDP/IP 包头。
真实公网的 Auto / Fast 各 45 次观察见 [`../public-comparison.md`](../public-comparison.md)，其公网命令不调用模拟器 Link。
尚未覆盖所有交互尺寸、与大传输并发争用、多路流和多条实际网络路径。
