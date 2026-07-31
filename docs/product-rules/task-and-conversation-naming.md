# 任务、对话、消息：面向用户的命名

> **状态**：权威产品规则（authoritative）。已随本次改名落地，机器口径见
> `i18n/glossary.json` 的 `session` / `chat` / `task` / `message` / `turn` 条目。
> **适用范围**：所有面向用户的中文文案、帮助内容与对外表述
> **读取时机**：新增或修改涉及「任务 / 对话 / 消息」的 UI 文案之前

## 1. 为什么要改

改名前中文把 `session` 译作「对话」。这个词无法表达 Cindy 最重要的一个能力：**同时跑
多个互不干扰的工作**。「对话」听起来是一次问答，用户看不出左侧列表里的每一条其实
是一个有自己空间、可以并行推进的独立工作。

改称「任务」就是为了让这件事在命名上自明。

但这**不是**把所有「对话」替换成「任务」。用户在每个任务里做的事**确实是在跟 AI 对话**，
产品里也确实还有对话框。所以需要先把概念分层定清楚。

## 2. 概念模型

面向用户只有**三层**，各有明确所指，互不重叠：

```
任务 (Session)          左侧列表里的一个条目
│                       有自己的独立空间，可以同时跑多个
│
└── 对话 (Chat)         你在这个任务里跟 AI 交互的过程
    │                   「对话区」「对话正文」「对话记录」都指这个
    │
    └── 消息 (Message)  对话里的一条往来，用户看到的最小单元
```

**「轮次」不是第四层。** 一轮（`turn`）指一次提问到一次回答结束，而 AI 在这一轮里做的
所有事——思考、调用工具、多次输出——最终**折叠成一条消息**呈现。所以从用户视角，
消息和轮次是同一个粒度的两种切法，不存在包含关系。

现有产品行为就是按这个口径实现的：删除时「用户消息只删除本条；**AI 消息会删除上一次
用户输入之后产生的整轮输出**」——AI 侧的一条消息就等于一轮输出。

因此**面向用户一律说「消息」**。`turn` 是内部概念，只在确实要强调"一次完整往返"时才
译作「一轮」（如"上一轮"），不要引入「轮次」这个词作为界面术语。

另有一类与上面**完全无关**、不得混用：

- **弹窗 (Dialog)** —— 界面上的模态框。中文用「弹窗」或「对话框」，不受本文约束。

### 2.1 判定规则

拿不准某处该用哪个词时，按顺序问：

1. **它能被单独打开、删除、重命名、分享、导出吗？** → 能，就是**任务**
2. **它指的是"人和 AI 来回交流"这件事本身，或者"没有项目归属"这一类吗？** → 是，就是
   **对话**（后一种见 §2.3）
3. **它指某一条具体往来吗？** → 是，就是**消息**（不要说「轮次」）
4. **它是界面上弹出来的框吗？** → 是，用**弹窗**，与本文无关

### 2.2 典型对照

| 场景 | 改前 | 改后 |
|---|---|---|
| 侧栏新建入口 | 新建对话 | 新建任务 |
| 列表为空 | 暂无对话 | 暂无任务 |
| 导出整条记录 | 导出对话 | 导出任务 |
| 找不到那条记录 | 对话不存在 | 任务不存在 |
| 远程接管 | 接管这个对话 | 接管这个任务 |
| 删除一条往来 | 删除本条对话 | 删除本条消息 |
| 上一次问答 | 上轮对话 | 上一轮 |
| 聊天区正文 | 对话正文 | 对话正文（不变） |
| 模态框 | 关闭此对话框 | 关闭此对话框（不变） |

第 6、7 行是**既有译名错误**，与本次改名无关，本来就该修（见 §6）。

### 2.3 「对话」还兼任一个分类名：没有项目归属的那一类

任务可以绑一个项目（工作目录），也可以不绑。UI 上需要一个词称呼**不绑项目**的那一类，
这个词就是「对话」——纯聊天，不落到某个项目上。

**这不改变单条仍然叫「任务」。** 分类名说的是「这一桶装的是什么」，不是「其中每一条叫
什么」。所以「对话」这一桶里装着若干条任务，两句话同时成立。

代码里这个二分就是 `workspaceKind: 'dialogue' | 'project'`。凡是它驱动的文案都按这个
口径，英文用 `Chat`：

| 位置 | 分类名 |
|---|---|
| 侧栏「对话」分组标题、导航项、展开／收起、整理 | 对话 |
| 把某条任务移出项目 → 归到该分组 | 移到对话 |
| 任务顶部的归属 chip（`workspaceKind === 'dialogue'` 时） | 对话 `<编号>` |
| 新建时的项目选择器（chip + popover 标题 + 选项） | 对话 / 对话或选择项目 |
| 手机端新建的工作区二选一、位置预览 | 对话 / 对话工作区 |
| 远端新建 banner | 在 X 上新建对话（不绑定项目） |
| 设置 → 任务导入的「位置」筛选、条目归属标签与统计 | 已有项目 / 对话 |
| 定时任务列表按项目分组 | 对话（`DIALOGUE_GROUP_KEY` 那一组） |
| 自动化表单的工作区二选一 | 项目 / 对话 |

**但同一栏里指向条目的文案仍用「任务」**，这条界线要划清：

| 文案 | 用词 | 为什么 |
|---|---|---|
| 该分组的 + 按钮 | 新任务 | 动作产物是一条任务 |
| 该分组空态 | 暂无任务 | 说的是这栏里没有条目 |
| 该分组条目计数 | {{count}} 个任务 | 数的是条目 |

判定时问：**这个词指的是一批任务的归属类别，还是其中某一条？** 前者用「对话」。

落地时这一类被漏判了 21 处（最初全改成「任务」），最刺眼的是项目选择器上出现
「任务或选择项目」——把一个**归属分类**说成了单条条目，用户根本读不出它在选什么。
是实机目检截图时发现的，静态检查和测试都没拦住。

### 2.4 那个自动分配的目录叫「工作目录」，不要另起名字

不绑项目的任务也有工作目录：Cindy 在 `userData/dialogues/<日期>/<sessionId>/` 下自动开一个
空目录当 cwd，Agent 产出的文件落在那里。**对话消息存在数据库里，与这个目录无关。**

它对外一律叫**工作目录**（`Working directory`，现状 43 处唯一译法），**不要为它单独造词**
——「独立任务空间」「任务空间」「工作空间」这类说法一并禁用（2026-07-31 裁决）。同一个东西
攒出多套称呼，用户就不知道点开会看到什么。

**但任务顶部那个 chip 不写「工作目录」**，仍按 §2.3 写归属分类「对话」——权衡过一轮后维持
原样（2026-07-31）：chip 上还跟着 `sessionId` 前 8 位用来区分同时开着的多条任务
（`inter-session distinguishability`，见 `CCAgentSessionView.tsx` 注释），「对话 5dc71f0f」比
「工作目录 5dc71f0f」更能说明这条任务的归属，而「点开能看到文件」这件事由 chip 的点击行为
承担，不必写进标签。

本条约束的是**称呼那个目录本身**的场合（提示、说明、aria、设置项），不是 chip 标签。

门禁已就位：`glossary.json` 的 `working-directory` 条目把「任务空间」「工作空间」列入
`forbidden`。禁用是**子串匹配**，所以「独立任务空间」「专属任务空间」这类前缀变体都会被
「任务空间」一条拦下，不需要逐个枚举（已实测：注入 `独立任务空间` 后门禁报错并指回本条目）。「工作区」**不在**禁用列表——那是 `Workspace` 的合法译法（见 `worktree` 条目
note，那里早已裁定「工作区」只留给 Workspace、working directory 用「工作目录」；本条把该
裁决提为独立条目并加上门禁）。

## 3. 「任务」与 `task` 的冲突

这是落地时最大的坑。

「任务」原先已被 `task` 占用——指 **Agent 正在执行的那件活**。撞得最直接的一句：

```
"当前对话正在执行任务，请稍后再试。"
 ← "This session is currently running a task."
```

改名后会变成「当前任务正在执行任务」。

### 3.1 处理方式：同句出现时必须消解歧义

**同一句里同时出现 `session` 与 `task` 时，task 一侧必须改写。** 优先动词化，确需名词时
用「执行」或「作业」：

| 英文 | 不要 | 应该 |
|---|---|---|
| This session is currently running a task | 当前任务正在执行任务 | 当前任务正在运行 |
| Another Codex task is still running | 其他 Codex 任务正在运行（+本任务…） | Codex 正在其它任务中运行 |
| stop all background tasks (session can continue) | 停止全部后台任务（任务可继续） | 停止全部后台作业（任务可继续） |
| Pinned sessions with task-status summaries | 置顶任务…含任务现状摘要 | 置顶任务…含执行状态摘要 |

不同句、语境清晰时，`task` 沿用「任务」（现状 104 处）——落地时刻意没有全量改写，
因为「后台任务」「定时任务」这类有限定词的说法本身不歧义，强行统一反而生硬。

**`automation` 不带「任务」二字。** 原先中文叫「自动化任务」，与 session 撞在同一句里会
出现「删除任务和任务」这种读不通的文案。英文侧本来就以 `automation`（38 处）为主、
只有 4 处叫 `automation task`，所以中文统一为「自动化」：

- 「只删除自动化，任务继续留在左侧列表中。」
- 「删除自动化并归档任务」

例外：**定时任务**（`schedule`）保留「任务」二字，有「定时」前缀限定，不歧义。

## 4. 英文侧已一并收敛

中文的混乱有一半来自英文侧本身不统一——改名前同一个东西有**五种英文写法**，所以只改
中文治不了根：写文案的人看到 `Dialogue` 仍会译成「对话」。

| 英文 | 改名前 | 现在 |
|---|---|---|
| `Session` | 330 | **唯一正式写法**，指那个可打开可删除的条目 |
| `Conversation` | 124 | 已全部改为 `Session`（英文侧不再使用） |
| `Dialogue` | 16 | 已废弃（英文侧不再使用） |
| `Chat` | 62 | **基本保留**，只改了 12 处明确指条目的（`New chat` / `Chats` / `chat titles` / `chat link`） |
| `Thread` | 3 | 按 `glossary.json` 的 thread 条目分语境处理 |

新写英文文案时：**指条目用 `Session`，指交流过程用 `Chat`**，不要再引入
`Conversation` / `Dialogue`。

### 4.1 三个词都不能批量替换（踩过的坑）

`dialogue` 在本产品里只有一种用法。**`chat` 和 `conversation` 都不行。**

`chat` 同时承载至少五种互不相干的含义，机器分不开：

| 用法 | 例子 | 能不能改 |
|---|---|---|
| OpenAI 协议名 | `Chat Completions (Cindy bridge)` | **绝对不能**，是外部协议名 |
| 模型类型 | `chat model picker` / `chat model endpoint` | 不能，指对话类模型 |
| 外部平台概念 | `group chats` / `private chat` / 飞书 `recently-active chats` | 不能，那是微信 / Telegram / 飞书自己的概念 |
| 动词 | `you chat from here` / `people I chat with` | 不能，改了语法就坏 |
| 界面区域 | `chat input` / `chat width` / `the chat on the left` | 不能，指对话区 |
| 那个条目 | `New chat` / `Chats` / `search chat titles` | 可以 → `Session` |

落地时先用正则批量替换过一遍，结果把 `Chat Completions` 和 `you chat from here` 都改坏了，
是 review diff 时发现的。**改 `chat` 必须用白名单，不要用黑名单或 lookahead。**

`conversation` 起初被判定为"只有一种用法、可整体替换"，**这个判断是错的**。它至少还有
三种用法不能动：

| 用法 | 例子 | 后果 |
|---|---|---|
| IM 平台自己的会话 | `New Feishu conversations` / `Send /new in an existing conversation` | 改后与同组的 `in an existing DM` / `in an existing chat` 自相矛盾 |
| 通道等复合概念 | `one session per conversation lane` | 改成 `one session per session lane`，重复且丢义 |
| 隐私与合规文案 | `never conversations, files, or prompts` | 改成 `never sessions` 后承诺范围变了；这类措辞一律不在术语 PR 里动 |

判断 `conversation` 该不该改，看它**属于谁**：属于 Cindy 的条目 → `Session`；属于对方
平台，或指交流内容本身 → 不动。

### 4.2 中英必须成对判断

最有效的自检：**逐条比对中英去向**。中文侧逐条人工判过，可以当基准——凡「中文保持
了『对话』而英文改成了 `session`」的，都是英文侧判错了。落地时这条检查抓出 13 处
不一致，其中 2 处是隐私承诺文案。

反过来也要看：中文改成「任务」而英文还是 `conversation` 的，要么英文漏改，要么中文改
错了。

## 5. 不改的东西

- **代码标识符**：`session`、`sessionId`、`SessionView`、IPC channel 名、数据库字段、
  协议字段一律不动。术语表现有条目已写明「代码与内部标识仍用 Session」，本文延续。
- **弹窗**：见 §2。

日文与韩文**一并收敛了**，理由见 §5.1。

### 5.1 ja / ko 为什么也要改（原本以为不用）

最初的判断是「`セッション` / `세션` 是音译，不存在中文这种一词多义问题，不跟改」。这句话
**只对 task/session 撞车那部分成立**，管不到另一件事：同一个概念在 ja / ko 里本来就有两种写法。

改名前的实际分布（`origin/main` 基线，取英文含 `session` 的 key）：

| | 主流 | 少数派 |
|---|---|---|
| ja | `セッション` **271** | `会話` 16 / `チャット` 2 |
| ko | `세션` **277** | `대화` 11 / `채팅` 2 |

也就是说 ja / ko 本来就在混用，而且主流早已是音译，那 16 / 11 处是**违反术语表自身声明**的既有
债务。英文侧从 `Chat` / `Conversation` 收敛到 `Session` 之后，这类不一致放大到 **133 处**
（出现 `New Session` / `新しい会話` 这种四语打架的组合），所以 2026-07-31 一并收敛到音译。

**这不是新裁决，是向既有主流靠回去**：术语表 `session` 条目本来就声明 ja = `セッション`、
ko = `세션`。

三类刻意保留（逐条判断出来的，占候选的 5%）：

| 保留什么 | 例子 | 为什么 |
|---|---|---|
| 交流过程（动词性） | `このセッションで会話を続ければ` / `이 세션에서 계속 대화하면` | 对应 `keep chatting`，改了语法就坏 |
| `chat history` | `チャット履歴` / `채팅 기록` | 对应的是 chat 不是 session |
| 复合概念 | `会話 lane`（conversation lane）、`会話コンテキスト`（the context）、`会話インデックス`（transcript indexes） | 英文本身就不是 session |

**`タスク` / `작업`（task）不用像中文那样改写成「自动化」**——日韩音译天然区分
`セッション` / `タスク`，没有中文那种撞车。这恰好是最初判断里成立的那半。

## 6. 落地记录

一次性完成，四种语言同步收敛（`ja` / `ko` 的取舍见 §5.1）。

| 项 | 数量 |
|---|---|
| 含「对话」的中文文案条目 | 565（**逐条人工判断**：改 478 / 保持「对话」87） |
| 英文 `conversation`/`dialogue` → `Session` | 110 |
| 英文 `conversation`/`dialogue` → `Chat`（§2.3 归属分类 + 交流过程） | 26 |
| 英文 `conversation` 保留不动（IM 平台／复合概念／隐私文案） | 16 |
| 英文 `chat` → `Session`（白名单，仅指条目的） | 11 |
| 「自动化任务」→「自动化」 | 23 |
| `ja` 文案收敛到 `セッション` | 136 |
| `ko` 文案收敛到 `세션` | 130 |
| 术语表条目 | 7 个：新增 4（`task` / `message` / `turn` / `working-directory`）+ 改译 3（`session` / `chat` / `thread`） |

### 6.0 落地方法：脚本只用来定位，判断必须人工

**这一条是踩出来的，后来者别再犯。** 最初的做法是让脚本按正则规则自动判断并批量替换，
人工事后 review。结果：

- 把代码标识符改了（`buildDialogueWorkspaceDir` → `buildSessionWorkspaceDir`，靠 typecheck 才暴露）
- 把 OpenAI 协议名 `Chat Completions` 改了
- 把动词改坏了（`you chat from here` → `you session from here`）
- 把飞书的「群/单聊」改成了「任务」（`List recently-active chats`）
- 把 `Subsequent messages will be discarded` 改成「后续**任务**会被丢弃」，而且 5 条同类文案
  改得互相不一致

抽查命中率约 **9%**（前 142 条查出 13 处错），也就是说事后 review 一旦看漏，错的文案就直接
到用户眼前。

**正确流程**：脚本只负责**列出候选**（key + 英文原文 + 当前中文），逐条人工判断要不要转、
转成什么，只写入确认的那些。**默认不转。** 最终 565 条里有 87 条判定为保持「对话」——
这 87 条正是自动规则最容易改错的地方。

即便如此仍有漏判，而且**逐条看也没能全部拦住**：§2.3 那类归属分类名（21 处）是实机跑
起来目检截图才发现的。所以除了逐条判断，落地必须再叠三层：

1. **中英成对比对**（§4.2）——抓出 13 处
2. **同一区块的兄弟条目一起看**——IM 那 5 条 channelDescriptions 只有并排看才能发现
   「已有私聊发送 /new」证明主语是平台侧
3. **实机目检**——分类名这类错误在代码和测试里都是合法字符串，只有跑起来才看得出

顺带被这几层抓出两处**句子截断**（改写时丢了「使用该模型。仍要切换吗？」和「默认开启。」），
与术语无关，纯属编辑事故。检测手段是：把新旧值里的术语词都替换成占位符后比对，剩余
部分不同的就是夹带了非术语改动。

同时修掉了两批**既有译名错误**（与改名无关，本来就该修）：

- **42 处**英文是 `message`、中文却译成「对话」（`"Delete this message"` → 「删除本条对话」）
- **7 处**英文是 `turn`、中文也译成「对话」

**没有改的**：代码标识符、`SSH 远程会话` / `Agent 进程会话` / `登录绑定会话` /
`操作系统桌面会话`（那是另一类 session，与产品概念无关，见 §6.0.2）。

#### 6.0.1 只扫 locale 文件会漏掉一整类：代码里的硬编码文案

改术语时最容易漏的不是判断错，是**根本没扫到**。本仓有一批面向用户的中文写在代码里、
不走 i18n，只扫 `locales/**` 完全看不见它们。落地时漏了 **11 处**，全靠 review 才发现：

| 位置 | 漏掉的文案 | 后果 |
|---|---|---|
| `apps/mobile/src/session/messageActionMenu.ts` | 「在新对话中继续」「复制当前对话链接」「删除本条对话」 | 手机长按消息的操作表整套还是旧术语 |
| `apps/mobile/app/sessions/[sessionId].tsx` | Fork 确认框三句 | 同一流程里桌面说「任务」、手机说「对话」 |
| `apps/desktop/src/main/applicationMenuLabels.ts` | 影子 catalog 的 `newMaker`（四语） | macOS File 菜单与 renderer 入口直接冲突 |
| `apps/desktop/src/main/hook-control/interactions.ts` | 「本对话总是允许」 | 同一个权限请求，App 里说「任务」、Slack 卡片里说「对话」 |
| `apps/desktop/src/main/hook-control/dispatcher.ts` | 两条 IM 通知 | 换任务的说明还在说「原对话」 |
| `apps/desktop/src/main/im/{telegram,wechat}/*` | `/new` 反馈与命令帮助 | IM 侧术语与桌面端不一致 |
| `packages/maker-core/src/agents/codex/index.ts` | 记忆 feature 的 description | 设置页里的说明还是旧术语 |

#### 不变量与文案来源的全部对称路径

一句话不变量：**面向用户的中文里，指「那个能单独打开／删除／归档／重命名的东西」时一律说
「任务」。** 落地时它被违反了三轮，每轮都是因为**漏了一条来源路径**，不是判断错。所以把
来源枚举完整，改术语时逐条过：

| # | 来源 | 覆盖办法 |
|---|---|---|
| 1 | `apps/desktop/src/renderer/i18n/locales/**` | diff locale |
| 2 | `apps/mobile/src/i18n/locales/**` | diff locale |
| 3 | `apps/desktop/src/main/**` 硬编码 | 代码搜索（IM 通知、菜单影子 catalog、权限卡、IPC 错误） |
| 4 | `apps/mobile/{src,app}/**` 硬编码 | 代码搜索（操作表、Alert 确认框） |
| 5 | **`packages/maker-shared/**` 硬编码** | 代码搜索。**最容易漏**：mobile 首页与设备详情的空态／筛选／副标题全在这里，不在 locale |
| 6 | `packages/maker-core/**` 硬编码 | 代码搜索（agent capability 的 displayName / description） |
| 7 | `packages/lizi-mcps/**` | **不改**：MCP 元数据是给 LLM 读的，不是 UI |

**判据要同时搜两个词**：「对话」和「**会话**」。只搜「对话」会整片漏掉——共享层里那批空态
写的是「还没有会话」「活跃会话」「未命名会话」，一个「对话」都没有。（「会话」是 `session`
条目的 forbidden 译法，出现在产品语境就是问题；属于 §6.0.2 那几类另一种 session 时才保留。）

**搜索模式也要覆盖拼接与模板字符串**。第一次只搜 `xxx: '…会话…'` 形式，漏掉了
`` `${n} 个会话` ``、`` `持续会话 ${id}` `` 这类，靠测试断言里的实际值才发现：

```bash
# 宽口径：先不限模式看全量，再逐条判断
grep -rn '会话\|对话' packages/maker-shared/src/*.ts | grep -vE ':[0-9]+:\s*(\*|//)'
```

**所以候选清单必须包含代码搜索**，不能只 diff locale 文件：

```bash
# 面向用户的硬编码中文（排除注释与测试）
grep -rnE "(label|text|title|message|placeholder|subtitle|desc|Description):\s*'[^']*<词>" \
  --include='*.ts' --include='*.tsx' apps/ packages/ | grep -vE '__tests__|\.test\.'
```

同时留意**影子 catalog**：`applicationMenuLabels.ts` 这类为了不依赖 renderer i18n 而单独
维护四语文案的文件，天然会和 i18n 漂移，改术语时要专门找一遍。

#### 6.0.2 Agent 进程会话不跟改，但要看清楚是哪一类

`session` 在本仓有两层含义，UI 文案里都出现：产品条目（改「任务」）和 **Agent 进程 /
runtime 会话**（保持「会话」）。后者的判据不是词形而是**行为**——

落地时把 `settings.memory.agent.toast.takesEffectSuffix` 改成了「在新任务中生效」，但代码
写着 `setMemory 只更新 memoryOverride, 影响下次 buildQuery (新 session / rewind 重启)`：
**同一条任务里 rewind 也会生效**，说「新任务」会让用户白开一个任务、还割裂了上下文。同页
同机制的兄弟文案（`lspMode.toast.*`、`builtinTools.toast.*`）早就写着「Agent 会话」并登记
在 `session` 条目的 `exempt` 里——一致性证据就在隔壁，却没去看。

判据：**这句话会不会让用户去做一个多余的动作？** 会（「新建任务才生效」）→ 说 Agent 会话；
只是描述影响范围（「已在运行的任务不受影响」）→ 说任务没问题。

#### 6.0.3 `/new` 不产生新任务：按落库行为定名，不按命令名字

IM 渠道的 `/new` 看着像「新建」，实际走 `im/shared/sessionRepo.ts::resetSessionToDefaults` ——
`db.update(sessions).where(eq(sessions.id, …))`：**保留同一条 session 行**，只清 `sdkSessionId`、
按渠道默认重置工作目录与上下文。侧边栏里的条目数不变，也没有新条目可以单独打开。

所以凡是描述这条路径的中文，一律说**「新对话」**。说「新任务」会让用户去侧边栏找一条根本不
存在的新条目。这条不变量的全部对称路径：

| 触点 | 底层 | 说法 |
|---|---|---|
| IM 平台**首次**私聊 | `INSERT` 新 session 行 | 确实是新任务 |
| 已有私聊发 `/new` | `UPDATE` 原行 | **不是**新任务 |
| 消息操作菜单 fork | `INSERT` 新 session 行 | 确实是新任务（「开启一个新任务」） |
| `/ctr` → ➕ 新建 | `INSERT` 新 session 行 | 确实是新任务 |

前两条**共用同一份设置、同一句文案**，所以文案必须取两者都成立的说法 = 「新对话」。落地时
这一族被指出过三轮，每轮漏一处：`settings.imBot.defaults.*`（设置项标题）→
`settings.wechatBot.workingDir.*` 与 `toasts.workingDir*`（工作目录那组）→
`settings.telegramBot.commandMenu.new`（Telegram 斜杠菜单说明）。**判据一律回到落库行为。**

英文侧同理：`Start a new session` 也不准确，已一并改成 `Start a new chat`（ja「新しい会話を
開始」/ ko「새 대화 시작」）。en 的 `session` 词义比中文「任务」宽、读起来不刺眼，但既然中文
已按落库行为定名，四语就该说同一件事（§4.2）。

#### 6.0.4 兄弟渠道必须成组改：一处 IM 文案改动 = 四个包一起过

`apps/desktop/src/main/im/{telegram,discord,feishu,wechat}/uiText.ts` 是四份**近亲文案包**
（结构同形、大量句子逐字相同；刻意不共享，以免渠道措辞互相串味）。落地时只改了 telegram，
于是后面每轮 review 点出一个兄弟包——典型的逐条打补丁。

**规则：改任一渠道的 IM 文案，必须同一轮把四个包一起过。** 判据不是「reviewer 点了哪个」，
而是「这句话在别的包里有没有同形副本」。

配套要区分**不跟改**的「会话」。本轮枚举全仓硬编码字符串共 102 处含「会话」，按读者归类：

| 类别 | 例子 | 处理 |
|---|---|---|
| 渠道直接发给用户 | 四个 `uiText.ts` | **改**（已清零） |
| main 抛给 renderer 的 `Error` message | `maker-orchestration/fork.ts` 的 `forkError('SOURCE_NEVER_RAN', '原会话尚未运行…')` | **不改**：renderer 按 code 渲染 i18n（`chat.userMessage.forkErrors.sourceNeverRan`），这串只进日志。`rewind.ts` → `chat.rewind.errors.*` 同理 |
| 插件 / MCP / LLM 读的字符串 | `cindy-brain/*Slot.ts`、`mcp-integrations/ghost.ts` | **不改**：不是 UI 文案，且多数确实指 Agent 进程会话（§6.0.2） |
| Orca 协同术语 | `packages/maker-shared/src/sessionIdentity.ts` | **不改**：归 `orca-team-architecture.md` |
| 测试 fixture | `packages/maker-shared/src/fixtures.ts` | **不改** |

另有一类**刻意保留的渠道人格用词**：discord / feishu / wechat 把 session 叫「存档」、把接管
叫「上号」（`feishu/uiText.ts` 文件头写明了这个基调：「偶尔带点游戏味的隐喻（上号、存档、
副本、AFK 之类）」）。那不是错译而是渠道语气，本次只清 forbidden 词「会话」，不动「存档」。

**禁用词的判定要看条件，不要顺手断言原因。** `sessionActionStrip.ts` 的
`filesDisabledReason` 原文是「Dialogue 会话没有远程工作目录」，改名时顺势写成「不绑项目的
任务没有…」，但实际判据只是 `!!session.workingDir`：旧数据或异常行同样会缺 workingDir，被
这句话解释成「因为任务类型」。文案只陈述状态（「这个任务没有远程工作目录」），不断言原因。

#### 6.0.5 注释与测试常量里「陈述现有文案」的地方必须跟改

§8 声明内部注释与代码标识符刻意不动，但有一类例外，判据是**这句注释有没有断言「用户看到的
是 X」**：改名让 X 变了，这类注释就变成了错的，比不改更坏——后来人照注释去「修正」代码，
方向正好相反。落地时被 review 连点两轮（每轮列出不同实例），做检查点后一次扫清 41 处：

| 类型 | 例子 | 处理 |
|---|---|---|
| 注释断言兜底文案 | `sessionList.ts`「与 desktop 侧的『未命名对话』不一致」 | **改**：实际值已是「未命名任务」（`ccAgent.common.unnamedSession` / `sessionHeader.untitled` / mobile `devices.list.untitled` 实测） |
| 注释断言按钮文案 | `interactions.test.ts`「注：按钮文案用『对话』」，而按钮已是「本任务总是允许」 | **改** |
| 测试常量当兜底文案的替身 | `const UNNAMED = '未命名对话'` | **改**：值是注入的、改了不影响行为，但留着会变成下一个人「修正」代码的依据 |
| 泛指 session 的普通注释 | 「idle 会话直接显示」「worktree 会话按 base repo 归组」 | **不改**（§8） |

**退役渠道的 fixture 整体不动。** `im/shared/__tests__/threadUiFixture.ts` 保存的是 2026-07-17
退役的 SlackIM 文案包原件（文件头写明「不进产品包」），它的价值正是「忠实副本」。落地时误改了
其中 4 句，把「开一个新会话」和「同一个任务」并列进同一句；已整体回退到 `origin/main`。

### 6.1 门禁怎么表达「同一个词分场合」

**不能简单把「对话」加进 `Session` 的 `forbidden`**——那会把「对话区」「对话正文」这些
合法用法一并拦下。用 `alsoAllowed` + `when` 按语境豁免（写法参照 `glossary.json` 里
`thread` 条目，它按语境分了四类）：

```jsonc
{
  "id": "session",
  "translations": { "zh-CN": "任务" },
  "alsoAllowed": {
    "zh-CN": [
      { "text": "对话", "when": "指任务内人与 AI 交流的过程或其内容（对话区、对话正文、对话记录、继续对话）" }
    ]
  },
  "forbidden": { "zh-CN": ["会话"] }
}
```

`Message` 的 forbidden 同样收窄到**精确的错译形式**「条对话」，而不是笼统禁「对话」——
一句话里可能既有 `message` 又有合法的「对话X」，机器分不清哪个词对应哪个，笼统禁会误报。

门禁设计不到位会天天误报，最终没人看——这一层的成本最容易被低估。

## 7. 已知代价

**两个月内第二次大规模改名。** `glossary.json` 里 `Session` 条目原先的备注记录着上一次
裁决：「落地时把 **440 处「会话」+ 22 处「聊天」统一改为「对话」**」（2026-07）。

再改一次，影响的不只是代码——已发布的截图、教程、帮助内容，以及用户已经形成的认知都要
跟着变。这是本次改名唯一需要产品明确承担的成本，已确认接受。

## 8. 遗留

- **侧栏全局「新建」入口不在本次范围**：`ccAgent.layout.new` 仍是「新建」/`New`。改成
  「新任务」/`New Task` 由 PR #951 承担（它同时重构该入口的快捷卡片与一键启动），本文只
  确认命名方向一致，不抢那个 key。若 #951 迟迟不合，这个按钮会和周围已改的「新任务」措辞
  不齐，届时再单独补
- **`task` 未全量改写**：不同句、语境清晰时仍用「任务」（104 处）。只在与 session 同句时
  强制消解，见 §3.1。后续若发现新的歧义句，按同一原则改写即可
- **IM 渠道的「存档 / 上号」人格用词未统一**：discord / feishu / wechat 仍把 session 叫
  「存档」（见 §6.0.4）。本次只清了 forbidden 词「会话」，因此这三个渠道会同时出现「任务」
  与「存档」。要不要把「存档」也收敛成「任务」是语气取舍而非错译，留给产品单独裁决
- **共享层与 mobile 的部分中文仍是硬编码**：`packages/maker-shared/src/sessionList.ts` 的
  `remoteSessionListTitle` / `deviceSessionEmptyState`、`apps/mobile/src/session/messageActionMenu.ts`
  都在业务代码里返回中文串，mobile 直接渲染，因此非 zh-CN locale 下会露出中文。这是
  `origin/main` 既有状态（`messageActionMenu.ts` 的注释写明「那边走 i18n，这里暂为硬编码」），
  正是 §6.0.1 那份来源清单第 5 条要专门代码搜索的原因。**把这一层下沉到 i18n（或改成返回结构化
  数据交 UI 层翻译）是独立重构**，不在本次改名范围；本 PR 只保证这些中文串与桌面端同款 key
  用词一致
- **代码标识符与内部注释仍以 Session 为主**：刻意不动。仅当中文注释被测试当作源码锚点、
  且新旧术语冲突时才跟进（本次有 1 处：`apps/mobile/app/sessions/new.tsx` 的
  「新建任务默认运行配置」）
