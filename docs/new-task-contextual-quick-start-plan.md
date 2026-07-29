# Desktop「新任务」上下文快捷入口完整优化方案

> 状态：实施中；已完成首席产品经理 Review 并按反馈修订。
> 最后更新：2026-07-29。
> 范围：Cindy Desktop 全局「新任务」入口、`/cc-agent/new` 页面、项目选择器、快捷入口、首次消息发送链路，以及新建对话在 Mobile／远程场景中的最小连续性契约。
> 性质：产品与技术实施参考方案，不是长期产品规则；实现完成后以代码、测试和权威规则为准。

## 1. 执行摘要

本方案将当前固定、以代码场景为主、点击后仅填入一条预设文字的「新建」页，升级为根据工作上下文变化的任务启动器：

1. 全局「新建」改名为「新任务」。
2. 全局新任务在没有未发送草稿时默认进入「对话」模式。
3. 保留输入框中的品牌问候 `Hi Cindy!`。
4. 未选择项目时显示四个通用任务入口：
   - 制作工具／应用；
   - 写文档／分析数据；
   - 设计／编辑图片；
   - 搜索互联网。
5. 用户手动选择本地或远程项目后，快捷入口立即切换为：
   - 了解项目；
   - 构建新功能；
   - 审查代码；
   - 排查并修复问题。
6. 点击任一快捷入口后直接创建对话并自动发送一条简短、自然、用户可见且本地化的意图消息，不再要求第二次点击发送。
7. 用户消息只表达「想完成什么」；提问数量、执行步骤和验收规则保留在产品行为规范中，不伪装成用户发送的专家 Prompt，也不放进隐藏 system prompt。
8. 「了解项目」直接开始可停止的只读了解；其余入口先问一个最关键的问题，只有缺失信息确实阻止执行时才继续追问，累计不超过 3 个简短问题。
9. 对话模式创建 Cindy 管理的独立本地任务空间，并在 P0 提供可理解的空间标识和「打开任务文件夹」入口；项目模式直接使用用户选择的项目目录，不额外创建通用任务目录。
10. 「搜索互联网」「设计／编辑图片」等能力型卡片必须在展示为可执行入口前满足最低能力契约，不能创建对话后才告知无法完成。
11. 快捷卡片只在输入为空时承担启动作用，不覆盖文字、附件、引用或其他未发送草稿。
12. 自动启动后保留标准停止／恢复能力；Desktop 创建的对话可以按现有机制在 Mobile 继续，文件交付不能只留下 Mobile 无法访问的绝对路径。
13. 实现覆盖 `zh-CN`、`en`、`ja`、`ko`，同时交付 Light 和 Dark 模式，并加入不记录 Prompt、路径或文件内容的最小效果观测。

最终产品逻辑是：

> 没有项目时，Cindy 帮用户开始一项通用任务；选择项目后，Cindy 自动转为项目助手。卡片只负责表达自然意图，Agent 负责理解和执行，稳定的完整工作方法继续由 Skill 承载。

## 2. 背景与现状问题

### 2.1 当前问题

当前「快速开始」存在四个主要问题：

- 四个入口高度集中在代码场景，无法覆盖办公、创作和互联网研究等普通用户需求；
- 各入口语义接近，用户难以快速判断应该选择哪一个；
- 点击后只把一段固定文字写入 Composer，用户仍需再次点击发送；
- 固定文字没有根据任务类别帮助用户补充目标、材料、格式或验收标准，实际价值有限。

此外，当前全局「新建」会保留上一次草稿页选择的项目上下文。这会让用户从全局入口开始一项新工作时，可能无意间继续操作旧项目。新方案需要在保护真实草稿的前提下，把 fresh task 的默认上下文调整为「对话」。

### 2.2 本轮目标

- 提升快捷入口对非程序员、知识工作者和创作者的覆盖面；
- 降低从点击入口到真正开始工作的操作成本；
- 根据「对话／项目」上下文展示更准确的任务入口；
- 用简短自然的用户意图和渐进式澄清帮助用户表达需求，而不是增加复杂表单或暴露专家 Prompt；
- 让通用任务产生的文件有明确、可访问的本地落点；
- 让自动启动的工作保持可停止、可恢复，并在 Desktop／Mobile／远程场景中维持一致的任务语义；
- 用最小且不采集工作内容的指标验证覆盖面、启动成功率和任务继续率；
- 复用现有会话创建和首条消息发送链路，不新增不必要的协议或数据模型。

### 2.3 非目标

本轮不做：

- 新增独立的 Task 数据库实体；
- 把八类快捷入口实现为永久模式、固定问卷或八套硬编码垂直工作流；
- 在 Core 长期维护详细执行方法；需要稳定复用的完整工作方法进入 Skill；
- 自动切换 Agent、模型、供应商、推理强度或权限；
- 修改 maker-core system prompt；
- 新增 IPC channel、wire protocol 或数据库 migration；
- 要求 Mobile 机械复制 Desktop 的新任务页面；
- 根据项目技术栈自动生成无限种卡片；
- 为普通文本回答强制创建文件；
- 顺带增加任务目录自动清理或静默删除。

### 2.4 Core／Agent／Skill 边界

本功能可以进入 Cindy Core，因为「根据当前 workspace 帮助用户开始任务」是跨用户、跨行业的通用连接原语。但边界必须保持清晰：

| 层级 | 本功能中的职责 |
|---|---|
| Cindy Core | 识别 Dialogue／Project 上下文、展示意图入口、创建对话、连接工作目录、保持权限和生命周期 |
| Agent | 理解自然意图、利用已有上下文判断缺失信息、推理和执行 |
| Skill | 承载需要稳定步骤、固定模板、专业方法或组织规范的完整工作流程 |
| 插件 | 承载图表、画布、表单、Diff 等比长文本更适合的富交互结果 |

因此，Core 中的快捷消息只表达意图，不内置「必须依次读取哪些文件、必须问哪三道题、必须输出哪种固定报告」等流程。若后续数据证明某类方法值得稳定复用，应升级为可发现的 Skill，而不是继续加长卡片 Prompt。

## 3. 产品概念与存储模型

### 3.1 产品概念

| 概念 | 用户含义 | 实现映射 |
|---|---|---|
| 新任务 | 开始一项新的工作 | 全局创建入口，不新增持久实体 |
| 对话 | 需求澄清、执行过程和结果记录 | 现有 Session／Conversation |
| 独立任务空间 | 通用任务的文件型交付物和中间产物目录 | `workspaceKind: 'dialogue'` 的 managed working directory |
| 项目 | 用户明确选择的已有目录 | `workspaceKind: 'project'` + 显式 `workingDir` |

不应把所有保存后的对话都改称「任务」。产品术语保持：

- 入口叫「新任务」；
- 保存和展示的沟通记录仍叫「对话」；
- 自动化模块中的单条实例仍按术语规则称「自动任务」或「自动化任务」。

### 3.2 对话模式的本地目录事实

当前主进程已经会为没有显式 `workingDir` 的 Dialogue 分配目录。普通持久路径形态为：

```text
<Electron userData>/
  owners/
    <owner-hash>/
      dialogues/
        YYYY-MM-DD/
          <sessionId>/
```

其中：

- owner hash 是当前数据所有者 ID 的 SHA-256 派生命名空间；
- 日期桶使用本地日历日期；
- 目录在真正创建对话时产生，不在仅打开 `/cc-agent/new` 时产生；
- 目录是 Agent 的实际 cwd，可保存文档、表格、代码、图片和其他任务产物；
- 对话消息主要保存在 SQLite，媒体由 Cindy media storage 管理；任务目录不是唯一的对话存储；
- 没有可用 owner 时，现有 helper 会回退到进程级临时目录，正常可用的本地或云端模式使用 owner-scoped `userData`；
- Dialogue 目录不进入最近项目列表，也不应被当作用户项目注入项目上下文。

相关实现：

- [`apps/desktop/src/main/localDb/dialogueWorkspace.ts`](../apps/desktop/src/main/localDb/dialogueWorkspace.ts)
- [`apps/desktop/src/main/appSessionState.ts`](../apps/desktop/src/main/appSessionState.ts)
- [`apps/desktop/src/main/maker-ipc/sessionRequest.ts`](../apps/desktop/src/main/maker-ipc/sessionRequest.ts)
- [`apps/desktop/src/main/localDb/ipc/sessions.ts`](../apps/desktop/src/main/localDb/ipc/sessions.ts)

### 3.3 文件职责

| 内容 | 存储位置 |
|---|---|
| 用户需求、澄清过程、Agent 回复 | Cindy 本地数据库 |
| 模型、权限、标题和对话状态 | Cindy 本地数据库 |
| 附件和图片等媒体 | Cindy media storage 及消息引用 |
| Agent 生成的文档、表格、代码、图片和中间产物 | 当前工作目录 |

推荐用户心智：

> 对话保存「为什么做、讨论了什么、作出了什么决定」；工作目录保存「实际生成了哪些文件和交付物」。

### 3.4 P0 可见性与访问

既然独立任务空间承载真实交付物，它就不能只是内部实现。Dialogue 对话在 P0 必须提供：

- 可理解的「独立任务空间」标识；
- 「打开任务文件夹」操作；
- Agent 生成文件后的文件名、类型和可操作入口；
- 不默认暴露冗长绝对路径；
- 打开失败时说明发生了什么以及如何重试。

Project 模式继续使用项目名称和现有项目目录操作。产品不能一边承诺文件已保存，一边只向用户返回一个难以访问的内部路径。

### 3.5 多端和远程所有权

- Desktop 快捷入口创建的是普通 Cindy 对话，Mobile 不需要复制同一套卡片，但必须能通过现有同步继续沟通；
- Dialogue 工作目录由实际执行该任务的 Desktop 持有；
- 远程 Project 的文件位于远程主机的显式项目目录；
- Mobile 上展示文件结果时，优先使用现有附件、文件预览或远程文件能力；不能只显示 Mobile 无法打开的 Desktop／远程绝对路径；
- 执行设备离线时沿用现有离线和重连语义，不能让用户误以为任务已转移到手机执行；
- 本轮不新增跨端协议字段；若现有能力无法满足上述最小连续性，应在发布前明确降级表现并单独立项，而不是静默丢失文件入口。

按 `remote-and-mobile-adaptation.md` 的设计门禁，本方案结论为：

| 问题 | 结论 |
|---|---|
| SSH 远程工作区如何执行 | Project 快捷任务使用现有远程 `workingDir`、cc-manager 和 remote-file-service；任何文件访问不得用本机 `fs` 误读远端路径 |
| 是否新增 IPC／推送 | 本方案不新增；若「打开任务文件夹」复用的既有 channel 需要从 Mobile 调用，再按 allowlist 准入，不能默认放行 |
| Mobile 是否需要同页入口 | 不机械复制新任务页；本轮必须验证现有对话继续、停止／重试和文件结果展示，缺口同 PR 适配或按规则开跟踪 issue |

## 4. 页面信息架构

### 4.1 全局入口

将全局可见的「新建」统一改为「新任务」，覆盖：

- 展开侧栏；
- 收起侧栏；
- Tooltip；
- `aria-label`；
- 相关源码注释和测试。

四语建议：

| Locale | 文案 |
|---|---|
| zh-CN | 新任务 |
| en | New Task |
| ja | 新規タスク |
| ko | 새 작업 |

### 4.2 输入区

保留：

```text
Hi Cindy!
```

不翻译、不加句号、不替换成任务型 Placeholder。它承担品牌问候；任务分类和需求引导由快捷卡片及后续对话承担。

### 4.3 区块标题

本轮保留现有「快速开始」区块标题，避免同时引入不必要的信息层级变化。卡片内容根据工作上下文切换。

### 4.4 对话模式页面

```text
CINDY

Hi Cindy!

[ 输入消息……                                      ]

快速开始

[ 制作工具／应用 ] [ 写文档／分析数据 ] [ 设计／编辑图片 ] [ 搜索互联网 ]
```

### 4.5 项目模式页面

```text
CINDY                          [ 当前项目 ▼ ] [ 当前分支 ▼ ]

Hi Cindy!

[ 输入消息……                                      ]

快速开始

[ 了解项目 ] [ 构建新功能 ] [ 审查代码 ] [ 排查并修复问题 ]
```

## 5. 上下文切换规则

快捷卡片必须由创建对话时实际使用的 workspace 状态驱动，不根据顶部显示文字、目录名称或 Git 分支猜测。

| 当前上下文 | 卡片集合 |
|---|---|
| 未选择项目／Dialogue | 通用任务卡片 |
| 显式选择本地项目目录 | 项目任务卡片 |
| 显式选择远程项目目录 | 项目任务卡片 |
| 项目 A 切换到项目 B | 保持项目卡片，后续任务作用于项目 B |
| 项目切回 Dialogue | 恢复通用任务卡片 |
| 只切换 Git 分支 | 卡片集合不变 |

补充约束：

- 输入为空时，项目选择变化后卡片立即切换，不刷新页面、不重建 Composer；
- Dialogue／Project 两套卡片使用稳定的容器高度和网格位置，切换时不产生空白帧、整体垂直跳动或 Composer 位移；
- 如使用过渡，只允许基于 motion token 的短 opacity／color 变化；`prefers-reduced-motion` 下直接切换；
- 已有文字、附件、引用或浏览器评论时，保留全部草稿，卡片隐藏而不是以可点击状态留在页面；
- 项目目录不可访问或失效时，禁止启动并显示本地化错误，不得使用 stale working directory；
- 点击瞬间快照当前 workspace 和分支状态，创建过程中用户界面再变化也不能把任务发到另一个项目；
- 没有可用供应商时继续显示现有连接供应商引导，不展示无法执行的快捷入口；
- 自动启动后沿用对话页标准 Stop／Retry 能力，用户误点时可以立即停止，停止不删除对话或工作目录。

### 5.1 渐进式澄清原则

除 Project「了解项目」外，卡片点击后不展示固定问卷。Agent 应：

1. 先提出一个最关键、最能解除执行阻塞的问题；
2. 允许用户在一次回复中自由补充多项信息；
3. 利用已选项目、附件、引用和用户已说过的内容，不重复询问；
4. 只有缺失信息确实影响执行时才继续追问；
5. 累计不超过 3 个简短问题；
6. 信息足够时立即工作，不为了流程完整而机械问满 3 个。

验收不仅检查问题数量，还要检查问题是否必要、是否利用已有上下文，以及是否避免问卷式体验。

### 5.2 能力承诺与发布门槛

快捷卡片是用户可见的能力承诺。以下最低能力在发布前必须有明确结论：

| 卡片 | 最低可执行能力 |
|---|---|
| 制作工具／应用 | Agent 执行和当前工作目录文件读写 |
| 写文档／分析数据 | 附件读取、文件读写和基础数据处理 |
| 设计／编辑图片 | 可用的图片生成、编辑或明确满足标签承诺的处理能力 |
| 搜索互联网 | 可用互联网搜索能力，并能返回可核验来源 |
| Project 四类 | 对显式项目目录的对应读写权限；「了解项目」最低为只读 |

产品优先保证默认 Cindy 执行环境具备这些基础能力。若当前 Agent／环境无法满足某张能力型卡片：

- 不能创建对话后才告知用户「无法完成」；
- 不能静默切换 Agent、模型或供应商；
- 卡片保持原位但显示明确的不可用状态和原因，并提供已有的一步启用／连接入口；
- 如果没有可理解、可完成的启用路径，该卡片不得随本轮发布。

能力状态同样需要四语、键盘和屏幕阅读器语义。卡片可用性只基于稳定 capability 真值，不按 provider ID 或模型名称硬编码猜测。搜索供应商、图片工具和具体执行方法由现有 Agent／Tool／Skill／插件连接层承载，不进入 Core 卡片逻辑。若现有代码没有可复用的 capability 真值，先完成技术 discovery；在不新增本轮协议的约束下无法可靠判断时，对应卡片暂不发布。

## 6. 通用任务快捷入口

### 6.1 卡片定义

| 顺序 | 标签 | 图标 | 主要场景 |
|---|---|---|---|
| 1 | 制作工具／应用 | `Blocks` | 从零制作小工具、网页、应用和自动化脚本 |
| 2 | 写文档／分析数据 | `FileSpreadsheet` | 报告、方案、表格、数据整理和分析 |
| 3 | 设计／编辑图片 | `Image` | 海报、配图、界面草图、图片生成与编辑 |
| 4 | 搜索互联网 | `Globe2` | 查资料、做调研、比较信息和整理来源 |

通用入口不再显示「写代码／修 Bug」。已有项目中的开发需求由项目卡片承接；从零做工具或应用仍适合在 Dialogue 的独立任务空间开始。

### 6.2 制作工具／应用

用户可见 kickoff：

> Hi Cindy! 我想做一个工具或应用，先陪我把需求聊清楚吧。

Agent 首轮目标：先询问它要解决的核心问题。只有必要时再确认目标用户或使用场景、运行平台、第一版最重要的功能和交付形式。

验收约束：利用用户已经提供的附件和上下文；需求不足时不生成大量文件；信息足够后立即开始推进可使用的最小成果。

### 6.3 写文档／分析数据

用户可见 kickoff：

> Hi Cindy! 我想写份文档或者分析些数据，先问问我要交付什么、手上有哪些材料吧。

Agent 首轮目标：优先确认交付物。只有必要时再确认受众、已有材料或数据、输出格式和要回答的核心问题。

验收约束：能从附件和上下文得出的信息不再询问；普通文本回答足够时不强制创建文件；需要文件交付时保存到当前任务空间并提供可操作入口。

### 6.4 设计／编辑图片

用户可见 kickoff：

> Hi Cindy! 我想做点设计或者修修图，先问问我的使用场景、手头的素材和想要的效果吧。

Agent 首轮目标：先确认设计的使用场景。只有必要时再确认已有素材或参考、视觉方向、尺寸、比例和输出格式。

验收约束：卡片启用前已满足图片能力契约；不能以纯文字建议冒充已完成图片交付；生成或编辑后的文件保存到当前任务空间并可直接打开。

### 6.5 搜索互联网

用户可见 kickoff：

> Hi Cindy! 我想上网查点东西，先问问我要找什么、想要什么样的结果吧。

推荐首轮回复：

> 你想搜索什么？如果有时间范围、地区或语言，以及希望的结果形式，也可以一起告诉我。

Agent 首轮目标：先获得搜索主题；只有必要时再确认时间范围、地区或语言、结果形式和来源要求。

验收约束：

- 卡片启用前已满足互联网搜索能力契约；
- 区分来源事实与 Agent 判断；
- 引用主要来源并尽可能提供链接；
- 时效性内容标注日期或时间范围；
- 来源冲突时说明差异；
- 不能把模型记忆伪装成实时搜索；
- 普通搜索结果直接在对话中回答，不自动下载网页或堆积文件；
- 用户要求报告、表格或资料清单时，才把文件型交付物保存到独立任务空间。

## 7. 项目任务快捷入口

### 7.1 卡片定义

| 顺序 | 标签 | 图标 | 首轮行为 |
|---|---|---|---|
| 1 | 了解项目 | `SearchCode` | 直接开始只读了解项目 |
| 2 | 构建新功能 | `Code2` | 询问功能目标和验收标准 |
| 3 | 审查代码 | `MessageSquareCode` | 询问审查范围、重点和交付方式 |
| 4 | 排查并修复问题 | `Wrench` | 询问现象、复现方式和错误信息 |

这些图标沿用 Lucide 单色线性语言，不为不同任务增加任意强调色。

### 7.2 了解项目

这是唯一不先询问用户的入口。用户可见 kickoff：

> Hi Cindy! 先带我熟悉一下这个项目吧。

Agent 首轮目标：直接进行有限、只读的项目了解，优先读取项目说明和规则，识别项目用途、技术栈、主要模块、入口、启动／测试方式和关键限制。

首轮结果保持紧凑，建议结构为：

1. 项目是什么；
2. 核心技术栈；
3. 3–5 个主要模块；
4. 启动和测试方式；
5. 最值得注意的限制或风险；
6. 3 个可以继续推进的方向。

验收约束：默认不修改文件、不安装依赖、不启动应用、不跑全量测试，也不执行提交、推送或创建 PR；标准 Stop 在运行开始后立即可用。若未来需要稳定的深度项目地图流程，应沉淀为 Skill，不继续扩张 Core kickoff。

### 7.3 构建新功能

用户可见 kickoff：

> Hi Cindy! 我想给这个项目加个新功能，先陪我把需求和验收标准理清楚吧。

推荐首轮回复：

> 你想为这个项目增加什么功能？如果已经有目标用户、预期交互或验收标准，也可以一起告诉我。

Agent 首轮目标：优先确认具体功能目标；只有必要时再确认目标用户或使用场景、期望行为、验收标准和限制。

验收约束：需求不足时不修改项目；需求明确后读取项目规则、定位相关模块、给出简短实现思路、进行最小范围修改并运行风险匹配的验证。

### 7.4 审查代码

用户可见 kickoff：

> Hi Cindy! 我想审查一下这个项目的代码，先问问我要看的范围和重点吧。

推荐首轮回复：

> 你希望我审查哪些代码：当前未提交改动、某个分支、指定文件，还是某个模块？也可以告诉我需要重点关注正确性、安全、性能或用户体验中的哪些方面。

Agent 首轮目标：优先确认审查范围；只有必要时再确认关注点以及用户只需要建议还是也希望修复确认的问题。

验收约束：审查发现至少包含文件位置、缺陷描述、具体失败场景、影响和修复建议；不把纯风格偏好或没有实际失败场景的猜测当作缺陷。

### 7.5 排查并修复问题

用户可见 kickoff：

> Hi Cindy! 这个项目有个问题想排查修复，先问问我具体现象、怎么复现、有什么报错吧。

推荐首轮回复：

> 当前遇到了什么问题？请描述实际现象和预期结果；如果有错误信息、日志、截图或复现步骤，也可以直接发给我。

Agent 首轮目标：优先确认实际现象；只有必要时再确认预期行为、复现步骤、错误信息、日志或截图。

验收约束：需求明确后复现或静态定位、确认根因、进行最小范围修复、补回归测试、运行风险匹配的验证并如实汇报结果。

## 8. 点击和发送体验

### 8.1 一键启动链路

快捷入口应复用现有延迟创建链路：

```text
点击卡片
  → 认证门禁
  → createSession()
  → setPending(sessionId, localizedKickoff)
  → navigate('/cc-agent/<sessionId>')
  → CCAgentSessionView hydration
  → consumePending(sessionId)
  → sendMessage(...)
```

相关现有实现：

- [`apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx`](../apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx)
- [`apps/desktop/src/renderer/state/pendingFirstMessage.ts`](../apps/desktop/src/renderer/state/pendingFirstMessage.ts)
- [`apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx`](../apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx)

### 8.2 透明性

- kickoff 作为用户可见的第一条消息保存和展示；
- kickoff 使用自然第一人称表达意图，不显示「最多问 3 个问题」「不要重复询问」等产品内部行为规范；
- 不使用隐藏 system prompt，也不把详细工作流嵌进 Core；
- 不静默切换 Agent、模型、供应商、推理强度、权限、项目或分支；
- 不在卡片点击后先填 Composer 再要求二次发送；
- 自动开始后，用户在对话页立即看到运行状态和标准 Stop 操作。

### 8.3 草稿保护

以下任一内容存在时，快捷卡片不得覆盖草稿：

- 文本；
- 附件；
- 引用；
- 浏览器评论；
- Agent references；
- 其他已持久化 Composer 内容。

推荐：快捷卡片仅作为 empty-state affordance。草稿非空时隐藏卡片区域，而不是清除、替换或把 kickoff 拼接到用户文本中。

### 8.4 并发和错误

- 第一次点击后立即设置同步 busy guard；
- 连点、双击或键盘重复触发只能创建一个对话；
- 创建失败时恢复卡片可操作状态并保留原上下文；
- 创建成功但发送失败时沿用新对话内的错误与重试能力，不创建第二个对话；
- 认证取消不产生对话；
- 项目路径不可用时在创建前失败；
- 页面仅打开、未发送时不创建 Dialogue 空目录；
- 错误文案说明发生了什么以及下一步怎么做，不只显示「失败」；
- Stop 只停止当前运行，不删除对话、草稿、项目文件或 Dialogue 工作目录。

### 8.5 瞬时状态

- busy guard 必须同步生效，但本地创建很快时不额外制造闪烁的 loading 页面；
- 如果状态持续到用户可感知的时长，选中卡片使用本地化的进行时文案，例如「正在开始…」，其余卡片 disabled；
- 不在 SVG 图标上挂持续动画；如必须使用 spinner，动画放在 HTML wrapper，并响应 `prefers-reduced-motion`；
- 成功后直接进入对话，不显示「创建成功」一类多余 Toast。

## 9. 新任务默认上下文与草稿恢复

### 9.1 Fresh task

从展开或收起侧栏点击全局「新任务」时：

- 如果没有真实未发送草稿，workspace 重置为 Dialogue；
- 保留 Agent、模型、供应商、推理强度和权限偏好；
- 不继承上一次空草稿页选择的项目；
- 展示通用任务卡片。

### 9.2 Existing draft

如果 `NEW_MAKER_DRAFT_KEY` 已有真实内容：

- 数据安全优先，本轮恢复草稿文本、附件、引用和原 workspace；
- 不为了「默认 Dialogue」改变已有草稿的项目上下文；
- 页面应让用户能够理解自己正在继续未发送内容，而不是伪装成一个全新空任务；
- 草稿成功发送或用户显式清空后，下一次 fresh task 再从 Dialogue 开始。

「新任务」与「恢复草稿」存在轻微语义张力，但不能以静默丢弃内容解决。后续可评估明确的「继续未发送内容／丢弃内容并开始新任务」选择；在没有多草稿存储或显式确认前，不覆盖现有草稿。

需要同步调整的现有入口：

- [`apps/desktop/src/renderer/components/sidebar/SidebarTopNav.tsx`](../apps/desktop/src/renderer/components/sidebar/SidebarTopNav.tsx)
- [`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx`](../apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx)

## 10. 视觉与可访问性

### 10.1 图标

通用卡片：

- `Blocks`
- `FileSpreadsheet`
- `Image`
- `Globe2`

项目卡片：

- `SearchCode`
- `Code2`
- `MessageSquareCode`
- `Wrench`

统一建议：

```text
图标尺寸：20px
线宽：1.75px
默认色：create-agent-quick-card-icon
图标背景：create-agent-quick-card-icon-bg
```

### 10.2 卡片

- 复用现有 `create-agent-quick-card-*` 语义 Token；
- 不新增任意强调色、渐变或装饰插画；
- 保持统一图标容器、边框、圆角和留白；
- 宽窗口保持现有四列布局，较窄窗口按现有断点切换为两列或单列；
- Dialogue／Project 两套卡片保持相同尺寸和稳定网格，不因文案长度或顶部项目栏出现而推动 Composer／内容组跳动；
- 长文案允许合理换行，四语不得截断关键含义；
- Hover 使用现有 hover token；
- 按压使用标准 `active:scale-[0.98]`；
- Focus ring 键盘可见；
- busy／disabled 有文本、`aria-*` 和交互语义，不只依赖颜色；能力不可用卡片提供明确原因和启用路径；
- Light 和 Dark 一起实现，不使用模式专属硬编码补丁；
- 动效只使用现有 motion token，禁止 `transition-all`，并响应 `prefers-reduced-motion`；
- 继续满足 `DESIGN.md` §15.15 的 Create Page 固定垂直位置与零跳变契约。

现有 Token：[`apps/desktop/src/renderer/themes/colors.ts`](../apps/desktop/src/renderer/themes/colors.ts)。

## 11. i18n 方案

### 11.1 卡片标签

#### Dialogue

| zh-CN | en | ja | ko |
|---|---|---|---|
| 制作工具／应用 | Build a Tool / App | ツール／アプリを作る | 도구/앱 만들기 |
| 写文档／分析数据 | Write Docs / Analyze Data | 文書作成／データ分析 | 문서 작성/데이터 분석 |
| 设计／编辑图片 | Design / Edit Images | デザイン／画像編集 | 디자인/이미지 편집 |
| 搜索互联网 | Search the Web | ウェブを検索 | 웹 검색 |

#### Project

| zh-CN | en | ja | ko |
|---|---|---|---|
| 了解项目 | Explore Project | プロジェクトを理解する | 프로젝트 이해 |
| 构建新功能 | Build a New Feature | 新機能を構築する | 새 기능 구축 |
| 审查代码 | Review Code | コードをレビューする | 코드 검토 |
| 排查并修复问题 | Diagnose and Fix Issues | 問題を調査・修正する | 문제 진단 및 수정 |

日文和韩文在实现阶段必须由实际卡片宽度验证自然换行，不能为追求逐字对应牺牲本语言表达。

### 11.2 Key 结构

建议：

```text
newChat.createAgent.quickStarts.dialogue.appsAndTools.label
newChat.createAgent.quickStarts.dialogue.appsAndTools.kickoff
newChat.createAgent.quickStarts.dialogue.docsAndData.label
newChat.createAgent.quickStarts.dialogue.docsAndData.kickoff
newChat.createAgent.quickStarts.dialogue.designAndImages.label
newChat.createAgent.quickStarts.dialogue.designAndImages.kickoff
newChat.createAgent.quickStarts.dialogue.webSearch.label
newChat.createAgent.quickStarts.dialogue.webSearch.kickoff

newChat.createAgent.quickStarts.project.explore.label
newChat.createAgent.quickStarts.project.explore.kickoff
newChat.createAgent.quickStarts.project.build.label
newChat.createAgent.quickStarts.project.build.kickoff
newChat.createAgent.quickStarts.project.review.label
newChat.createAgent.quickStarts.project.review.kickoff
newChat.createAgent.quickStarts.project.fix.label
newChat.createAgent.quickStarts.project.fix.kickoff

newChat.createAgent.quickStarts.status.starting
newChat.createAgent.quickStarts.unavailable.webSearch
newChat.createAgent.quickStarts.unavailable.imageTools
newChat.createAgent.taskWorkspace.label
newChat.createAgent.taskWorkspace.openFolder
newChat.createAgent.taskWorkspace.openFailed
```

要求：

- 4 个 locale 同步新增、修改或删除；
- kickoff 使用当前 UI locale，不能只翻译卡片标签；
- 四语 kickoff 都保持自然第一人称意图，不把产品内部提问上限和验收规范翻译进用户消息；
- 不依赖英文 fallback 掩盖缺 key；
- 文案通过 `t()` 消费，不在组件中硬编码；
- 实现前重新核对 [`i18n/GLOSSARY.md`](../i18n/GLOSSARY.md)；若「新任务」或「独立任务空间」被确认为新的稳定产品术语，应先在 `i18n/glossary.json` 登记 `status: "proposed"` 再评审；
- 实现后运行 `pnpm check:i18n` 和 `pnpm check:i18n-glossary`。

## 12. 建议代码结构

### 12.1 配置模型

建议把展示信息、自然意图消息和最低能力要求放在声明式配置中：

```ts
type QuickStartCapability =
  | 'workspace-files'
  | 'image-tools'
  | 'web-search';

type QuickStartItem = {
  key: string;
  labelKey: string;
  kickoffKey: string;
  icon: LucideIcon;
  requiredCapability?: QuickStartCapability;
};
```

不增加可持续扩张的 workflow／behavior 枚举。八张卡片走同一条创建和发送链路；「了解项目」是否直接执行由自然 kickoff 表达。`requiredCapability` 只用于发布门槛和可用状态，不编码执行步骤，也不按 provider ID 猜测。

```ts
const dialogueQuickStarts: readonly QuickStartItem[] = [/* ... */];
const projectQuickStarts: readonly QuickStartItem[] = [/* ... */];
```

卡片集合必须从与 `createSession()` 相同的 workspace 真值派生，避免 UI 显示 project 卡片但创建出的 Session 实际是 Dialogue。

### 12.2 组件边界

建议提取纯展示组件：

```text
apps/desktop/src/renderer/features/cc-agent/NewMakerQuickStarts.tsx
```

职责：

- 接收当前 quick starts；
- 渲染统一卡片；
- 处理键盘、busy、disabled 和可访问状态；
- 不直接创建 Session；
- 不保存 Composer 草稿。

`NewMakerDraftRoute` 保持以下业务职责：

- 认证门禁；
- workspace／project 状态；
- 当前模型和权限选择；
- Session 创建；
- pending first message；
- 路由导航和错误恢复。

### 12.3 删除旧 QuickStart Pill

直接发送稳定后，确认无其他使用方再清理：

- [`apps/desktop/src/renderer/components/new-chat/QuickStartPillMark.ts`](../apps/desktop/src/renderer/components/new-chat/QuickStartPillMark.ts)
- `composerDraftStore.ts` 中的 `quickStartTextToTiptapDoc()`；
- `ChatInput.tsx` 中的 mark 注册；
- `pastePipeline.ts` 对 `data-quick-start-pill` 的内部 HTML 识别；
- `globals.css` 中 `.quick-start-pill` 样式；
- 对应旧测试。

删除必须在全仓确认无其他调用后进行，不为清理扩大无关重构。

## 13. Feature List

### P0-A：命名与全局入口

- 「新建」改为「新任务」；
- 展开／收起侧栏、Tooltip、`aria-label` 和测试同步；
- fresh task 默认 Dialogue；
- existing draft 恢复原 workspace。

### P0-B：上下文感知快捷入口

- Dialogue 和 Project 两套卡片；
- 选择、切换、清除本地或远程项目时实时切换；
- Git 分支变化不切卡片集合；
- 切换过程不重建 Composer、不丢草稿。

### P0-C：一键发起对话

- 点击直接创建对话；
- 自动发送本地化 kickoff；
- 不需要第二次发送；
- 不切换用户配置；
- 防重复创建和重复发送。

### P0-D：自然意图和渐进式澄清

- 用户可见 kickoff 只表达自然意图，不显示内部 Prompt 规范；
- 通用四类先问一个最关键的问题；
- Project「了解项目」直接进行有限只读了解；
- Project Build／Review／Fix 先询问对应需求；
- 只有确实阻止执行时才继续追问，累计不超过 3 个且不重复已有信息；
- 不增加隐藏 system prompt 或 Core 固定工作流。

### P0-E：工作目录语义和可访问性

- Dialogue 创建 managed task workspace；
- Project 使用显式项目目录；
- Dialogue 目录不污染最近项目；
- 对话模式显示「独立任务空间」并提供「打开任务文件夹」；
- 文件型交付物保存到当前工作目录，并给出文件名和可操作入口；
- 普通回答不强制创建文件。

### P0-F：视觉、多语言与可访问性

- 八张卡片统一 Lucide 风格；
- 四语 label、kickoff、能力状态和任务空间文案完整；
- Light／Dark 同时交付；
- Keyboard focus、Enter／Space、busy 和 disabled 完整；
- Dialogue／Project 切换无空白帧和垂直跳变。

### P0-G：错误、停止和草稿安全

- 不覆盖文字、附件、引用等草稿；
- 不可访问项目 fail closed；
- 认证取消不创建对话；
- 创建或发送失败有可恢复路径；
- 标准 Stop／Retry 在自动启动后可用；
- 停止不删除对话或文件；
- 页面仅打开不产生空 Dialogue 目录。

### P0-H：能力承诺

- 为八张卡片建立最低 capability 真值；
- 搜索和图片入口在可执行能力满足前不得显示为正常可用；
- 不静默切换 Agent、模型或供应商；
- 不可用状态提供明确原因和已有的一步启用路径；没有可用路径则该卡片不发布。

### P0-I：任务连续性

- Desktop 创建的对话在 Mobile 按现有机制继续；
- Dialogue、local Project 和 remote Project 的文件所有权清晰；
- 文件交付不只返回 Mobile 无法访问的绝对路径；
- 不新增不必要的协议字段，现有能力不足时明确降级并单独立项。

### P0-J：最小效果观测

- 在用户允许统计的前提下记录卡片曝光、点击、创建／发送结果和首轮继续状态；
- 不记录 Prompt、搜索词、项目名、路径、文件名、附件或生成内容；
- 建立旧方案基线，并用任务继续率而不是点击量作为核心效果指标。

### P1：后续生命周期和效率能力

- 设置页展示任务空间占用；
- 删除对话和删除任务文件成为两个可区分、显式确认的动作；
- 评估「继续未发送内容／开始新任务」的明确草稿选择；
- 评估把通用任务迁移到用户项目；
- 当某类稳定方法需要固定步骤或结构化结果时，作为 Skill／插件验证，而不是扩张 Core 卡片。

## 14. 成功指标与评估

### 14.1 核心问题

本次优化不能只证明「更多人点击了卡片」，而要证明快捷入口让更多任务真正进入下一轮工作。核心指标是：

> 快捷入口创建的对话中，有多少获得首个 Agent 回复后，用户继续补充需求或让任务进入实际执行。

### 14.2 最小事件

在用户允许产品统计的前提下，可以记录：

- 新任务页曝光；
- Dialogue／Project 上下文类型；
- 卡片类别；
- 点击；
- 对话创建成功／失败；
- 首条消息发送成功／失败；
- 首个 Agent 回复是否到达；
- 用户是否继续回复；
- 是否触发重复点击保护；
- 从点击到进入对话、从点击到首个回复的耗时。

禁止记录：

- 用户 Prompt 和搜索关键词；
- 项目名、项目路径、分支名和文件名；
- 附件或文件内容；
- Agent 输出正文；
- 能反推出用户工作内容的自由文本。

### 14.3 评估指标

上线前先记录旧 QuickStart 的可比基线，再观察：

1. 快捷入口点击率；
2. 点击后成功进入对话的比例；
3. 首个 Agent 回复后用户继续回复的比例；
4. 创建对话后没有后续动作的放弃率；
5. 非代码类入口占 Dialogue 快捷启动的比例；
6. Project／Dialogue 两套入口各自的使用分布；
7. 重复或空对话创建率；
8. 各能力型卡片的不可用率和启用完成率。

发布目标在取得现状基线后确定，不凭空承诺绝对增长数字。稳定性硬指标是：一次点击最多创建一个对话，创建／发送失败可恢复，且不能因观测写入用户工作内容。

## 15. 文件生命周期

Dialogue 工作目录可能保存用户真正需要的交付物，不能假定可随时清理。

推荐产品契约：

| 操作 | 任务空间处理 |
|---|---|
| 归档对话 | 保留 |
| 恢复对话 | 继续使用原目录 |
| 清空对话上下文 | 保留 |
| 删除对话 | 不静默删除任务文件 |
| 存储清理 | 展示占用并由用户显式确认 |

如果未来提供删除能力，应区分：

- 仅删除对话；
- 删除对话和任务文件。

本轮不增加自动清理逻辑。

## 16. 测试与验收

### 16.1 单元与源契约测试

更新或新增：

- quick-start 配置顺序、key、图标和 required capability；
- Dialogue／Project 状态映射；
- 项目 A→B、Project→Dialogue 和 branch-only 切换；
- 草稿 presence 下卡片隐藏；
- capability 可用／不可用状态、原因和启用入口；
- 点击一次只调用一次发送；
- workspace 在点击时快照；
- kickoff 由当前 locale 取得，且不包含内部「最多 3 个问题」等元指令；
- `Hi Cindy!` 保持不变；
- Dialogue／Project 卡片切换不改变固定内容位置；
- Stop／Retry 不创建第二个对话、不删除工作目录；
- 「打开任务文件夹」使用当前 Dialogue 目录并正确处理失败；
- 最小观测事件不包含 Prompt、搜索词、路径和文件内容；
- 旧 QuickStart Pill 清理后的 draft／paste 测试；
- 对话目录分配、safe session id 和项目路径不分配 managed Dialogue directory 的现有 main 测试继续通过。

重点现有测试：

- [`apps/desktop/src/renderer/__tests__/newMakerCreateAgentVisualContract.test.ts`](../apps/desktop/src/renderer/__tests__/newMakerCreateAgentVisualContract.test.ts)
- [`apps/desktop/src/renderer/lib/__tests__/composerDraftStore.test.ts`](../apps/desktop/src/renderer/lib/__tests__/composerDraftStore.test.ts)
- [`apps/desktop/src/main/maker-ipc/__tests__/sessionCreateHandler.test.ts`](../apps/desktop/src/main/maker-ipc/__tests__/sessionCreateHandler.test.ts)
- [`apps/desktop/src/main/maker-ipc/__tests__/sessionRequest.test.ts`](../apps/desktop/src/main/maker-ipc/__tests__/sessionRequest.test.ts)

### 16.2 手工交互矩阵

至少覆盖：

1. Dialogue 四张卡片；
2. 本地项目四张卡片；
3. 远程项目四张卡片；
4. 项目切换、返回 Dialogue 和 Git branch 切换；
5. 切换过程无空白帧、Composer 位移或内容组垂直跳动；
6. 有文字、附件和引用的草稿；
7. 快速双击和键盘重复触发；
8. 认证取消、创建失败、发送失败、Stop 和 Retry；
9. 无可用供应商；
10. 搜索／图片 capability 可用与不可用；
11. 失效项目路径和任务文件夹打开失败；
12. Light／Dark；
13. `zh-CN`／`en`／`ja`／`ko`；
14. 宽窗口四列和窄窗口换行；
15. Project「了解项目」直接执行、保持只读、输出紧凑且可停止；
16. 其他七类先问一个必要问题，而不是机械问满 3 个；
17. Dialogue 和 Project 实际 cwd 正确；
18. Dialogue 文件可从 Desktop 打开；
19. Mobile 可以继续对话，文件结果不只显示不可访问的绝对路径；
20. 观测开启和关闭时功能一致，且事件不含工作内容。

### 16.3 验证命令

实现阶段至少运行：

```bash
pnpm check:i18n
pnpm check:i18n-glossary
pnpm --filter desktop run typecheck
pnpm --filter desktop exec vitest run <相关测试文件>
```

提交前按仓库门禁运行：

```bash
pnpm test:unit
pnpm --filter desktop run --if-present typecheck
```

未实测的 macOS／Windows 或 Light／Dark 模式必须如实写明，不能把复用 themed 样式当作完成实机验证。

## 17. 分阶段实施计划

### Phase 1：产品契约、能力基线和 i18n

- 建立 Dialogue／Project 两套声明式配置；
- 确认八张卡片的最低 capability 和现有启用路径；
- capability 无法闭环的卡片不进入发布范围；
- 增加自然 label／kickoff、不可用状态和任务空间 keys；
- 更新四个 locale 和「新任务」文案；
- 如需要，登记 proposed glossary 条目。

### Phase 2：一键启动链路

- 快捷点击改为复用现有 `handleSend` 和 pending message；
- 增加同步 busy guard；
- 保留认证、供应商和错误处理；
- 不改变模型和权限选择；
- 自动启动后保证 Stop／Retry 可用。

### Phase 3：workspace 动态切换和草稿安全

- 使用 createSession 的同一 workspace 真值选择卡片集合；
- 调整展开和收起侧栏的 fresh task 默认行为；
- 保留 existing draft 并让恢复状态可理解；
- 覆盖本地、远程和 branch 状态；
- 保证项目栏出现／消失和卡片切换无垂直跳动。

### Phase 4：任务空间访问和连续性

- Dialogue 显示独立任务空间语义；
- 提供「打开任务文件夹」及失败恢复；
- 文件型交付物提供文件名和可操作入口；
- 验证 Desktop 创建的对话可在 Mobile 继续；
- 验证 local／remote 文件结果不会只留下不可访问路径。

### Phase 5：展示组件、观测和旧机制清理

- 提取 `NewMakerQuickStarts`；
- 落实 Light／Dark、focus、busy、disabled、capability state 和 responsive；
- 接入不记录工作内容的最小观测事件；
- 确认无调用后删除 QuickStart Pill 机制。

### Phase 6：验证和产品验收

- 定向测试；
- i18n／glossary 门禁；
- Desktop typecheck；
- 四语和双模式目检；
- Dialogue／Project cwd、任务文件夹和 Mobile 连续性手工验证；
- capability 发布门槛和隐私事件 review；
- 全量单测和最终 diff review。

建议保持为一个聚焦的 Desktop PR；若旧 QuickStart Pill 清理使 diff 明显扩大，可拆成：

1. 行为与新卡片 PR；
2. 旧机制删除 PR。

## 18. 完成定义

只有同时满足以下条件才算完成：

- 全局可见入口统一为「新任务」；
- fresh task 默认 Dialogue，existing draft 不被重置且恢复状态可理解；
- `Hi Cindy!` 保持不变；
- Dialogue 与 Project 各显示正确的四张卡片；
- 项目选择切换即时、稳定、无空白帧和垂直跳动且不丢草稿；
- 点击卡片无需二次发送；
- 一次操作只创建一个对话；
- kickoff 是简短自然的用户意图，不包含内部元指令；
- Project「了解项目」直接进行紧凑、可停止的只读了解；
- 其他入口先问最关键的问题，仅在必要时继续追问，累计不超过 3 个；
- 搜索、图片等能力型卡片满足最低 capability，不能在创建对话后才告知不可用；
- Project Session 使用选中项目目录，Dialogue Session 使用 owner-scoped managed directory；
- Dialogue 显示独立任务空间并可打开任务文件夹；
- 文件交付提供可操作入口，不只返回 Mobile 无法访问的绝对路径；
- Desktop 创建的对话可以按现有机制在 Mobile 继续；
- kickoff、能力状态和任务空间文案四语完整；
- Light／Dark、键盘和 responsive 成立；
- 标准 Stop／Retry 可用，停止不删除对话或文件；
- 最小观测不采集 Prompt、搜索词、项目路径或文件内容；
- 无隐藏 system prompt、无 Core 固定工作流、无新 IPC、无数据库 migration；
- 不静默删除任务文件；
- 相关测试、i18n 门禁、Desktop typecheck 和提交前全量单测通过。

## 19. 主要代码范围

Renderer：

- [`apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx`](../apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx)
- `apps/desktop/src/renderer/features/cc-agent/NewMakerQuickStarts.tsx`（建议新增）
- [`apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx`](../apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx)
- [`apps/desktop/src/renderer/components/sidebar/SidebarTopNav.tsx`](../apps/desktop/src/renderer/components/sidebar/SidebarTopNav.tsx)
- [`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx`](../apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx)
- [`apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`](../apps/desktop/src/renderer/components/new-chat/ChatInput.tsx)
- [`apps/desktop/src/renderer/lib/composerDraftStore.ts`](../apps/desktop/src/renderer/lib/composerDraftStore.ts)
- [`apps/desktop/src/renderer/hooks/useComposerDraftPresence.ts`](../apps/desktop/src/renderer/hooks/useComposerDraftPresence.ts)
- [`apps/desktop/src/renderer/state/pendingFirstMessage.ts`](../apps/desktop/src/renderer/state/pendingFirstMessage.ts)
- [`apps/desktop/src/renderer/themes/colors.ts`](../apps/desktop/src/renderer/themes/colors.ts)
- `apps/desktop/src/renderer/i18n/locales/{zh-CN,en,ja,ko}/common.json`

Main（现有能力与回归保护，预计无需业务改动）：

- [`apps/desktop/src/main/localDb/dialogueWorkspace.ts`](../apps/desktop/src/main/localDb/dialogueWorkspace.ts)
- [`apps/desktop/src/main/appSessionState.ts`](../apps/desktop/src/main/appSessionState.ts)
- [`apps/desktop/src/main/maker-ipc/sessionRequest.ts`](../apps/desktop/src/main/maker-ipc/sessionRequest.ts)
- [`apps/desktop/src/main/maker-ipc/sessionCreateHandler.ts`](../apps/desktop/src/main/maker-ipc/sessionCreateHandler.ts)
- [`apps/desktop/src/main/maker-ipc/register.ts`](../apps/desktop/src/main/maker-ipc/register.ts)
- [`apps/desktop/src/main/localDb/ipc/sessions.ts`](../apps/desktop/src/main/localDb/ipc/sessions.ts)

Mobile／device-link（预计以兼容性验证为主，不机械复制页面）：

- 现有对话同步和发送链路；
- 现有附件、文件预览和远程文件展示能力；
- 如验证发现现有协议无法表达最小连续性，先明确降级并按 `remote-and-mobile-adaptation.md` 单独评估，不在本方案中隐式扩协议。

适用权威规则：

- [`docs/product-rules/core-product-principles.md`](./product-rules/core-product-principles.md)
- [`docs/design-rules/DESIGN.md`](./design-rules/DESIGN.md)
- [`docs/dev-rules/engineering-conventions.md`](./dev-rules/engineering-conventions.md)
- [`docs/dev-rules/credentials-and-local-storage.md`](./dev-rules/credentials-and-local-storage.md)
- [`docs/dev-rules/remote-and-mobile-adaptation.md`](./dev-rules/remote-and-mobile-adaptation.md)
- [`docs/dev-rules/desktop-development.md`](./dev-rules/desktop-development.md)
