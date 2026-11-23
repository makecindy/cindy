# 远程选择器里的模型组

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 产品规则见 [模型组](../../product-rules/model-groups.md)「所有模型选择器都能选模式」一节；伙伴模型链的做法见
> [伙伴模型链里的模型组](teammate-model-groups.md)。

- **范围**：手机在被控电脑上新建任务、新建目标、给进行中的任务换模型；电脑远程控制另一台电脑时的同样三处；
  本机选择器「其他电脑」那几段列出那台电脑自己的模式。模式属于那台电脑，选路、提交选路记录、记撞配额用的绑定
  与写任务里的说明都由那台电脑做。
- **新增准入的 channel**(`packages/device-link/src/allowlist.ts`，被控端 `main/model-groups/ipc.ts`)：
  - `model-groups:get`：那台电脑的模式配置，与 `model-groups.json` 同形(名字、选法、例外、推理强度、来源的
    agentKind / 供应商连接 id / 模型 id / 运行位置)，只有同账号可读的目录级标识，不含凭证。控制端按不可信数据解析：
    Desktop 复用 `normalizeModelGroupsConfig`，Mobile 复用 `parseCompanionModelGroups`(32 组 × 16 来源，只留显示字段)。
    归入后台读取(`invokePolicy.ts`)，选择器打开时每台电脑读一次，15 秒内复用。
    2026-11-23 起选法多了 `drain`、`headroom`、`weighted`，2026-11-23 之前的手机会整条不列认不出选法的模式、电脑会当成
    「快作废的先用」。所以发给别的设备时(本接口与伙伴设置里的模型组，`modelGroupsConfigForRemote`)，`strategy` 换成最接近的
    旧选法(`order` / `expiring` / `rotate`)，真实选法放在新字段 `pick`；新版两端都先读 `pick`。选路始终由模式所在的那台
    电脑做，旧设备只是选法的标签不准，模式照样能选。手机今后认不出的选法只是不写标签，不再丢掉整条模式。
    时段例外多了可选的 `days`(0–6，与 `Date#getDay` 相同)，来源多了可选的 `weight`；旧版忽略这两个字段，只影响显示。
  - `model-groups:resolve`：请那台按自己的模式选。选择只带 `{ type: 'route', id }`(控制端去掉位置字段，被控端也会去掉)；
    `context.hasImages` 与 `location.agentDeviceId`(进行中的任务只在它所在的位置里选)沿用本机接口的语义。
    可选 `remoteInvocableOnly: true`：Agent 将在这台为另一台电脑运行，只用这台开了「允许被远程调用」的连接，
    其余连接这次按没有连接处理(旧被控端不认识该字段时不会被问到：旧被控端整段不显示)。
    返回那台的选路结果；`route.agentDeviceId` 是**那台电脑眼里的**运行位置。
  - `model-groups:commit`、`model-groups:bind-session`：与本机接口相同。会话 id 是那台电脑上的任务 id。
  - `model-groups:route-note`(新)：`{ sessionId, note }`。远程不能裸写消息(`local-db:messages:create` 不放行)，
    说明由被控端代写：任务不存在回 `NOT_FOUND`；说明按不可信数据收(`sanitizeModelGroupRouteNote`：只留说明卡认识的字段、
    限长、`source` 固定为 `model-group`)，在后台等首条用户消息落库(最多 10 秒)后写在它之后 1ms，clientId
    `model-group-route:<sessionId>` 与本机界面写的同一个，重复写只留一行。说明的文字由控制端按它的语言写好。
  - `model-groups:set` 不放行：改模式只在本机。
- **权限**：上面五个接口在被控端只接受同账号本人控制的设备(`readDeviceLinkModelSelectionOrigin() === 'owner'`，
  与远程选模型同一判据)；分享来的任务等受限控制端回 `PRECONDITION_FAILED`。本机调用仍走可信主界面闸。
- **「其他电脑」那一段**：本机草稿记住的选择带 `deviceId`(`ModelGroupSelection.deviceId`，只在本机草稿里，不上传)。
  只给已列在「其他电脑」那一段的电脑(至少开放了一个允许被远程调用的来源)显示。
  发送时请那台按自己的模式、`location: { agentDeviceId: null }` 与 `remoteInvocableOnly: true`(只用那台自己的、
  允许被远程调用的来源)选，任务建在本机、Agent 在那台运行，
  与选「其他电脑」那一段里的普通模型同一条路径；说明写在本机，选路记录提交给那台，不记本机的撞配额绑定。
- **旧被控端**：没有这些准入 → `CHANNEL_NOT_ALLOWED` → 控制端记为「那台不支持模型组」，不列模式，按普通模型照常工作。
  这个答案不永久保留：Desktop 控制端在那台离线或链路重置后清掉，Mobile 5 分钟后再问一次，那台升级后不必重开控制端。
  新被控端 + 旧控制端：旧控制端不调用这些接口，行为不变。
- **建任务的时机**：会话在那台建成(远程创建的提交点)后才提交选路、记绑定、写说明；手机经新建任务后台管线的
  `onSessionCreated` 回调做一次，重跑管线不重复。全部尽力而为，失败只影响撞配额提议与那行说明。
- **自建中转**：只是既有 `invoke` 隧道里多了几个 channel 名，帧格式、握手、能力协商、签名都不变，自建中转按原样转发，
  无需同步修改。`allowlistHash` 随准入表变化，它只作为信息随 link-accept 下发，不参与准入判定。
- 无数据库 migration、服务端改动或原生 fingerprint 变化。
- 实现：被控端 `main/model-groups/ipc.ts`、`remoteAccess.ts`、`routeNote.ts`；Desktop 控制端
  `renderer/features/model-groups/remoteModelGroups.ts`、`draftModelGroupRouting.ts`、`NewMakerDraftRoute.tsx`、
  `CCAgentSessionView.tsx`，选择器 `components/new-chat/ModelGroupsPickerSection.tsx`、`UnifiedModelPanel.tsx`、
  `UnifiedModelRail.tsx`；Mobile `src/session/hostModelGroups.ts`、`src/device-link/mobileMakerTransport.ts`、
  `app/sessions/new.tsx`、`app/sessions/[sessionId].tsx`。回归见 `main/model-groups/__tests__/remoteAccess.test.ts`、
  `packages/device-link/src/__tests__/allowlist.test.ts`、`renderer/__tests__/unifiedModelPanelRendering.test.tsx`、
  `apps/mobile/src/__tests__/hostModelGroups.test.ts`。
