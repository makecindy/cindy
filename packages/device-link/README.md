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

### 弱网可靠传输（可选 `reliable-transport-v1`）

在 `link-open` / `link-accept` 的 `capabilities` 中同时声明该能力后，`invoke`、
`invoke-result` 和普通 `push` 会使用端到端可靠 wrapper；旧客户端仍收到原始 payload，
不会误把 wrapper 当成业务数据。

- 每个 peer 使用独立 `streamId + seq`；接收端只按序交付，乱序和重复帧进入有界缓存。
- 单条逻辑消息最多 4 MiB，按 UTF-8 字节计算；超过物理 `MAX_FRAME_BYTES` 的消息拆成
  128 KiB 目标大小的安全 UTF-8 分片，最多 64 段。
- ACK 是累计确认，但只有上层 handler 成功接收后才推进；Desktop 在第一次 `await` 前把
  requestId 登记进有界执行队列，因此 ACK 表示“已安全进入本地状态机”，不等待耗时 IPC
  完成，也不会让 stop/steer 被慢查询堵住。handler 拒绝时保留当前 seq，等待有限重传。
- 请求超时或永久单帧错误会用同 seq 的 skip marker 收敛；控制方向 invoke 遇到
  `DEVICE_OFFLINE` / `REMOTE_DISABLED` 会立即失败并跨过该 seq。已执行完成的
  `invoke-result` 若在回程遇到目标瞬时离线，则保留到下一次 link-open 重放；能力降级或
  显式 link-close 才清空该 peer 的不可交付 pending，并用 `transportBaseSeq` 跨过。
- 重传次数耗尽不会静默挂起：客户端主动切换连接世代，保留未确认消息，握手后按原
  `streamId/seq` replay；握手还会携带未确认消息的 `transportBaseSeq`，接收端进程重启
  丢失内存 ACK 时也能从当前起点继续，不会永远等待旧 seq。
- 每个 peer 最多保留 64 条未确认消息、16 MiB pending；接收重组/待交付缓存同样限制为
  16 MiB，缓存满时优先为当前队头分片/skip 腾出空间，避免未来 seq 占满后永久卡死。
  Desktop 耗时 invoke 执行队列另限 64 条/16 MiB；旧协议 fallback 的串行入站队列限
  128 帧/16 MiB。WebSocket native send buffer 超过 8 MiB 时停止继续灌入并让连接重连收敛。
- 被控端 IPC 已完成、但 `invoke-result` 因本地 WebSocket/可靠层背压暂时无法入队时，
  Desktop 会把**原结果**放进 64 条/16 MiB 的有界 outbox，每 500ms 尝试补发；presence
  短暂离线不清 outbox，显式 link-close/撤权才清，最长保留 120s。这样 mutation 已成功时
  不会被错误改写成 BACKPRESSURE、诱导控制端重复执行。
- `ipcMain` handler 没有统一的取消信号，不能把控制端 30s 超时等同于副作用已取消。
  Desktop 对永久不 settle 的 handler 只在 120s 后回收执行槽和 busy lease，返回明确
  `[TIMEOUT]`，并继续吞住底层 Promise 的晚到结果/异常；同 requestId 仍由结果缓存去重。
- 初次发送、relay 入站队列和 relay 出站 buffer 都有上限；relay 过载使用 close code
  `1013`，客户端依靠现有退避和 link reopen 恢复。
- 心跳、ACK、握手响应不与慢的业务 handler 共用串行队列；同一可靠 stream 仍保持严格
  顺序，避免“业务处理慢”被误判成“网络断开”。
- 可靠业务帧必须等 link-open/link-accept 能力协商完成后才接收；断线后迟到到新进程的
  旧 relay 帧不会在新基线建立前执行。
- 同时声明 `reliable-link-confirm-v1` 时，可靠链路按方向提交：收到 `link-open` 的一端
  发出 `link-accept` 后，只先开放接收方向；控制端真正处理匹配的 accept、安装 stream
  基线后，会回一条带该 `link-open` requestId 的 transport ACK。被控端只有收到同代、
  同 stream 且基线合法的确认才开放发送方向并 replay pending；若这条确认因瞬时背压未发出，
  控制端会按既有可靠重试间隔有界重发确认。确认窗口耗尽仍无确认时，被控端复用现有 peer 级
  `transport-timeout` 重置，要求控制端重开链路，而不是永久停在等待态。迟到 accept、被新请求
  替换的 accept、错误 requestId、旧 stream 业务帧都不能跨代放行；任一端未声明本能力时继续
  使用旧版即时 ready 行为，保证 Desktop 与 Mobile 可以独立升级，server relay 无需理解新字段。
- Desktop 与 Mobile 的自动恢复共用同一条 presence 三态规则：当前连接代没有收到
  presence 时是 `unknown`，只允许熔断器/恢复器自己的单飞探测或定向重建尝试；relay
  明确报告 `false` 时才停止自动发送。这样重连清空 presence 不会把熔断器永久锁死，
  也不会把普通业务请求在未知状态下全部放行成洪峰。
- 当前**不做压缩**：wrapper 只做分片、顺序、ACK、重传和背压。文本消息的压缩收益有限，
  先避免引入 CPU、延迟和跨端实现差异；后续若需要可新增独立 capability。

### 本次修复后的剩余问题边界

这组修复覆盖“可靠链进入错误代际”以及“熔断在重连后无法自探测”两类客户端状态机
卡死；以下日志仍应按独立问题保留线索，不要再次归因到 pending 消息池：

- `401`、`4409`、`4429`、`VERSION_MISMATCH`：鉴权过期、设备被顶、连接数超限或版本
  不兼容，走连接/账号恢复路径。
- WebSocket 升级、DNS、代理、VPN、TLS 或握手超时：属于 relay 到本机的网络路径，
  需要看 `connection issue`、socket error 和握手耗时。
- `1013` / relay backpressure：属于服务端或共享 relay 拥塞；本客户端只做退避和
  peer 级恢复，不等同于链路代际分叉。
- `local-db:sessions:list` 探测本身仍超时：说明对端进程、数据库迁移或 IPC/DB 子系统
  仍未恢复；熔断器会继续保持单飞探测，不应把普通业务请求重新放成洪峰。
- 真机版本未同时包含这组代码时，只能验证旧协议兼容路径；必须以 Desktop、Mobile
  实际版本和 24 小时日志中的 `await-link-confirm`、`link-confirm-ack`、
  `link confirmation timeout` 与 `responsiveness probe` 证据判断发布效果，不能仅凭
  “online”判定连接健康。若同一 request 长期只有 `await-link-confirm`，说明对端没有
  提交本代 accept；若随后出现 `link-confirm-ack`，说明发送方向已经安全恢复；若出现
  `link confirmation timeout`，说明本代确认未完成并已进入 peer 级重开路径。

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
- 物理帧上限 `MAX_FRAME_BYTES`(2MB,按 **UTF-8 字节** 计,两端一致)；可靠 wrapper 的
 逻辑消息上限和分片边界见上节。

## 源码导航

| 关注点 | 文件 |
|---|---|
| 协议帧 / payload / 错误码 / 版本 | `src/protocol.ts` |
| 客户端状态机(握手/心跳/重连/req-resp/帧分发) | `src/client.ts` |
| 远程调用白名单 + push 转发白名单 + hash | `src/allowlist.ts` |
| server 中继(presence / 路由 / pub-sub) | `apps/server/src/device-link/*` |
| 被控端 dispatch(双层校验 + 合成 event) | `apps/desktop/src/main/device-link/dispatch.ts` |
| 桌面控制端传输路由(本地/远程按 session 切换) | `apps/desktop/src/renderer/lib/makerTransport.ts` |
