# KCP 差距优化记录

目标：持续追赶仍落后的用时、流量和交互延迟；只有可以量化的真实取舍进入配置。
用户选择「自动选择，支持手动覆盖」，核心提供 Auto / Lean / Fast。尚未接入产品设置或持久化。

本目录当前包含多轮原型结果，**不能混为同一版代码的成绩**。优化前完整基线和公网结果在
[`../2026-10-31/README.md`](../2026-10-31/README.md)，核心指纹 `0207ddfd23a0`。

模拟器的突发日程已与逐包随机数流分开。受影响的五个突发场景与 KCP 对照已按网络模型 v2 重跑；
最新结果在 `network-v2/`，根目录 `comparison.*` 是它的快捷副本。旧模型完整快照在 `legacy-network-v1/`。
真实公网的 Auto / Fast 各 45 次传输已完成，不使用模拟器日程，不受这项修正影响。

## 已有证据的边界

- `initial-probe-*`：只改变未测得 RTT 时的首轮超时探测；长往返干净链路的回归先失败后通过。
- `small-message-prototype-*`：独立小消息副本原型，尚无后续中断退避、稀疏消息积压恢复和策略 API。
- `speed-prototype-selected-scenarios.txt`：只测七个场景的速度策略原型，不是完整矩阵。
- `rejected-startup-candidate.txt`：全局提高初始速率后有两项严格回归失败，已拒绝；没有放宽测试。
- 原型矩阵使用 27 个调参场景，每场景 16 个种子，窗口 128 / 1024；五个历史保留场景未参与本轮调参。
- 原始 `AGENT_NET_KCP=none` 输出末尾的零胜负统计不构成比较证据；后续工具已改为不输出该统计。
- `../2026-10-31/` 的公网基线属于旧核心。本目录 Auto / Fast 公网记录属于当前核心；不把模拟结果概括为所有真实路径。

## 可复现比较

固定 KCP 对照使用相同模拟器、场景、负载和 16 个种子。每一指标取十二种配置的最好值，
这是更强的逐项包络，不能合成一套 KCP 配置。按保存表格精度计算，差距 1% 内算平，边界结果需高精度复核。
`sim/summarize.py` 校验每个场景确实读入十二种 KCP，不因大数值挤掉空格而漏掉普通 KCP 行；输出胜平负和全部落后项。
汇总工具也会拒绝不同网络模型混用，验证记录为 `network-v2/model-mismatch-rejection.txt`。

```sh
python3 sim/summarize.py \
  --baseline sim/results/2026-10-31-optimization/network-v2/kcp-reference-merged.txt \
  --candidate sim/results/2026-10-31-optimization/network-v2/simulation-auto.txt \
  --candidate sim/results/2026-10-31-optimization/network-v2/simulation-lean.txt \
  --candidate sim/results/2026-10-31-optimization/network-v2/simulation-fast.txt \
  --output sim/results/2026-10-31-optimization/network-v2/comparison.md
```

非突发 27 场景的 54 行自研结果不变；KCP 的两种窗口、共 24 行无突发控制结果也逐项相同。
因此兼容复用 27 个非突发场景，只替换五个重跑场景。来源与逐行选择见
`network-v2/kcp-reference-provenance.json`，可用 `network-v2/merge-reference.py` 重建 768 行纯 KCP 参考。
两个原始文件里的 agent-net 行均不参与 KCP 参考。

## 本轮采用版本 `bc94b7e56a6d`

完整核心指纹：`bc94b7e56a6d26a8264d0eb5629b032fb7035806`，在 package 目录执行
`shasum src/*.rs | shasum`；源码逐文件 SHA-256 见 `source-sha256.json`。
Linux 测试服务器编译得到相同核心指纹；Mac 与 Linux 的测试工具 `netperf.rs` 哈希也已核对一致。

采用的变化：

1. 未测得 RTT 时首轮超时只探测一个数据包，保留其余测量机会。
2. Auto 在稳定零散丢包时将小消息副本分开发送，持续中断后退回保守恢复。
3. 稀疏消息已经由副本或校验确认后，过期原包释放在途预算；判丢记录保持包号顺序。
4. 应用稀疏样本不再卡住积压恢复；已测得大 BDP 且包列速率贴着发送上限时，允许增加启动探测。
5. 核心导出 Auto / Lean / Fast 和 `Config::for_policy`。Lean 关闭主动冗余，Fast 扩大启动与校验；显式字段不被构造函数重写。

没有接入客户端设置、偏好存储、加密或产品设备链路；策略只改变本地发送行为，线格式不变。

### 模拟结果与剩余差距

`network-v2/` 中的 `simulation-auto.txt`、`simulation-lean.txt`、`simulation-fast.txt` 是本版全部 32 场景、
两种窗口、每场景 16 种子，共 192 行结果。`network-v2/validation.json` 与 `policy-matrices.json` 保存命令、退出码和耗时。
完整五指标胜平负和每个落后项见 [`comparison.md`](comparison.md)，结构化结果见 `comparison.json`。

| 策略 | 窗口 128 的用时：胜 / 平 / 负 | 窗口 1024 的用时：胜 / 平 / 负 |
| --- | --- | --- |
| 默认 Auto | 16 / 2 / 14 | 31 / 0 / 1 |
| Lean | 7 / 2 / 23 | 26 / 0 / 6 |
| Fast | 19 / 3 / 10 | 32 / 0 / 0 |

小窗口仍有差距，最省字节与中断尾延迟也没有全面赶超。五个历史保留场景也列入上表，
它们在本轮调参中排除，但并非从未看过的盲测。

具体取舍可复现：5% 丢包、窗口 128、8 MiB，Auto 2153 ms / 20.3% 额外协议字节，
Lean 4243 ms / 8.5%，Fast 1985 ms / 108.9%；最快 KCP 为 2036 ms / 159.8%。
同场景交互字节分别约 1412 / 551 / 2050 KiB，交互 p99 为 20.9 / 98.7 / 20.8 ms。
Auto 跨洋 2232 ms，仍慢于最快 KCP 的 2206 ms；Fast 为 2102 ms。不能事后逐项挑三个策略的最好值冒充 Auto。

“额外协议字节”计入数据、确认和冗余，**不含 UDP/IP 和链路层包头**；增加独立小包会增加这些未计入的包头。
虚拟传输时间不包含实际 CPU 编解码耗时，因此仍需要真实 UDP 和 CPU 验证。

### 可靠性与回归

- `network-v2/tests.txt`：当前模型的 workspace 扩展验证，43 通过、1 个 profiling 忽略，包含默认 10000 + 10 历史失败种子、三种策略各 1000 + 10 种子，workspace 用时 96.34 秒。
- `network-v2/fresh-*`：使用 300000 起的 1000 个种子，默认策略与三策略矩阵均通过；验证字节完整、有序、内存边界、恢复进展和无空转。这是可靠性验证，不是性能盲测。
- `post-fixture-validation.json` 与根 `final-fresh-*` 为同核心、旧网络模型下的补充历史记录，不替代当前模型验证。
- 三种策略六种不同组合的双向传输通过；手动省流量在同一消息输入下确实减少线上协议字节。
- `initial-probe-regression-before/after.txt`：未测 RTT 的长往返干净路径先失败后通过。
- `small-message-regression-before/after.txt`：采用前的小消息原型回归，旧捎带版 p99 40.92 ms，独立副本版满足 30 ms 上限。
- `idle-retirement-regression-before/after.txt`：旧模型下，移除回收时 p99 为 2035.801 ms，启用后通过 2000 ms 上限；原断言为 2400 ms，已收紧。
- `network-v2/idle-retirement-causal-*`：相同断网日程下额外复核，仅移除回收调用为 1933.437 ms，启用为 1908.008 ms，两者都满足 2 秒限制。旧模型的较大差值不作为同日程的因果收益。
- `fair-regression-before/after.txt`：额外发包会改变旧模型后续断网时段，新模型消除该问题；最小观察失败点为 242000 us。
- `startup-probe-regression-before/after.txt`：仅禁用新增启动探测分支后，长往返传输均值为 2586.337 ms；启用后通过 2550 ms 上限，短往返原断言保持。

百万规模与全部变异测试没有在本轮核心上重跑，不作对应承诺。旧版本记录单独保留。
格式检查发现实验包原有 rustfmt 差异，优化前基线也失败（4689 行格式差异）；本轮保留既有排版，没有批量重写。

### CPU 与真实 UDP

`cpu.txt` / `cpu.json`：Mac arm64，512 MiB 内存直连、无加密无 socket，三策略各三轮。
这不是持续重 FEC 链路的编解码吞吐测试。同轮 KCP 也从约 200 MiB/s 波动到约 70 MiB/s，
观察到其它编译和系统扫描负载，因此保留全部原始值，**不能据此对三策略作稳定 CPU 排名**。
CPU 对照使用 `KcpPeer::with_window(true, 1024)`，并非十二种 KCP 配置各自的 CPU 最好值。

公网测试使用 Mac → aotu-dev，Linux 端 rustc 1.96.0，同核心、同测试工具。
首轮因 HTTPS 代理出口与 UDP 出口不同而打洞超时，失败记录保存在
`public-auto-1024-path-failure.*`；三家 STUN 确认一致映射后重测。
当前轮次不足以证明稳定 p95/p99 优势；所有公网验证只代表这条路径。
Auto / Fast 各 45 次传输均完成，发送失败计数为零。数字和同轮 KCP 对照见
[`public-comparison.md`](public-comparison.md)，结构化完整 30 行在 `public-comparison.json`。
公网上传和极端尾延迟仍落后；下载领先本轮四种 KCP 配置。公网命令不调用模拟器 Link，故不受网络模型修正影响。

### 前一采用候选 `95127e954272`

`previous-95127e954272/` 保留增加大 BDP 启动探测之前的三策略完整矩阵、测试与源码哈希；
其 100000 起的 10000 种子段也通过，但不能当作本轮最终核心的同版本证明。

## 下一轮仍需追赶

- 小窗口的窗口阻塞和校验效率，尤其乱序、卫星与高带宽低丢包路径。
- 省流量策略在限速、配额与长往返下的多余重传和启动丢弃。
- 中断与高铁场景的尾延迟；更紧的 1900 ms 固定回归试验仍未通过（1911.899 ms），不声称已满足该阈值。
- 公网上传与模拟器的差异：实际包列与突发损失是否让校验关闭，需要进一步观测验证。
- 持续重校验负载的 CPU 成本和多条真实路径；不以这条路径的少量轮次概括所有网络。
- 当前交互负载只有 200 字节 / 20 ms，且与大传输分开测量；更大交互消息、宿主定时精度、并发争用与多路流仍需单独验证。
