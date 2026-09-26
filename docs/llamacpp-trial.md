# llama.cpp 试验清单

状态：开发分支，尚未发布。2026-09-25 核验下载包装，2026-09-26 整理试验入口。
先保留 Ollama 入口和所有用户设置，待用户比较后决定是否撤下默认推荐入口。

## 如何试验

在包含此改动的 Cindy 中打开「设置 → 模型供应商 → 添加 → llama.cpp」。
点击后立即添加供应商并进入详情，不等待运行环境安装或服务启动。
安装和模型下载在详情中进行，安装后不启动服务，也不展示手动启动按钮。模型下载完成后自动加入可用模型，首次使用时启动并刷新
服务；下载期间可以取消，分片由 Cindy 自动补齐。「手动下载」位于模型清单下方，停止／重启位于
「管理服务」。已有外部服务可通过「自定义端点」添加。
只按用户点击下载，不自动下载这张清单里的所有模型。

## 当前包装

这张表是本次核验记录，不是第二份可编辑模型目录。后续在 Server 的
`catalog/source/registry/local-models.json` 同一模型下维护 `llamacpp[]`，生成完整 Registry
并同步客户端。公共名称、搜索别名和推荐顺序只维护一次。

| 模型 | 量化 | 下载总量（十进制） | 核验来源 |
| --- | --- | --- | --- |
| Qwen3.8 27B | Q4_K_M | 18.97 GB | [ggml-org/Qwen3.8-27B-GGUF](https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-Q4_K_M.gguf) |
| Qwen3.5 4B | Q4_K_M | 3.01 GB | [bartowski/Qwen_Qwen3.5-4B-GGUF](https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/blob/main/Qwen_Qwen3.5-4B-Q4_K_M.gguf) |
| Qwen3.5 9B | Q4_K_M | 6.17 GB | [bartowski/Qwen_Qwen3.5-9B-GGUF](https://huggingface.co/bartowski/Qwen_Qwen3.5-9B-GGUF/blob/main/Qwen_Qwen3.5-9B-Q4_K_M.gguf) |
| Gemma 4 12B | Q4_K_M | 7.66 GB | [bartowski/gemma-4-12B-it-GGUF](https://huggingface.co/bartowski/gemma-4-12B-it-GGUF/blob/main/gemma-4-12B-it-Q4_K_M.gguf) |
| Qwen3.6 35B A3B | Q4_K_M | 20.42 GB | [ggml-org/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/ggml-org/Qwen3.6-35B-A3B-GGUF/blob/main/Qwen3.6-35B-A3B-Q4_K_M.gguf) |
| Nemotron 3.5 Lightning 30B | Q4_K_M | 25.48 GB | [bartowski/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF](https://huggingface.co/bartowski/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF/blob/main/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-Q4_K_M.gguf) |
| Qwen3.8 Flash-Next | Q4_K_M | 119.60 GB | [bartowski/Qwen3.8-Flash-Next-GGUF](https://huggingface.co/bartowski/Qwen3.8-Flash-Next-GGUF/blob/main/Qwen3.8-Flash-Next-Q4_K_M/Qwen3.8-Flash-Next-Q4_K_M-00001-of-00004.gguf) |
| Laguna S 2.1 118B A8B | Q4_K_M | 96.03 GB | [poolside/Laguna-S-2.1-GGUF](https://huggingface.co/poolside/Laguna-S-2.1-GGUF/blob/main/laguna-s-2.1-Q4_K_M.gguf) |

Flash-Next 为四片，其他所选包装为单文件。安装时重新解析仓库 revision 并按 LFS SHA-256
校验内容；上表日期的大小不能替代下载时校验。仓库可能变更，失败时不会安装部分文件。

以上八款均未完成 Cindy llama.cpp 全链路运行评测；GGUF 存在不表示具体架构、工具调用、
速度或内存已验证。界面复用 Ollama 的共用型号主推选择，显示芯片和内存，并将有 GGUF
包装的主推标为「主推 · 先试这个」。这只是型号级试用顺序，不代表该包装的峰值内存或性能已验证。
2026-09-26 按用户要求调整本机 Apple M5 Ultra / 256 GiB 的试用主推为 Qwen3.8 Flash-Next Q4_K_M；
共用目录显式将其排在 27B 之前，沿用现有 192 GiB 门槛，27B 为轻量备选。
能力参考 [AA Flash-Next](https://artificialanalysis.ai/models/qwen3-8-flash-next) 与
[AA 27B](https://artificialanalysis.ai/models/qwen3-8-27b)：同为 v4.3.2，分别为 40 和 34；
这不是本地 Q4 的成绩或速度证明。未知硬件或缺失包装时不从其他候选补位。
默认上下文为 32,768；2026-09-26 用户授权将当前 bartowski Flash-Next 试验包装调为 262,144。
通过 llama.cpp 原生模型 preset 分型号设置，并同步 Pi/Codex/Claude 的托管模型资料；其他包装不随之扩容。
单并发、最多加载一个模型。Flash-Next 可在模型高级设置的上下文中选择 256K 或 1M；
默认仍为 262,144，1M 指 1,000,000 tokens。沿用已有模型上下文偏好存储，跨重启保留，
下次使用时自动配置服务；扩展时同时启用 YaRN（scale=4、orig_ctx=262144）。
正在生成时不会自动重启服务，需等当前生成结束后重试。恢复默认会撤下扩展参数。
目前只对 bartowski Flash-Next 包装提供此快捷选项，不推广到其他 GGUF。视觉 projector 暂未接入。
本机 b11178 已实测加载 Flash-Next：`/props` 与 `/v1/models` 均返回 `n_ctx=262144`，
原生 Pi + 真实 Flash-Next 完成短问答。
另于 2026-09-26 在 Apple M5 Ultra / 256 GiB、b11178、Q4_K_M 上完成一次百万窗口测试：
实际输入 982,003 tokens，输出 59 tokens，无截断；10%、50%、90% 三处校验码全部召回。
耗时 40 分 42 秒，进程峰值 RSS 132.87 GiB（包含映射权重，不等于整机占用），
swap 保持约 5.62 MiB，未增长。这是单次合成长输入检索验证，不代表复杂推理或多轮工具任务稳定性。
产品入口亦已实测：在高级设置点击 1M，三个引擎的既有上下文偏好均保存为 1,000,000；
新建指定 llama.cpp 供应商的 Pi 会话自动启动服务，生成原生 YaRN preset，完成短问答。
Pi 上下文用量接口返回 maxTokens=1,000,000；服务 /props 返回 n_ctx=1,000,192（内部对齐取整）。
2026-09-26 按用户反馈撤下模型自查专用工具，避免额外工具定义占用上下文；保留 256K 配置，
不另加系统提示词替代。模型名称与窗口以宿主配置及实际服务查询为准。
macOS 使用对应架构构建；Windows/Linux 当前选 CPU 构建，尚未实机验收。

## 试验记录

每次记录模型仓库/文件/revision、llama.cpp 版本、机器、量化、上下文和思考设置，
分别测试：普通问答、一次真实工具调用、多步修改及测试、停止后再次使用、长输入。
记录首字延迟、输入/输出速度、整个请求耗时、系统内存峰值和 swap；失败也保留。
和 Ollama 比较时尽量使用相同权重、量化、提示、上下文及思考设置，不能把 MLX 与 GGUF
的差异全部归因于运行时。

| 检查项 | 已有结果 | 待用户试验 |
| --- | --- | --- |
| 安装、GGUF 下载、启动、停止、Chat API | 本机 b11178 + SmolLM2 135M Q4_K_M 返回 Hello. | 八款清单模型逐项运行 |
| 目录、取消、校验、入口、旧端兼容 | 自动化测试覆盖 | Light/Dark 实机目检 |
| 暂停、继续下载 | 实际 HF 下载 SmolLM2 135M：2,216,008 字节处暂停，HTTP 206 续传，105,454,432 字节完整 SHA-256 校验通过；测试目录已清理 | 跨进程恢复尚未支持 |
| 工具调用与真实编程任务 | Flash-Next + Pi 曾完成只读工具调用（该专用工具已按用户反馈撤下） | 真实编程、多步稳定性 |
| 速度、系统内存与 swap | 未做同条件比较 | 和 Ollama 配对记录 |
| 百万上下文与 YaRN | Flash-Next 可选 1M；本机 982,003 token 输入完成，三处校验码 3/3 | 复杂长文推理、多轮工具任务、其他硬件 |

效果满足要求后再决定默认推荐是否只保留 llama.cpp。撤下默认推荐不等于删除已有
Ollama 连接、卸载运行环境或移除用户模型，这些操作不在本次授权范围内。

## 与 Ollama 交互逐项核对（2026-09-26）

| 场景 | llama.cpp 行为 |
| --- | --- |
| 点供应商 | 立即添加，再到详情安装/连接 |
| 推荐 | 同一目录/硬件筛选，主推与轻量备选明确区分 |
| 已安装 | 默认下载列表隐藏；搜索可找到并标为已在本机 |
| 下载中、暂停、失败 | 只出现一张卡片；搜索或离开页面后返回仍保留进行中的下载 |
| 完成 | 自动同步到供应商，移出下载区，不需要再点应用 |
| 搜索、其他候选、无结果 | 共用列表分组规则，避免空的其他候选区 |
| 下载操作 | 共用暂停/继续/取消控件；继续使用已下载字节 |
| 手动下载 | 仓库与 GGUF 文件选择是运行时必需差异；分片显示总大小 |
| 服务 | 真实运行状态；启动/停止入口，退出 Cindy 停止自有进程 |

仍有运行时差异：一次一个托管操作；退出应用会取消下载，不能像 Ollama 一样跨进程继续。
这些限制不应被「共用界面」掩盖，也不算已经实现完全等价。

共享 userData 的多个实例各自持有独立暂存目录，操作结束只清理自己的目录；重复模型发布以原子目录提升为准，不删除另一实例的模型。安装使用独立版本目录和暂存清单。为避免误删仍在下载的文件，不自动扫描清理其他暂存目录；强制退出或崩溃遗留的暂存文件目前不会自动回收。

2026-09-26 用户确认支持多实例共享托管服务。启动复用现有跨进程锁与进程实例存活探测：同一 userData、存活身份匹配、模型 preset 相同且健康检查通过时，第二个 Cindy 直接使用已启动的服务，不生成第二份进程。共享方停止或退出不终止拥有方；拥有方仍需保持运行，退出后服务会停止，下次使用重新按需启动。配置不同或身份无法确认时拒绝接管，不通过重启打断生成。一次性辅助模型请求同样走按需启动；正常退出等待当前安装／下载取消及其暂存清理完成。多实例服务尚未做正式版与开发版同时运行的实机验收。
