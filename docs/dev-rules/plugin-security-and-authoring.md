# 插件运行时安全与作者契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改插件（`.cindy`）的运行时、沙箱、权限、能力声明、面板供片、
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

| 内容                                                 | 权威来源 |
| ---------------------------------------------------- | -------- |
| 编写手册（作者唯一教材，现拿现读）                   | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `FORGE_GUIDE`，经 `ghost_forge_guide` 工具下发 |
| `ghost.json` 身份卡字段与校验                        | `packages/plugin-protocol/src/manifest.ts` 是跨消费者协议正本；`apps/desktop/src/shared/ghost.ts` 是 Desktop 运行时 validator。除下文登记的 Desktop-only 能力外，两端必须同步维护 |
| 管子协议类型                                         | `apps/desktop/src/shared/ghost.ts`（`cindy.send` / `cindy.onHostMessage` 类型） |
| 打包限制                                             | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `packGhostDir` |
| 运行时、沙箱进程与生命周期                           | `apps/desktop/src/main/cindy-brain/runtime/GhostRuntime.ts`、`GhostManager.ts` |
| 安装事务状态、内容摘要与技能快照 receipt             | `apps/desktop/src/main/cindy-brain/ghostInstallReceipt.ts`，状态投影见 `shared/ghost.ts` 的 `GhostInstallApproval` |
| 能力实现（网络／通知／确认／文件系统／技能／宿主等） | `networkSlot.ts`、`notifySlot.ts`、`badgeSlot.ts`、`confirmSlot.ts`、`fsSlot.ts`、`cindySlot.ts`、`skillSlot.ts`、`agentSlot.ts`、`errandSlot.ts`、`iosSimulatorSlot.ts`；持久作品库见 [`plugin-library-storage.md`](plugin-library-storage.md)，主实现在 `libraryVault.ts`、`librarySlot.ts`、`libraryDbCore.ts` |
| 面板供片、注入主题 token 与协议                      | `apps/desktop/src/renderer/cindy-brain/ghostPanelTheme.ts`、`cindy-ghost://` 分支 |
| 插件详情能力说明 UI                                  | `apps/desktop/src/renderer/features/plugin/GhostPluginDetailView.tsx` |
| 远程／手机版能力准入白名单                           | `packages/device-link/src/allowlist.ts` |
| 行为与安全不变量                                     | `apps/desktop/src/main/cindy-brain/__tests__/`、`forge.test.ts` |

文档与实现冲突时以代码为准，但必须在同一改动内同步修正本文与手册。

## 1. 插件形态与代码术语

- `.cindy` 是以 `ghost.json` 为身份卡的插件包，现行唯一形态为 `kind: 'chip'`。
- 代码目录与运行时使用 `cindy-brain` / `Ghost` 命名，**不得重新引入已退役的 cartridge
  声明型兼容层**。
- `cindy-` / `filo-` / `xd-` 是官方保留 id 前缀，第三方插件不得占用；前缀正本见
  `apps/desktop/src/shared/ghost.ts` 的 `GHOST_OFFICIAL_ID_PREFIXES`。

### 1.1 Manifest v3 直接能力声明

- 新插件统一使用 `schemaVersion: 3`，并填写插件实际依赖的首个 Cindy 正式版本作为
  `minCindyVersion`。Manifest schema 不设置统一的 Cindy 版本下限；具体版本只属于插件包元数据。
  v3 **没有** `slots`；
  `tools`、`card`、`panel`、`mainView`、`subscribe`、`skill`、`cindy`、`agent`、`node`、`network`、
  `preview` 等顶层字段本身就是插件贡献项或自主 Host 能力的直接声明。
- 无配置的布尔能力只接受字面量 `true`：`notify`、`badge`、`confirm`、`fs`、`library`、
  `sessionContext`、`pick`、`workspace`、`iosSimulator`。不用就省略，写 `false` 是无效清单。
- `card: {}` 与 `agent: {}` 分别表示基础卡片能力和由真实用户点击触发 Agent 回合；
  其它对象型能力必须至少包含一项真实能力，不能用空对象占位。
- v3 未识别的顶层字段必须原样保留，但当前 Host 不展示、不授权、也不因此阻止安装。
  未来 Host 识别该字段后，才按正常的能力展示和运行时守门链路启用。不能把
  未知字段猜成现有权限，也不能让它意外获得能力。
- **Agent 在途调用不需要重复登记具体操作。** 插件工具是否执行由当前
  `ghost_call` 的 Cindy Agent 授权决定；普通网络和当前工作目录操作使用主机
  下发且仍在途的 `callId`。随包代码与 CLI 继续使用已有 Node 工作进程，顶层
  `node` 字段只声明这一运行形态，不预登记具体命令。不得为具体 CLI、域名或路径
  新增 Slot、manifest 字段或客户端特例。只有插件要在 Panel、订阅、常驻进程、
  后台任务等**脱离当前 Agent 调用**的场景自主使用 Host 能力时，才需要
  对应直接字段。需要 Cindy 尚未实现的真正新 Host 服务时，才提高
  `minCindyVersion` 并增加客户端实现。
- `schemaVersion: 2` 只作存量兼容。Desktop 在验证边界把已知 `slots` 显式映射为同名的
  v3 直接字段；运行时只消费规范化后的直接字段。未知但格式合法的 v2 slot 不阻止安装，
  运行时也不授予任何能力。未来支持必须新增明确映射，不得按名称猜测。
- v2 的空 `slots` 和历史零能力声明可继续安装，规范化时直接丢弃。v2 → v3 更新按规范化
  后的直接能力比较；只删除 `slots`、能力等价时不算新增权限。
- 安装／更新与能力授权解耦：用户导入 `.cindy`、明确要求当前 Agent 通过 Forge 安装、
  点击市场安装或命中服务端
  `defaultInstall` 即构成安装依据，真实包校验通过后直接安装并启用，不追加能力确认弹窗。
  插件自主 Host 能力仍须在 manifest 如实声明、在插件详情展示，并由 Host
  运行时强制守门；动态资源与 Agent 在途操作不重复建权限实体，继续复用 Cindy 既有
  Agent 授权系统，不新增 grant／申请状态机。

## 2. 运行时沙箱与进程隔离

- 每个运行中的插件使用独立 Electron 沙箱进程与专属 session partition。沙箱禁止直接访问
  Node、宿主文件系统和网络。
- 插件只允许读取自身安装目录内、经安全相对路径校验的静态资源，不得越权读取其它目录。
- 逻辑页只能经最小 `contextBridge` 管子申请主机能力；面板 webview 保持零特权桥。
- 主机按 `webContents` 绑定反查真实 ghostId，**不信任 sender 自报身份**。
- 沉睡、抽离和主机退出必须终止对应沙箱；沙箱崩溃只由 `GhostRuntime` 收敛，不得带崩
  主应用。

## 3. 权限即授权边界

- 先判断**谁在执行**，再判断授权边界：
  - 当前 Agent 在途 `ghost_call` 是否执行插件工具，由该会话既有的 Agent 授权决定。
    普通网络和工作目录操作以 Host 下发的严格在途 `callId` 绑定会话；随包代码与
    CLI 仍由已有 Node 工作进程执行，不新增 Host 进程协议或具体命令登记。
  - 插件脱离当前 Agent 调用的自主 Host 能力，必须先在 manifest 以对应顶层字段
    直接声明，通过校验，在插件详情中如实展示，再由 Host 代码强制守门。
- Agent 调用必须同时满足：`callId` 尚在途、绑定同一插件、绑定本地会话。已交卷、
  他插件、scheduler 脚本、Panel 和后台调用都不得借此绕过自主能力声明。
  对未声明公网目标，Host 必须在每一跳完成代理选择与 DNS/IP 守门后、真正 dispatch
  前再次复核同一 `callId`；直连与系统代理都只能连接该次守门确认的 IP，代理不得
  重新解析插件提供的域名。选中代理不构成私网授权；无法证明由当前代理生成的 fake-IP
  仍按特殊用途／私有地址拒绝。
- 安装／更新不以弹窗点击作为能力授权事实；
  **prompt 和前端展示都不构成安全边界**。
- 新增或修改能力声明时，除同步编写手册与校验（下节 6）外，还必须同步 shared 类型、
  preload／host handler、详情能力 UI（`GhostPluginDetailView.tsx`）、错误边界和测试。

### 3.1 安装与自动更新

- 首次安装只来自四种明确依据：用户导入本地 `.cindy`、明确要求当前 Agent 调用
  `ghost_forge_install`、用户点击某个市场条目的安装，或服务端为当前 owner 下发
  `defaultInstall`。安装成功默认启用；插件声明哪些能力不改变
  安装动作是否需要确认，因为安装不设能力确认弹窗。
- 市场安装账本是后续更新来源的唯一事实：服务端市场按 `pluginId + releaseId` 路由，
  自定义市场还必须匹配 `sourceKey`；已装目录的原始 `ghost.json` 字节 SHA-256 必须与账本
  一致。旧记录缺少 raw 字段时，Host 只能按已发布的 legacy digest 编码核对同一份受限读取
  的字节，命中后原地补字段且不改 `updatedAt`；raw 字段已经存在但不匹配时必须 fail closed，
  不得用当前目录覆盖基线。`manifestDigest` 保留旧语义供降级客户端读取，不能改写成 raw SHA。
  同 id 来源冲突或目录漂移通常不得被自动覆盖，只能由用户显式选择替换来源。唯一受控例外是：
  当前组织下发 `defaultInstall`、组织与合法非空前缀都精确匹配、同 ghost id 在目录中唯一时，
  可以接管无有效市场来源的普通本地安装，或修复同一目标 `pluginId` 的坏 market / legacy-adopted
  记录。接管仍要求现有 receipt 已批准、未显式卸载退订、插件不忙，并在落位前于 ghost id 锁内
  重读 owner、来源、批准与退订事实；不得覆盖有效的公开／其它组织市场路由或 Git／本地自定义
  市场路由。`ghost_forge_install` 的首装与更新一律记录 `agent-forge`，作为作者本地自测保护，
  不进入自动接管；普通 `.cindy` 导入仍是 `manual`，不享受这项保护。自动接管不得复用用户手动
  换源的退订语义，不写 `markRemoved` 或 default-install opt-out。普通本地／Forge 换源只把
  旧来源记录置为 `installed=false`，不得新增或清除 opt-out；只有用户显式卸载才写 opt-out。
- 所有仍匹配稳定来源的已装插件都静默自动更新，不限 public／organization、也不限
  `defaultInstall`。更新保持现有启用状态，不弹成功 toast；插件正有调用、派活或 Cindy
  工作时跳过，下一轮重试。服务端市场按客户端版本投影最近发布、曾上架且仍有效的兼容
  Release；current 不兼容时回退兼容历史版本，没有兼容版本时不展示。Desktop 信任该投影，
  不再用 `minCindyVersion` 二次筛选、跳过或弹兼容性确认。自定义市场和本地 `.cindy` 采用
  同一安装策略：`minCindyVersion` 是发布／发现元数据，不是客户端安装授权或确认闸门。
  真实包身份、Release 摘要、能力上限、Manifest schema 与当前 Host 是否能解析仍按各自
  安全边界校验，不能把包内容异常降级成“仍要安装”。
- 自动对账在 owner 稳定后的启动／登录切换、应用回前台、系统唤醒和 30 分钟周期触发。
  不新增持久化任务队列或“是否自动更新”设置；卸载写下的 opt-out 继续阻止默认安装复活。
- 同一 release 自动更新失败后，在当前进程内按 owner、来源路由和 release 做指数退避
  （5 分钟起、最长 6 小时），日志记录失败次数与下次重试时间；来源发布新 release 时立即
  解除。忙碌跳过不记失败，用户手动重试不受退避限制。
- 服务端包必须通过 release SHA／大小校验，真实包能力不得超出该 release 的市场 manifest；
  自定义市场以发现并规范化的 manifest 为能力上限。能力上限内的新版声明可静默更新，超出
  则按包内容不一致拒绝并留待来源修复，不转成用户审批流程。能力上限按 Host 实际消费语义
  比较：真实包不得从无到有增加 `settingsHtml` 设置 WebView 或扩大固定 `settingsHeight`；
  OAuth `scopes` 换序或取子集属于收权，其它 OAuth、凭证标签与注入字段仍须保持在清单上限内；
  `setup.requires` 只能保留或删除市场已有的完整需求组，不能增加组、收紧 `anyOf` 或更换引用；
  真实包同名工具的 `parameters` JSON Schema 必须与市场规范值一致（仅对象键顺序可不同）。
- 本地 `.cindy` 没有稳定来源，不自动更新；用户再次导入同 id 新包时直接原位更新，由 Main
  保持当前启用状态。
- Host receipt 是安装事务和运行完整性的状态记录，不是一次交互式“能力授权”。合法的安装／更新
  事务直接写入 receipt，钉住 canonical manifest、trust、启停态与随机 `revision`；
  `ghostInstallApprovalToken()` 只是 Renderer 与 Main 之间防止并发漂移的前置条件，不是权限凭证。
  没有或损坏 receipt 的存量安装优先走自动迁移／对账，不能改成逐插件能力确认弹窗。
- receipt 不等于“安装目录从此不可变”的证明：普通 `packageSha256` 仍是安装时点来源指纹；
  真正越出沙箱的技能继续使用 receipt 绑定的字节指纹与 Host 状态根快照。不要把审计字段误写成
  全量运行时内容校验，也不要因取消能力确认弹窗而删除现有完整性守门。
- **Forge 的源码区与 Host 受管根互斥。** `ghost_forge_scaffold` / `ghost_forge_pack` /
  `ghost_forge_install` 的目标
  必须是当前会话工作目录里的独立作者目录；命中安装根或状态根一律拒绝，并按 realpath
  挡住大小写折叠与软链／junction 别名。`ghost_forge_pack` 只负责校验与打包；只有用户明确
  要求后调用独立的 `ghost_forge_install` 才安装或更新，不因 scaffold／pack 成功而隐式安装。
- `skill` 是唯一**越出沙箱**的能力：技能指令由主 Agent 以用户全部权限执行、全局
  生效、不随 workdir 级停用隐藏。其安全边界是**声明一致性**（manifest 里的
  name／description 必须与 SKILL.md frontmatter 逐字一致，`skillSlot.ts` 的
  `checkSkillMdConsistency` 是唯一裁判，打包与装入、以及 Host 固化快照三侧共用；注意它**只**
  校验 frontmatter 的 name／description，正文与辅助文件不在它的判据里）+
  **Host 固化快照与字节指纹**（安装／更新事务提交时把技能目录逐字节拷进
  `<状态根>/skill-snapshots/<id>/<revision>`，只收普通文件，同时把逐 item 的内容
  指纹钉进 receipt 的 `skillContentSha256`——装入/更新时该指纹取自 **`.cindy` 包的
  内存投影**(inspect 时已被 `packageSha256` 钉住的那份字节),不从已发布的可变安装
  目录首读:publish 与首次 hash 之间被换的字节应当在快照对账时被拒,而不是被首读钉成
  固化基线；安装事务校验的 SKILL.md 必须就是 Agent 之后
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
  辅助文件"，那会把一份未经合法安装／更新事务校验的指令在一次启用里固化成
  宿主快照并全局挂链。对不上一律 fail closed，要求重新安装合法包，不许就地自愈成新固化状态；
  `skillContentSha256` 因此是
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
    fail closed 并按第 5 节迁移，不能拿旧摘要继续授权。**编码 bump 属于第 5 节的存量兼容
    场景**：先按**旧编码**核对旧摘要与当前安装字节，对得上就原地重算成新编码并升级
    receipt（安全水位与旧版本已提供的保证等价），只有对不上（真漂移）才 fail closed 并
    要求重新安装合法包——不得把一次纯格式升级直接变成全体用户的重新安装操作。
  - 同理，"源目录与受管根的包含关系"必须**双向**判（既不能落在受管根内，也不能是受管
     根的祖先）：单向判定下只要在 owner 数据目录里放一个 `ghost.json`，递归打包就会把
     已安装插件字节、批准 receipt 与技能快照打进 `.cindy`。
  - 随包种子是第一方输入；发现链接、junction、FIFO 等非普通条目必须整颗跳过并告警，
    不得在复制时静默丢弃后继续写批准 receipt。

## 4. 网络、凭证与资源交接

- 自主 network 只允许 manifest 白名单域名；凭证由主机保险库注入，**无明文读回**
  给沙箱。Agent 在途调用可凭严格 `callId` 访问未预声明的普通 HTTPS 地址，仍须通过
  主机 URL、SSRF、超时、体积与重定向守门。此途径不注入任何未在 manifest 中声明且
  未命中目标 host 的托管凭证。
- `source: "gh-cli"` 是只为官方 `cindy-github` 保留的宿主凭证来源：Host 优先读取
  本机 `gh auth token`，不可用时才回落到同 key 经 `/secrets` 保存的 PAT。两种 token
  均只在 Main 的 networkSlot 内存中注入 `api.github.com` 的
  `Authorization: Bearer` 请求头，不得进入插件、Renderer、Agent、KV、日志或 Node
  Worker。设置页只能读取 `hostAvailable` 布尔与备用 PAT 的 `saved/tail` 状态。该来源
  不允许 `exchange` 或 `setup.requires` 引用，第三方插件不得声明。
- `source: "oidc-token"` 是 Host 托管的短时 Cindy Connection JWT：只对当前企业
  Membership 生效。资格有两条默认基座：当前组织的 Plugin Market organization 安装记录仍有效、
  且安装目录 `ghost.json` 的 raw SHA（旧记录迁移前为集中 legacy digest）与记录一致；
  Manifest 与身份必须来自同一次受限读取，禁止分两次读取后分别校验与消费；或企业作者显式使用 `ghost_forge_install`
  安装、在提交前核对插件 id 与精确注入域名，且插件 id 命中当前组织前缀。手动导入不取得
  Forge 作者资格。另有一条点名例外：`ghostId` 精确等于 `mivo-canvas` 的组织成员本地安装，
  在已装 manifest 声明的精确 `oidc-token` host 仅为 `mivo-canvas.dsworks.cn` 时可解析 audience；其它本地插件、个人账号、
  通配 host、其它精确 host 仍不签发。若该插件已有市场 organization 记录（含 `installed:false` 的卸载残留），不得走白名单捷径，必须仍走
  digest 校验。市场账本损坏、schema 不认或该 ghostId 记录校验失败时 fail-closed，不得当成「无记录」走例外。Host 根据当前组织和插件 id 推导 audience。
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
  Setup、OAuth、Secret／凭证或其它运行时确认边界，也不改变第 3.1 节的安装／更新策略。
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
- `iosSimulator` 能力只允许读取 Host 当前台前任务的公开模拟器状态，并请求打开既有
  Host viewer。请求协议不得出现插件自报 `sessionId`，可选 `instanceId` 必须重新匹配
  当前任务的公开实例。视频帧、viewer lease、触控、Sidecar／Helper、artifact 路径、进程
  句柄和私有诊断都不得跨进插件沙箱；Agent 侧构建／安装／控制继续走 Host 注册的
  `cindy_ios_simulator` MCP。该能力是本机 Desktop 专属，不进入 device-link/mobile，
  SSH／远程任务 fail closed。状态查询必须走脱敏、短缓存、无副作用的只读投影，不得借
  panel 轮询执行 ownership reconcile、续租、启动 WDA／Sidecar 或创建 driver。

## 5. 存量插件兼容：升级必须无感（红线）

**红线**：插件系统的任何改动，都不得让用户本地**已安装、已启用**的插件在 Cindy 升级
后变得不可用，也不得要求用户重新安装、额外确认、重新配置凭证或重新落一次技能。
升级后的默认结果只有一个：用户什么都不做，插件照旧能用。

- **判据是用户视角的可用性，不是代码路径没报错。** 插件还在列表里但被标成「已停用」
  「失效」「需恢复安装」，或者启用按钮点不动、技能链断了、面板打不开、
  已配置的凭证要重填 —— 都算不可用。「fail closed 得很干净」不是通过条件。
- **触及范围**（改这些就命中本节，逐条按"老数据怎么办"设计）：宿主侧批准状态记录
  （receipt 一类）的 schema／字段必填性／落盘位置、指纹与摘要编码、
  `validateGhostManifest` 的校验规则、能力字段与参数形态、技能快照布局与链接命名、
  安装根与状态根路径、`.cindy` 包格式、
  管子协议消息形态、随包种子与内置插件 id／前缀、市场侧的 id 与版本口径。
- **新增校验或新增必填字段，默认必须自带迁移（backfill），不是自带拒绝。** 老数据缺
  新字段是**升级前的正常历史状态，不是攻击证据**，不得按篡改处理。迁移的判据是"能不能
  从旧版本自己的安装验证事实重建出等价物"：
  - 例：receipt 机制上线前的安装，等价事实就在安装目录的 `ghost.json` /
    `.cindy-trust.json` / `.disabled` 三份文件里（第 3 节所说的"旧版本兼容镜像"）。
    宿主必须能一次性读它们 backfill 出等价 receipt，用户无感。
  - **迁移不得成为扩权或降级通道**，这是它与安全不变量共存的前提：迁移只在该 id
    **从未有过 receipt**（或 receipt 已判损坏）时发生，manifest 及运行事实原样取旧记录、
    不做并集、不吞新增能力；迁移只重建旧版本已有的等价安装验证状态，之后的
    manifest 变化只能由新的合法安装／更新事务固化；迁移来源必须记进日志，便于事后分辨
    “正常安装写入”与“宿主迁移来的”。
  - 迁移**读不出**（文件缺失、格式坏）或**自相矛盾**（镜像与内容互斥）时才 fail
    closed，落到下面的兜底义务。
- **receipt schema／指纹编码 bump 必须走「按旧编码核对 → 原地升级」，不是 fail closed
  到用户重新安装。** 纯格式变更时旧 receipt 的安装验证事实没有消失：先用旧编码核对旧摘要与当前
  安装字节，对得上就原地重算成新编码并升级 receipt，只有真漂移才 fail closed。一次内部
  格式变更不得变成全体用户重新安装。历史注：v1→v2（NUL framing 修复）没有专门的 v1
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
     errand 配置、面板状态。恢复的是安装验证记录，不是用户的配置。
  4. **留回滚余地**：新版本写出的状态被旧版本读到时不得当成损坏——未知字段忽略而不是
     判 `invalid`，否则用户一旦回退旧版就再炸一次。
- **测试门槛**：命中本节的 PR 必须有"从旧状态升级"的自动化用例——fixture 造出老布局
  （无 receipt／旧 schema／旧指纹编码／旧目录形态），断言升级后插件仍列为启用、技能仍
  挂链、无需用户操作。只测全新安装流程不算覆盖，这类回归**只在存量数据上出现**。
- **PR 约束**：命中本节的 PR，Description 必须写明「存量插件影响：无」或「有 + 迁移与
  提示方案」，并说明上面的升级用例跑在哪。会让存量插件失效的改动与 mobile 冷更同级：
  需仓库把关人针对该影响明确确认后才能合并，提交者身份不构成例外。漏迁移 = P0。
- **插件基座改动一律走白名单确认门。** 「基座」= 所有已装插件共同踩着的那一层：运行时与
  沙箱、来源／信任 receipt、能力声明、打包与内容判据、manifest 契约、装入与能力说明 UI、已装
  列表投影（`main/cindy-brain/`、`main/plugin-market/`、`main/mcp-integrations/ghost.ts`、
  `shared/ghost.ts`、`packages/cindy-tools` 的 ghost 部分，以及 renderer 侧的
  `installFlow.tsx`／`installErrorKey.ts`／`GhostPluginDetailView.tsx`／`useInstalledGhosts.ts`／
  `runtimeStates.ts`／`features/plugin/lib/ghostPluginViewModel.ts`／
  `features/plugin/lib/pluginMarketPresentation.ts`）。命中即需放行人在 PR 上明确
  Approve 才能合并，**不看 diff 大小，也不因为「是 bugfix／纯技术改动」就放过**——#1080
  正是以 `fix` 身份、按纯技术改动被放过的。这条与本节前面的义务是一套：门只保证「有人
  看过存量影响」，看什么按上面逐条对。纯粹改插件面板视觉、纯文案／locale 不算基座。
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

`ghost_forge_pack` 的边界严格止于校验和生成 `.cindy` 产物；打包成功不构成安装依据，
不得顺带安装、更新或启用插件。安装由用户导入本地包、明确要求当前 Agent 调用独立的
`ghost_forge_install`、点击市场安装或服务端 `defaultInstall` 明确触发；Forge 安装与本地
导入必须复用同一套 Main 安装／更新事务。

凡改动**插件作者可见的契约**，同一改动内必须同步更新手册对应章节：

- (a) `ghost.json` 身份卡字段或校验规则（`shared/ghost.ts` 的 `validateGhostManifest`）；
- (b) 管子协议（`cindy.send` / `cindy.onHostMessage` 的消息形态，`shared/ghost.ts` 管子类型）；
- (c) Cindy 模型代办能力的 kind／参数／模型白名单；
- (d) 面板供片协议与注入的主题 token（`cindy-ghost://` 分支、`ghostPanelTheme.ts` 白名单）；
- (e) 打包限制（`forge.ts` 的 `packGhostDir`）。
- (f) 安装、来源绑定、自动更新与能力展示的用户可见行为。

其中 `ghost.json` 属于 Ghost manifest 协议。新增或修改字段、v2 兼容映射或枚举时，至少同步：

1. 协议正本 `packages/plugin-protocol/src/manifest.ts` 及其测试；
2. Desktop 完整镜像 `apps/desktop/src/shared/ghost.ts` 及其测试；
3. 作者文档 `FORGE_GUIDE` 的对应章节及 Forge 测试。

`mainView` 的现行协议在 `FORGE_GUIDE` §4.20；v2 的 `main-view` 只保留输入兼容。
`mainView.icon` 只接受 Cindy 系统线性图标
`puzzle`、`globe`、`code`、`folder`、`database`、`chart-column`、`image`、
`message-circle`、`calendar-days`，缺省回退 `puzzle`。枚举值直接等于图标名，不设别名；
该字段只控制主视图侧边栏入口，不替代或修改根级 `icon` 品牌图片协议。后续扩展该枚举时也
必须遵守第 5 节的存量兼容红线，并核对第 7 节的旧客户端降级缺口。

反向同样成立：改校验必须同步手册；改手册宣称的新能力必须真有实现。`forge.test.ts` 的
关键章节存在性测试只是最低闸，不替代逐条人工核对。

**PR 约束**：命中上述任一路径的 PR，Description 必须写明「手册已同步（改了哪节）」或
「无需同步 + 为什么不涉及作者契约」；漏同步 = P1。

## 7. 已知安全／兼容缺口（不得随旧文档删除而视为完成）

以下缺口在触及相关链路时必须一并修复，或在 PR 中保留明确的正式跟踪，不得静默丢弃：

- **存量安装的 receipt backfill 必须无感。** `GhostManager.migrateLegacyApprovalsOnce()` 在对账前
  从旧安装事实重建等价的安装状态记录；迁移必须崩溃安全、不扩张 manifest 能力、只写状态根，
  并受 owner 租约保护。能自动重建时不得要求用户重新安装或确认能力；确实无法重建时应进入统一的
  legacy recovery 状态并保留凭证与偏好，不能伪装成普通停用，也不能把能力审批弹窗当恢复方案。
- **manifest 扩展的降级兼容（#1283）。** v3 通过“未知顶层字段原样保留，但当前 Host
  不展示、不授权、不阻止安装”解决向前兼容；能力一旦被 Host 支持，必须成为明确的直接字段
  和权限映射。v2 仅保留输入兼容：未知但格式合法的 slot 允许安装、运行时不提供能力。
  不得恢复独立的 Host slot 支持表或按名字猜测映射。`subscribe.topics` 等带具体
  运行语义的子枚举仍严格校验；`schemaVersion > 3` 仍以 `GHOST_HOST_UNSUPPORTED` 拒绝，避免
  当前 Host 误读整体结构变化。已经发布的旧 Host 无法追改，降到 v3 改造前仍可能拒绝新清单。
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
    时一律拒绝并要求重新安装合法包。
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
2. 是否先按执行者分清边界：当前 Agent 在途的通用操作是否严格绑定同插件、同会话、
   未交卷的 `callId` 并复用 Agent 授权；插件自主 Host 能力是否以 manifest 直接字段声明、
   在详情如实展示并由 Host 守门？是否误把安装弹窗或前端展示当成授权事实？
3. receipt 是否仍只由 Main 的合法安装／更新／迁移事务写入？跨进程更新是否回传
   `ghostInstallApprovalToken()` 并在锁内重读比对？缺失或损坏状态是否优先无感迁移，
   而不是重新引入能力确认？停用方向是否始终可成功？技能快照与字节指纹是否仍受保护？
4. Agent 在途网络是否仍通过 URL／SSRF／重定向等 Host 守门，自主网络是否限 manifest
   白名单，托管凭证是否只向声明且命中的 host 注入、无明文读回？附件／媒体／目录是否经
   归属校验的 grant／deposit／ledger 交接，未暴露宿主绝对路径？
5. 内联凭证是否只走 trusted Desktop 专用 IPC，未登记 device-link？Main 是否重新校验
   sender、request、revision、action、精确字段集合与 manifest 绑定？
6. Forge（scaffold／pack／install）是否排除了 Host 受管根，按 realpath 双向判定并挡住
   大小写与软链／junction 别名？`ghost_forge_pack` 是否仍然只产出 `.cindy`，没有隐式安装；
   `ghost_forge_install` 是否只在用户明确要求时调用并复用本地安装／更新事务？
6.5. 新增的“读插件内容目录”代码是否走 `ghostContentTree.ts` 的统一分类、逐段路径解析和
   指纹格式，而不是就地复制一份 `readdir`／`stat` 实现？
6.6. **存量插件升级后还能不能用（第 5 节红线）**：改动安装状态记录、manifest、能力字段、
   快照、安装根、包格式或管子协议时，是否提供无感 backfill，保留已装、启停、凭证与偏好，
   并覆盖旧布局 fixture？让存量插件失效且无迁移 = P0。
7. 改动是否命中作者可见契约（身份卡／管子／模型代办能力／面板供片／打包）？命中就必须
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
