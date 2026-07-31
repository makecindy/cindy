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
3. 网络是否限白名单域名、凭证无明文读回？附件／媒体／目录是否经归属校验的
   grant／deposit／ledger 交接，未暴露宿主绝对路径？
4. 内联凭证是否只走 trusted Desktop 专用 IPC，未登记 device-link？Main 是否重新校验
   sender、request、revision、action、精确字段集合与 manifest 绑定，且没有把 Renderer
   字段 id 直接当作 Secret key／路径？保险库写失败是否不 emit，写成功后是否仍重新
   assessment，而不是把“提交完成”当作 ready？
5. 改动是否命中作者可见契约（身份卡／管子／模型 slot／面板供片／打包）？命中就必须
   同步 `FORGE_GUIDE` 并在 PR 说明；漏同步 = P1。
6. 第 6 节的已知缺口是否被触及？触及是否一并修复或留了正式跟踪？
7. 新增 IPC／推送是否需要远程／手机版？需要就登记 device-link 白名单与 topic 路由。

最小验证入口：

```bash
pnpm --filter desktop exec vitest run src/main/cindy-brain
pnpm --filter desktop typecheck
```

其余按 [`desktop-development.md`](desktop-development.md) 的分层验证选择；命中媒体、协议或
IPC 时追加对应专项规则要求的验证。
