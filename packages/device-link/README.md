# @cindy/device-link — 远程控制协议与契约

同账号跨设备远程控制的**传输/协议层**。当前消费者是 desktop(`apps/desktop`),既可作控制端也可作被控端。

> **为什么有这份文档**:未来的**手机版 App = 纯控制端**(本地无 AI agent / 无会话 / 无 DB),完全经本协议连到桌面端 Cindy 驱动。手机版照着这份契约实现自己的客户端即可 —— 不需要本地 maker。本文件是「远程控制面」的 single source of truth;具体值以源码为准(见各节引用),改协议先读本文件的「兼容性」一节。

本包**严格 host 无关**:WebSocket 实现、token、设备信息全部由 host 注入(见 `DeviceLinkClientOptions`,`src/client.ts`),不依赖 Electron / 渲染层。手机端注入自己的 WS + token 即可复用同一个 `DeviceLinkClient`,或用任意语言按本协议另写客户端。

## 角色与拓扑

```
控制端(desktop / 未来手机) ─┐                        ┌─ 被控端(desktop,开了「允许被控」)
                            ├─ server relay(哑中继)─┤
            另一控制端 ──────┘   apps/server/device-link └─ 另一被控端
```

- **server 是哑中继**:只看路由头(`v` / `kind` / `dst`),不看 `payload`;按 `userId` 命名空间隔离、按 `deviceId` 路由(presence + Redis pub/sub)。同账号才可互达。
- **控制端-only 是一等公民**:一个从不开「允许被控」、从不处理入站 `invoke` 的设备(手机)天然被支持 —— 它只发 `link-open` / `invoke`、只收 `push` / `presence-changed`。
- 身份在 WS 握手时由 server 用 JWT 固化;`Envelope.src` 由 server 回填(客户端传值会被覆盖,防伪造)。

## 连接生命周期(连接层帧)

`src/client.ts` 的 `DeviceLinkClient` 状态机:`connect → hello 握手 → online`,断线指数退避重连(1s→30s),online 后每 20s `ping`,连续 2 周期无 `pong` 判僵死重连。

| 帧 `kind` | 方向 | 说明 |
|---|---|---|
| `hello` | client→server | 进站第一帧,带 `HelloPayload`(deviceName/platform/appVersion/remoteControlEnabled/busy/deviceInfo?)。控制端-only 设备 `remoteControlEnabled=false`。|
| `hello-ack` | server→client | 带 `serverProtocolVersion`;**版本不一致不应进 online**(client 防御性关连接重连)。|
| `ping` / `pong` | 双向 | 心跳 + presence lastSeenAt / route TTL 续期。|
| `presence-set` | client→server | 部分更新本机 presence(开关 / busy),server 广播。|
| `presence-changed` | server→client | 同账号某设备 presence 快照(`PresenceSnapshot`)。控制端据此维护设备列表 / 在线态。**改名也经此即时广播**。|

设备列表另有 REST:`GET /api/device-link/devices` → `DeviceView[]`(DB 档案 ∪ presence 三态合成,含可选 `selfName/deviceInfo`);`PATCH`/`DELETE` 改名/删除。

## 远程控制面(隧道层)—— 手机版要实现的核心

控制端对某台被控设备先 `link-open`(可选,见下),再用 `invoke` 调被控端的**白名单内 IPC channel**,并订阅被控端转发回来的 `push` 事件。

### invoke:调被控端能力

- `Envelope{ kind:'invoke', dst:<deviceId>, id:<uuid>, payload:InvokePayload{ channel, args } }`。
- 被控端**双层校验**(开关 + allowlist)后,用合成 event 调本机既有 `ipcMain.handle(channel)`,回 `invoke-result`。
- **可远程调用的 channel 全集 = `REMOTE_INVOKE_ALLOWLIST`**(`src/allowlist.ts`,默认拒绝制)。这就是控制端能驱动被控端做的全部事 —— 手机版的能力边界完全由它定义。分组(以源码为准):
  - 会话生命周期:`maker:create-session` / `close-session` / `abort-session` / `fork` / `fork-strip-encrypted`
  - 收发与流:`maker:send` / `steer` / 完整 `maker:input:*`(enqueue/steer/stop/resume/move/remove/update-text/clear-session/锁/重试…)
  - 交互审批:`maker:resolve-interaction`
  - 运行时切换:`maker:set-model` / `set-effort` / `set-permission-mode` / `set-fast-mode` / `set-extra-dirs`
  - Rewind / 上下文:`maker:rewind:preview` / `rewind:commit` / `get-context-usage`
  - Orca 协同:`maker:session:enable-orca` / `disable-orca` / `worker:*` / `team:end` …
  - Scheduler / project-automation / 只读 usage / memory 读 / 命令·技能列举 / `fs:resolve-path*` / `scan-at-resources`
  - 读模型:`local-db:sessions:list` / `sessions:get` / `messages:list` / `recent-workdirs:list`
- **永不放行**(`allowlist.ts` 顶注 + `__tests__/allowlist.test.ts` 不变式守卫强制):本机 UI/shell 副作用、对话框、账号与密钥(`auth:*` / `api-key`)、全局设置写(`*:set`)、`local-db` 裸写(`*:create/update/delete`)、updater、新窗口。
- 入参收敛:被控端对 `create-session` / `fork` 的 `workingDir` 限定到本机已知目录(`apps/desktop/.../device-link/remote-workdir-guard.ts`),挡任意路径越权执行。

### push:被控端 → 控制端的事件流

被控端命中 `link-open` 或 `device-link:subscribe` 且事件 channel 在 **`PUSH_FORWARD_ALLOWLIST`**(`src/allowlist.ts`)时,把本机 renderer 广播经 `push` 帧转发给控制端(`maker:event` / `status-changed` / `input:projection` / `interaction-request` / `schedule:event` / `local-db:sessions:created|patched|activity` / `messages:created` 等)。控制端据 `src`(来源 deviceId)把事件路由到对应设备的视图。

`local-db:sessions:activity` 是列表级实时活动摘要,归 `sessions` topic。payload 为轻量 `{ sessionId, phase, compactDetail, interactionKind?, attention? }`,来源是被控桌面 Agent Island 状态机的 `compactDetail` 快照(无原生 Island UI 的平台以 headless 模式维护同一状态)。它只给 Home/侧边栏这类列表行显示低频活动,不承载 maker 事件、消息正文或工具结果;会话详情仍必须订阅 `session:<id>`。

### link-open / link-accept / link-close

- `link-open`(控制端→被控端):建立「正在被控」链路 → 被控端 arm push 转发 + 弹「正在被控」可见性。`link-accept` 回带 `allowlistHash`(探测两端版本差异)。
- **`invoke` 不依赖 link-open**(只读 listing 可不开链路、不触发被控横幅);进入某会话实时操作时才 `link-open` 升级到「streaming tier」。
- 控制端的 append-only `capabilities` 除可随 `link-open` 协商，也可随
  `device-link:subscribe` 的首参或 listing invoke（当前为 `maker:provider:list`）的首参携带；
  因此 listing-only 控制端无需先打开控制链路，也能安全接收能力门控的新 wire 字段。被控端
  必须把缺失、非数组、超长或非字符串能力值按“不支持”处理。
- `link-close`:任一端解链(`reason: user|toggle-off|shutdown`)。

## 错误模型

`DeviceLinkError`(`code` ∈ `DeviceLinkErrorCode`)贯穿全链路。被控端 handler 抛的 `throwIpcError` 的 `[CODE] message` 经 `invoke-result.error.message` **原样透传**,控制端按本地同款 `extractIpcError` 解码 —— 错误协议跨端零改。

## 兼容性(改协议必读)

- `PROTOCOL_VERSION`(`src/protocol.ts`,当前 `1`)**只升不降**,不兼容改动 +1;`apps/server/src/device-link/protocol.ts` 的最小子集必须同步。
- `allowlistHash`(`computeAllowlistHash`,FNV-1a)在 `link-accept` 回传,供控制端探测「对方 allowlist 与我不一致」并提示,而非静默 `CHANNEL_NOT_ALLOWED`。
- **手机与桌面版本会错位**:新增/变更 channel 走兼容评估,别破坏老客户端;新增 push 事件控制端应忽略未知 channel。
- 帧上限 `MAX_FRAME_BYTES`(2MB,按 **UTF-8 字节** 计,两端一致)。

## 源码导航

| 关注点 | 文件 |
|---|---|
| 协议帧 / payload / 错误码 / 版本 | `src/protocol.ts` |
| 客户端状态机(握手/心跳/重连/req-resp/帧分发) | `src/client.ts` |
| 远程调用白名单 + push 转发白名单 + hash | `src/allowlist.ts` |
| server 中继(presence / 路由 / pub-sub) | `apps/server/src/device-link/*` |
| 被控端 dispatch(双层校验 + 合成 event) | `apps/desktop/src/main/device-link/dispatch.ts` |
| 桌面控制端传输路由(本地/远程按 session 切换) | `apps/desktop/src/renderer/lib/makerTransport.ts` |
