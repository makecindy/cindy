# 模型目录历史取舍与迁移记录

> 参考记录，不是当前配置或部署状态。当前维护规则见 [模型配置与下发](dev-rules/model-catalog-maintenance.md)。
> 下列文字记录各批次当时的事实，不能相互当作后续状态的证明。引用时须带日期、来源和验证范围。

## 本地模型配置与证据快照（2026-09-05）

本轮由 9 个内置条目收敛到 7 个逻辑模型。正式推荐保留 Qwen3.8 27B；其他
6 个只是待比较候选。5 个选择位置中，低内存中档和速度档各保留两名候选等待比较。
“保留推荐”是当前证据下的产品选择，不表示已完成所有量化与硬件组合的 Pareto 证明。

| 位置     | 模型                                         | 当前处理              | 仍需补齐的证据                                            |
| -------- | -------------------------------------------- | --------------------- | --------------------------------------------------------- |
| 更低内存 | Qwen3.5 4B                                   | 候选                  | 同条件能力、速度、峰值内存                                |
| 低内存   | Qwen3.5 9B / Gemma 4 12B                     | 两名候选，未决出胜者  | 同硬件、同量化条件的三维比较                              |
| 能力     | Qwen3.8 27B                                  | 保留能力推荐          | 本地量化对能力的影响、长上下文峰值；不宣称所有 Mac 上最优 |
| 速度     | Qwen3.6 35B A3B / Nemotron 3.5 Lightning 30B | 两名候选，未决出胜者  | 同一台 Mac 上的完整比较                                   |
| 大内存   | Qwen3.8 Flash-Next                           | 仅 Apple Silicon 候选 | Ollama 对应标签的加载/运行峰值及能力损失                  |

移出内置目录：GPT-OSS 20B、Gemma 4 E2B/E4B/26B/31B、Ornith 1.5 35B、
GLM-4.7-Flash。本轮未证明它们相对上述候选有独立的三维优势，不为这些条目另设推荐位；
这不等于已经用完整同机实验证明它们都被支配。Laguna XS 2.1、Muse Glimmer 30B
也不因新品或厂商宣传进入目录。

### 证据快照

- [Artificial Analysis Qwen3.8 27B xhigh](https://artificialanalysis.ai/models/qwen3-8-27b)：
  Intelligence Index **v4.2 = 42**，是保留能力推荐的独立依据。该配置是 xhigh，
  不是本地 MLX/MXFP8 已复现的成绩。
- [Qwen3.8 Flash-Next](https://artificialanalysis.ai/models/qwen3-8-flash-next) 的 v4.2
  **46**、[Qwen3.6 35B A3B](https://artificialanalysis.ai/models/qwen3-6-35b-a3b) 的
  **26**在本轮查询中标为 estimated；仅用于候选判断，不据此宣称已实测击败 27B。
- [M4 Air 32GB 对比原始项目](https://github.com/jordanilchev/local-qwen)：Ollama 0.32.14，
  关闭思考、短输入、最多 200 输出 tokens；Qwen3.6 Q4_K_M 为 29.9 tokens/s，
  Qwen3.8 27B NVFP4 为 17.2 tokens/s。量化不同且未提供完整内存峰值，
  只能支持速度候选资格。
- [Nemotron 长上下文测试](https://omarshabab.com/local-llm-256k-leaderboard/) 使用
  M3 Ultra 512GB 和 MLX；不能与上述 M4 Air 数字直接排出快慢。
- [Flash-Next 4-bit 测试](https://huggingface.co/rapid-mlx/Qwen3.8-Flash-Next-4bit)
  使用 M3 Ultra 256GB、Rapid，报告加载峰值约 148.1GB；不能推断 Ollama 在 128GB
  上适合日用。本目录的 192GB 是保守候选提示，尚未由对应 Ollama 标签验证。

### 包装与内存提示

标签和下载字节于 2026-09-05 从 Ollama 官方 registry 的 manifest 核对，下载大小
为 `layers[].size` 之和。目录中各 `variants[].sizeBytes` 按具体包装分别记录，不能混用。
标签可变；后续更新应重新读取 manifest 并记录摘要。大小仅用于下载提示。

| 模型                   | 通用标签                     | Apple Silicon 标签                      | 内存提示 GB   |
| ---------------------- | ---------------------------- | --------------------------------------- | ------------- |
| Qwen3.5 4B             | `qwen3.5:4b-q4_K_M`          | `qwen3.5:4b-mlx`                        | 8             |
| Qwen3.5 9B             | `qwen3.5:9b-q4_K_M`          | `qwen3.5:9b-mlx`                        | 16            |
| Gemma 4 12B            | `gemma4:12b-it-q4_K_M`       | `gemma4:12b-mlx`                        | 16            |
| Qwen3.8 27B            | `qwen3.8:27b`                | `qwen3.8:27b-mlx` / `qwen3.8:27b-mxfp8` | 32 / MXFP8 64 |
| Qwen3.6 35B A3B        | `qwen3.6:35b-a3b-q4_K_M`     | `qwen3.6:35b-mlx`                       | 32            |
| Nemotron 3.5 Lightning | `nemotron-3.5-lightning:30b` | `nemotron-3.5-lightning:30b-mlx`        | 48            |
| Qwen3.8 Flash-Next     | 未纳入通用包装               | `qwen3.8-flash-next:125b-mlx`           | 192           |

查询入口为 `https://registry.ollama.ai/v2/library/<模型家族>/manifests/<标签>`。
以上内存提示全部是当前配置的估算门槛，不是测得的最低运行内存，不保证任意上下文可用。
Qwen27 的 32GB MLX、64GB MXFP8 选择沿用现有行为，不把更大包装描述成已经证实更优。
非 Apple 主机的普通 RAM 也不等于 GPU 显存；内存适配不是 GPU 性能认证。


## 2026-09-05 至 09-07：协议与价格迁移

历史 V1–V3 迁移时，先保存并恢复经核实的 `nativeApi` / `nativeApiRules`，
按 route 身份对齐；当时以 V3 格式生成新的递增 revision。此时两份 Registry 不再逐字相等，
应分别核对业务参数与协议补全差异，不能沿用同 revision 却修改内容。服务端以后可在原文件
补写这些字段，无需再维护第二份配置文件。

2026-09-05 对齐发现的典型差异包括：OpenAI 订阅与 XD 路由窗口混用、Sonnet 5 已取消
的涨价仍留在旧兜底、Opus Fast 缓存价缺项、Grok 长输入分档过时，以及 DeepSeek
直连参考价 route 缺失。此类修正先落 Server，再同步兜底，不能再维护两份独立数字。
既有 GPT-5.x 公共 API 长输入参考价仍用于历史／显式长窗口估值，不表示订阅默认窗口
应扩大；Astra 的长输入参考价已于 2026-09-07 核实并补齐；此前未核实的长输入历史价格仍返回未知。

2026-09-05 核对[火山方舟流式输出官方示例](https://www.volcengine.com/docs/82379/2123275)：
`doubao-seed-2-1-pro-260628` 可直接调用 `/api/v3/chat/completions`。
Cindy 的 Seed 2.1 Pro 默认协议基准补为 `openai-completions`；这表示默认协议选择，
不表示官方只支持这一种协议（同页也有 Responses 示例）。Gateway 出站仍按实际通道比较。
当时 Server V2 目录可继续在原文件维护价格与窗口，当时本地 V3 只补协议；后续完整快照遗漏
协议时仍由客户端兜底，显式 null/retired 保持优先。


## 2026-09-07 至 09-08：不同批次的同步记录

- 09-07 目录核对曾记录：客户端先递增 Registry，Server 同步待完成。详见 [该次核对](model-catalog-audit-2026-09-07.md)。
- 09-08 本地目录配套工作曾记录：客户端已有型号、协议资料和 medium 默认策略同步到 Server 工作分支，两份随包 Registry 一致。该记录仅证明当时工作快照一致，不证明 PR 合并或环境部署。
- 两条记录不能推导今天的状态。后续核验应记录客户端 commit、Server commit、Registry updatedAt、环境和接口响应；缺少证据的项写未验证。
