# 插件运行时安全与作者契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改插件（`.cindy`）的运行时、沙箱、权限、能力 slot、面板供片、
> 网络／凭证／文件交接，插件作者可见的身份卡、管子协议、打包与编写手册，或批准状态、
> 安装布局、指纹格式等**存量安装读得到的任何东西**之前

本文治理 Cindy 中运行的插件——以 `ghost.json` 为身份卡的 `.cindy` 包。它约束三件
互为支撑的事：**运行时权限安全**（宿主如何隔离并授权插件）、**存量插件兼容**（升级
不得让用户已装的插件失效或需要重装）和**作者契约同步**（改了作者可见的能力，必须同步
编写手册与校验）。Electron 进程与协议安全另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
媒体字节交接另见 [`media-storage-and-protocols.md`](media-storage-and-protocols.md)，插件在
产品中的定位见 [`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)。

> **术语**：产品与对外措辞统一为「插件」，`.cindy` 即插件包；不再使用旧的概念称呼。
> 代码标识仍沿用历史 `Ghost` / `cindy-brain` 命名（目录 `cindy-brain/`、`GhostRuntime`、
> `ghost.json`、`cindy-ghost://`、`ghost_forge_guide` 等），与产品术语「插件」指同一事物；
> 引用代码时照实使用这些标识，不因措辞改写。

> **增量适用原则**：运行时沙箱与权限的安全不变量（下节 2–4）与存量插件兼容红线
> （下节 5）对**所有**触及相关路径的改动都生效，不因是存量代码而豁免。作者契约同步
> （下节 6）在改动命中作者可见契约时触发；不要求为统一形式专项重构无关存量。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 编写手册（作者唯一教材，现拿现读） | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `FORGE_GUIDE`，经 `ghost_forge_guide` 工具下发 |
| 身份卡字段与校验、管子协议类型 | `apps/desktop/src/shared/ghost.ts`（`validateGhostManifest`、`cindy.send` / `cindy.onHostMessage` 类型） |
| 打包限制 | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `packGhostDir` |
| 运行时、沙箱进程与生命周期 | `apps/desktop/src/main/cindy-brain/runtime/GhostRuntime.ts`、`GhostManager.ts` |
| 能力 slot（网络／通知／确认／文件系统／技能／宿主等） | `apps/desktop/src/main/cindy-brain/networkSlot.ts`、`notifySlot.ts`、`badgeSlot.ts`（未读角标，落盘账本 `ghostUnreadStore.ts`）、`confirmSlot.ts`（往返桥 `ghostConfirmDialogBridge.ts`，renderer 落地 `cindy-brain/GhostConfirmDialogHost.tsx`）、`fsSlot.ts`、`cindySlot.ts`、`skillSlot.ts`、`agentSlot.ts`、`errandSlot.ts`（派活执行链在 `maker-ipc/ghostErrandRunner.ts`，每插件配置在 `errandPrefsStore.ts`） |
| 面板供片、注入主题 token 与协议 | `apps/desktop/src/renderer/cindy-brain/ghostPanelTheme.ts`、`cindy-ghost://` 分支 |
| 权限注入／更新确认 UI | `apps/desktop/src/renderer/cindy-brain/GhostPermissionList.tsx` |
| 远程／手机版能力准入白名单 | `packages/device-link/src/allowlist.ts` |
| 行为与安全不变量 | `apps/desktop/src/main/cindy-brain/__tests__/`、`forge.test.ts` |

文档与实现冲突时以代码为准，但必须在同一改动内同步修正本文与手册。

## 1. 插件形态与代码术语

- `.cindy` 是以 `ghost.json` 为身份卡的插件包，现行唯一形态为 `kind: 'chip'`。
- 代码目录与运行时使用 `cindy-brain` / `Ghost` 命名，**不得重新引入已退役的 cartridge
  声明型兼容层**。
- `cindy-` id 前缀保留给随包官方插件，第三方插件不得占用。

## 2. 运行时沙箱与进程隔离

- 每个运行中的插件使用独立 Electron 沙箱进程与专属 session partition。沙箱禁止直接访问
  Node、宿主文件系统和网络。
- 插件只允许读取自身安装目录内、经安全相对路径校验的静态资源，不得越权读取其它目录。
- 逻辑页只能经最小 `contextBridge` 管子申请主机能力；面板 webview 保持零特权桥。
- 主机按 `webContents` 绑定反查真实 ghostId，**不信任 sender 自报身份**。
- 沉睡、抽离和主机退出必须终止对应沙箱；沙箱崩溃只由 `GhostRuntime` 收敛，不得带崩
  主应用。

## 3. 权限即授权边界

- 所有能力必须先在 manifest 声明 slot，通过同一套校验，并在注入／更新确认框中逐项
  如实展示，再由 host 代码强制授权。**prompt 不构成安全边界**，前端展示与确认框文案
  也不构成授权。
- 新增或修改 slot 时，除同步编写手册与校验（下节 6）外，还必须同步 shared 类型、
  preload／host handler、权限 UI（`GhostPermissionList.tsx`）、错误边界和测试。
- `skill` 槽是唯一**越出沙箱**的能力：技能指令由主 Agent 以用户全部权限执行、全局
  生效、不随 workdir 级停用隐藏。其安全边界是**声明一致性**（manifest 里的
  name／description 必须与 SKILL.md frontmatter 逐字一致，`skillSlot.ts` 的
  `checkSkillMdConsistency` 是唯一裁判，打包与装入两侧共用）+ **链接对账**
  （`reconcileGhostSkillLinks` 只增删"目标落在 cindy-brain 安装根内的
  symlink／junction"，绝不触碰真实目录与外来链接；启用挂链、停用／卸载撤链、
  断链自愈）。改动技能落链、命名（`<id>--<name>`，name 侧禁 `--`）或对账判据前，
  必须先读 `skillSlot.ts` 头注释并保持上述不变量。

## 4. 网络、凭证与资源交接

- network 只允许 manifest 白名单域名；凭证由主机保险库注入，**无明文读回**给沙箱。
- `source: "oidc-token"` 是 Host 托管的短时 Cindy Connection JWT：只对当前企业
  Membership 生效；只有当前组织的 Plugin Market organization 安装记录仍有效、且
  安装目录 manifest digest 与记录一致时，Host 才会根据当前组织和插件 id 推导 audience。
  插件和 Node Worker 都不能读取或保存令牌。声明必须固定使用
  `Authorization: Bearer {value}` 并显式列出非空 `inject.hosts`；其中只允许精确域名，
  不允许通配。实际目标必须精确命中这份可信 manifest 声明的服务域名才会签发和注入。它没有用户输入、`url`、`exchange` 或
  `setup.requires` 配置动作。Connection JWT 请求遇到 401 时，仅 GET / HEAD / OPTIONS
  可自动换令牌重试一次；非幂等请求只作废缓存，不自动重放。
- 插件 setup 的完成状态只由 Host 读取真实持久化状态后判定。简单的
  `source: "user"` Secret 可由 Host 在聊天 Setup 卡中生成 `inline_form` 并直接写入
  保险库；插件详情页的 `settings.js` 仍可通过 `/oauth`、`/kv`、`/secrets`、
  `/connections` 完成正常保存。两条路径都不得自行向聊天卡回调“已完成”，Renderer
  也不得以轮询或 `BroadcastChannel` 事件替代 Host 判定。
- Agent 可编排 setup 卡片的说明与步骤，但只能引用 Host 下发的 requirement / action；
  插件身份、字段 schema、字段与存储目标的绑定、Action 执行、完成状态和原
  `ghost_call` 恢复均由 Host 掌控。Secret、Token、OAuth code 和连接凭证不得进入
  Agent、Ghost、interaction / pending snapshot、会话历史、日志或分析事件。内联 Secret
  只允许短暂存在于本地 Desktop 输入组件和一次性的 trusted Renderer → Main 专用 IPC；
  不得走通用 interaction response、device-link 或其它远程通道，也不得写入 Renderer
  store。提交成功、取消、request / revision 替换和组件卸载时必须清空。
- Host 必须把每个未满足 `any_of` 组的全部可执行 item 投影到卡片，Agent plan
  不能隐藏合法配置路径。Renderer 统一按组展示选项并复用 Ask 卡片的正文限高与纵向
  滚动，不得为 Brave、Tavily、Gmail 等具体插件增加分支。
- `network.secrets[].url` 可由 Host 作为 Setup 字段旁的辅助获取入口展示。该地址必须
  继续满足 manifest 安装期的 `https`、无内嵌凭证校验；它不是 Agent 文案或 plan
  的一部分，插件也不能通过 `settings.js` 动态替换 Setup 卡地址。
- 模型调用一律走 Cindy 统一通道，不允许插件自建绕过通道的推理请求。两条 AI 代办
  通道的固定边界（2026-07-31 定案，主机代码强制）：
  - 快问快答（`cindy.text.oneshot`）只走主机轻量任务模型链，无 agent、无工具、
    不进会话；选型不在插件手里，链上无候选时返回结构化 `NO_CANDIDATE`。
  - 派活取件（`agent.errand`）的任务文本**只进普通 user 消息、绝不进 system
    prompt**；errand 会话侧边栏可见、可旁观可叫停；agent／模型／权限档／工作
    目录全部由用户在插件详情页配置，权限档只有 `plan`（默认）／`acceptEdits`／
    `auto` 三档，**`bypassPermissions` 在协议层就不存在**，不得以任何形式放开；
    工作目录缺省为插件专属对话目录，指向真实项目必须由用户亲手选择。
- 附件、媒体、目录和保存路径通过归属校验后的 grant／deposit／ledger 交接，**禁止把
  宿主绝对路径或不必要的字节暴露给沙箱**。媒体字节须走
  [`media-storage-and-protocols.md`](media-storage-and-protocols.md) 的统一入库。
  `ghost_call` 的 `attachments`／`dir`／`save_dir` 在目标位于 workdir 外时，普通权限档
  仍沿用现有确认与授权记忆策略；仅当 Host 能现读到**本地活跃会话**的运行时权限恰为
  `bypassPermissions`（Full Access）时自动批准。该判定不得读取启动期 MCP context 快照，
  也不得回退可能滞后的 DB `permission_mode`。business `sessionId` 不足以证明仍是同一内存
  Session，必须同时匹配由 Maker 铸造、调用方不可覆盖的 instance identity；权限切换在途、
  close／detach 已开始、会话缺失、实例不匹配、查询失败、远程会话均 fail closed。
  对 Codex、Pi 与远端 Claude Code 这类进程外 harness，instance 只作为 opaque MCP route
  identity 写入 Host 生成的 loopback URL；桥接层必须将 URL identity 与注册表中的当前实例
  严格比对，不匹配直接 401。兼容旧客户端时，缺 instance 的 URL 可继续获得普通会话上下文，
  但必须剥除 instance 能力，使 Full Access 自动交接继续 fail closed。
  自动批准须在日志标明来源为 Full Access，不得伪装为用户点击，也不得写入人工目录授权
  记忆。附件自动交接必须写独立 `ghost-tool-grant`，不得写 `ghost-grant`；这是回退兼容
  边界——旧客户端只认识后者，降级时必须 fail closed，不能把新版自动交接误读成人工永久
  授权。热切回其它档位后新请求必须恢复确认。此旁路**不适用于** workspace 创建、插件
  Setup／安装／更新、OAuth、Secret／凭证或其它确认边界。
  `dir`／`save_dir` 批准的是裁决时解析到的 canonical realpath 快照；出票必须使用该规范路径
  并在票据库内重新解析核对，路径映射已变化时拒绝并要求重新确认。出票后真正读／写时仍须
  再次核对根与目标真身；保存文件必须排他创建且不跟随最终 symlink，不能让短命票据留下消费期
  TOCTOU。附件继续使用裁决前已读入的字节，不得在批准后重新跟随原始路径。
- 面板供片与注入的主题 token 只用 `ghostPanelTheme.ts` 白名单内的值，不扩大暴露面。

## 5. 存量插件兼容：升级必须无感（红线）

**红线**：插件系统的任何改动，都不得让用户本地**已安装、已批准、已启用**的插件在升级
后变得不可用，也不得要求用户重新安装、重新确认权限、重新配置凭证或重新落一次技能。
升级后的默认结果只有一个：用户什么都不做，插件照旧能用。

- **判据是用户视角的可用性，不是代码路径没报错。** 插件还在列表里但被标成「已停用」
  「失效」「需重新确认」「需重新安装」，或者启用按钮点不动、技能链断了、面板打不开、
  已配置的凭证要重填 —— 都算不可用。「fail closed 得很干净」不是通过条件。
- **触及范围**（改这些就命中本节，逐条按"老数据怎么办"设计）：宿主侧批准状态记录
  （receipt 一类）的 schema／字段必填性／落盘位置、指纹与摘要编码、
  `validateGhostManifest` 的校验规则、slot 名称与参数形态、技能快照布局与链接命名、
  安装根与状态根路径、`.cindy` 包格式、
  管子协议消息形态、随包种子与内置插件 id／前缀、市场侧的 id 与版本口径。
- **新增校验或新增必填字段，默认必须自带迁移（backfill），不是自带拒绝。** 老数据缺
  新字段是**升级前的正常历史状态，不是攻击证据**，不得按篡改处理。迁移的判据是"能不能
  从旧版本自己的授权事实重建出等价物"：
  - 例：把授权事实从安装目录搬到宿主侧独立记录时（#1080 做过、已回滚，见第 7 节），
    搬迁前的存量安装的授权事实就在安装目录的 `ghost.json` / `.cindy-trust.json` /
    `.disabled` 三份文件里。宿主必须能一次性读它们 backfill 出等价的批准记录，用户无感。
  - **迁移不得成为扩权或降级通道**，这是它与安全不变量共存的前提：迁移只在该 id
    **从未有过 receipt**（或 receipt 已判损坏）时发生，权限集原样取旧记录、不做并集、
    不吞新增 slot；迁移出的授权**只等价于旧版本已经给出的授权，不等价于一次新的用户
    确认**，因此此后任何 manifest／权限变化照旧走完整确认；迁移来源必须记进日志，
    便于事后分辨"用户确认过"与"宿主迁移来的"。
  - 迁移**读不出**（文件缺失、格式坏）或**自相矛盾**（镜像与内容互斥）时才 fail
    closed，落到下面的兜底义务。
- **确实不可避免时的兜底义务**（四条全部要满足，缺一条就不算做完）：
  1. **能自动就别打扰用户**：自动重建／自动重算／自动重新播种优先，且要能在下一轮启动
     对账时自愈，不要求用户在特定时机点特定按钮。
  2. **自动做不到就必须明确提示**：UI 要说清发生了什么、影响哪些插件、点哪里恢复，并
     提供**一次性批量恢复入口**；不得只留"去市场逐个重装"，也不得让它看起来像是用户
     自己关掉的（与第 3 节的 UI 义务同一条）。
  3. **不丢用户本地状态**：恢复过程不得清掉已保存的凭证／Secret、KV、per-plugin 偏好、
     errand 配置、面板状态。恢复的是授权，不是用户的配置。
  4. **留回滚余地**：新版本写出的状态被旧版本读到时不得当成损坏——未知字段忽略而不是
     判 `invalid`，否则用户一旦回退旧版就再炸一次。
- **测试门槛**：命中本节的 PR 必须有"从旧状态升级"的自动化用例——fixture 造出老布局
  （无批准记录／旧 schema／旧指纹编码／旧目录形态），断言升级后插件仍列为启用、技能仍
  挂链、无需用户操作。只测全新安装流程不算覆盖，这类回归**只在存量数据上出现**。
- **PR 约束**：命中本节的 PR，Description 必须写明「存量插件影响：无」或「有 + 迁移与
  提示方案」，并说明上面的升级用例跑在哪。会让存量插件失效的改动与 mobile 冷更同级：
  需仓库把关人针对该影响明确确认后才能合并，提交者身份不构成例外。漏迁移 = P0。
- **插件基座改动一律走白名单确认门。** 「基座」= 所有已装插件共同踩着的那一层：运行时与
  沙箱、批准 receipt、能力 slot、打包与内容判据、manifest 契约、装入与权限确认 UI、已装
  列表投影（`main/cindy-brain/`、`main/plugin-market/`、`main/mcp-integrations/ghost.ts`、
  `shared/ghost.ts`、`packages/cindy-tools` 的 ghost 部分，以及 renderer 侧的
  `installFlow.tsx`／`installErrorKey.ts`／`GhostPermissionList.tsx`／`useInstalledGhosts.ts`／
  `runtimeStates.ts`／`features/plugin/lib/ghostPluginViewModel.ts`／
  `features/plugin/lib/pluginMarketPresentation.ts`）。命中即需放行人在 PR 上明确
  Approve 才能合并，**不看 diff 大小，也不因为「是 bugfix／纯技术改动」就放过**——#1080
  正是以 `fix` 身份、按纯技术改动被放过的。这条与本节前面的义务是一套：门只保证「有人
  看过存量影响」，看什么按上面逐条对。纯粹改插件面板视觉、纯文案／locale 不算基座。
- **历史教训（本节的由来）**：2026-07-31 合入的批准 receipt 改造
  （`ghostInstallReceipt.ts`，#1080）把"无 receipt = 不构成运行授权"一次性作用到全部存量
  安装，只给随包内置插件留了自动补批准的路，市场与本地安装没有 backfill 路径，结果升级后
  用户**所有非随包插件**同时变成停用、必须逐个重新确认，本地包还要求重新提供原始
  `.cindy` 文件（包已丢失就无从恢复）。安全方向是对的，落地方式把一次内部机制升级变成了
  全量用户故障，**因此于 2026-08-01 在 `main` 上整体回滚**；#636 的漏洞随之敞开，重做
  要求见第 7 节。本节就是这次回滚的产物：下一次做同一件事，迁移与红线必须同时满足。

## 6. 作者契约与编写手册同步

`FORGE_GUIDE` 是 agent 替用户编写插件的**唯一教材**，由 `ghost_forge_guide` 现拿现读。
**手册过期 = AI 按旧规则写出过不了校验的插件包**（校验拒装只是兜底，用户体验是“AI
反复打包反复被拒”）。

凡改动**插件作者可见的契约**，同一改动内必须同步更新手册对应章节：

- (a) `ghost.json` 身份卡字段或校验规则（`shared/ghost.ts` 的 `validateGhostManifest`）；
- (b) 管子协议（`cindy.send` / `cindy.onHostMessage` 的消息形态，`shared/ghost.ts` 管子类型）；
- (c) 模型能力 slot 的 kind／参数／模型白名单；
- (d) 面板供片协议与注入的主题 token（`cindy-ghost://` 分支、`ghostPanelTheme.ts` 白名单）；
- (e) 打包限制（`forge.ts` 的 `packGhostDir`）。

反向同样成立：改校验必须同步手册；改手册宣称的新能力必须真有实现。`forge.test.ts` 的
关键章节存在性测试只是最低闸，不替代逐条人工核对。

**PR 约束**：命中上述任一路径的 PR，Description 必须写明「手册已同步（改了哪节）」或
「无需同步 + 为什么不涉及作者契约」；漏同步 = P1。

## 7. 已知安全／兼容缺口（不得随旧文档删除而视为完成）

以下缺口在触及相关链路时必须一并修复，或在 PR 中保留明确的正式跟踪，不得静默丢弃：

- **【待重做】授权事实与可变安装目录解耦（原 #636）。** 原修复（#1080 的批准 receipt
  改造）已于 2026-08-01 回滚，**因此 #636 的漏洞当前是敞开的**：就地改写安装目录里的
  `ghost.json` 能让更新确认框的权限 diff 以被改过的现场为基线显示"无新增"，未经确认的
  slot 因此拿到运行授权。回滚原因不是方向错，而是它违反第 5 节红线——把"无批准记录 =
  不构成运行授权"一次性作用到全部存量安装，只给随包内置插件留了自动补批准的路
  （provisioning 逐字节对账后走 `approveTrustedBundledInstall`，那条路有权威字节可比，
  正是第 5 节要求的迁移形态），市场与本地安装没有 backfill，升级后全部非随包插件同时
  失效、需逐个重新确认，本地包还要求重新提供原始 `.cindy`（包已丢失即无从恢复）。
  **重做时必须一并带上第 5 节要求的迁移**：从安装目录的 `ghost.json` /
  `.cindy-trust.json` / `.disabled` 重建等价批准记录（只在从未有过该记录／已判损坏时、
  权限原样不扩权、来源记日志），本地包要有"不必重新提供原始包、但仍逐条确认"的恢复
  路径，格式 bump 走"按旧编码核对 → 原地升级"而不是 fail closed。不得再把一次内部
  机制升级变成全体用户重新确认。
- **manifest 枚举扩展在客户端降级方向不兼容（#1283 披露）。** `validateGhostManifest()`
  对 `slots` / `subscribe.topics` 的未知枚举值、以及 `schemaVersion` 不等于 2，都是整份
  判无效（`return { ok: false }`）；而 `GhostManager.list()` 每次调用都重新校验已装目录，
  无效即 `continue` 跳过。所以用户把客户端**降级**到某个枚举值引入之前的版本后，声明了该值
  的插件会从已装列表**整个消失**（不是能力降级）——界面上看不到、无从修复，已存凭证与偏好
  变成孤儿。这不是某次扩展的疏漏：校验器只在**字段**级向前兼容（「宽进严出：忽略未知字段」），
  不在**取值**级向前兼容，历史上每次新增卡槽都有同样特征。已发布的旧版无法追改，唯一可行
  方向是让**新版**把未知枚举值降级为「忽略 + warn」而非整份拒绝，使此后的扩展天然降级安全
  （救不了「从引入版降到引入前」那一段，任何方案都救不了）。改动方向本身要过第 5 节红线
  评估：放宽校验等于让主机接受读不全的权限声明，不能顺手做。**触及 `validateGhostManifest()`
  的枚举白名单、或 `GhostManager.list()` 的跳过逻辑时必须一并考虑。**
- `networkSlot.ts` 的 `as: 'media'` 不能只信任 Content-Type（GLB 常见
  `application/octet-stream`），需要安全的 magic-byte／扩展名嗅探。
- SSH 远程场景必须让 `LiziMcpSessionContext` 携带 remote 标识；目录过户不得回退读取本机
  同名路径，无法证明来源时 **fail closed**。
- 手机版仍需把历史 mivo 动作按钮降级为纯展示。

## 8. 远程与手机版

插件能力可能运行在 SSH 远程工作区、设备互联远程控制或手机版控制端。新增或修改 IPC
channel 与推送事件时，若手机／远程控制场景需要用到，必须按
`packages/device-link/src/allowlist.ts` 顶部注释的准入判据登记 invoke／push 白名单并同步
topic 路由；产品层多端语义见
[`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md) 的
「多端连接与任务连续性」。缺登记会让手机／远程控制端永远调不通，且静态检查发现不了。

## Review 清单

1. 沙箱是否保持进程隔离、专属 partition、无 Node／宿主 FS／网络直连？身份是否由主机
   反查而非信任 sender 自报？
2. 新能力是否先在 manifest 声明 slot、走同一套校验、在确认框如实展示后才由 host 授权？
3. 网络是否限白名单域名、凭证无明文读回？附件／媒体／目录是否经归属校验的
   grant／deposit／ledger 交接，未暴露宿主绝对路径？
4. 内联凭证是否只走 trusted Desktop 专用 IPC，未登记 device-link？Main 是否重新校验
   sender、request、revision、action、精确字段集合与 manifest 绑定，且没有把 Renderer
   字段 id 直接当作 Secret key／路径？保险库写失败是否不 emit，写成功后是否仍重新
   assessment，而不是把“提交完成”当作 ready？
5. **存量插件升级后还能不能用（第 5 节红线）**：本次是否改了批准状态记录的 schema／
   必填字段／落盘位置、指纹或摘要编码、manifest 校验、slot 形态、快照与链接命名、安装根
   或状态根路径、`.cindy` 包格式、管子协议、内置 id？命中就逐条问：用户升级后**什么都
   不做**时，已装、已批准、已启用的插件是否照旧可用？新增的必填字段／新校验是否自带从
   旧版授权事实的 backfill，而不是把"老数据缺字段"当篡改直接 fail closed？迁移是否只在
   "从未有过该记录／已判损坏"时发生、权限集原样不扩权、来源有日志？自动做不到时是否有
   明确提示 + 一次性批量恢复入口（不是"去市场逐个重装"）、且不清掉用户已存的凭证与
   偏好？新状态被旧版本读到是否不判损坏（可回滚）？是否有基于旧布局 fixture 的升级用例，
   而不是只测全新安装？让存量插件失效且无迁移 = P0，需把关人对该影响明确确认。
6. 改动是否命中作者可见契约（身份卡／管子／模型 slot／面板供片／打包）？命中就必须
   同步 `FORGE_GUIDE` 并在 PR 说明；漏同步 = P1。
7. 第 7 节的已知缺口是否被触及？触及是否一并修复或留了正式跟踪？
8. 新增 IPC／推送是否需要远程／手机版？需要就登记 device-link 白名单与 topic 路由。

最小验证入口：

```bash
pnpm --filter desktop exec vitest run src/main/cindy-brain
pnpm --filter desktop typecheck
```

其余按 [`desktop-development.md`](desktop-development.md) 的分层验证选择；命中媒体、协议或
IPC 时追加对应专项规则要求的验证。
