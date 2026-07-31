# 插件运行时安全与作者契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改插件（`.cindy`）的运行时、沙箱、权限、能力 slot、面板供片、
> 网络／凭证／文件交接，或插件作者可见的身份卡、管子协议、打包与编写手册之前

本文治理 Cindy 中运行的插件——以 `ghost.json` 为身份卡的 `.cindy` 包。它同时约束两件
互为一半的事：**运行时权限安全**（宿主如何隔离并授权插件）和**作者契约同步**（改了
作者可见的能力，必须同步编写手册与校验）。Electron 进程与协议安全另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
媒体字节交接另见 [`media-storage-and-protocols.md`](media-storage-and-protocols.md)，插件在
产品中的定位见 [`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)。

> **术语**：产品与对外措辞统一为「插件」，`.cindy` 即插件包；不再使用旧的概念称呼。
> 代码标识仍沿用历史 `Ghost` / `cindy-brain` 命名（目录 `cindy-brain/`、`GhostRuntime`、
> `ghost.json`、`cindy-ghost://`、`ghost_forge_guide` 等），与产品术语「插件」指同一事物；
> 引用代码时照实使用这些标识，不因措辞改写。

> **增量适用原则**：运行时沙箱与权限的安全不变量（下节 2–4）对**所有**触及相关路径的
> 改动都生效，不因是存量代码而豁免。作者契约同步（下节 5）在改动命中作者可见契约时
> 触发；不要求为统一形式专项重构无关存量。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 编写手册（作者唯一教材，现拿现读） | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `FORGE_GUIDE`，经 `ghost_forge_guide` 工具下发 |
| 身份卡字段与校验、管子协议类型 | `apps/desktop/src/shared/ghost.ts`（`validateGhostManifest`、`cindy.send` / `cindy.onHostMessage` 类型） |
| 打包限制 | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `packGhostDir` |
| 运行时、沙箱进程与生命周期 | `apps/desktop/src/main/cindy-brain/runtime/GhostRuntime.ts`、`GhostManager.ts` |
| 安装批准事实(receipt / 技能快照 / revision) | `apps/desktop/src/main/cindy-brain/ghostInstallReceipt.ts`，批准态投影见 `shared/ghost.ts` 的 `GhostInstallApproval` |
| 能力 slot（网络／通知／确认／文件系统／技能／宿主等） | `apps/desktop/src/main/cindy-brain/networkSlot.ts`、`notifySlot.ts`、`confirmSlot.ts`（往返桥 `ghostConfirmDialogBridge.ts`，renderer 落地 `cindy-brain/GhostConfirmDialogHost.tsx`）、`fsSlot.ts`、`cindySlot.ts`、`skillSlot.ts`、`agentSlot.ts`、`errandSlot.ts`（派活执行链在 `maker-ipc/ghostErrandRunner.ts`，每插件配置在 `errandPrefsStore.ts`） |
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
- 新增或修改 slot 时，除同步编写手册与校验（下节 5）外，还必须同步 shared 类型、
  preload／host handler、权限 UI（`GhostPermissionList.tsx`）、错误边界和测试。
- **授权事实由 Host receipt 持有，不由安装目录持有。** 一次明确的安装／更新确认写出
  一份 receipt（`ghostInstallReceipt.ts`），落在**安装根之外**的 owner-scoped 状态根里，
  钉住这次批准过的 manifest、trust、启停态和一个随机 `revision`；`GhostManager.list()`
  只从 receipt 取这些字段，安装目录里的 `ghost.json` / `.cindy-trust.json` / `.disabled`
  退化为旧版本兼容镜像。理由是可变安装目录曾经就是授权事实本身：就地改写
  `ghost.json` 能让权限 diff 显示"无新增"，未确认的 slot 因此拿到运行授权。
  - 没有 receipt（旧安装）或 receipt 损坏 = **不构成运行授权**：一律按停用列出、
    不许启用、不参与技能落链；恢复只能走一次完整重新确认（`diffInstalledGhostPermissionItems`
    在无批准基线时把候选包的**全部**权限当新增项展示）。UI 必须如实说出这个状态并
    给出恢复入口，不能让它看起来只是"被用户关掉了"。
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
    安装目录加载，`packageSha256` 只是批准时点的来源指纹、运行时不校验（见第 6 节）。
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
  指纹钉进 receipt 的 `skillContentSha256`；确认框看到的 SKILL.md 必须就是 Agent 之后
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
    fail closed 并重新确认，不能拿旧摘要继续授权。
  - 同理，"源目录与受管根的包含关系"必须**双向**判（既不能落在受管根内，也不能是受管
     根的祖先）：单向判定下只要在 owner 数据目录里放一个 `ghost.json`，递归打包就会把
     已安装插件字节、批准 receipt 与技能快照打进 `.cindy`。
  - 随包种子是第一方输入；发现链接、junction、FIFO 等非普通条目必须整颗跳过并告警，
    不得在复制时静默丢弃后继续写批准 receipt。

## 4. 网络、凭证与资源交接

- network 只允许 manifest 白名单域名；凭证由主机保险库注入，**无明文读回**给沙箱。
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
- 面板供片与注入的主题 token 只用 `ghostPanelTheme.ts` 白名单内的值，不扩大暴露面。

## 5. 作者契约与编写手册同步

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

## 6. 已知安全／兼容缺口（不得随旧文档删除而视为完成）

以下缺口在触及相关链路时必须一并修复，或在 PR 中保留明确的正式跟踪，不得静默丢弃：

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

## 7. 远程与手机版

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
7. 改动是否命中作者可见契约（身份卡／管子／模型 slot／面板供片／打包）？命中就必须
   同步 `FORGE_GUIDE` 并在 PR 说明；漏同步 = P1。
8. 第 6 节的已知缺口是否被触及？触及是否一并修复或留了正式跟踪？
9. 新增 IPC／推送是否需要远程／手机版？需要就登记 device-link 白名单与 topic 路由。

最小验证入口：

```bash
pnpm --filter desktop exec vitest run src/main/cindy-brain
pnpm --filter desktop typecheck
```

其余按 [`desktop-development.md`](desktop-development.md) 的分层验证选择；命中媒体、协议或
IPC 时追加对应专项规则要求的验证。
