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

| 内容                                                  | 权威来源                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编写手册（作者唯一教材，现拿现读）                    | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `FORGE_GUIDE`，经 `ghost_forge_guide` 工具下发                                                                                                                                                                                                                                                                                                                                                                                           |
| 身份卡字段与校验、管子协议类型                        | `apps/desktop/src/shared/ghost.ts`（`validateGhostManifest`、`cindy.send` / `cindy.onHostMessage` 类型）                                                                                                                                                                                                                                                                                                                                                                                 |
| 打包限制                                              | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `packGhostDir`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 运行时、沙箱进程与生命周期                            | `apps/desktop/src/main/cindy-brain/runtime/GhostRuntime.ts`、`GhostManager.ts`                                                                                                                                                                                                                                                                                                                                                                                                           |
| 安装批准事实(receipt / 技能快照 / revision)           | `apps/desktop/src/main/cindy-brain/ghostInstallReceipt.ts`，批准态投影见 `shared/ghost.ts` 的 `GhostInstallApproval`                                                                                                                                                                                                                                                                                                                                                                      |
| 能力 slot（网络／通知／确认／文件系统／技能／宿主等） | `apps/desktop/src/main/cindy-brain/networkSlot.ts`、`notifySlot.ts`、`badgeSlot.ts`（未读角标，落盘账本 `ghostUnreadStore.ts`）、`confirmSlot.ts`（往返桥 `ghostConfirmDialogBridge.ts`，renderer 落地 `cindy-brain/GhostConfirmDialogHost.tsx`）、`fsSlot.ts`、`cindySlot.ts`、`skillSlot.ts`、`agentSlot.ts`、`errandSlot.ts`（派活执行链在 `maker-ipc/ghostErrandRunner.ts`，每插件配置在 `errandPrefsStore.ts`）、`iosSimulatorSlot.ts`（当前台前任务的公开状态与 Host viewer 入口） |
| 面板供片、注入主题 token 与协议                       | `apps/desktop/src/renderer/cindy-brain/ghostPanelTheme.ts`、`cindy-ghost://` 分支                                                                                                                                                                                                                                                                                                                                                                                                        |
| 权限注入／更新确认 UI                                 | `apps/desktop/src/renderer/cindy-brain/GhostPermissionList.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 远程／手机版能力准入白名单                            | `packages/device-link/src/allowlist.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 行为与安全不变量                                      | `apps/desktop/src/main/cindy-brain/__tests__/`、`forge.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                          |

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
- **授权事实由 Host receipt 持有，不由安装目录持有。** 一次明确的安装／更新确认写出
  一份 receipt（`ghostInstallReceipt.ts`），落在**安装根之外**的 owner-scoped 状态根里，
  钉住这次批准过的 manifest、trust、启停态和一个随机 `revision`；`GhostManager.list()`
  只从 receipt 取这些字段，安装目录里的 `ghost.json` / `.cindy-trust.json` / `.disabled`
  退化为旧版本兼容镜像。**唯一的非对称例外是启停态**：`.disabled` 镜像在读取时只往
  停用方向合并（`enabled = receipt.enabled && !镜像存在`）——停用必须永远能成功，状态根
  不可写时镜像是 `setEnabled(false)` 唯一还能落笔的地方，只读 receipt 会让那次停用在
  重启后静默复活；镜像**不能**把插件往启用方向翻，重新启用只有 `setEnabled(true)` 成功
  写 receipt 一条路。理由是可变安装目录曾经就是授权事实本身：就地改写
  `ghost.json` 能让权限 diff 显示"无新增"，未确认的 slot 因此拿到运行授权。
  - 没有 receipt（旧安装）或 receipt 损坏 = **不构成运行授权**：一律按停用列出、
    不许启用、不参与技能落链。但"不构成运行授权"只是**当下状态**，不等于"该由用户
    重装"：这两种情况都必须先走第 5 节的存量迁移（能从旧版授权事实重建出等价 receipt
    就自动重建，用户无感），**只有迁移读不出或自相矛盾时**才落到一次完整重新确认
    （`diffInstalledGhostPermissionItems` 在无批准基线时把候选包的**全部**权限当新增项
    展示）。UI 必须如实说出这个状态并给出恢复入口，不能让它看起来只是"被用户关掉了"，
    也不能只留"去市场重装"这一条出路。
  - 通往"不构成运行授权"的还有第三条路：**撤销陈旧批准失败时的进程内隔离**。撤销的
    契约是"返回后该插件一定不再被授权运行"，所以删不掉 receipt（状态根不可写——与写
    批准失败同一个成因，指望再往状态根写点什么表达"已失效"并不可靠）时退回内存标记，
    由读批准状态的**唯一入口**统一投影成 `invalid`。读批准状态的所有消费方都必须走
    那个入口：各自直接读 receipt 会让隔离在某条路径上失效。撤销同时要熄灯运行中的
    实例（runtime / node broker / agent slot 三连），否则"不再被授权运行"对已经跑起来
    的进程不成立。下一轮启动对账成功即自愈。
  - 跨进程更新事务用 `ghostInstallApprovalToken()` 把批准态投影成 token：Renderer 把
    确认时看到的 token 回传，Main 重新读状态比对，不一致就拒（`state-changed`）。
    token 是前置条件不是凭证——真值一律由 Main 现读。
  - receipt 保证的是**授权事实**，**不是安装内容此后一直没被改过**：逻辑页代码仍从可变
    安装目录加载，`packageSha256` 只是批准时点的来源指纹、运行时不校验（见第 7 节）。
- **Forge 的源码区与 Host 受管根互斥。** `ghost_forge_scaffold` / `ghost_forge_pack` 的目标
  必须是当前会话工作目录里的独立作者目录；命中安装根或批准状态根一律拒
  （pack 返回 `SOURCE_IS_INSTALLED_PLUGIN`）。判定按 realpath 比对受管根，同时挡住大小写
  折叠与软链／junction 别名。理由不是洁癖：在已安装目录里就地制作"更新包"会让版本与
  权限 diff 以被改过的现场为基线，把未经确认的 manifest 送进运行时授权。
- `skill` 槽是唯一**越出沙箱**的能力：技能指令由主 Agent 以用户全部权限执行、全局
  生效、不随 workdir 级停用隐藏。其安全边界是**声明一致性**（manifest 里的
  name／description 必须与 SKILL.md frontmatter 逐字一致，`skillSlot.ts` 的
  `checkSkillMdConsistency` 是唯一裁判，打包与装入、以及批准快照三侧共用；注意它**只**
  校验 frontmatter 的 name／description，正文与辅助文件不在它的判据里）+
  **批准快照与字节指纹**（确认时把技能目录逐字节拷进
  `<状态根>/skill-snapshots/<id>/<revision>`，只收普通文件，同时把逐 item 的内容
  指纹钉进 receipt 的 `skillContentSha256`——装入/更新时该指纹取自 **`.cindy` 包的
  内存投影**(inspect 时已被 `packageSha256` 钉住的那份字节),不从已发布的可变安装
  目录首读:publish 与首次 hash 之间被换的字节应当在快照对账时被拒,而不是被首读钉成
  批准基线;确认框看到的 SKILL.md 必须就是 Agent 之后
  读到的那份，所以共享技能根的链接指快照而不是可被改写的 `cindy-brain/<id>/<dir>`。
  快照缺失需要从安装目录重建时，**顺序本身就是安全性质**：先把字节复制进状态根的
  临时目录，再对**临时目录里那份即将成为快照的字节**做全部权威校验（尺寸上限 →
  指纹逐字节比对 → frontmatter 一致性），通过才 rename 就位。**不得改成"先校验安装
  目录、再复制"**——安装目录随时可被同权限进程改写，校验与复制各读一次就有一个可换
  字节的窗口，复制出来的快照可能不是被校验过的那一份。同理，复制前对安装目录做的
  任何预检只是"早失败"优化，**不是安全边界**；尺寸上限必须排在算指纹之前——上限要在
  权威路径上真正生效，且不为一份注定被拒的字节先付一整趟读取成本。指纹计算一律流式
  喂入、不整份读进内存（技能目录里除 SKILL.md 之外的文件没有尺寸上限，整份读会被一个
  塞进来的超大辅助文件撑爆）。只靠 `checkSkillMdConsistency` 拦不住"frontmatter 不动、改写正文或塞
  辅助文件"，那会把一份没人确认过的指令在一次启用里固化成已批准快照并全局挂链。
  对不上一律拒、退回完整重新确认，不许就地自愈成新批准；`skillContentSha256` 因此是
  **运行期判据**，与只作审计用的 `packageSha256` 不同，且必填——留"字段缺失就跳过
  校验"的可选口子等于给漂移开一条绕过路径）+ **链接对账**（`reconcileGhostSkillLinks` 只增删"目标落在
  安装根或批准状态根内的 symlink／junction"，绝不触碰真实目录与外来链接；
  启用挂链、停用／卸载撤链、断链自愈）。快照目标带 revision，因此每次更新都换目标、
  靠对账重指，旧 revision 在 receipt 提交后回收。改动技能落链、命名
  （`<id>--<name>`，name 侧禁 `--`）、快照或对账判据前，必须先读 `skillSlot.ts`
  头注释并保持上述不变量；`approvalStateRoot` 是必填项——漏给会让指向快照的活链接被
  判成外来链接而永不撤链，停用／卸载后技能仍对主 Agent 生效。
- 收敛方向不对称：**启用需要有效批准状态，停用必须永远能成功**。停用是安全方向，不
  能因为快照缺失之类的环境问题把插件卡在"既不能用也不能关"。
- **「插件内容目录怎么读」只有一份判据：`ghostContentTree.ts`。** 条目类型判定
  （`classifyGhostDirEntry`，一律 `lstat`、链接与非普通条目显式归类，**不信 Dirent 的
  类型位**）、清单相对路径的逐段解析（`resolveGhostContentPath`，中间段是链接一律拒）、
  内容树收集与指纹格式（`collectGhostContentFiles` / `hashGhostContentFiles`）都在这里，
  各调用方之间的差异只允许以**显式策略参数**表达：点开头条目算不算内容
  （技能目录 `include` ／安装目录与种子 `skip`）、非普通条目是 `throw`（授权判据）还是
  `flag`（对账判据——收敛动作是重新播种而不是拒绝）。
  - 理由是实测的复发史：同一条判据曾经在技能指纹、快照拷贝、安装目录漂移指纹、随包
    种子指纹、种子复制、Forge 打包收集六处各写一遍，还有五处各自 `path.join` 后再判
    一次类型，分别用 Dirent 类型位／`lstat`／`stat`／realpath 钳制实现。于是每轮审查都
    能在其中一处找到没覆盖的角落，补一处、下一轮换另一处。
  - 新增任何"读插件内容目录"的代码一律从这里取判据，**不要就地 `readdir` + `isDirectory()`
    或 `stat` 直读**。只 `lstat` 最终段等于没判：中间段被换成软链／junction 时 OS 会
     静默穿透，最终段报的是"真目录、非链接"，字节却来自插件目录之外。
  - `hashGhostContentFiles` 的摘要编码必须保持无歧义 framing（当前为
    `cindy-ghost-content-v2` + UTF-8 路径长度前缀 + 每文件摘要），不得恢复成
    `path + NUL + bytes + NUL`；文件内容本身允许包含 NUL，分隔符编码会产生不同文件树
    的等摘要。该编码升级同步 bump `GhostInstallReceipt` schema；旧 receipt 必须
    fail closed 并重新确认，不能拿旧摘要继续授权。**编码 bump 属于第 5 节的存量兼容
    场景**：先按**旧编码**核对旧摘要与当前安装字节，对得上就原地重算成新编码并升级
    receipt（安全水位与旧版本已提供的保证等价），只有对不上（真漂移）才 fail closed 到
    重新确认——不得把一次纯格式升级直接变成全体用户重新确认。
  - 同理，"源目录与受管根的包含关系"必须**双向**判（既不能落在受管根内，也不能是受管
     根的祖先）：单向判定下只要在 owner 数据目录里放一个 `ghost.json`，递归打包就会把
     已安装插件字节、批准 receipt 与技能快照打进 `.cindy`。
  - 随包种子是第一方输入；发现链接、junction、FIFO 等非普通条目必须整颗跳过并告警，
    不得在复制时静默丢弃后继续写批准 receipt。

## 4. 网络、凭证与资源交接

- network 只允许 manifest 白名单域名；凭证由主机保险库注入，**无明文读回**给沙箱。
- `source: "gh-cli"` 是只为官方 `cindy-github` 保留的宿主凭证来源：Host 优先读取
  本机 `gh auth token`，不可用时才回落到同 key 经 `/secrets` 保存的 PAT。两种 token
  均只在 Main 的 networkSlot 内存中注入 `api.github.com` 的
  `Authorization: Bearer` 请求头，不得进入插件、Renderer、Agent、KV、日志或 Node
  Worker。设置页只能读取 `hostAvailable` 布尔与备用 PAT 的 `saved/tail` 状态。该来源
  不允许 `exchange` 或 `setup.requires` 引用，第三方插件不得声明。
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
- 媒体模型接入分成两层：插件声明并封装业务能力，Cindy Core 提供低级目录和调用能力。
  插件设置页／panel 只能通过同源只读 `/media-models?type=image|video` 配置模型；Host 按
  Gateway `mode` 切图片／视频大类，并结合插件 `cindy.image/video` 声明、Gateway
  `modalities`、Guide operation 与当前客户端协议支持度，只投影当前可执行模型。单模型
  Guide 失败必须局部隔离，不能阻断其余模型或插件面板。响应仍只把归一化后的
  `modalities.input/output` 原样交给插件，不得包含 Guide、endpoint、凭证或内部兼容判定；
  付费请求前 Core 必须再次校验。新媒体生成请求只能由当前 Agent 调用永久 Core `media`
  工具发起，插件沙箱和 panel 不得直接提交、轮询或下载。存量 `cindy-request` 媒体代办仅作
  兼容，不得作为新 Guide 模型的接入路径。插件工具通过现有 `tool-result` 返回普通 JSON，
  Agent 读取后自行决定下一次 `media` 调用；Host 不识别插件专用媒体意图字段，也不自动
  转发。插件需要结果时，Agent 调用普通接收工具，并通过顶层
  `ghost_call.attachments` 显式交接；Host 复用已有的通用授权链，将授权后的指纹注入
  `args.attachments`，绝不把本地绝对路径暴露给插件。插件自行保存业务状态和更新 UI。
  Host 不自动回调插件，也不得新增画廊等插件业务语义。
- 面板供片与注入的主题 token 只用 `ghostPanelTheme.ts` 白名单内的值，不扩大暴露面。
- `ios-simulator` 槽只允许读取 Host 当前台前任务的公开模拟器状态，并请求打开既有
  Host viewer。请求协议不得出现插件自报 `sessionId`，可选 `instanceId` 必须重新匹配
  当前任务的公开实例。视频帧、viewer lease、触控、Sidecar／Helper、artifact 路径、进程
  句柄和私有诊断都不得跨进插件沙箱；Agent 侧构建／安装／控制继续走 Host 注册的
  `cindy_ios_simulator` MCP。该能力是本机 Desktop 专属，不进入 device-link/mobile，
  SSH／远程任务 fail closed。状态查询必须走脱敏、短缓存、无副作用的只读投影，不得借
  panel 轮询执行 ownership reconcile、续租、启动 WDA／Sidecar 或创建 driver。

## 5. 存量插件兼容：升级必须无感（红线）

**红线**：插件系统的任何改动，都不得让用户本地**已安装、已批准、已启用**的插件在升级
后变得不可用，也不得要求用户重新安装、重新确认权限、重新配置凭证或重新落一次技能。
升级后的默认结果只有一个：用户什么都不做，插件照旧能用。

- **判据是用户视角的可用性，不是代码路径没报错。** 插件还在列表里但被标成「已停用」
  「失效」「需重新确认」「需重新安装」，或者启用按钮点不动、技能链断了、面板打不开、
  已配置的凭证要重填 —— 都算不可用。「fail closed 得很干净」不是通过条件。
- **触及范围**（改这些就命中本节，逐条按"老数据怎么办"设计）：批准 receipt 的
  schema／字段必填性／落盘位置、指纹与摘要编码、`validateGhostManifest` 的校验规则、
  slot 名称与参数形态、技能快照布局与链接命名、安装根与状态根路径、`.cindy` 包格式、
  管子协议消息形态、随包种子与内置插件 id／前缀、市场侧的 id 与版本口径。
- **新增校验或新增必填字段，默认必须自带迁移（backfill），不是自带拒绝。** 老数据缺
  新字段是**升级前的正常历史状态，不是攻击证据**，不得按篡改处理。迁移的判据是"能不能
  从旧版本自己的授权事实重建出等价物"：
  - 例：receipt 机制上线前的安装，授权事实就在安装目录的 `ghost.json` /
    `.cindy-trust.json` / `.disabled` 三份文件里（第 3 节所说的"旧版本兼容镜像"）。
    宿主必须能一次性读它们 backfill 出等价 receipt，用户无感。
  - **迁移不得成为扩权或降级通道**，这是它与安全不变量共存的前提：迁移只在该 id
    **从未有过 receipt**（或 receipt 已判损坏）时发生，权限集原样取旧记录、不做并集、
    不吞新增 slot；迁移出的授权**只等价于旧版本已经给出的授权，不等价于一次新的用户
    确认**，因此此后任何 manifest／权限变化照旧走完整确认；迁移来源必须记进日志，
    便于事后分辨"用户确认过"与"宿主迁移来的"。
  - 迁移**读不出**（文件缺失、格式坏）或**自相矛盾**（镜像与内容互斥）时才 fail
    closed，落到下面的兜底义务。
- **receipt schema／指纹编码 bump 必须走「按旧编码核对 → 原地升级」，不是 fail closed
  到重新确认。** 纯格式变更时旧 receipt 的授权事实没有消失：先用旧编码核对旧摘要与当前
  安装字节，对得上就原地重算成新编码并升级 receipt，只有真漂移才 fail closed。一次内部
  格式变更不得变成全体用户重新确认。历史注：v1→v2（NUL framing 修复）没有专门的 v1
  读取器，因为 v1 receipt 从未随任何构建发布、全网不存在；同时一次性 legacy 迁移会把
  「已判损坏」的 receipt 从安装目录 backfill 治愈，效果上覆盖了该场景（有回归用例钉住）。
  **从 v2 起的任何 bump 都必须实现原地升级器**，不得再引用本注作为豁免。
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
  （无 receipt／旧 schema／旧指纹编码／旧目录形态），断言升级后插件仍列为启用、技能仍
  挂链、无需用户操作。只测全新安装流程不算覆盖，这类回归**只在存量数据上出现**。
- **PR 约束**：命中本节的 PR，Description 必须写明「存量插件影响：无」或「有 + 迁移与
  提示方案」，并说明上面的升级用例跑在哪。会让存量插件失效的改动与 mobile 冷更同级：
  需仓库把关人针对该影响明确确认后才能合并，提交者身份不构成例外。漏迁移 = P0。
- **历史教训（本节的由来）**：2026-07-31 合入的批准 receipt 改造
  （`ghostInstallReceipt.ts`）把"无 receipt = 不构成运行授权"一次性作用到全部存量安装，
  只给随包内置插件留了自动补批准的路，市场与本地安装没有 backfill 路径，结果升级后用户
  **所有非随包插件**同时变成停用、必须逐个重新确认，本地包还要求重新提供原始 `.cindy`
  文件（包已丢失就无从恢复）。安全方向是对的，落地方式把一次内部机制升级变成了全量
  用户故障。

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

- **【已修复｜第 5 节红线迁移】存量安装的 receipt backfill。** receipt 机制上线前装的
  插件没有 receipt，`GhostManager.migrateLegacyApprovalsOnce()` 在每轮对账前跑一次(首次
  之后凭迁移 ledger 瞬时 no-op)，从旧的三份事实源(`ghost.json` / `.cindy-trust.json` /
  `.disabled`)重建等价 receipt，让市场与本地安装升级后无感可用；随包内置插件仍走
  provisioning 的 `approveTrustedBundledInstall`(有权威字节可比，是更强的迁移形态)，不
  重复迁移。三条不变量:**全局一次性且崩溃安全**(ledger 是 in-progress→completed 两态状态机:
  首个 backfill 动笔前先原子落 `in-progress` 并钉死本轮 `pendingIds`,全部处理完才原子
  改写成 `completed`;`completed`/存在但读不出 = 门关死,此后缺 receipt 一律 fail closed
  ——否则删 receipt 就能骗一次"从可变安装目录重建授权";`in-progress` = 上一轮中途崩溃,
  续跑**只认清单内的 id**,迁移窗口期间新装再删 receipt 的 id 骗不到重铸;receipt 首写
  在 receipt rename 生效**之前**先补落 completed 台账,且落账失败就拒绝本次批准；它只在
  "完全没有台账"时动笔,不覆盖 in-progress。该门是充分
  守卫,因为能删/改 ledger 的进程本就能直接写伪造 receipt,见下「批准状态根无写保护」)、**不扩权**(权限集原样取当前 `ghost.json`，等价于旧模型无条件
  授权的那一组，此后任何 manifest/权限变化照旧走完整确认)、**只写状态根不动安装目录**
  (三份旧文件原样保留，回滚到旧客户端时仍按安装目录判定，符合第 5 节兜底第 4 条)。核心
  授权事实读不出(manifest 不合法、技能目录含链接、声明的 locale 装入后损坏)才对该插件
  fail closed、走恢复 UI；trust 镜像缺失降级为 `unverified`、`packageSha256` audit-only
  故省略。改动装入／迁移链路时保持这些不变量，尤其不得把迁移改成"每次缺 receipt 就补"
  (那就是把授权事实重新交给可变安装目录，等于回到 #636)。迁移之后批准再丢失的恢复
  路径：市场包走市场重装确认；本地包走「从已装目录重新确认」（`ghosts:reapprove-inspect`
  → 确认卡全量权限清单 → `ghosts:reapprove-installed`，清单字节以 manifestSha256 绑定
  确认间隙，trust 走与迁移同一个封顶读取器，装入侧的指令查重／tokenBroker／保留前缀
  门禁照走）—— 不要求用户重新提供原始 `.cindy`，不存在不可恢复状态；随包插件不走人工
  确认，由启动对账自动补（UI 提示「重启应用即恢复」）。一次性门的完整判据：ledger
  `completed`（或存在但读不出）永久关门；`in-progress` 只按动笔前钉死的 `pendingIds`
  续跑；无 ledger 时先扫描完整安装根，不能因某一个有效 receipt 提前关门——曾短暂合入
  后回滚的 #1080 可能留下「部分有效 receipt + 其余 legacy 安装 + 无 ledger」的历史 mixed
  状态，提前关门会让其余插件永久失效。新代码必须在**首次写任何 receipt 前**先原子落
  completed ledger，落账失败则 receipt 不得生效（否则「新装 receipt 后、下一轮对账前」
  删 receipt 可骗一次按已扩权 manifest 的重铸）；legacy migration/recovery 已先落
  in-progress，因此首份 backfill receipt 不会覆盖迁移清单。
  安装根为空/未诞生时**不落 ledger**——门要留给 owner 命名空间 legacy 恢复流程随后搬入
  的旧目录；恢复流程对刚搬入的 id 走 `backfillRecoveredLegacyGhosts` 旁路（信任级与首轮
  迁移等同，只作用于恢复流程自己搬动的 id）。安装根读失败（非 ENOENT）整轮放弃且不落
  ledger，下次启动重试。迁移失败的 id 记进 ledger 的 `failedIds` 供排查，逐个走上面的
  恢复入口。整轮对账（迁移＋播种＋批准写入）与「从已装目录重新确认」都必须持
  GhostMutationCoordinator 的 owner 租约——状态根路径是每次调用现解析的，不持租约时
  异步 hash/copy 中途账号切换落定，写入会漏进新 owner 的状态根。
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
  新版 Host 的本地装入／更新／inspect 已先识别“未来 `schemaVersion`”与“形状合法但未知的
  字符串 slot”，并以 `GHOST_HOST_UNSUPPORTED` 引导升级，不再把这两类新能力包误报为非法。
  这只改善新版 Host 的错误分类，不改变严格校验，也无法追改已经发布的旧 Host；已装插件在
  客户端降级后从列表消失的兼容缺口仍然存在。
- `networkSlot.ts` 的 `as: 'media'` 不能只信任 Content-Type（GLB 常见
  `application/octet-stream`），需要安全的 magic-byte／扩展名嗅探。
- SSH 远程场景必须让 `LiziMcpSessionContext` 携带 remote 标识；目录过户不得回退读取本机
  同名路径，无法证明来源时 **fail closed**。
- 手机版仍需把历史 mivo 动作按钮降级为纯展示。
- **安装内容字节仍可变、且加载时不校验。** 批准 receipt 钉住的是授权事实
  （manifest／trust／启停／revision），逻辑页代码仍从 `cindy-brain/<id>/` 现读；
  `packageSha256` 只是批准时点的来源指纹（市场／本地包 = `.cindy` 文件哈希，随包种子 =
  内容目录哈希），**没有任何运行期校验消费它**。因此能写这个目录的本机进程仍可替换
  代码，只是被限制在**此前已批准的权限集**内运行，且不能借改写 `ghost.json` 扩权。
  技能目录因为越出沙箱已单独拷成快照（第 3 节），其余内容的持续完整性校验仍未做——
  改动装入链路时不得声称已有内容完整性保证。
- **批准状态根自身没有写保护。** 这是与上一条并列、但**不同**的缺口：上一条说的是
  内容根字节可变，这一条说的是 `<userData>/ghost-install-state/` 本身对同权限本机进程
  可写。当前实现已经把能在写入侧关掉的窗口关掉了，**剩下的是消费侧的窗口**，两者要分清：
  - **已关闭（写入侧）**：技能快照的字节指纹在每次写批准事实时都重新核对——接受既有
    快照前核一次、复制到临时目录后核一次、`rename` 就位后再核一次（`skillSnapshotMatchesReceipt`
    是唯一判据）。因此"复制完到 rename 之间被改写"与"快照事后被就地改写"都会在下一次
    写批准事实时暴露：对不上就删掉重建，重建仍要过安装目录的字节校验，安装字节也漂移
    时一律拒绝并退回完整重新确认。
  - **仍未关闭（消费侧瞬时窗口）**：启动/装卸/启停广播触发技能对账时，Host 会在建立
    或保留共享链接前重新核对整棵批准快照；但这次核对之后、主 Agent 顺着共享技能链接
    读取之前，快照仍可被同权限进程改写。Agent 的读取路径不在宿主控制内，宿主不做逐次
    校验。receipt 同理——它有严格结构与字段校验（改坏即判 `invalid`、fail closed），
    但没有签名或 MAC，能写状态根的进程可以伪造一份结构合法的批准。
  - 彻底关闭需要给状态根加签名／MAC 或 OS 级写保护，**尚未做**；改动批准链路时不得声称
    批准状态不可伪造，也不得把"写入侧已核对"说成"消费时读到的一定是被批准的字节"。
- **点开头目录的内容不进随包指纹（有意为之，不是缺口）。** `fingerprintDirContent` 与
  `hashApprovedDirectory` 都跳过 `.` 开头条目（`.disabled`、`.cindy-trust.json` 是用户与
  宿主状态，不是插件内容），点开头**目录**整条不递归。之所以安全：清单里所有相对路径
  （`entry` / `node.entry` / `panel.html` / `settingsHtml` / `icon` / `locales` / skill
  `dir`）都过 `isSafeGhostRelativePath`，段首字符必须是 `[a-zA-Z0-9_]`，任何声明都不可能
  指向点开头目录里的文件——它们既不会被当代码加载，也不会被当技能读取。点开头条目本身
  的**类型**仍然要判（名为 `.x` 的链接会翻起 `hasNonRegularEntry` 并触发重新播种），
  判定顺序见 `ghostContentTree.collectGhostContentFiles`。改这条策略前先确认清单路径
  正则没放开首字符。

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
3. 运行授权是否只取自 Host receipt，而不是可变安装目录？无批准／损坏批准是否 fail
   closed（列为停用、不许启用、不落技能链），且 UI 如实说明并给出重新确认入口？停用
   方向是否无论环境如何都能成功？改了技能落链或快照时 `approvalStateRoot` 是否仍必填？
   任何"从安装目录取字节"的路径（快照重建等）是否都复现了装入侧的门槛——字节指纹逐项
   对上、SKILL.md 定长后再读？失败时是拒绝并退回重新确认，而不是就地自愈成新批准？
4. 网络是否限白名单域名、凭证无明文读回？附件／媒体／目录是否经归属校验的
   grant／deposit／ledger 交接，未暴露宿主绝对路径？
5. 内联凭证是否只走 trusted Desktop 专用 IPC，未登记 device-link？Main 是否重新校验
   sender、request、revision、action、精确字段集合与 manifest 绑定，且没有把 Renderer
   字段 id 直接当作 Secret key／路径？保险库写失败是否不 emit，写成功后是否仍重新
   assessment，而不是把“提交完成”当作 ready？
6. Forge（scaffold／pack）是否排除了 Host 受管根（安装根 + 批准状态根），且按 realpath
   **双向**判定（源目录既不在受管根内、也不是它的祖先）、挡住大小写与软链／junction
   别名？递归收集是否不跟随链接进受管根？
6.5. 新增的"读插件内容目录"代码是否走 `ghostContentTree.ts` 取判据（`lstat` 分类 +
   相对路径逐段解析 + 统一指纹格式），而不是就地 `readdir` + `isDirectory()` 或 `stat`
   直读？策略差异（点开头条目算不算内容、非普通条目 throw 还是 flag）是否以显式参数
   表达而不是复制一份实现？
6.5a. **新增的路径式 worker（skill snapshot、Forge scaffold 等）是否采用
   「操作前检查（fast fail）→ 原子操作 → 操作后复验 → identity-guarded cleanup」
   模式，而不是仅靠操作前检查判定安全？** 操作后复验是否落在原子操作**之后**、
   无 TOCTOU 间隙的位置（如 `rename` 之后立刻 `lstat` + identity compare，而不是
   在 `rename` 之前加更多 `lstat`）？pre-check 与 rename 之间的间隙是 Node.js 未暴露
   `renameat` 等 fd-relative 原语的硬边界，不可消除——因此安全判定必须在操作之后做。
   cleanup 时是否按 `dev`/`ino` identity 守卫而非仅按 pathname 删除？
6.6. **存量插件升级后还能不能用（第 5 节红线）**：本次是否改了 receipt schema／必填
   字段／落盘位置、指纹或摘要编码、manifest 校验、slot 形态、快照与链接命名、安装根或
   状态根路径、`.cindy` 包格式、管子协议、内置 id？命中就逐条问：用户升级后**什么都不做**
   时，已装、已批准、已启用的插件是否照旧可用？新增的必填字段／新校验是否自带从旧版
   授权事实的 backfill，而不是把"老数据缺字段"当篡改直接 fail closed？迁移是否只在
   "从未有过 receipt／已判损坏"时发生、权限集原样不扩权、来源有日志？自动做不到时是否
   有明确提示 + 一次性批量恢复入口（不是"去市场逐个重装"）、且不清掉用户已存的凭证与
   偏好？新状态被旧版本读到是否不判损坏（可回滚）？是否有基于旧布局 fixture 的升级用例，
   而不是只测全新安装？让存量插件失效且无迁移 = P0，需把关人对该影响明确确认。
7. 改动是否命中作者可见契约（身份卡／管子／模型 slot／面板供片／打包）？命中就必须
   同步 `FORGE_GUIDE` 并在 PR 说明；漏同步 = P1。
8. 第 7 节的已知缺口是否被触及？触及是否一并修复或留了正式跟踪？
9. 新增 IPC／推送是否需要远程／手机版？需要就登记 device-link 白名单与 topic 路由。

最小验证入口：

```bash
pnpm --filter desktop exec vitest run src/main/cindy-brain
pnpm --filter desktop typecheck
```

其余按 [`desktop-development.md`](desktop-development.md) 的分层验证选择；命中媒体、协议或
IPC 时追加对应专项规则要求的验证。
