# 模型配置与下发：架构及维护入口

> 权威入口：先读本页，再按问题打开专题。Server 为独立仓库，文档不代表已部署。

## 数据流

```text
Server 随包 / 远程目录 → /api/model-catalog/catalog
    → 执行端加载与缓存 → 合并连接实报、用户覆盖 → 活动目录
    ├─ 选择器 / 管理页
    ├─ 聊天 → Claude Code / Codex / Pi
    └─ 媒体 → 对应媒体通道
```

聊天调用目标为「连接 ID + 上游模型 ID + 引擎」。同品牌多账号共用资料，凭证、发现、用量和覆盖按连接隔离。
Mobile / device-link 使用执行端目录；本地安装状态来自执行机器。目录声明不等于账号准入或协议已实现。

### 配置包含什么

Server 正本现为 `model-access-server/catalog/source/` 分片，由
`model-access-server/scripts/generateCatalog.mjs` 组装成 `catalog/generated/providers.json`。
本地域编辑 `source/registry/local-models.json`，revision 编辑 `source/catalog.json`；
不要直接编辑生成文件。客户端离线文件分别是
[`catalog/providers.json`](../../packages/model-providers/catalog/providers.json)（providers / presets）和
[`catalog/model-registry.json`](../../packages/model-providers/catalog/model-registry.json)（Registry）。
逻辑结构如下；具体字段及修改位置见下表：

```text
Catalog (version)
├─ providers[]                 内置接入、授权、routing、各引擎 models
├─ presets[].runtimes          新建连接的地址、协议和默认资料
└─ modelRegistry (schemaVersion / updatedAt)
   ├─ baseModels[]             公共型号
   ├─ models[]                 接入条目：modelRef → baseModels；perAgent 与 routes 同级
   ├─ nativeApiRules[]         原生协议判定
   └─ localModels              候选包装 models[].variants[] + 推荐 featuredIds[]
```

### 哪些东西应该在哪里改

| 要改什么 | 写入位置 / 责任侧 | 不能顺带改变什么 |
| --- | --- | --- |
| 型号公共名称、说明、窗口、输出、思考能力 | Registry `baseModels[].defaults` | 价格、账号权限、地址和凭证不在公共继承内 |
| 接入条目状态、排序、默认开启标记 | Registry `models[]` 顶层 | 显示开关不等于成员资格；订阅账号排序以账号为准，见下文模型排序与默认可见性 |
| 某供应商的上游 ID、支持路由、普通默认 | `models[].routes[]` / `routes[].defaults` | 普通默认不能压过实报 |
| Claude Code / Codex 的工作默认 | `models[].perAgent`，引擎必须被该条目 route 声明 | 不把工作预算当供应商承诺容量 |
| Pi 公共成员和 Pi 默认资料 | `providers[].models.pi`；订阅账号发现另补新型号，公共资料仍按 Registry 合并 | 复用已实现的订阅传输，不复制其他引擎的专属能力 |
| 经核实的错误实报 | 匹配 route 的 `forceOverrides` + `overrideReason` | 不影响其他供应商，也不压过用户配置 |
| 厂商官方参考价及历史价区间 | `baseModels[].referencePriceGroups[].prices[]`（Registry V5） | 按市场分组，保留币种、标准/Fast、输入区间及生效日期 |
| 接入供应商参考报价 | `routes[].referencePrices[]`；`referencePriceGroup` 指向公共型号的官方价组 | Gateway 实价/折扣仍归其计费控制面，不混填缺失字段 |
| 内置接入或新增连接模板 | `providers[]` 或 `presets[].runtimes` | 不在公共目录保存真实账号密钥 |
| 本地候选、包装、门槛、推荐 | `localModels.models` / `featuredIds` | 不自动安装、卸载、切换用户模型 |
| 某个用户的显式设置 | 本机 `model-catalog-overrides.json` 等既有偏好 | 不写回 Server；刷新保留，恢复默认删除 override |
| 新执行协议、SDK 参数、token 计量 | 本仓对应 host / harness / bridge | 加目录字段不会自动获得执行能力 |

结构例外：条目没有 `models[].defaults`；Registry agents / perAgent 只接受 Claude Code、Codex，
Pi 走 `providers[].models.pi`（用户补丁 perAgent.pi 另属合法 schema）。媒体 route 使用 `agents: []`。
`contextWindowMax` 是客户端容量投影，不能填进 Registry；容量与工作预算见 [运行时细则](model-catalog-runtime.md)。

### 覆盖顺序

这里是**模型资料字段**的优先级，右边覆盖左边；成员、权限、实际计费、显示开关不套用此链：

```text
公共 defaults → 匹配的预设默认（适用时）→ 条目顶层默认
             → route.defaults → 条目 perAgent[引擎]
             → 供应商明确实报 → route.forceOverrides → 用户显式覆盖
```

缺字段继承，false 明确关闭，数组整体替换，null 按字段合同处理，不使用真假判断吞掉空值。
用户公共型号补丁先于用户具体连接/引擎补丁。思考档位默认在公共型号维护，按需增加引擎例外；
`defaultEffort` 的已配置默认优先于供应商实报的推荐档，再适配实际支持能力，force / 用户覆盖仍优先。
详细字段及成员空值规则以 [模型资料优先级](../product-rules/model-metadata-precedence.md) 为唯一正本。

<a id="ordering"></a>
## 模型排序：账号优先，目录兜底

OpenAI（Codex 订阅）与 Anthropic（Claude 订阅）的 root 有账号模型清单时，`sortOrder` 以账号
返回顺序为准：Codex 取 `models_cache.json` 的 `priority` 或 app-server `model/list` 的返回位置，
Claude 取 SDK `supportedModels()` 的返回位置。只在 Registry 里有、账号没返回的模型按 Registry
`sortOrder` 接在其后。装配时重写为连续 `sortOrder`，选择器、设置页、新对话默认与 Claude Code
bridge 共用这一顺序；OpenAI 订阅的 Pi 清单成员与能力仍来自 Pi 目录，但同样按账号顺序排列，
并沿用 Registry 条目的 `defaultEnabled: false`；用户本地 `sortOrder` patch 仍最高。拿不到账号清单时才用 Registry `sortOrder`。
xAI 保留 Registry 声明顺序，XD 以 Gateway `/models` 为准，均不受此规则影响。
第三方 API key 连接（MiMo、Kimi Code 等预设及自定义端点）没有 sortOrder，按连接配置里的
顺序排：首次添加用接口返回的顺序；之后刷新发现的新型号排在已有型号之前（保持接口返回的
相对顺序），已有型号位置不动（`mergeDiscoveredRuntimeModels`）。

新对话默认模型不跟排序绑定的例外只有服务端按区域下发的 `newSessionDefault`；公共 Registry 的
同名字段不进入活动目录。未标记时取排序第一的默认可见模型，即账号返回的第一个可见模型。

设置页管理列表组内与选择器同序：组内每项都带 `sortOrder` 时按它排；只要有一项缺失，退回
按系列名 A–Z、同系列版本号降序，避免局部权重把新型号压到旧策展位置之后。

<a id="presets"></a>
## 第三方预设：一份推荐清单

`providers.json` 的每个预设只在顶层写一份 `models` 推荐清单，数组顺序即推荐顺序；
`runtimes[引擎]` 只放地址、协议、模型目录等连接信息，不再按引擎各写一份模型。
加载时由 `expandPresetModels` 展开回各引擎清单，下游与服务端下发的旧格式形状一致。

- 协议限制导致某模型只在部分引擎可用时写 `engines`（如 OpenCode Go 的 Anthropic 协议模型、
  GLM Coding Plan 只给 Claude Code 的 `[1m]` 变体）。
- 引擎专属字段写 `engineOverrides[引擎]`：Pi 的推理档位、按模型路由，以及确有差异的窗口
  （如 GLM Coding Plan 裸 `glm-5.2` 在 Claude Code 不写窗口、1M 走 `[1m]` 条目，Pi 为 1M）。
- `engines` 的每一项与 `engineOverrides` 的每个键都只能是本预设已声明的引擎；拼错或写成
  其它形状时整条预设被拒绝（即使 `runtimes` 另带旧格式清单），不静默丢模型或忽略覆盖。
- 本文件是源格式，旧客户端读不懂顶层清单，不能直接发布到旧 OSS `cfg/providers.json`
  （该文件自 2026-07 冻结，旧客户端经公共 API 与服务端投影拿到展开后的形状）。
- 名称与参数以厂商官方文档为准；未列入推荐清单的型号由 Pi 模型资料补入并默认隐藏。
- `presetModels.test.ts` 校验随包预设不再出现按引擎的清单。服务端分片同样只写一份推荐
  清单，由 `generateCatalog.mjs` 展开后下发；同 id 的服务端预设整体覆盖随包版本，所以
  推荐清单与参数两边保持一致。服务端的连接设置（含 Pi 照抄 Claude Code 的兼容映射）
  以服务端为准，随包版本的原生 Pi 地址只在离线时使用。

<a id="visibility"></a>
## 默认可见性：产品合同与实现差异

[产品合同](configuration-and-overrides.md#模型可见性)：用户开关优先，否则跟随目录 defaultEnabled。

- **不默认显示的型号只写在目录里**：条目标 `defaultEnabled: false`，未标的一律默认显示，
  所以新出的型号一定可见。客户端发现代码不按型号写死隐藏例外（2026-09-26 起移除了
  `gpt-5.4-mini`、Haiku、bridge `gpt-5.4` 等硬编码）。
- 保留的是按状态或引擎的规则，不针对具体型号：`deprecated`、`requires_payment` 默认关闭；
  跨 Harness bridge（如 Claude Code 里的 `chatgpt/*`）与自定义连接的兼容引擎默认关闭，
  Registry `perAgent` 可显式打开。
- **XD 路由一律使用独立的 `xd/*` 条目**，不与订阅或其他供应商共用条目：服务端生成
  Gateway `/models` 时读取 XD 路由所在条目的名称、排序与 `defaultEnabled`，共用会让订阅侧
  调整连带改动 XD。型号规格经 `modelRef` 继承同一公共型号，不重复维护。
  `xdRegistryEntries.test.ts` 校验离线 Registry 不出现混用条目。

排查须同时检查上游值、活动目录值和用户 override。

<a id="release"></a>
## 更新、下发与验收

来源回退：开发本地文件 → 公共 API / 对应最后有效缓存（LKG）→ 旧 OSS / 对应缓存 → 内置目录。
Registry 另按 updatedAt 选择整份有效版本，较新内置快照也可能胜出；这与逐字段覆盖不同。
localModels 整域缺失才用随包本地域，显式空不兜底。

1. **确认目标**：记下 Server/客户端 commit、部署环境、实际目录源、当前 schema/revision、要改的 provider/model/引擎；核实官方资料与该通道实报。本文不是线上状态台账。
2. **修改责任侧**：在授权范围内先维护 Server 正本，再协调客户端离线 Registry。遇到尚未上线的协议配套，分别记录工作分支、已合并和已部署状态，不混成“已支持”。
3. **整表同步**：将审阅后的 Server `modelRegistry` 整体同步到客户端 `catalog/model-registry.json`，保持同 updatedAt、同内容。不要复制 Server 整份 providers.json，也不能只复制 localModels 造成悬空引用。新 revision 必须递增且不可变；价格 effectiveFrom / verifiedAt 保留其真实日期。
4. **先验证兼容再发布**：完整结构过 parseModelRegistry / parseCatalog；确认旧客户端投影。尤其先读 [媒体扩展发布前置条件](../model-registry-v4-media.md#发布前置条件)：同为 V4 并不证明认识新增媒体字段。LKG/内置回退不能代替兼容方案。
5. **核对真实下发**：当前 Server 源码仅加载制品内生成目录，已不读取 MODEL_CATALOG_URL；须核对目标环境版本。部署后读取 `/api/model-catalog/catalog`，核对目标与旧版响应、ETag 和有效 revision。仅改文件、合并 PR、通过 CI 不算下发完成。
   同步回归须核对原有直连 route 与历史参考价区间未丢失；覆盖标准/Fast、缓存读写、长输入分档。
   离线默认档与已发布 Server 有差异时逐项披露。原生协议校验须遍历全部 route 和活动目录中的
   订阅 wire 别名，不能仅统计字段填写率；不能从供应商兼容 API 反推未知型号的原生协议。
6. **验收到运行时**：确认客户端实际接受目标快照，保留用户覆盖；检查选择器、发出的上游 ID/参数及新旧任务。覆盖离线、坏快照、同 revision 冲突与回退版本；刷新不改用户显式型号/档位，工作预算更新按 [运行时细则](model-catalog-runtime.md) 在安全时机应用。

兼容补全只能补缺项：旧快照缺失 nativeApi 可由内置补全；明确协议、null、retired 优先。
它不改窗口、价格、成员资格，也不从 Gateway wireProtocol 或 Pi piApi 猜原生协议。
旧格式迁移中若两份 Registry 有差异，必须使用不同 revision 并记录原因，不能伪造同版本一致。

## llama.cpp 托管接入

客户端的「添加供应商」只展示一个 llama.cpp 主入口，点击立即保存并进入详情，
不等待安装或连接。安装与下载在详情中进行；外部服务走「自定义端点」。
与 Ollama 共用 `LocalModelDownloadUI.tsx` 的安装提示、目录搜索、模型卡片、量化标签、
下载按钮、进度操作与手动下载布局，各运行时只适配传输和状态。
实现位于 `apps/desktop/src/main/local-model-runtime/llamaCpp*.ts`，界面为
`LlamaCppProviderDetail.tsx`。运行环境从 llama.cpp 官方 GitHub Releases 安装到
userData 下的 `llamacpp-runtime`；macOS 使用对应架构构建，Windows / Linux 先使用
CPU 构建。下载校验官方 SHA-256，不调用系统包管理器。

模型可从共用清单一键下载，也可由用户指定公开 Hugging Face 仓库并选择 GGUF 文件；下载固定到仓库 revision，
校验大小与 LFS SHA-256，自动补齐分片，全部完成后才移入已安装列表。取消或失败清理
本次暂存文件；磁盘不足在下载前提示。当前支持文本模型，不自动下载视觉 projector，
下载清单复用 Server Registry 的 `localModels.models[].llamacpp[]`，只增加
`repo / file / quantization / sizeBytes / verifiedAt` 下载资料，不维护第二份模型名单。
名称、搜索别名、五语简介、顺序来自同一模型条目和 `featuredIds`；两个运行时共用分档推荐。
GGUF 的型号级试用主推复用 `recommendForHost` 与 `featuredIds`，显示实际芯片和内存；
只保留存在 GGUF 包装且文件大小小于物理内存的主推型号。未知硬件、主推撤下或包装缺失时不从其他候选补位。
这是共用型号筛选，不是该 GGUF 的运行内存测量；卡片标明「主推 · 先试这个」，并说明本机速度与峰值内存待实测。
不继承 Ollama 包装的思考配置或实测结论，也不因内存充裕把其他候选自动提升为主推。
2026-09-26 按用户要求将 Flash-Next 显式加入共用主推首位（现有 192 GB 门槛），27B 为轻量备选。
`localModelBrowserItems` 统一过滤已安装项、保留活动下载、搜索与去重；已安装主推也从默认下载区隐藏。
下载支持同一次运行中的暂停/继续：保留暂存字节，按固定 revision 用 HTTP Range 续传，重新校验完整 SHA-256。
取消清理本次暂存；退出应用仍会取消，尚不恢复跨进程的下载。当前一次只执行一个托管操作。
`verifiedAt` 表示文件存在与大小核验日期，不能解释为运行验证；分片大小为总和。
明确空的 `llamacpp: []` 撤下该模型的 GGUF 候选，旧快照缺字段也不按型号猜下载地址。
试验范围与维护记录见 [llama.cpp 试验清单](../llamacpp-trial.md)。

托管服务只绑定 `127.0.0.1:11435`，与原手动预设的 8080 分开；端口被占用时不接管。
router 按请求加载模型，最多同时加载一个模型，默认上下文 32,768、单并发。
2026-09-26 经用户授权，当前 bartowski Flash-Next 试验包装使用 262,144；
按模型生成原生 INI preset，不用全局 CLI 窗口覆盖其它模型。发布模型资料时同步升级旧的托管默认值。
下载完成后自动同步供应商模型列表并广播刷新；首次使用时更新 router 的模型清单，
不需要再点击应用，也不会在下载完成时中断正在运行的服务。
添加时创建 `cindy-local-llamacpp` 连接，经现有 Chat 协议桥供 Pi / Codex / Claude Code 使用，
并保留已有模型的用户设置。后续使用该连接时自动启动服务；Cindy 退出时停止自有子进程。
2026-09-26 用户确认按需启动：安装后不立即启动，详情页不展示启动按钮，停止时显示「按需启动」。
会话启动和 Pi provider 装配均复用 preflight；下载不依赖服务运行。高级管理中保留停止/重启用于排障。
这不代表任意 GGUF 都支持工具调用。Flash-Next 可选 1,000,000 tokens，并自动配置 YaRN；
已完成本机单次 982,003 token 合成检索验证，不能据此承诺其他包装或复杂任务质量。

安装与下载管理目前与既有 Ollama 管理入口一样，只在执行端 Desktop 设置页开放，
不新增远程 privileged IPC 白名单。手机仍可通过已有执行端模型目录使用已连接模型；
SSH 执行路径跳过本机启动，不会把本机模型安装到远端。
安装与手动下载独立于服务端；共用目录的后续更新需要配套发布 Server。
客户端请求增加 `registryLocalRuntimes=1`，服务端仅向同时声明 media 和本能力的 V4/V5
客户端下发 `llamacpp`，旧端剥离该字段并重新计算 ETag。未知能力值等同未声明。
本轮完整 Registry 从 Server 正本同步为 `2026-09-25T00:00:00.000Z`。同步前将客户端
已有但 Server 主干尚缺的 Grok 4.7 / Build Fast 配置原样补入 Server，避免回退已有型号。
没有仅拼入本地域、改变用户 override 或发布到线上。

回归测试为 `llamaCppDownloads.test.ts`、`llamaCppService.test.ts`、`llamaCppIpc.test.ts`、
`managedLlamaCppProvider.test.ts` 与 `LlamaCppProviderDetail.test.tsx`。

## 通用供应商导入

Pi 上游生成资料统一转换为客户端 `catalog/provider-models.json`，供各引擎和设置页补缺；
不另存 Pi 原始表。目录的 Pi API 是该渠道的执行协议，不冒充 Registry 的厂商原生协议。
维护命令、覆盖顺序和验收见 [通用供应商目录](provider-catalog-generation.md)。
渠道多协议与逐模型接口证据见 [供应商接口核查](provider-interface-audit.md)。

## SSH Codex 模型目录

SSH Codex 的创建入口（含 Orca Worker）、任务内选择器与 main 的新建／切换准入读取所选主机
app-server 的完整 `model/list`，不使用控制端 OpenAI 登录或网关目录作为远端可用性的依据。
沿用已有远端安装与 daemon 连接流程；分页有界，读取失败或空清单显示重试，不回退到本机。
结果只用于该主机，断连、换主机或换账号后的迟到结果丢弃，不发布到本机公共目录。

新任务从远端清单解析默认模型及推理强度／Fast；已有任务保留原模型和历史，由用户改选。
设置页及普通 SSH 创建入口不继承控制端草稿的模型、推理强度或 Fast 记忆，即使型号同名；
采用远端默认模型及推荐推理强度，Fast 初始关闭，创建后可在任务内手动改选。
原样恢复只有在持久化的主机、原生线程、引擎、模型及来源均匹配时才豁免新建目录校验，
允许恢复后来被隐藏的原模型；模型是否仍可推理由远端 Codex 决定。SSH 模型及档位选择不写入控制端本地模型偏好。
首次连接成功会补偿挂载时因尚未就绪而失败的目录读取；重复 ready 快照不清空已成功读取的目录。
升级远端 Codex 包前先停止旧 daemon；有正在执行的回合或无法确认停机时，升级失败并提示稍后重试。
`model/list` 不提供的真实窗口保持未知；普通 SSH Codex 切换沿用 main 的窗口策略：
未知窗口允许切换且不主动重建，已核实的高风险缩窗在远端拒绝，回合中延期。
不能因前端尚无用量报告而静默丢弃点击。未知窗口不代表已证明切换安全，后续上下文处理仍由原生 Codex 决定。
目录成员资格不等于认证、网络和实际推理已验证。

实现：`maker-host/ssh-codex-models.ts`、`remote-ssh/codex-model-list.ts`、
`useSshCodexProviders.ts`；回归：`codex-model-list.test.ts`、`sshCodexModels.test.tsx`、
`chatInputModelLoading.test.tsx`。新增读取 IPC 属于本机 SSH 管理面，与既有 SSH 管理 channel
一样不开放 device-link；手机及设备互联的供应商清单协议保持原样，完整远端能力发现仍由 #65 跟进。

## 按问题继续阅读

| 按需阅读 | 入口 |
| --- | --- |
| 资料、账号、覆盖、空名单 | [模型资料优先级](../product-rules/model-metadata-precedence.md) |
| 窗口、压缩、价格与展示 | [运行时与展示细则](model-catalog-runtime.md) |
| 本地包装、内存、推荐证据与更新 | [本地模型筛选](../product-rules/local-model-selection.md) |
| 图片/视频/音频/向量字段与发布兼容 | [V4 全类型规范](../model-registry-v4-media.md) |
| 供应商界面、账号状态、用量呈现 | [供应商设置](../product-rules/provider-settings.md) |
| 历史型号与同步记录 | [历史记录](../model-catalog-history.md)；不可当作当前状态 |
| 字段写法及可执行校验 | [五个示例](../examples/model-catalog.md) |
| 修改代码与定位测试 | [代码导航](model-catalog-runtime.md#从需求找到代码) |

## 厂商参考价（Registry V5）

公共型号的 `referencePriceGroups` 使用市场标识（当前为 `global` / `cn`），不是供应商 ID。
每组 `prices` 沿用原价格结构与官方证据：币种、每百万 tokens 单价、缓存读/写及 1h 写入、
标准/Fast 等变体、输入区间 `[minInputTokens, maxInputTokens)`、生效日期区间。
缺字段保持未知，明确的 0 才表示零单价；缓存存储每小时费用不能写成缓存写入单价。

`resolveBaseModelReferencePrice` 按公共 ID/唯一 alias 读取，不依赖供应商名单。
多市场/币种必须明确选择到唯一有效价格；无匹配或有歧义返回未知。
路由用 `referencePriceGroup` 明确选择所属公共型号的价格组；供应商自己的 `referencePrices`
优先于该组，整组替换，不逐字段补齐。订阅价值估算指定 `officialOnly`，仅取厂商参考价，
用户显式价格覆盖仍优先，账号归属不变。XD 计费继续只读 Gateway 实报。

新客户端请求 `registrySchemaVersion=5&registryMedia=1`。无媒体能力标识的请求保持服务端
冻结兼容快照，不跟随完整正本更新；正本与客户端离线 Registry 仍保持完整一致。
服务端向 V1–V4 展开官方参考价到原路由字段，
剥离新增组与引用字段；V4 保留公共资料、本地域及原覆盖语义。各版本响应有独立 ETag。
旧服务端仍可返回旧目录，新客户端保留旧格式读取；应先部署服务端再发布客户端。
本次只迁移已有、已核实的价格，不补猜测价格，不改变 XD 的缺价处理。

## xAI 双接口同步与导入验收

新维护入口为 [`tools/model-catalog/sync-xai.mts`](../../tools/model-catalog/sync-xai.mts)，
用账号 `/models` 与官方 `/language-models` 合并型号和资料，再通过实际活动目录、三引擎
选择器数据与参考价解析验收。运行方式、凭证边界、缺项报告与实测限制见
[同步说明](../../tools/model-catalog/README.md)。输出是账号范围的本地导入候选，不可直接
作为全局 Server 清单发布；它不改用户覆盖，也不以抓取成功代替完整适配。

订阅 Fast 若通过独立上游型号执行，在 `providers.models[agent].fastModelId` 声明同来源、
同引擎的目标 ID；不能只下发 `supportsFastMode: true`。客户端结合当前账号发现结果计算
可用性，并在 Claude / Codex / Pi 请求边界统一切模，不再叠加 `service_tier: priority`。
`null` 可显式撤销映射；缺省保持旧行为。旧客户端忽略新映射，因此执行适配需先随客户端
发布；后续相同执行方式的新型号可维护目录数据。4.7 的关系与 Fast 价表已由官方文档和
实测补证，4.6 不从版本号推导 Fast 支持。
