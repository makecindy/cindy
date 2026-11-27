# 远程选择器里的模型组

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 产品规则见 [模型组](../../product-rules/model-groups.md)「所有模型选择器都能选模式」一节；伙伴模型链的做法见
> [伙伴模型链里的模型组](teammate-model-groups.md)。

- **范围**：手机在被控电脑上新建任务、新建目标、给进行中的任务换模型；电脑远程控制另一台电脑时的同样三处；
  本机选择器「其他电脑」那几段列出那台电脑自己的模式。模式属于那台电脑，选路、提交选路记录、记撞配额用的绑定
  与写任务里的说明都由那台电脑做。
- **新增准入的 channel**(`packages/device-link/src/allowlist.ts`，被控端 `main/model-groups/ipc.ts`)：
  - `model-groups:get`：接受可选参数 `{ includeSourceRoutes?: boolean }`。
    - 默认（不带参数或 `includeSourceRoutes !== true`）：下发不含 `sourceRoutes` / `expandedRoutes` 的兼容配置，避免旧控制端出现意外字段，也无需白等远程目录读取。
    - 显式传入 `{ includeSourceRoutes: true }`（2026-11-27 新增）：被控端补齐远程目录后，在返回中附加经 `modelGroupsConfigForRemote` 净化的 `sourceRoutes`（按供应商合并路由定义）与 `expandedRoutes`（按模型展开后的路由映射），仅含同账号目录级标识，不含凭证。Mobile 通过 `sourceRouteProviders.ts` 按不可信数据解析为虚拟 `sroute:` 供应商并隐藏已被合并的成员；Desktop 远程控制选择器复用同一合并展示逻辑。
    - 其余字段沿用既有兼容策略：2026-11-23 起选法多了 `drain`、`headroom`、`weighted`，发给别的设备时 `strategy` 换成最接近的旧选法(`order` / `expiring` / `rotate`)，真实选法放在 `pick`；时段例外可选 `days`，来源可选 `weight`。
  - `model-groups:resolve`：请那台按自己的模式选。选择只带 `{ type: 'route', id }`(控制端去掉位置字段，被控端也会去掉)；
    `context` 支持 `hasImages`、`effort`、`fastMode`；`location.agentDeviceId`(进行中的任务在指定位置内选，省略时支持跨位置重选) 与可选 `sshHostId`(仅限目标 SSH 主机可运行的来源) 沿用本机接口语义。
    可选 `remoteInvocableOnly: true`：Agent 将在这台为另一台电脑运行，只用这台开了「允许被远程调用」的连接。
    返回那台的选路结果（`route` 可选携带 `fastMode`）；`route.agentDeviceId` 是**那台电脑眼里的**运行位置。
  - `model-groups:commit`、`model-groups:bind-session`：与本机接口相同。会话 id 是那台电脑上的任务 id。
  - `model-groups:unbind-session`（2026-11-27 新增）：`{ sessionId }` → `{ ok: true, unbound: boolean }`，显式解除任务的持续托管绑定并保留当前具体模型。旧被控端返回 `CHANNEL_NOT_ALLOWED` 时控制端静默降级。
  - `model-groups:get-session-binding`（2026-11-27 新增，后台读取）：`{ sessionId }` → `ModelGroupSessionBindingView | null`，供控制端查询任务当前托管路由与待生效状态。
  - `model-groups:switch-offer`（2026-11-27 新增，后台读取）：`{ sessionId }` → `ModelGroupSwitchOffer | null`，在关闭自动切换或自动接替受限时供错误横幅提供一键换源按钮。
  - `session.modelGroupBinding`（2026-11-27 新增，增补式会话投影字段）：任务读取与 `session_changed` 补丁中附带可选 `ModelGroupSessionBindingView | null`（仅对 owner 投影，访客/共享视图自动省略）；旧控制端忽略未知字段。
  - `model-groups:route-note`：`{ sessionId, note }`。远程不能裸写消息(`local-db:messages:create` 不放行)，说明由被控端代写，限制同前。
  - `model-groups:set`、`model-groups:decisions` 不放行 Device Link：改模式与读取完整决策日志只在本机/本地 Host 会话。
- **Node Host 与网页端（2026-11-27 新增）**：9 个本地通道（`get / set / resolve / commit / bind-session / unbind-session / get-session-binding / switch-offer / decisions`）纳入 `packages/maker-shared/src/hostChannelContract.ts` 并映射到 `/api/model-groups/*`；`apps/host/src/service.mjs` 在 `profileHold` 期间仅放行只读接口（`get / resolve / get-session-binding / switch-offer / decisions`），拒绝所有写接口；`model-groups:route-note` 在 `apps/host/src/device-link.ts` 中单独按 owner + `refuseWhileHeld()` 注册；`apps/desktop` 在 `hostClientMode` 下跳过重复注册本地 IPC；`apps/web/shim.js` 通过共享契约自动暴露全部接口。
- **插件协议兼容（2026-11-27 新增）**：插件任务偏好（`PluginTaskPrefs` / `PluginTaskSettings`）、插件模型选择弹窗（`PluginModelPickerHost` / `PluginModelPicker`）、插件定时草稿（`PluginScheduleDraft`）以及 `GET /agent-models` 均以**增补方式**支持可选 `modelGroup?: string`，同时强制保留原有 6 字段具体模型（`agentKind / providerId / model / effort / fastMode / agentDeviceId`）作为只认识具体模型的旧插件与旧客户端的兜底。
- **权限**：上面全部 Device Link 接口在被控端只接受同账号本人控制的设备(`readDeviceLinkModelSelectionOrigin() === 'owner'`，与远程选模型同一判据)；分享来的任务等受限控制端回 `PRECONDITION_FAILED`。本机调用走可信主界面闸。
- **「其他电脑」那一段**：本机草稿记住的选择带 `deviceId`(`ModelGroupSelection.deviceId`，只在本机草稿里，不上传)。
  只给已列在「其他电脑」那一段的电脑(至少开放了一个允许被远程调用的来源)显示。
  发送时请那台按自己的模式、`location: { agentDeviceId: null }` 与 `remoteInvocableOnly: true`(只用那台自己的、
  允许被远程调用的来源)选，任务建在本机、Agent 在那台运行，
  与选「其他电脑」那一段里的普通模型同一条路径；说明写在本机，选路记录提交给那台，不记本机的撞配额绑定。
- **旧被控端**：没有这些准入 → `CHANNEL_NOT_ALLOWED` → 控制端记为「那台不支持模型组」，不列模式，按普通模型照常工作。
  这个答案不永久保留：Desktop 控制端在那台离线或链路重置后清掉，Mobile 5 分钟后再问一次，那台升级后不必重开控制端。
  新被控端 + 旧控制端：旧控制端不调用这些接口，行为不变。
  独立后台服务对白名单内缺少普通 IPC 处理器的请求复用同一 `CHANNEL_NOT_ALLOWED` 回执。桌面被控端分派及两类中转帧沿用原契约。
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
