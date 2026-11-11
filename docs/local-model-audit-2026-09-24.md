# 本地模型复核：2026-09-24

## 本轮结论

目标是补齐 128–256 GB 的可选模型，尤其是 Apple Silicon 256 GB，而不是按参数量扩张名单。
本轮从 7 个逻辑模型增加到 8 个：增加 Laguna S 2.1 118B A8B 编程候选，给
Qwen3.8 Flash-Next 增加官方跨平台 Q4 包装，并更新全部既有条目的证据核对日期。
`featuredIds` 仍只有 Qwen3.8 27B；网页研究没有补齐对应 Ollama 包装的同机比较，
不能声称新增模型已通过本地推荐验收。Flash-Next 是 256 GB 机器的优先试用候选，
Laguna S 是较小下载体积的编程比较对象。未下载权重、未自动切换用户模型。

数据编辑在 `model-access-server/catalog/source/registry/local-models.json`；
公共名称在 `registry/base-models/07.json`；revision 在 `source/catalog.json`。
由生成器组装完整 Registry 后同步客户端离线副本，不编辑 generated 文件。

## 能力证据：同版本复核

访问日期均为 2026-09-24。以下是 Artificial Analysis **v4.3.2** 页面展示值，
不是本地量化版得分；API 输出速度没有用于 Mac 速度排序。页面未明确给出全部
推理预算、服务版本和权重精度，因此这些字段仍为未验证。旧文档 v4.2 的 42/46
不得与本表混算，也不能把跨版本分数下降解释成模型能力退步。

| 模型 / 页面配置 | 指数 | 证据状态与决定 |
| --- | ---: | --- |
| [Qwen3.8 Flash-Next，reasoning](https://artificialanalysis.ai/models/qwen3-8-flash-next) | 40 | 页面不再标 estimated；上游能力证据更新为 measured，Ollama 包装仍未验证 |
| [Qwen3.8 27B，xhigh](https://artificialanalysis.ai/models/qwen3-8-27b) | 34 | 保留现有能力推荐；不宣称 MXFP8/MLX 已复现该分数 |
| [Qwen3.6 35B A3B，reasoning](https://artificialanalysis.ai/models/qwen3-6-35b-a3b) | 18 | 页面不再标 estimated；保留速度候选，没有用 API tokens/s 证明 Mac 优势 |
| [Muse Glimmer，high](https://artificialanalysis.ai/models/muse-glimmer) | 17 | 本轮不加入；缺少对现有候选的同机能力、速度、内存优势证据 |
| [Qwen3.5 122B A10B，reasoning](https://artificialanalysis.ai/models/qwen3-5-122b-a10b) | 16 | 本轮不加入；参数更大不足以构成对 27B 的能力升级 |
| [Mistral Medium 3.5，reasoning](https://artificialanalysis.ai/models/mistral-medium-3-5) | 14 | 本轮不加入；未找到足以增加大内存推荐位的优势 |
| [Nemotron 3.5 Lightning，reasoning](https://artificialanalysis.ai/models/nemotron-3-5-lightning) | 13 | 页面不再标 estimated；保留速度候选，尚未证明被其他本地配置全面超过 |
| [Qwen3.5 4B](https://artificialanalysis.ai/models/qwen3-5-4b) | 13 estimated | 保留低内存候选，不自动推荐 |
| [Qwen3.5 9B](https://artificialanalysis.ai/models/qwen3-5-9b) / [Gemma 4 12B](https://artificialanalysis.ai/models/gemma-4-12b) | 各 14 estimated | 保留两名低内存比较候选，不依据估计值决出胜者 |

`evidence.status` 描述链接中的证据，不是整个本地条目的认证状态。Ollama 标签页
证明包装存在，不能证明性能，因此该链接标 pending；厂商自报也不标成独立实测。

## 192–256 GB：Flash-Next

[发布者模型卡](https://huggingface.co/Qwen/Qwen3.8-Flash-Next)说明它是实验性架构：
125B 主体、每 token 激活 6B，另有约 51B n-gram embedding。不能用 6B 激活量估计内存。
官方模型卡的编程与工具调用成绩属于上游自报，不作为本地量化版已胜出的证明。

[Ollama 标签](https://ollama.com/library/qwen3.8-flash-next/tags)已包含 GGUF Q4。
本轮保留 Apple Silicon 首选 `125b-mlx`，新增 `125b-a6b-q4_K_M` 跨平台候选，
两者的候选内存提示均为 192 GB。非 Apple 平台的系统内存不代表显存，也不承诺 GPU 速度。
不加入 189 GB Q8 和 355/360 GB BF16：前者缺少额外精度收益与峰值证据，后者超出本轮机器的容量。

[Rapid-MLX 原始测试](https://huggingface.co/rapid-mlx/Qwen3.8-Flash-Next-4bit)：
M3 Ultra 256 GB、Rapid 0.13.2、权重 revision `dcf657e4`，单请求、冷前缀缓存、
256 输出 tokens、三次中位数。32K 输入时 TTFT 44.659 秒、预填充 732.9 tokens/s、
生成 21.72 tokens/s；MLX active 约 102.8–103.8 GB，allocator 历史峰值 148.1 GB。
这些不是系统总占用，也不是 Ollama NVFP4 包装的测量；不能据此降低门槛到 128 GB。
报告还提供与 27B 4-bit 同条件的小样本能力比较，结果有胜有负，不能认定全面替代。
测量的完整请求耗时、波动和 swap 在本轮摘录中未验证；M5 Ultra 的对应配置也未验证。

## 128–256 GB：Laguna S 2.1

[发布者模型卡](https://huggingface.co/poolside/Laguna-S-2.1)：118B 总参数、8B 激活，
纯文本、原生推理与工具调用；2026-07-21 的厂商报告为 Terminal-Bench 2.1 70.2%、
SWE-bench Multilingual 78.5%。不把不同 harness 的成绩直接与 Flash-Next 排名。
思考历史保留会影响多轮效果，Cindy/Ollama 的完整工具循环仍待验证。

[Ollama 标签](https://ollama.com/library/laguna-s-2.1/tags)明确区分 Apple MLX NVFP4
与 GGUF Q4。候选只加入 NVFP4（128 GB 提示）和 Q4（192 GB 提示），不自动选择
136 GB MXFP8、235/237 GB BF16 或 DFlash 包装。这些门槛是给权重、缓存、系统留空间的
保守估计，不是运行峰值实测，也不承诺在 1M 上下文满载运行。

[独立测试项目](https://github.com/tanishq-dubey/macos-laguna-s2.1/blob/main/BENCHMARK_RESULTS.md)
提供 2026-07-21/22、M5 Max 128 GB、Python 3.13.12、MLX 0.32.0、mlx-vlm 0.6.6、
MLX-LM 0.31.3、greedy/固定种子/无提示缓存的配置。它比较的是社区量化，而非这里的
Ollama NVFP4；小规模功能套件得分不能冒充通用能力评测。仅支持继续比较的候选资格，
不转录其 tokens/s 为产品性能承诺。Ollama 的 TTFT、生成速度、完整耗时、冷/热启动、
重复波动、加载峰值、系统运行峰值、KV 精度及 swap 均未验证。

## 其余重点排查

| 模型 / 来源 | 本轮处理与理由 |
| --- | --- |
| [DeepSeek V4.1 Flash / V4 Flash、GLM 5.3 / Flash、Kimi K3、MiniMax M3：Ollama 目录](https://ollama.com/library?sort=newest) | 对应官方条目标 cloud，不能当作可下载本地模型加入。此判断只限该通道，不意味着没有开放权重或社区运行时 |
| [DeepSeek V4.1 Flash 社区 MLX](https://github.com/PipeNetwork/deepseek-v41-mlx) | 有独立实现，但需专用运行时/量化；没有验证其与 Cindy 托管 Ollama 的兼容性。本轮不引入新执行协议 |
| [Inkling-Small MLX](https://huggingface.co/mlx-community/Inkling-Small-mlx-4bit) | 有 4-bit 转换及专用 loader，但模型卡峰值仍待测；没有核实官方 Ollama 本地标签。不把 Hugging Face MLX URL 填进 Ollama 下载目录 |
| [Laguna XS 2.1](https://ollama.com/library/laguna-xs-2.1) | 官方仍提示 macOS/Metal 聊天可能空输出，保留在研究记录而不加入候选。不能把 raw generate 绕过当作正常工具调用已可用；该警告不自动推断到 S 2.1 |
| [Ornith 1.5](https://ollama.com/library/ornith-1.5) | 包装存在，但没有补齐同机取代现有档位的优势；不恢复之前移出的推荐位 |
| [Granite 4.2](https://ollama.com/library?sort=newest) | 目录可发现，详情页本轮抓取失败；不据搜索摘要填写参数或增加推荐 |

这是一轮面向可部署配置的筛选，不声称穷尽全部开放权重模型；没有足够证据的型号允许留在研究记录中。

## 包装核验与后续验收

2026-09-24 对原有 14 个标签和本轮新增 3 个标签逐一读取
`https://registry.ollama.ai/v2/library/<name>/manifests/<tag>`，全部返回有效 manifest。
`sizeBytes` 是 manifest 的 layers 大小之和，沿用既有目录口径；它不是加载或运行内存。
原有 14 个大小未变。新增值：

| 标签 | layers bytes | config digest |
| --- | ---: | --- |
| `qwen3.8-flash-next:125b-a6b-q4_K_M` | 120058268208 | `sha256:4634fd1a9e1fa11fbdd6558552755189f3db28463b46f661e191815f460e3e53` |
| `laguna-s-2.1:nvfp4` | 66189691080 | `sha256:72d6c829e9f983adc1665c60c532dd0e844ab9774ae46390159684c2b1a8b2fe` |
| `laguna-s-2.1:q4_K_M` | 96031832391 | `sha256:5bdc3aaf1e3505f44b1634d778c8d6bc97fef119578b2edcf85892e37182657a` |

以上 digest 标识配置 blob，不是完整权重的固定 revision。标签仍可能被上游更新。
正式晋升前应固定完整 manifest/权重 digest，在同一 M5 Ultra 256 GB、同一 Ollama
版本、相同思考预算下比较 27B MXFP8、Flash-Next MLX 与 Laguna NVFP4；至少覆盖
短输入/32K/128K、冷/热启动、工具多轮和可执行编程结果，并记录 TTFT、预填充、
生成速度、请求总耗时、系统峰值、swap、三次中位数与波动。本轮未下载或加载权重，没有本机推理证据。

## 发布边界

本地基线 Server `42977cb` 的完整 Registry 与客户端离线副本逐项一致，原 revision
为 `2026-09-23T00:00:00.005Z`。本轮 revision 为 `2026-09-24T10:51:31.000Z`。
调研时 Global 公共 V5 + media 接口仍为 `2026-09-23T00:00:00.003Z`，本轮文件更新
不代表上线。冻结 legacy 文件不修改；发布需服务端先行，再验证 V4/V5 media 响应、
旧版冻结投影与客户端刷新。实际部署状态以目标环境接口响应为准。
