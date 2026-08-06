<!-- 本文件由 scripts/generate-glossary-doc.mjs 自动生成，请勿手改。 -->
<!-- 修改术语请编辑 i18n/glossary.json，然后运行 pnpm i18n:glossary-doc。 -->

# Cindy 术语表

产品术语的唯一事实源。**新增或修改任何 UI 文案前先查这里**——同一个概念在不同界面译法不一致，是用户能直接看见的质量问题。

> **这是一份参考，不是替换表。**
>
> 表里的「译法」是默认情况下的选择，不是「见到 A 就换成 B」的映射。同一个中文词往往
> 对应多个英文概念——「额度」同时是 Balance / Quota / Credits 的正确译法，「代理」同时是
> Agent / Subagent / Proxy 的译法——具体这一条文案该怎么译，取决于它的英文源和这个 key
> 的实际用途。
>
> 所以：**禁止拿本表做脚本批量替换**。门禁只报告「这里用了禁用译法」并给出英文源，
> 不给替换目标；改哪一条、改成什么，逐条读语境决定。

- 数据正本：`i18n/glossary.json`（本文件由它生成）
- 自动门禁：`pnpm check:i18n-glossary`（随 CI 阻断）
- 存量豁免：`i18n/glossary-baseline.json`（只减不增）

## 已裁决术语

这些术语的译法已定，**违反会阻断 CI**。

| 英文 | zh-CN | ja | ko | 禁用译法 |
| --- | --- | --- | --- | --- |
| **Active** | 活跃 | アクティブ | 활성 | zh-CN: 活动（仅当英文含 Active） |
| **Agent** | `Agent`（保留英文） | `Agent`（保留英文） | `Agent`（保留英文） | zh-CN: 智能体；zh-CN: 代理（仅当英文含 Agent） |
| **Agent session** | Agent 会话 | Agent セッション | Agent 세션 | zh-CN: 任务（仅当英文含 agent session） |
| **Author** | 作者 | 作成者 | 작성자 | zh-CN: 提交者（仅当英文含 Author）；zh-CN: 提出者（仅当英文含 Author） |
| **Automation** | 自动化 | 自動化 | 자동화 | ja: オートメーション；ko: 오토메이션 |
| **Balance** | 余额 | 残高 | 잔액 | zh-CN: 额度（仅当英文含 Balance） |
| **Chat** | 对话 | チャット | 채팅 | zh-CN: 聊天 |
| **Collaboration** | 协同 | 協同 | 협업 | zh-CN: 协作（仅当英文含 Collaboration） |
| **Collapse** | 收起 | 折りたたむ | 접기 | zh-CN: 折叠（仅当英文含 Collapse） |
| **Credits** | 点数 | クレジット | 크레딧 | zh-CN: 额度（仅当英文含 Credit） |
| **Directory** | 目录 | ディレクトリ | 디렉터리 | — |
| **Dismiss** | 关闭 | 閉じる | 닫기 | zh-CN: 忽略（仅当英文含 Dismiss）；zh-CN: 知道了（仅当英文含 Dismiss） |
| **Effort** | 推理强度 | 推論強度 | 추론 강도 | zh-CN: 思考强度；zh-CN: 思考深度；zh-CN: 推理深度；zh-CN: 努力程度；zh-CN: 推理力度；ja: 推論レベル；ja: 推論の強度 |
| **Issue** | `Issue`（保留英文） | `Issue`（保留英文） | 이슈 | zh-CN: 工单；zh-CN: 议题；ja: 課題（仅当英文含 Issue） |
| **Message** | 消息 | メッセージ | 메시지 | zh-CN: 条对话（仅当英文含 Message） |
| **Plugin** | 插件 | プラグイン | 플러그인 | zh-CN: Plugin；zh-CN: plugin |
| **Project** | 项目 | プロジェクト | 프로젝트 | zh-CN: Project |
| **Provider** | 供应商 | プロバイダー | 제공자 | zh-CN: 提供方；zh-CN: 提供商；ja: 提供元（仅当英文含 Provider）；ja: 事業者（仅当英文含 Provider）；ko: 공급자；ko: 제공업체 |
| **Proxy** | `Proxy`（保留英文） | プロキシ | 프록시 | zh-CN: 代理（仅当英文含 Proxy） |
| **Quota** | 配额 | クォータ | 할당량 | ja: 残量；zh-CN: 额度（仅当英文含 Quota） |
| **Running** | 运行中 | 実行中 | 실행 중 | zh-CN: 执行中（仅当英文含 Running）；zh-CN: 进行中（仅当英文含 Running） |
| **Session** | 任务 | セッション | 세션 | zh-CN: 会话 |
| **Skill** | 技能 | スキル | 스킬 | ja: 技能；ko: 기술 |
| **SkillHub** | `SkillHub`（保留英文） | `SkillHub`（保留英文） | `SkillHub`（保留英文） | ja: スキルハブ；ko: 스킬 허브 |
| **Subagent** | `Subagent`（保留英文） | サブエージェント | 하위 에이전트 | zh-CN: 代理（仅当英文含 Subagent） |
| **Task** | 任务 | タスク | 작업 | — |
| **Thread** | 任务 | スレッド | 스레드 | zh-CN: 线程 |
| **Turn** | 轮 | ターン | 턴 | — |
| **Usage** | 用量 | 使用量 | 사용량 | zh-CN: 使用情况；zh-CN: 使用表现；ja: 使用状況；ja: 利用状況；ko: 사용 현황 |
| **Worker** | `Worker`（保留英文） | `Worker`（保留英文） | `Worker`（保留英文） | — |
| **Working directory** | 工作目录 | 作業ディレクトリ | 작업 디렉터리 | zh-CN: 任务空间；zh-CN: 工作空间 |
| **Worktree** | worktree | worktree | worktree | zh-CN: 工作树（仅当英文含 Worktree）；zh-CN: 工作区（仅当英文含 Worktree） |

### 分场合译法

同一个词在不同语境下有不同说法。下面这些是**允许的**，按场合选，不会被门禁拦截。

| 英文 | 语言 | 译法 | 什么场合 |
| --- | --- | --- | --- |
| **Active** | zh-CN | 活跃 | 默认 |
| Active | zh-CN | 生效中 | 计费语境（"no active subscription"→没有生效中的订阅），指订阅状态而非活跃度 |
| **Automation** | zh-CN | 自动化 | 默认 |
| Automation | zh-CN | 自动操作 | Computer Use 语境——「自动操作电脑 / 浏览器」，指代操控设备而非定时任务 |
| **Credits** | zh-CN | 点数 | 默认 |
| Credits | zh-CN | credits | 指第三方服务自身的 credits（如 Codex / ChatGPT 订阅余量），保留其原生叫法 |
| Credits | zh-CN | 重置次数 | reset credits——指可用的配额重置次数，与计费点数无关 |
| **Provider** | zh-CN | 供应商 | 默认 |
| Provider | zh-CN | 模型供应商 | 首次出现或需要消歧时用全称，如设置页标题 |
| **Running** | zh-CN | 运行中 | 默认 |
| Running | zh-CN | 正在运行 | 完整句子里作谓语时（"Agent 正在运行"），不是状态标签 |
| **Session** | zh-CN | 任务 | 默认 |
| Session | zh-CN | 对话 | 指任务内人与 AI 交流的过程或其内容（对话区、对话正文、对话记录、继续对话） |
| **Skill** | zh-CN | 技能 | 默认 |
| Skill | zh-CN | Skill | 技术语境下指代具体的 skill 文件 / 目录结构时，可保留英文 |
| **Thread** | zh-CN | 任务 | 默认 |
| Thread | zh-CN | thread | 指 Codex 的 thread 这一外部系统概念时（导入历史、thread 上下文），保留英文 |
| Thread | zh-CN | 评论 | 指 GitHub PR 的 review thread 时，用「review 评论」 |

### 裁决理由

- **Active** — 对话 / 设备状态用「活跃」（现状 21:7）。mobile/devices 同一屏上筛选 chip 写「活跃」、指标磁贴写「活动」。条件禁用：「活动」是 Activity 的正确译法，无条件禁会误伤「活动记录」这类。豁免 Windows Computer Use 提示：那里的 active desktop 指「当前接收输入、显示目标应用的 Windows 桌面」，是 OS 概念，中文既定说法为「当前活动桌面」，与产品的活跃度无关。
  - 豁免范围：`desktop:settings.computerUse.directControl.permissions.windowsHint`
- **Agent** — 产品一级概念，四语统一保留英文原词。zh-CN 现状 44:5 已是主流；ja / ko 实测拉丁 Agent 同样是主流（59:38 / 58:39），故三语一致（2026-07 修正：此前误按抽样声明为片假名 エージェント / 한글 에이전트，那是少数派）。「代理」一词在中文 UI 里整体废弃——Agent 与 Proxy 都保留英文，不共用这个译名；「代理」按英文源分别登记在 agent / subagent / proxy 三条下（条件禁用），不再统一挂 proxy——统一登记会让自动替换无法确定目标：2026-07 一次批量重放就把 "Agent"→「代理」的 4 处和 "Subagent models" 的 4 处一并换成了 Proxy，产出「子 Proxy 模型」这种错译。引入术语表时全仓仅 9 处「代理」，已全部清理为 Agent / Subagent / Proxy。豁免 settings.remote 整段：那里的 agent 指 ssh-agent（英文原文即 "SSH agent" / "probe agent"），是与产品 Agent 同形的另一个概念。
  - 豁免范围：`desktop:settings.remote.`
- **Agent session** — Agent / 引擎的**运行时**会话（SDK Query 的生命周期），不是 session 条目说的那个产品条目。中文必须叫「Agent 会话」而不是「任务」——两者的区别是用户会不会因此做一个多余的动作：记忆、MCP、内置工具、LSP、权限开关这类设置都在「下一个 Agent 会话」生效，而同一条任务里 /clear、rewind、重启都会开新的 Agent 会话，说「新建任务才生效」会让用户白开一条任务、还割裂上下文。forbidden 规则只覆盖英文源字面写了 agent session 的 key（精确、无误报）；英文只写 session 的那批（`The Codex session state` / `Session is inactive` / `in-flight sessions`）**机器判不出来**——英语本身不区分这两个意思，同一句里两个所指并存也是合法的（`The historical agent session ... so a new session can't be started`：前半指运行时、后半指条目，已登记 exempt）。所以这批只能靠人读英文源判断，判据与全部踩坑记录见 docs/product-rules/task-and-conversation-naming.md §6.0.2。session 条目的 exempt 里另有三类同样叫 session 的东西：登录/绑定校验会话、SSH 远程与传输会话、操作系统桌面会话，以及 mobile 的语音连接会话——它们各自稳定、极少改动，故未单独立条目。
  - 豁免范围：`desktop:chat.userMessage.forkErrors.unsupportedHistory`
- **Author** — 中文用「作者」（现状 9:4）。典型的同模块自相矛盾：issueTracker 同一个页面里，assignee.labelAuthor 写「提交者」、list.filterAuthor 写「提出者」、visibility.onlyAuthorCanChange 写「作者」——同一个字段三种叫法。条件禁用避免误伤 Committer / Reporter 等其它英文词的正确译法。
- **Automation** — scheduler 的模块名、单条实例与能力名统一用「自动化」；不再把「自动任务」「自动化任务」登记为用户可见译法，避免与产品条目 Session（同样叫「任务」）在『删除自动化和任务』等文案里相撞。Computer Use 是另一个概念，用「自动操作电脑 / 浏览器」，改成「自动化电脑」反而不通。因此 zh-CN 只保留「自动操作」这一语境豁免。术语门禁只扫描 locale，不扫描源码注释；历史注释与测试 fixture 的旧称按 docs/product-rules/task-and-conversation-naming.md §6.0.5 逐条判断，不借术语改名机械扩大代码改动。（2026-07 修正：ja 原声明 オートメーション 仅 37/121，主流是 自動化；ko 的 자동화 75/121 本就正确。）豁免通讯录授权提示的两个 key:那里指的是 macOS 系统设置里的面板名,日文官方标签是「オートメーション」而非产品术语「自動化」——照产品术语改会让用户按提示在系统设置里找不到对应项,授权恢复路径直接断掉。zh-CN 的「自动化」与 ko 的「자동화」恰好就是各自的 macOS 官方标签,不受影响。
  - 豁免范围：`desktop:settings.contacts.import.permissionDenied`、`desktop:settings.contacts.ipcError.PERMISSION_DENIED`
- **Balance** — 账户余额用「余额」。原先被并入「额度」（可用额度 / 额度更新于 / 剩余额度），与 Credits、Quota 混同。Balance 是「账上还剩多少」，Credits 是「可购买消耗的计数单位」，Quota 是「周期内上限」——三者是不同层面的量，中文必须分开。
- **Chat** — Chat 专指任务内人与 AI 交流的过程与内容（对话区 / 对话正文 / 对话记录 / 继续对话），中文「对话」。指那个可打开可删除的条目时用 Session（中文「任务」）——此前 Chat 与 Session 混用同一个中文词的问题已随 2026-07-31 的改名解决：英文侧指容器的 Chat 已改为 Session。「聊天」一律禁用。ja / ko 保留各自既有译法。
- **Collaboration** — Orca 多 Agent 功能名，中文用「协同」（现状 21:2）。可见 bug：设置导航项写「协作」，点进去页面标题写「协同」。条件禁用：settings.contacts 里的「协作经历」是 collaboration history，属另一个语义，英文源不含独立 Collaboration 一词时不判违规。
  - 豁免范围：`desktop:settings.contacts.`
- **Collapse** — 中文用「收起」（现状 29:7），与反义词「展开」（Expand，29/30 已统一）配对。ccAgent 与 rightSidebar 内部各自「收起 / 折叠」混用，是同模块自相矛盾。条件禁用：「折叠」在别处可能是正常中文，只在英文源含 Collapse 时判违规。
- **Credits** — 计费点数用「点数」。清理前中文「额度」同时对应 Balance / Credits / Quota 三个英文概念，是计费面板里最容易误导用户的一处：同一个 billing 页面里「点数」和「额度」并存，而「额度」在别处又指配额。裁决把三者拆开——Credits =「点数」、Quota =「配额」、Balance =「余额」，「额度」整体退出。「额度」的禁用按英文源拆成三条条件禁用,分别挂在 credits / quota / balance 下。不能无条件禁:同一个「额度」在不同 key 里分别对应 Credits / Quota / Balance,目标译法不唯一,无条件禁只会让自动替换随机挑一个——xAI 的 subscription quota 就是这样被改成「订阅点数」的。第三方原生 credits 与 reset credits 属不同概念，走 alsoAllowed。whenEn 写单数 Credit:匹配本来就带可选复数 s,单数能同时覆盖 Credit / Credits,写成复数反而漏掉全部单数用法(Promotional Credit Details、credit snapshot 等 8 个 key 原先完全不受约束)。(2026-07-30 更新:Desktop billing 界面弃用「点数」概念(PR #1053),计费文案与金额直接挂钩——新增计费文案一律用金额/余额(Balance=余额)措辞,en 源不再引入 Credit/Credits 用词,因此本条的 Credits→点数 映射不再适用于计费界面;裁决继续约束的只剩 alsoAllowed 覆盖的第三方原生 credits(Codex / ChatGPT 订阅余量)与 reset credits 语境。后续给计费界面添加文案时不要恢复「点数」。)
- **Directory** — Directory 用「目录」（现状 96:4），Folder 用「文件夹」（37:20），两个英文词在中文里也分开。**本条刻意不设 forbidden**：英文侧自己就在一句话里混用二者（"not a folder. Choose a project directory."、"re-select the working directory and wait for the folder badge"），而条件禁用是句子级匹配，区分不了句内哪个中文词对应哪个英文词——实测 4 处命中全是假阳性，那 4 条中文其实译得完全正确。要真正管住这对词，得先清理英文侧的 path / folder / directory 混用。此条目保留为文档指引，供人查阅。
- **Dismiss** — 中文用「关闭」（现状 6:4）。同一个 chat 模块里，errorBanner 写「关闭错误提示」、interruptedBanner 写「忽略此中断提示」。条件禁用：「忽略」是 Ignore 的正确译法、「知道了」是 Got it 的正确译法，只在英文源为 Dismiss 时才算违规。
- **Effort** — 模型的推理投入档位（low/medium/high/…）。用「推理强度」有三重依据：①同类工具 i18n 里断层第一（GitHub 代码搜索共现量级 1452，第二名「思考强度」431）；②OpenAI 简中帮助中心即用此词；③跨 provider 中立——Cindy 的 create_worker 用一个 effort 同时映射 Codex reasoning effort 与 Claude thinking 预算，而 Anthropic 官方简中叫「努力程度」、OpenAI 叫「推理强度」，需要不偏向任一方的词。禁用项各有硬理由：「思考深度」「推理深度」会与国内产品普遍的「深度思考」开关撞车，且语义错误（低 effort 是想得少，不是想得浅）；「努力程度」在中文里强烈指向人的绩效评价；「推理等级/级别」未入禁用但不推荐——Cindy 已有 model tier 概念，「等级」易被读成模型档位。
- **Issue** — 保留英文（2026-07 裁决）。现状「工单」32 /「议题」4 是既有 bug 的来源：列表按钮写「新建议题」、点进去页面标题写「新建工单」。「问题」不入 forbidden——它在「修复问题和失败」这类泛指语境下是正常中文，不是 Issue 的误译。checkCase 关闭：issue 同时是常用英语单词，prompt 模板里的 "fix the issue" 是正常用法，做大小写约束会制造 9 处假阳性。（2026-07 修正：ko 原声明 Issue 仅 3 处，实测 이슈 45 处才是主流，改随本语言主流；ja 的 Issue 43:2 保持不变。）ja 的「課題」同样是多义词（问题 / 课题），按 whenEn=Issue 条件禁用——插件创建 prompt 里的 "define the problem" 用「課題」是正确的。豁免两个 Jira capability:那里指的是 Jira 自己的记录类型,日文 UI 的既定叫法是「課題」,保留英文反而与用户实际看到的 Jira 界面对不上。产品自身的 Issue 不受影响。 菜单入口(titleBar.menuItems.issues 与系统菜单 labels.issues)刻意不用术语:那里回答的是「点这里能干什么」,邻居全是动作短语(帮助 / 检查更新 / 最新更新介绍),夹一个英文名词既断风格,也让不熟悉 GitHub 的用户不知道该不该点 —— zh-CN 用「问题反馈」、ja 用「フィードバック」(ja 同级项同样全是日文,原先的 Issue 一样孤立)。这不是把 Issue 译成那些词:指代该类对象的位置(页面标题、正文、提示)仍写 Issue,因为点进去就跳 GitHub,名字必须对得上 —— 判据与 ja 的 Jira 豁免同源(跟用户实际看到的外部界面一致)。en 保持 Issues、ko 保持 이슈(各自在本语言里本就是自然的入口词)。
  - 豁免范围：`desktop:scheduler.editor.script.capabilityDescs.jira_comment`、`desktop:scheduler.editor.script.capabilityDescs.jira_read`
- **Message** — 对话里的一条往来，用户看到的最小单元。此前有 42 处英文是 message、中文却译成「对话」（如 "Delete this message" → 「删除本条对话」），2026-07-31 一并修正。AI 在一轮里的思考与工具调用最终折叠成一条消息呈现，所以消息与轮次是同粒度的两种切法，不是包含关系。（门禁只精确拦「条对话」这种错译形式，不拦「对话历史 / 对话上下文」——同句里既有 message 又有合法「对话X」时机器无法区分对应关系。）
- **Plugin** — 中文一律「插件」，不保留英文原词（现状 94:4）。历史上 Ghost / Plugin 两种叫法并存，对外统一为「插件」。
- **Project** — 中文一律「项目」（现状 119:15）。同一个侧边栏里筛选叫「项目」、批量操作提示叫「Project」是既有 bug。小写 project 不入 forbidden——它常出现在路径与文件名里（project.json）。
- **Provider** — 中文用「供应商」（现状 36:18 领先简称）。全称「模型供应商」在需要消歧的位置仍可用。「提供商」「提供方」是同义漂移，禁用——设置页标题写「模型供应商」、它自己的表单写「提供商」是既有 bug。豁免 ssoVerificationSubtitle：那里的「身份提供方」是 SSO / SAML 领域 Identity Provider 的标准中文术语，与模型供应商是两个概念。该文案在 desktop locale 与 mobile 影子 catalog 各有一份副本，两处都要豁免。（2026-07 修正：ko 原声明 제공업체 仅 6 处，实测 제공자 32 处为主流，改随主流。）ja 的「提供元」是多义词——同时表示 "source"（来源），因此按 whenEn=Provider 条件禁用；无条件禁会把「共有元の提供元を信頼できるか」这类 source 语境一并换掉。豁免 creditParity 两条:那里的 third-party providers 指支付渠道/收单机构,不是模型供应商——ja 用「事業者」、zh-CN 用「第三方渠道」都对,套上「プロバイダー」反而会让用户以为是模型服务商在收钱。(2026-07 更新:billing 弃用「点数」概念改用金额/余额,creditParityCny/Usd 两条文案已删除,对应豁免一并移除。)
  - 豁免范围：`desktop:login.ssoVerificationSubtitle`、`mobile/loginMessages:ssoVerificationSubtitle`
- **Proxy** — 网络代理，中文保留英文原词（2026-07 裁决：Agent 与 Proxy 都不叫「代理」）。本条只管英文源为 Proxy 的那些——Agent / Subagent 的「代理」误译各自登记在自己条目下。ja / ko 沿用既有音译。whenEn 的匹配走 makeSourceTermMatcher,复数按英语真实形态展开:Proxy 的复数是 proxies,原先只认「加 s」,英文源写 system proxies 时这条条件禁用会整个跳过。
- **Quota** — 周期内的使用上限用「配额」（现状已有 3 处这么写）。与 credits 条目一起裁决：「额度」原先同时表示 Balance / Credits / Quota，三个概念在计费与限额提示里互相污染。「额度」的 forbidden 统一登记在 credits 条目下，不在这里重复——一个词只归属一个术语，否则同一处违规会被两个术语各报一次。（2026-07 修正：ko 原声明 쿼터 在全仓零出现，属凭空造词；ja 原声明 クォータ 仅 desktop 用、mobile 用 残量。定为 ja クォータ / ko 할당량——残量 语义偏 Balance 会与 残高 混淆，而 ko 的 사용량 正是 Usage 的标准词，让 Quota 占用它会重演 zh「额度」三义合一的错误。）
- **Running** — 状态标签用「运行中」（现状 16:9）。条件禁用是必需的——「进行中」是 In Progress 的正确译法、「执行中」在别处也可能对，无条件禁会大面积误伤。mobile/devices 的自动化面板上「运行中 / 执行中 / 重跑中」三种写法同屏出现。
- **Session** — 面向用户叫「任务」——它是左侧列表里可单独打开/删除/分享的条目，有自己的独立空间、可以同时跑多个；「对话」表达不出这个并行性（2026-07-31 裁决，替代此前的「对话」）。任务内人与 AI 交流的过程与内容仍叫「对话」，见 alsoAllowed 与 chat 条目。「会话」继续禁用于产品概念。但英文的 session 在本仓实际承载**五个**不同概念，其中最容易译错、也最影响用户行为的是 Agent 运行时会话——已单独立为 agent-session 条目，中文叫「Agent 会话」，务必先读它再改这类文案；余下三类（登录/绑定校验、SSH 远程与传输、操作系统桌面）与 mobile 语音连接会话都与产品无关，存量译法不在本条约束内，见本条 exempt。代码与内部标识仍用 Session，本条只约束 UI 文案。ja / ko 用音译 `セッション` / `세션`，本次一并收敛：改名前这两种语言就在混用（音译 271 / 277 处 vs `会話`・`대화` 16 / 11 处），改完英文后不一致放大到 133 处，2026-07-31 逐条判断后统一到音译（详见 docs/product-rules/task-and-conversation-naming.md §5.1）。日韩不存在中文那种一词多义问题，所以 `タスク` / `작업`（task）无需像中文那样改写成「自动化」。交流过程仍用 `会話` / `대화`，chat history 仍用 `チャット履歴` / `채팅 기록`。概念分层与判定规则见 docs/product-rules/task-and-conversation-naming.md。
  - 豁免范围：`desktop:settings.providers.custom.fields.modelSupportsReasoningHelp`、`desktop:chat.backgroundActivity.stopBashTitle`、`desktop:chat.remoteError.REMOTE_COMPAT_MODE_UNSUPPORTED`、`desktop:chat.rewind.errors.remoteNotSupported`、`desktop:chat.systemCard.context.noLiveSession`、`desktop:chat.userMessage.forkErrors.codexStateUnavailable`、`desktop:chat.rewind.errors.noLiveQuery`、`desktop:chat.userMessage.forkErrors.unsupportedHistory`、`desktop:login.errors.INVALID_BIND_TICKET`、`desktop:login.errors.INVALID_LOGIN_TICKET`、`desktop:newChat.atMention.typeToSearchFiles`、`desktop:newChat.chatInput.agentSwitch.confirmation.description`、`desktop:newChat.collaboration.archiveWorkerConfirmDesc`、`desktop:newChat.collaboration.stopConfirmDesc`、`desktop:settings.about.debugLogDescription`、`desktop:settings.builtinTools.toast.disabled`、`desktop:settings.builtinTools.toast.enabled`、`desktop:settings.builtinTools.toggleHint`、`desktop:settings.builtinTools.description`、`desktop:settings.builtinTools.scopePicker.userDefault`、`desktop:settings.builtinTools.scopePicker.userDefaultDescription`、`desktop:settings.builtinTools.source.userTooltip`、`desktop:settings.computerUse.android.toggleHint`、`desktop:settings.computerUse.browser.toggleHint`、`desktop:settings.computerUse.codexRefreshDeferred`、`desktop:settings.computerUse.directControl.permissions.linuxHint`、`desktop:settings.computerUse.directControl.toggleHint`、`desktop:settings.lspMode.toast.disabled`、`desktop:settings.memory.agent.toast.takesEffectSuffix`、`desktop:settings.sessionImport.description`、`desktop:settings.sessionImport.summary.filteredHint`、`desktop:settings.mcp.dialog.desc`、`desktop:settings.mcp.deleteConfirm.message`、`desktop:settings.memory.description`、`desktop:settings.lspMode.toast.enabled`、`desktop:settings.personalization.placeholder`、`desktop:settings.subagentModels.hint`、`desktop:newChat.modelSelector.subscriptionDirectDisabled.chatgpt`、`desktop:newChat.modelSelector.subscriptionDirectDisabled.xai`、`desktop:newChat.modelSelector.subscriptionDirectDisabled.generic`、`desktop:ccAgent.draft.remoteProviderUnsupported`、`desktop:ipcError.REMOTE_PROVIDER_UNSUPPORTED`、`mobile/composer:voice.invalidSession`、`mobile/composer:voice.missingConnectionProvider`、`mobile/composer:voice.missingRefinerTargetProvider`、`mobile/composer:voice.sessionExpiredOrForbidden`、`mobile/composer:voice.sessionNotConnected`
- **Skill** — 中文用「技能」（现状 32:26 领先），偶尔保留英文 Skill 也允许，故 zh-CN 不设 forbidden——硬性禁用会逼出别扭的中文。ja / ko 则禁用 技能 / 기술：那是与 スキル / 스킬 并存的同义漂移，且只出现在 skillhub 内部（3 / 3 处）。ko 的 기술 是多义词（技术 / 记述 / 技能），两处非 Skill 义已按 key 豁免。SkillHub 作为产品名单独登记在 skillhub 条目。(2026-07 补充:alsoAllowed 允许保留英文,那就必须是规范形态 Skill——caseStandardFor 会把这类条目一并纳入大小写检查,skillhub 里原有 10 处小写 skill 已统一。)
  - 豁免范围：`desktop:localDbFatal.details`、`desktop:issueTracker.create.descriptionPlaceholder`
- **SkillHub** — 产品名，四语一律保留英文原样（暂定保留，未来若做中文名再改）。注意与 skill 条目区分：侧边栏 tab 现在叫「技能」但实际指 SkillHub，创建面板的「技能」指 Skills——这是既有 bug，两者不是一个东西不该同名，清理存量时需一并处理。
- **Subagent** — Agent 的派生概念，中文跟随 Agent 保留英文原词，不译「子代理」。「代理」在此条下按 whenEn=Subagent 登记：同一个中文词在 Agent / Subagent / Proxy 三处各有来源，只有按英文源区分，自动替换才知道该换成哪个词。ja / ko 沿用既有音译。
- **Task** — 指 Agent 正在执行的一件活，与 Session（也叫「任务」）同名。**同一句里同时出现两者时必须消解歧义**：task 一侧优先动词化（"当前任务正在运行" / "执行完成"），确需名词时用「执行」或「作业」——"当前任务正在执行任务" 这类写法一律不可接受。不同句、语境清晰时沿用「任务」（现状 104 处）。定时任务（Schedule）与后台作业各有限定词，不歧义。判定规则见 docs/product-rules/task-and-conversation-naming.md §3。
- **Thread** — 按语境分四类：①指产品内那个条目 → 跟随 session 叫「任务」（2026-07-31 随 session 改名一并更新）；②Codex 外部概念 → 保留 thread；③GitHub PR review thread →「review 评论」；④比喻用法 "persistent work thread" → 改写为「持续推进的工作」。「线程」一律禁用。
- **Turn** — 一次提问到一次回答结束。**内部概念，不作为界面术语**：面向用户一律说「消息」，只在确实要强调一次完整往返时说「一轮」（如「上一轮」）。不要引入「轮次」作为界面用词。
- **Usage** — 中文用「用量」（现状 37:6 压倒性）。「使用情况」「使用表现」是同义漂移，禁用。注意 usage 在英文里也有「用法」义（如 CLI usage），那属于另一个概念，不在本条约束范围。豁免遥测说明两处:那里的 usage 指「启动与留存情况」这类使用行为,不是计费口径的用量指标。硬套成「用量」会写出「启动与留存用量」这种不通的话——zh-CN 用的是「留存情况」+「使用环境」,ja/ko 的「継続利用状況」「지속 사용 현황」同理。
  - 豁免范围：`desktop:settings.about.analyticsDescription`、`mobile/settings:legal.analyticsHint`
- **Worker** — Orca 协同角色名，四语统一保留英文。这里只钉大小写形态：首字母大写 Worker。小写 worker 由 guard 的大小写规则单独覆盖（desktop 26:13 混用、mobile 一律小写）。
- **Working directory** — Agent 干活所在的那个目录，中文一律「工作目录」（现状 43:0，四语唯一译法）。**不绑项目的任务也有工作目录**：Cindy 在 userData/dialogues/<日期>/<sessionId>/ 下自动分配一个空目录，用来存 Agent 产出的文件；对话消息存在数据库里，与该目录无关。这个目录不要另起名字——「独立任务空间」「任务空间」「工作空间」一类新造说法一并禁用（2026-07-31 裁决），免得同一个东西攒出多套称呼。「工作区」不入 forbidden：它是 Workspace 的合法译法，见 worktree 条目 note（那里已裁定「工作区」只留给 Workspace、working directory 用「工作目录」，本条把该裁决提为独立条目并加上门禁）。
- **Worktree** — Git worktree 是外部工具的既定概念，四语一律保留英文小写原词（现状 21 处最多）。desktop:chat 一个模块里就有 worktree / 工作区 / 工作树 三种写法。特别要紧的是「工作区」——它同时被用于 worktree、Workspace、working tree 三个不同英文概念，必须让出来只表示 Workspace；working directory 用「工作目录」。条件禁用只在英文源含 Worktree 时生效，不影响 Workspace 的正常翻译。豁免导入提示那一句：英文原文同时出现 worktree 与 main workspace，条件禁用是按整句英文判定的，无法区分句内两个概念——那里的「主工作区」正是 Workspace，必须保留，否则会把「不影响主工作区」这条安全边界说成「不影响主 worktree」。
  - 豁免范围：`desktop:sessionShare.import.useWorktreeHint`

## 待讨论术语

这些术语现状不一致但**尚未拍板**，guard 只告警不阻断。裁决后把 `i18n/glossary.json` 里对应条目的 `status` 改为 `decided`、补上 `translations`。

**注意别指望 `--update-baseline` 帮你收尾。** `proposed` 存在的理由正是「已知有存量不一致」，改成 `decided` 的那一刻这些告警会变成阻断违规；而 `--update-baseline` 只删不加，遇到 baseline 里没有的指纹会直接拒绝。所以裁决时只有两条路：要么把命中逐条读语境改掉，要么先人工把已 review 过的指纹写进 `i18n/glossary-baseline.json` 冻结存量，之后再用 `--update-baseline` 做修剪。

### Anthropic Messages

Anthropic Messages API / wire protocol 的用户可见名称。四语统一保留官方英文名称，避免与普通的“消息”概念混译；先登记为 proposed，待产品术语评审后固化。

### API Price Estimate

用户为自有 API、OAuth 或订阅通道维护的本地 token 单价估算；只影响 Cindy 的用量价值估算，不代表供应商实际账单，也不覆盖 Cindy AI Gateway 的服务端实售价。先登记为 proposed，待产品术语评审后固化。

### Global region

企业认证与业务服务所在区域的用户可见名称，用于组织登录检测到 Global 服务区域时的确认文案；它描述连接的服务区域，不是对当前安装版本的标签，也不同于项目配置里的 generic global scope。先按现有四语文案登记为 proposed。

### Mainland China

企业认证与业务服务所在区域的用户可见名称，用于组织登录检测到中国大陆服务区域时的确认文案；它描述连接的服务区域，不代表当前安装的是中国大陆版。先按现有四语文案登记为 proposed，避免后续出现“中国区／国内区／China region”等多套说法。

### reply (the bot's public post on X)

Cindy 在 X 上发出的那条公开回复。zh-CN 取「回帖」以强调它是**一条公开帖子**而不是私聊消息——这正是 X 与 Slack / Telegram 的性质差异, 也是风险告知的核心。与「消息」区分开: 后者按 task-and-conversation-naming 只用于任务内的单条往来。proposed 同上。

### Cindy Codex home

远端主机上由 Cindy 管理的 Codex 凭证目录（~/.xdt-server/v1/codex-home/），与用户本机 ~/.codex 相区分。四语统一保留英文原词（home 小写），避免各语言自造「Codex 主目录」等不同说法；syncAuth 与 codexAuthMissing 等远端登录态文案使用。

### Content Update

指不更换 TestFlight 或商店安装包、可通过 OTA 下发的 JS 与资源更新。当前先采用四语直译并登记为待讨论术语，避免与整包更新或测试版本更新混称。

### Context window

模型一次请求可容纳的 token 上限。自定义 Provider 的窗口编辑字段(#386)与用量/压缩相关文案使用;空间紧的 placeholder 可缩写为「上下文 / Context / コンテキスト / 컨텍스트」+ (tokens)。

### Crash

应用异常终止。此前只出现在内部日志里, 随日志上报进入用户可见文案, 因此登记。ko 取音译「크래시」而非「충돌」——后者在韩语里更常指冲突/碰撞(如合并冲突), 会与 merge conflict 语境混读。proposed。

### Device

device-link 里「可以选择在哪台机器上运行」这一维度，两端统一叫「设备」。desktop 的 machineSwitcher 本来就是 This device / このデバイス / 이 기기，mobile 原先用 computer 系（选择电脑 / パソコンを選択 / 컴퓨터 선택），2026-07 裁决为向 device 系对齐，与既有 device-code（设备码 / デバイスコード / 기기 코드）同口径。alsoAllowed 保留「电脑」系：指代桌面端物理机的文案（安装、导出、等待确认）换成「设备」反而不通中文，那是 desktop/PC 的意思，不是这里的目标维度。

### Device Code

OAuth 2.0 Device Authorization Grant 中由用户在另一设备验证页输入的一次性代码。当前先采用各语言直译，作为待产品裁决术语登记，避免后续界面出现“设备代码／配对码／认证码”等多套说法。

### DingTalk

钉钉机器人连接的产品名称，沿用官方品牌写法；先登记为 proposed，待产品术语评审后再决定是否固化。

### embedding

文本转成的数值向量，用于语义检索。zh-CN 用「向量」而非「嵌入」——设置页的模型分组、UnifiedModelList 的能力分类既有注释都已用「向量」，「嵌入」在中文里更容易被读成动作。指模型本身时说「向量模型」，不说「嵌入模型」。插件 cindy.embed 能力与 embedding-client 的四语文案使用。

### End-to-end encryption

设备间数据在发送端加密、接收端解密，中转服务只搬运密文。当前先按四语言常用安全术语登记为待讨论，避免 E2EE、端对端加密、End-to-End 暗号化等多套可见说法并存。

### Lark

Lark 国际版 IM 服务的官方品牌名，四语统一保留原品牌写法；先登记为 proposed，待产品术语评审后再决定是否固化。

### Black Cat

灵动岛角色皮肤名(设置页「图标皮肤」列表)。角色本体是黑猫形象,四语先采用直译并登记为待讨论,避免后续界面出现「ブラックキャット / 블랙캣」等音译与直译混用。

### Erika

灵动岛角色皮肤名(设置页「图标皮肤」列表)。角色专名,四语统一保留拉丁原词,不做音译(避免「艾莉卡 / エリカ / 에리카」多套写法)。

### Compression

issue #882：模型管理/新对话选择器的分类标签，对应网关的文档压缩类模型（如 ai-gateway-doc）。此前被硬编码为笼统的 other 分类。

### Realtime Audio

issue #882：模型管理/新对话选择器的分类标签，对应 Gateway mode=realtime 的实时多模态模型（如 gpt-realtime-2、gemini-omni-flash-preview）。

### Speech to Text

issue #882：模型管理/新对话选择器的分类标签，对应 Gateway mode=audio_transcription 的语音转写/ASR 模型（如 gpt-4o-transcribe）。

### Text to Speech

issue #882：模型管理/新对话选择器的分类标签，对应 Gateway mode=audio_speech 的语音合成模型（如 elevenlabs/eleven_v3）。原先与语音转写、实时音频混在一个笼统的「音频语音」分类里，本次拆分为独立类型。

### Not signed in

跳过登录后应用内的账号状态名（侧边栏账号胶囊、设置页资料卡、语音服务提示，以及 main 侧不走 locale 的 model-visible 文案——已知 mcp-integrations/ghost.ts 的 GHOST_NOT_FOUND tool result，它会被模型读到并可能回显进对话，#907 review 补上）。**约束范围不限于 locale JSON**：guard 只扫 locale 文件，这类硬编码文案要人工找（见 engineering-conventions §5.1「Slack / IM 侧的文案不在任何 locale 文件里」同类问题）。2026-07-29 产品口径：面向用户只说「未登录」，不再叫「本地模式」——后者听起来像另一种服务端连接方式，实际只是没有登录 Cindy 账号。「本地」仅用于描述数据落在本机（如资料卡副文案「数据仅保存在本机」），不作为状态名。代码内部标识（AuthState mode='local'、authEnterLocal IPC、data owner）不受本条约束，仍用 local。en 侧统一走 not signed in 一种说法（含 settings.userProfile.local 的 exit / exitFailed 两条当前无引用的文案：the not-signed-in state），不与 unauthenticated 混用——PR #907 review 指出过同一状态两种英文说法会让日后启用这些文案时 UI 自相矛盾。status 仍为 proposed：Not signed in 作为状态名尚未与设计侧正式过一遍。

### OpenClaw

腾讯授权页可能展示的外部产品名称，客户端仅按原品牌名展示；先登记为 proposed，待产品术语评审后再决定是否固化。

### Passkey

WebAuthn 可发现凭证的用户可见名称，采用 Apple、Google 与 Microsoft 平台常见译法；先登记为 proposed，待产品术语评审后固化。

### Personal WeChat

个人微信连接在设置页中的产品名称；先登记为 proposed，待产品术语评审后再决定是否固化。

### Pin

右侧栏插件面板页签的图钉:钉住 = 面板在所有对话中保留。动词对:Pin=钉住 / Unpin=取消钉住。2026-07-31 随图钉功能提出,待裁决。

### Region badge

桌面登录页标题旁的品牌红胶囊（DESIGN.md §16.3），指徽标这个 UI 元素本身。徽标上的标签值另立条目（region-code-cn / region-code-dev）——本条 en 为 Region badge、各语言译文均非英文原词，caseStandardFor 天然返回 null，所以本条约束不到标签值，也无需写 checkCase。作为待产品裁决术语登记：尚未拍板是否改为可译文案（如「中国大陆版 / Mainland China」），先登记以免后续界面自造“国内版／中国版／开发版”等多套说法。

### CN

中国大陆版登录页区域徽标上的标签值（DESIGN.md §16.3）。四语同值、**不翻译**——它是区域代号不是可译文案，所以把 en 原样写进各语言 translations（同 Agent 条目的做法），这让 caseStandardFor 生效、guard 能挡住 cn／Cn 之类的大小写漂移。forbidden 用条件形态（whenEn=CN）补另一半：大小写规则挡不住“被整体译走”，条件形态又能把拦截精确限定在英文源为 CN 的 key 上，不误伤别处正当的“国内”“中国版”表述。列的是最可能的自造说法，不求穷举。status 取 proposed 与 region-badge 一致：产品尚未拍板是否改用可译文案，改判后本条应随之作废而非沿用。2026-07-28 起同一代号也用于 submit_github_issue 的提交确认卡片与 issue 正文（`issueAgent.confirm.regionCodeCn`）与侧栏用户卡片版本行（`sidebar.user.regionCodeCn`），口径与徽标完全一致：global 不标；「哪些区域要标」的唯一事实源是 `apps/desktop/src/shared/regionCode.ts`。

已确定禁用：`中国版（仅当英文含 CN）`（zh-CN）、`国内版（仅当英文含 CN）`（zh-CN）、`中国版（仅当英文含 CN）`（ja）、`중국판（仅当英文含 CN）`（ko）

### Dev

dev 版登录页区域徽标上的标签值（DESIGN.md §16.3），四语同值、不翻译，理由同 region-code-cn。与 CN 不同的是 dev 还是个普通技术词：豁免的两条文案里“Always on in dev mode.”“dev builds may be authorized…”“dev 模式下始终开启”指的是开发模式而非本区域标签，小写本就正确（四语同 key 一并覆盖）。用 exempt 精确豁免这两条、而不是整条关掉 checkCase，是为了保住徽标值本身的大小写约束——这正是本条存在的意义。2026-07-28 起同一代号也用于 submit_github_issue 的提交确认卡片与 issue 正文（`issueAgent.confirm.regionCodeDev`）与侧栏用户卡片版本行（`sidebar.user.regionCodeDev`），口径与徽标完全一致：global 不标；「哪些区域要标」的唯一事实源是 `apps/desktop/src/shared/regionCode.ts`。

已确定禁用：`开发版（仅当英文含 Dev）`（zh-CN）、`開発版（仅当英文含 Dev）`（ja）、`개발판（仅当英文含 Dev）`（ko）

### Run records

日志上报文案里对「App 自身运行日志」的用户可见说法。刻意不直接叫「日志」: 设置页同屏已有「日志目录」「Debug 日志」两处指本地文件, 而这里要表达的是被上报的那部分内容(基础设施运行记录, 不含对话)。proposed: 与「日志」的分工尚未产品裁决。

### shortcut listener permission

macOS TCC 的 kTCCServiceListenEvent(系统设置里叫「输入监控」)在 Cindy 内的对外称法。产品侧只按用途讲: 这个权限只服务语音输入快捷键的监听, 不讲系统实现, 所以 zh-CN 沿用设置页权限项已有的「监听权限」(settings.voiceInput.permissions.inputMonitoring.label), 不引入「输入监控」这个直译——后者听起来像 Cindy 在监控用户的全部输入, 与实际能力(只识别快捷键按键组合)不符, 反而制造隐私误解。禁用项都挂 whenEn 条件: 要引用 macOS 系统设置面板名本身时那是 OS 的 UI 名称, 不受本条约束。四语的比喻不统一(en listener / ja 監視 / ko 감지)是现状登记而非裁决——各语言内部一致但跨语言不同, 保持 proposed 等产品拍板, 先把清单摆出来防止继续在 listener / monitoring / detection 之间漂移。

已确定禁用：`输入监控（仅当英文含 shortcut listener permission）`（zh-CN）、`入力監視（仅当英文含 shortcut listener permission）`（ja）、`입력 모니터링（仅当英文含 shortcut listener permission）`（ko）

### Skip Sign-In

登录页免账号入口的动作名（面板内文字按钮 + 登录服务不可用时的 error 步逃生按钮，#697 起取代原游客圆钮）。与 not-signed-in 成对：动作叫「跳过登录」，进入后的状态叫「未登录」。历史说法「本地模式」「游客登录」已废弃——前者暗示另一种服务端连接方式，后者在本产品里没有对应的 guest 账号概念（代码里 GuestRoute 等内部标识不受本条约束）。先登记 proposed：en 的 Title Case 形态（Skip Sign-In）与本仓其它按钮的句首大写风格不一致，待随登录页文案统一时裁决。

### Token Plan

阿里云百炼与小米 MiMo 的外部订阅产品名称，四语统一保留官方英文写法；与 Coding Plan 是不同套餐和凭证类型，先登记为 proposed，避免供应商预设中混用产品名。

### Upload code

客户端日志上报后返回给用户的短标识, 用户报障时口述给我们。zh-CN 取「编号」而不是「码」——它是一次上报的检索标识, 不是验证码或错误码, 「上传码」容易被读成验证码。proposed: 日志上报是新链路, 等实际排障流程跑一段后再固化。

### Voice dictionary

语音输入的用户自定义术语表(人名、产品名、代号与其常见误识别写法),在同账号的电脑之间自动同步、手机只读查看。当前先采用四语直译并登记为待讨论术语,避免与「自定义词典」「术语表」「用户词库」等说法混用。

### WeChat

个人微信连接的产品名称，沿用微信官方品牌写法；先登记为 proposed，待产品术语评审后再决定是否固化。

### WeCom

企业微信官方英文品牌名，用于智能机器人和群机器人能力；先登记为 proposed，待产品术语评审后再决定是否固化。

### WeCom group bot

企业微信群 Webhook 单向通知能力的名称；先登记为 proposed。

### WeCom Intelligent Bot

企业微信 WebSocket 长连接双向 IM 能力在设置页中的名称；先登记为 proposed。

### withdraw (a reply)

用户在 X 上让 Cindy 删掉它那条公开回帖的动作(在回帖下回 /delete)。zh-CN 取「撤回」而不是「删除」——「删除」在本仓已大量用于删任务/删会话/删文件, 而这个动作的对象是「已经发出去的公开内容」, 与 IM 里的消息撤回同义。刻意登记为 proposed: X 撤回是新功能(server PR #288 / client 侧告知), 四语只有这一处用例, 等更多用例出现后再定 decided。

## 怎么加一条术语

1. 在 `i18n/glossary.json` 的 `terms` 里加条目，`note` 必填——写清楚**为什么**这么定，
   否则后人会反复推翻它。
2. 拿不准时先设 `status: "proposed"`，让 guard 把现状规模统计出来再讨论。
3. 跑 `pnpm i18n:glossary-doc` 重新生成本文件。
4. 跑 `pnpm check:i18n-glossary` 看新规则命中多少存量，逐条核对后清理干净。
   `--update-baseline` **只删不加**——它会拒绝登记新违规；确需冻结一批存量时
   手动编辑 `i18n/glossary-baseline.json`，让新增条目出现在 diff 里被 review 看到。
5. 把 `proposed` 提升为 `decided` 时也是这一条：`proposed` 存在的理由正是「已知有存量
   不一致」，改成 `decided` 的那一刻这些告警全部变成阻断违规。因为 `--update-baseline`
   **只删不加**，此时只有两条路——逐条读语境改掉，或先人工把已 review 过的指纹写进
   baseline，之后再用 `--update-baseline` 做修剪。

## 清理存量：不要用脚本批量替换

guard 只能告诉你「这个词不该用」，回答不了「该换成哪个」——目标译法取决于该 key 的
英文源，而 sed / 正则看不见语境。**逐条读英文源再决定**。

「额度」同时是 Balance / Quota / Credits 三个英文源的正确译法，「代理」同时是
Agent / Subagent / Proxy 的译法——无条件替换必然改错其中两类。这类词要用条件禁用
`{ text, whenEn }` 按英文源拆开，让每条规则的目标译法唯一；目标不唯一的禁用词
就是误译的温床。

还要当心外部产品的既定术语被产品术语盖掉：macOS 系统设置面板名日文是
「オートメーション」而非产品的「自動化」，照改会让用户在系统设置里找不到授权项。
这类走 `exempt`。

**误报排查**：guard 已剥离 `{{插值}}`、URL、文件名，并把连字符视作词边界
（`ssh-agent` 不会被判成产品 `Agent`）。仍需放行时用 `exempt`：完整路径精确匹配，
或以 `.` 结尾的子树前缀。同形异义（SSH agent vs 产品 Agent）走 `exempt` 并在 `note` 里写明。

