# 手机版(纯控制端)行为对齐 Checklist

> **怎么用这份文档**:`README.md` 是远程控制**协议/契约**的 SSOT;这份是协议之外、**控制端实现必须逐条趟过的行为坑** —— 每条都是桌面端真机踩出来并修过的问题。手机版 App(本地无 agent / 无 DB / 无会话,纯控制端)从零实现时,**每一项都要评估自己怎么对齐**,打勾即「已评估并有结论(实现 / 复用 / 明确不做)」。
>
> 文件引用以 `apps/desktop/...` 为例指出桌面端是怎么解的;手机版若不复用 renderer,需在自己的栈里实现等价行为。

## 0. 三条贯穿全局的手机版前提(先读)

- [ ] **手机无「本机分支」**:桌面端很多逻辑是 `makerApiFor(sessionId)` / `mergeSessionSources` 这类「本机 vs 远程」二选一,本机会话走本地 IPC、远程走隧道。**手机上一切会话都是远程**,本机分支恒不命中 → 任何「只在本机分支才正确」的逻辑都会在手机暴露。结论:手机端把所有读写**无条件走隧道**,反而比桌面简单,但要求「远程路径」100% 完备(下面每条都是远程路径)。
- [ ] **App 生命周期 = 频繁中途加入**:手机切后台 → WS 断;回前台 → 重连。所以「重连后对账」不是边缘 case 而是**主路径**:重连要重新 `subscribe(session:<id>)` + 重拉消息对账 + **重建挂起交互快照**(见 §4)。桌面端靠 `onStatusChanged('online')` 触发,手机靠前台事件触发同一套。
- [ ] **后台推送**:WS 只在前台活。要在 App 后台也能收到 permission/ask 提醒,需 APNs/FCM 之类(协议外),需单独评估;否则回前台靠快照重建补面板即可。

---

## 1. 镜像架构(被控端单一真相 + 控制端纯镜像)

- [ ] **控制端零权威状态**:远端会话/消息只活在内存镜像,断链/设备下线即弃,**永不本地落库、不做乐观预测**。桌面端 `remoteProjectsStore`(`apps/desktop/src/renderer/features/device-link/remoteProjectsStore.ts`)是范式:`setDeviceSessions` 快照 + `applyPatch` 增量 + epoch 乱序保护。手机版要有等价的「按设备分片的内存镜像」。
- [ ] **origin 注册表**:`sessionId → deviceId`(`getSessionDeviceId`),决定一条会话的所有读写路由到哪台被控端。手机版每条会话都要带 deviceId 归属。

## 2. 会话列表 & 项目镜像

- [ ] **拉取被控端会话列表**:隧道 `local-db:sessions:list`,写入镜像,合并进项目/会话列表。桌面 `refreshRemoteDeviceSessions` + `useDeviceLinkRemoteProjects`。
- [ ] **会话元数据增量**:被控端 `local-db:sessions:patched` push → 就地合并镜像(`applyPatch`);`local-db:sessions:created`(无 row)→ 触发重拉该设备。
- [ ] **设备在线/可控筛选**:只对 `online && remoteControlEnabled && !isSelf` 的设备建镜像;下线/关被控 → 移除分片 + 驱逐相关缓存。
- [ ] **瞬态错误重试**:首拉可能撞「DbClient not ready / NOT_CONNECTED / DEVICE_OFFLINE / INVOKE_TIMEOUT」等瞬态错 → 退避重试;`REMOTE_DISABLED / CHANNEL_NOT_ALLOWED` 是永久错不重试。桌面 `refreshRemoteSessions.ts` 的 `isTransientRemoteError` + 重试循环。手机弱网更需要这条。

## 3. 消息历史 & 实时流 & 对账

- [ ] **历史经隧道拉**:`local-db:messages:list`(`listMessagesFor`),形状与本地一致。
- [ ] **首屏 loading**:网速慢时控制端要让用户理解「在等被控端」——桌面用「仅消息区 loading + 延迟防闪」(`useRemoteSessionLoading`,250ms debounce)。手机弱网更明显,必做。
- [ ] **重 topic 订阅**:打开会话 `subscribe(session:<id>)`,关闭 unsubscribe;实时 `maker:event` push 喂进同一套流式 reducer(`handleMakerEventRaw`)。
- [ ] **丢帧对账(reconcile)**:push 是 fire-and-forget,断连窗口会丢帧 → 重连/turn 结束/聚焦时重拉最近一页**合并去重保序**(`reconcileRemoteMessages`),不是替换。手机切后台回来必触发。
- [ ] **origin 漂移重载**:启动竞速下路由可能先于镜像 bootstrap → 会话以「本机空库」误加载 → 镜像注入 deviceId 后要重载真历史(`reconcileOpenSessionOrigins`)。手机若有「冷启动直达某会话」的深链,同样要处理。

## 4. 交互特性(permission / plan / ask)—— 手机重灾区,逐条评估

> 模型 = 被控端产生 interaction → push 推控制端渲染面板 → 控制端把决定隧道回被控端。两半 + 一个快照,缺一面板就卡死。

- [ ] **请求推送**:`maker:interaction-request` / `maker:interaction-dismissed` 在 `PUSH_FORWARD_ALLOWLIST`,`topicForPush` 路由到 `session:<id>`;控制端经 `onRemotePush` 喂进**和本地同一个** reducer(`handleInteractionRequestRaw`,置 `pendingPermission` / `pendingAskUser` / `pendingPlanReview`)。
- [ ] **响应回传**:`maker:resolve-interaction` 在 `REMOTE_INVOKE_ALLOWLIST`;permission(allow/deny + updatedInput)、plan(allow + editedPlan / deny + reason)、ask(answers)三种 decision 形状各异,手机 UI 都要能产出。
- [ ] **★ 挂起交互快照重建(最容易漏,手机刚需)**:pending 状态原本**只由实时 push 设置**;在交互挂起**之后**才打开/重连/刷新会话的窗口会错过 push → 面板不显示。桌面解法:`maker:get-pending-interactions`(扫 `pendingInteractionResolvers` 返回 `{request, persistId}[]`)+ 控制端 `reconcilePendingInteractions` 在 `ensureInitialMessages` 与重连时拉快照重建。**手机几乎每次打开都是「中途加入」,这条必做,否则用户永远看不到等待中的审批。**
- [ ] **消息去重**:ask/plan 会落库成消息;快照重建 / 历史加载 / live push 竞态会重复 → 按 `requestId` 去重(就地翻回 pending,不 append)。桌面 `handleStreamEvent` 的 ask/plan 分支。否则手机会「多一条非交互消息」。
- [ ] **dismissed 清面板**:超时(permission 10min)/ 模式切换 / 会话关闭 → `maker:interaction-dismissed` push → 清 pending,无需响应。
- [ ] **触控 UI**:权限卡、plan viewer(可编辑 + 折叠)、AskUserQuestion 向导(多问题 + Skip + 自定义输入)都要重做移动布局。
- [ ] **多会话不串台**:不同会话的 pending 各自隔离,resolve 命中正确 requestId。

## 5. 运行时控制(model / effort / permissionMode / fast / stop / steer / fork / rewind)

- [ ] **permissionMode 切换**:经隧道 `maker:set-permission-mode`,被控端持久化后 `sessions:patched` 回流镜像(不本地乐观写)。
- [ ] **model / effort / fastMode 切换 + 回流**:同上,set-* 隧道 + patched 回流。fastMode 还要 mirror 进 chat in-memory。
- [ ] **能力声明(capabilities)**:模型/effort/fast/permission/fork/rewind 的可用集是**每台被控端 + 每个 agent 各异**的 → 要 deviceId-aware 缓存 + 打开会话前预取(桌面 `useAgentCapabilities` prefetch/evict、`modelDefinitions` deviceId 线程化)。手机下拉菜单不预取会是空的。
- [ ] **输入队列 / stop / steer**:`maker:input:*`(enqueue/steer/stop/resume/move/remove/...)+ `maker:input:get-projection` 快照。注意 projection **不含** pending interaction(见 §4 单列)。
- [ ] **fork / rewind**:`maker:fork` / `maker:rewind:preview|commit` 经隧道(注意 fork 不走 path-guard,见安全节)。
- [ ] **vendor 鉴权就绪**:被控端没配 XD AIGateway Key / 没连 Codex / Codex 组件没就绪时,控制端要给出「需在被控设备 X 上完成配置」的提示而非静默失败(桌面 `vendorAuthGate` + `remoteAuthDescription`)。

## 6. 协同(orca)

- [ ] **团队读/管理走隧道**:`local-db:orca-workflows:*`(读)+ `maker:worker:* / maker:team:end / maker:collaboration-settings:*`(写)按 ctx session 来源路由(桌面 `orcaWorkflowsFor`)。
- [ ] **worker-changed 推送**:`maker:orca:worker-changed` 在 PUSH_FORWARD;控制端按 `leadSessionId` 过滤刷新(`subscribeOrcaWorkerChanged`)。
- [ ] **orca 会话解析要合并镜像源**:lead/worker session 在镜像里,不在本地 store → 解析 lead/worker 必须合并「本地 + 远程镜像」两源(桌面 `mergeSessionSources`,OrcaWorkflowRoute/OrcaSplitView)。手机无本地源,但等价地「从镜像里找 lead/worker」不能漏。
- [ ] worker 会话本身是远程会话,经单会话隧道打开(同 §3)。

## 6.5 desktop 命令(/goal /learn /cmd)—— 业务体在被控端

> 桌面控制端的模型:命令解析在控制端 main(`commands/builtins.ts`),业务体按 ctx.deviceId 隧道路由。手机没有 main 层,**直接调对应业务 channel** 即可,不需要复刻 desktop 命令注册表。

- [ ] **/goal 全生命周期走隧道**:`maker:goal:set / clear / pause / resume / update / get-status` 在 REMOTE_INVOKE(per-session 业务写,goal-host 在被控端自主续跑,控制端断链不中断);状态推送 `maker:goal:status-changed` 在 PUSH_FORWARD,带 sessionId → `session:<id>` topic(打开会话即订阅)。桌面范式:`goalApiFor` / `subscribeGoalStatusChanged`(`makerTransport.ts`)。
- [ ] **/learn 全生命周期走隧道**:`learn:start / list-runs / get-proposal-diff / apply / discard / cancel` 在 REMOTE_INVOKE(learn-host 全流程在被控端:证据查它的 DB、skill 落它的 `~/.agents/skills`);状态机推送 `learn:event` 在 PUSH_FORWARD,**账号级 → `sessions` topic**(run 关联触发/蒸馏两个会话,单 sessionId 路由会漏)。桌面范式:`learnApiFor` / `subscribeLearnEvents`(`features/learn/learnTransport.ts`)。手机 UI 需要:发起入口、run 状态卡、diff 审查页(`LearnFileChange[]` 渲染 + apply/discard 双按钮,`LEARN_BUSY` 互斥提示)。
- [ ] **learn 蒸馏会话 = 普通远程会话**:被控端建蒸馏 session → `sessions:created` push → 重拉注册,打开它订阅 `session:<id>` 即可实时看模型干活、对话迭代(复用 §3 全套,无新增管道)。
- [ ] **/cmd 走 `desktop-cmd:run`**:被控端在会话 workingDir 执行(cwd 过 remote-workdir-guard),回 `CmdExecutionResult`(30s 超时 / 64KB 截断语义与本机一致)。
- [ ] **中途加入对账**:回前台 / 重连时重拉 `learn:list-runs` + `maker:goal:get-status` 对账(push 是 fire-and-forget,断连窗口会丢帧,同 §3 心智);`awaiting-review` 的后台推送提醒(APNs)是协议外增强,单独评估。
- [ ] **版本偏斜降级**:老被控端对这些 channel 回 `CHANNEL_NOT_ALLOWED` → 提示「对方设备版本过旧」,不硬报错(桌面用 `commands.toast.remoteUnsupported`)。

## 7. 多端 / 多窗口 / 订阅引用计数

- [ ] **订阅引用计数**:被控端按 **controllerDeviceId** 记一份订阅(不分窗口/不分会话)。同一控制端多处订阅同一 `(device, topic)`,**最后一个释放才真正 unsubscribe**,否则关一个会拆掉其它还在用的(桌面 `subscriptionRefcount.ts` + 窗口 destroyed 释放)。手机若有多 Tab / 多会话同时订阅,需同款计数;App 退出/杀进程要释放。
- [ ] **多控制端天然并存**:手机 + 桌面同账号 = 两个 controllerDeviceId,各自独立订阅、各自 fan-out。被控端是单一真相,多控制端无状态 invoke 不冲突 —— 但要确认手机这第三方接入不破坏已有控制端。
- [ ] **窗口无关 invoke**:`listDevices` / `sessions:list` 等是纯 invoke,与「哪个窗口/客户端」无关。手机直接调即可。

## 8. 连接生命周期 & 健壮性

- [ ] **连接状态横幅**:断连 → 「与被控设备连接中断,正在重连…」;被控端离线 → 「已离线,暂时无法同步」+ 重新同步按钮(桌面 `RemoteSessionBanner` + `useRemoteSessionConnection`)。手机网络抖动频繁,必做。
- [ ] **重连后三件事**:重新 subscribe heavy topic + reconcile 消息 + 重建 pending 交互快照(§4)。桌面 `useRemoteSessionSync` 的 reconcile 路径。
- [ ] **被控端结束远程会话 / 断开**:`remoteSessionEnded` 等提示 + 清理。
- [ ] **epoch / 半开连接 / offline-send**:协议层 client.ts 已处理(epoch guard 防旧 snapshot 覆盖、半开清理、离线发送拒绝);手机复用 `DeviceLinkClient` 即可,自写客户端要照抄这些不变式(见 `TESTING.md` 的 client gap tests）。

## 9. 项目 / 工作目录选择

- [ ] **添加远程项目默认列「对方已有项目」**:device-link 拉被控端 `recent_workdirs`(`local-db:recent-workdirs:list`),默认展示,「浏览文件夹」为次要入口(桌面 `AddRemoteProjectDialog` + `remoteExistingProjects.ts`)。
- [ ] **远端目录浏览**:隧道 `fs:list-dir / fs:stat-path / fs:mkdir-p`,被控端可能是 Windows → **用 handler 回传的 native 路径,客户端不拼路径**(桌面 `deviceLinkBrowseAdapter`)。
- [ ] **SSH 远程项目兼容**:桌面把 SSH 与 device-link 统一进同一入口;手机若不支持 SSH host,至少不能因此报错。
- [ ] **create-on-send(延迟建会话)**:从首页指向被控端项目时**不立即建会话**(避免在被控端留空会话),首条消息发出时才隧道 `maker:create-session`。
- [ ] **workdir 安全闸**:被控端校验远程工作目录是否允许(recents/sessions/已存在目录),手机选的目录也走同一被控端校验,不另开后门。

## 10. 鉴权 & allowlist & 安全

- [ ] **白名单默认拒绝**:`REMOTE_INVOKE_ALLOWLIST`(invoke)+ `PUSH_FORWARD_ALLOWLIST`(push)是 default-deny;新增任何远程能力**两张表都要显式加**(`packages/device-link/src/allowlist.ts`)。手机不能调白名单外 channel,被控端也只转发白名单内 push。
- [ ] **path-guard 例外**:少数 channel(如 `maker:create-session`)需路径校验,`maker:fork` 等不需要 —— 以源码 `PATH_GUARDED_CHANNELS` 为准,别照搬错。
- [ ] **身份防伪**:`Envelope.src` 由 server 回填,客户端传值被覆盖;手机不能伪造来源。
- [ ] **同账号边界**:server 按 userId 命名空间隔离;手机必须同账号登录才能控被控端。
- [ ] **隐私**:截图/日志上传前自查(头像/路径/token/内部域名等),手机端同样适用。

## 11. i18n / UI 适配

- [ ] 远程控制相关文案全部 4 语言(zh-CN/en/ja/ko)齐全且准确(`settings.remoteControl.*` / `ccAgent.remoteSession.*` / `newChat.addRemoteProject.*` 等),缺 key 会静默回退英文。手机版自己的文案同理。
- [ ] 颜色走主题 token,不硬编码(手机若另起设计系统,等价约束)。

## 12. IM(飞书/Slack)接管交互的相互影响

- [ ] **单 listener 语义**:被控端 `setInteractionListener` 是覆盖式。IM `/ctr` 接管期间,desktop/手机控制端**收不到新 interaction push**(由 IM 持有),`get-pending-interactions` 也不返回那条(在 IM 的 map 里)。手机要明白这是设计使然,不是 bug;脱接后恢复。
- [ ] 手机作为又一个控制端接入时,不应破坏 IM 接管 / 桌面控制的既有语义。

## 13. 插件执行引擎（ACP）手机端对齐清单

- [ ] **目录读取与旧被控端降级**:手机通过 `maker:list-plugin-engines` / `maker:refresh-plugin-engines` / `maker:get-plugin-engine-usage` 读取被控电脑开放的本机插件引擎；旧被控端回 `CHANNEL_NOT_ALLOWED` 时按「没有插件引擎」静默隐藏入口，不报错（`apps/mobile/src/session/pluginEngines.ts`）。
- [ ] **图标体积预算与断线缓存**:`PluginEngineView` 图标单张上限 64 KiB、单次列表合计上限 512 KiB，超预算回退通用插件标记；被控端暂时失联时保留上次已读目录与图标，重连后按账号与设备代次刷新。
- [ ] **不支持插话时的同步降级**:输入投影 `AgentInputProjection.steerUnsupported === true`（含运行期通过 `onCapabilitiesChange` 撤回插话能力）时，隐藏插话按钮与排队菜单插话项，改为排队发送并在消息流末尾展示等待说明（#13231）。
- [ ] **收藏 wire 兼容编码**:写入 `maker:model-favorites:apply` 时，`agent` 必须固定写 `PLUGIN_ENGINE_FAVORITE_WIRE_AGENT`（`'cc'`），**绝不发 `agent: 'acp'`**；新端通过 `providerId` 的 `acp-plugin:`（含 `agent-device-favorite:` / `provider-share-favorite:` 前缀）识别插件引擎收藏并忽略 wire `agent`。
- [ ] **当前明确边界**:手机端暂不提供被控电脑再转接的同账号其他电脑／跨账号分享插件引擎，也不提供仅限桌面本机新任务草稿的插件路由模型（`GhostPickerModel`）；遇到时按产品规则隐藏，不降级成内置模型。详参 `docs/product-rules/plugin-engines-and-models.md` 与 `docs/dev-rules/protocol-compatibility/plugin-harnesses.md`。

---

## 已解决问题溯源(本轮 device-link 开发的实修记录)

供「这条到底怎么修的」回查 —— 详见对应 commit / 测试:

| 问题 | 桌面端修法 | 关键文件 / 测试 |
|---|---|---|
| 远程会话开协同浏览不出来 | orca 团队读/管理 + worker-changed 全经隧道路由 | `makerTransport.orcaWorkflowsFor` / `subscribeOrcaWorkerChanged` |
| 远程 orca lead 打开被弹回 /cc-agent | lead/worker 解析合并本地+镜像两源 | `mergeSessionSources`,OrcaWorkflowRoute/OrcaSplitView |
| 新窗口看不到受控端 | 去掉副窗口 gate + 主进程订阅按窗口引用计数 | `useDeviceLinkRemoteProjects`,`subscriptionRefcount.ts` |
| 添加远程项目默认浏览文件夹 | 默认列被控端 recent_workdirs / SSH 本地会话 | `remoteExistingProjects.ts`,`AddRemoteProjectDialog` |
| 中途打开会话交互面板不显示 + 多一条消息 | `maker:get-pending-interactions` 快照重建 + 按 requestId 去重 | `reconcilePendingInteractions`,`handleStreamEvent` ask/plan |
| 远程交互往返无测试 | Tier-1 集成 + 源不变式锁接线 | `deviceLinkInteractionScenarios.test.ts` |
| 控制端启动竞速误命中本机空库 | origin 漂移重载 | `reconcileOpenSessionOrigins` |
| 丢帧消息缺失 | 重拉合并去重对账 | `reconcileRemoteMessages` |
| 首拉瞬态错误 | 瞬态判定 + 退避重试 | `refreshRemoteSessions.isTransientRemoteError` |

> 自动化测试范式(手机若用 JS 栈可复用):node-env vitest(无 RTL)、stub `deviceLink.{invoke,onRemotePush}` + 忠实 FakeHost、in-memory drizzle、真 relay + ioredis-mock E2E。详见 `TESTING.md`。
