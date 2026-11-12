# 2026-10-31 传输核心验证记录

核心指纹：`0207ddfd23a09577960e513f07be8a5dd73cc1f2`。
算法：在 `packages/agent-net-core` 运行 `shasum src/*.rs | shasum`，路径名也是输入的一部分。
文件级 SHA-256 见 [source-sha256.json](source-sha256.json)。本次没有修改传输算法。

## 数据来源

| 文件 | 内容与边界 |
| --- | --- |
| [simulation-kcp-baseline.txt](simulation-kcp-baseline.txt) | 2026-10-31 09:59 的完整模拟器基线，32 场景、两个窗口、12 种 C KCP 配置；其中 agent-net 行属于旧版本，不用于最终结论 |
| [simulation-agent-net.txt](simulation-agent-net.txt) | 2026-10-31 13:37 的最终核心模拟器输出；只跑 agent-net，因此输出末尾的 KCP 胜负统计为 0，不是有效比较结论；需要与基线的 KCP 行配对 |
| [public-udp.txt](public-udp.txt) | 2026-10-31 13:40～14:03（Asia/Shanghai），真实公网 UDP，30 项、每项 4 轮，共 120 次运行；全部完成、发送失败为 0；两端核心指纹一致，结束时两端测试进程都已退出 |
| [cpu.txt](cpu.txt) | 最终核心，公网运行结束后连续测 3 次；本机 arm64，rustc 1.97.1，内存直连，每次 512 MiB；正文采用中位数并保留范围 |
| [validation.txt](validation.txt) | 最终核心的 Cargo 编译与可靠性测试原始输出 |
| [validation.json](validation.json) | 同一次 Cargo 验证的命令、退出码与墙钟耗时 |

KCP 固定提交为 `b1a7a2101dcbb96017681a500d6b82bbe5a88766`，源码摘要与 `sim/fetch-kcp.sh` 一致。FEC 和 kcptun 参数使用本仓适配层，没有直接运行完整 kcptun 产品。KCP 模拟器行是缓存基线，本轮没有重跑全部 KCP 模拟器矩阵；公网 5 种实现则均在本轮重新运行。

模拟器每个场景 16 个种子，传输 8 MiB；交互为每 20 ms 发送 200 字节，共 2000 条，测单向送达。公网批量传输也为 8 MiB，交互是每轮 500 条、200 字节 echo，测往返时间。模拟器与公网的延迟数值不可直接横向比较。

公网参数：`--rounds 4 --mib 8 --windows 1024,128 --limit 90`，默认上传、下载、交互全开；每轮旋转 5 种实现的顺序。原始输出中的 `NaN` 表示该模式没有这个指标（批量模式没有交互分位数，交互模式不统计批量开销）。4 轮短样本不足以评价稳定的公网 p95 / p99；至少 30 轮的尾延迟验证尚未完成。

## 复跑

在 `packages/agent-net-core` 下执行：

```sh
cargo check --profile sim --workspace --all-targets --features agent-net-sim/kcp --locked --offline
AGENT_NET_SEEDS=10000 cargo test --profile sim --workspace --features agent-net-sim/kcp --locked --offline
AGENT_NET_CPU_ONLY=1 cargo run --release -p agent-net-sim --features kcp --bin compare
AGENT_NET_NO_CPU=1 cargo run --release -p agent-net-sim --features kcp --bin compare
```

首次对比须先运行 `sim/fetch-kcp.sh` 下载并校验固定版本的 KCP，仅存入被忽略的测试目录。`--offline` 要求本地已有依赖；本核心运行时零第三方依赖。

公网需要另一台已授权的测试机器及可达的 UDP 端口；命令和打洞方式见 `sim/src/bin/netperf.rs` 文件头。不要把本文的结果视为已接入客户端、已通过手机真机或已完成加密验证。

## 最终版本检查

- `cargo check`：workspace 全部目标及 KCP 特性通过，1.00 秒。
- Cargo 测试：39 项通过（核心单测 3、FEC 单测 1、可靠性集成测试 35），profiling 用例 1 项按原设计忽略；总墙钟 100.67 秒，其中可靠性文件 97.61 秒。
- `AGENT_NET_SEEDS=10000`：10000 个连续种子及 10 个历史失败种子；20 万轮随机与变异包、5 万个构造包、64 万个伪造校验帧。均通过现有完整性、进展、崩溃与缓冲内存边界断言。
- 测试后仅更正了可靠性文件头的 tier / 耗时说明，未改变用例或断言；源文件摘要记录该注释更正后的版本，核心指纹保持不变。
- 仓库文档契约 10 项、术语规则 71 项通过；术语检查无新增违规，仅有既存 proposed 术语告警。完整客户端 CI 未运行。

## 历史验证边界

- 百万种子通过发生在最终几次算法修改前，本轮不把它归于最终指纹。最终指纹的实际种子数以 `validation.txt` 的命令为准。
- 变异集曾扩展到 67 项，当时抓到 57 项、存活 10 项。随后量化差异、补回归并移除冗余逻辑，目前脚本 65 项；最终版本尚未完整重跑变异矩阵，不能宣称全被抓到。
- 回环 UDP 在较早版本上测过，最终指纹没有重跑全部回环场景。
- 尚未验证多流公平性、与 TCP 共存、Windows / iOS / Android 真机、Wi-Fi 切蜂窝、三大运营商和长期稳定性。
