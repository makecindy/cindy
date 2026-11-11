# 代输入（2026-10-13）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`../product-rules/input-handoff.md`](../../product-rules/input-handoff.md)，共享类型与 parser 在
`packages/device-link/src/inputHandoff.ts`。

- **卡片快照** `InputHandoffSnapshot`（`kind: "input_handoff"`）随既有交互推送下发，控制端按字段透传、
  不做结构化拒收。新能力一律加**可选**字段：`picture`（本步按截图作答，像素不在快照里）、`liveView`
  （可打开单窗口实时画面）、`deviceCode`（`{ code, url, origin }`，设备码登录）、`holder`、`remoteInput`、
  `agentPicture`（2026-10-30：码来自 Agent 截图，主人扫完手动交还；同时带 `agentControlled`，旧端照常显示该提醒
  与跳过；加密 offer 的 presentation 不变）、`directSignIn`（2026-11-01：这一步由主人在窗口上完成；`controls` 仍保留，
  旧控制端照旧显示表单，无实时画面的设备也退回表单或截图）等。
  本机带路用只限受信本地窗口的 `INPUT_HANDOFF_LOCAL_RAISE_CHANNEL`，不进远程 allowlist（`device-link/ipc.ts` 拒绝）。
  旧控制端忽略不认识的字段，仍能看到本步的说明文字并交还／取消；新控制端只在字段存在时展示对应入口。
  `deviceCode` 在打开前必须经 `isInputHandoffDeviceCode` 复核（https、无账号密码、origin 与显示一致）。
- **带值提交**只走插件授权 v3：`capabilities` 声明 `inputHandoff: true`，`start` 带 `inputHandoff: true`；
  每步按 (requestId, revision) 绑定，`validateInputHandoffSubmissionForStep` 复核控件与值上限。
  加密 offer 上限放宽到 480,000 字节以容纳一张截图（`PLUGIN_OAUTH_SEALED_MAX_BYTES.offer`），
  控制端回传的 callback 仍为 32,000 字节。对端未声明 `inputHandoff` 时返回「请更新」，**不降级到明文**。
  不带值的决定（交还、取消、停留、刷新、接手、看画面）沿用既有 `resolveInteraction`。
- **单窗口实时画面**沿用远程桌面业务通道，不改 relay、IPC allowlist 或协议版本：
  - 被控端以可选能力 `handoffWindow` 声明支持；控制端只在 `start` 里附 `handoff: <requestId>`
    （`^[A-Za-z0-9_-]{1,128}$`），**不能**指定窗口——窗口由被控端按请求选择。
  - 响应的 lease 附 `window: { app, title? }`。控制端收到不带 `window` 的整屏 lease 时立即 `stop` 并报错；
    被控端未声明能力时控制端报 `CHANNEL_NOT_ALLOWED`、不展示入口。
  - 该 lease 只允许窗口内输入：控制端剔除整桌面能力（剪贴板、显示模式、隐私屏、系统音频、接管），
    被控端拒绝越界操作（`DESKTOP_HANDOFF_WINDOW_ONLY`），代输入结束即结束（`DESKTOP_HANDOFF_ENDED`），
    非 macOS 或要求音频时拒绝（`DESKTOP_HANDOFF_UNAVAILABLE` / `DESKTOP_AUDIO_UNAVAILABLE`）。
  - 先发被控端：卡片上的 `liveView` 由执行代输入的那台电脑给出，它本身就是新版。
- **插件实时屏幕**（手机上的模拟器等）同样沿用远程桌面业务通道，不改 relay、IPC allowlist 或协议版本：
  - 被控端以可选能力 `liveScreens` 声明支持，并接受租约外的 `screens` 列表操作；控制端只在 `start` 里附
    `screen: {plugin, id}`（取自 `screens`），由被控端解析插件与设备。
  - 响应的 lease 附 `screen: {plugin, id, name, platform, …}`。控制端收到不带同一 `screen` 的 lease
    时立即 `stop` 并报 `INVALID_RESPONSE`——旧被控端会丢掉 `screen` 并开成整屏远程桌面。
  - 新输入 `touch` / `press` 只在实时屏幕租约内有效；旧被控端会因未知输入结束会话，所以控制端只在
    能力位存在时发送。被控端在整屏租约里拒绝这两种输入，在实时屏幕租约里拒绝 `move` / `button` /
    `scroll`（`INVALID_REQUEST`）。
  - 该 lease 只允许 stop / heartbeat / control / presentation / input / offer / ice / viewerHidden /
    screenShape，其余返回 `DESKTOP_SCREEN_ONLY`；不需要屏幕录制或辅助功能权限，结束时不锁屏，与整屏租约共用
    「每台电脑一个远程租约」（替换需 `takeover`）。
  - 设备画面转动后的形状：heartbeat 结果附可选 `shape: {width, height}`；控制端另发
    `screenShape {lease, known?}` 等待形状与 `known` 不同（被控端最多等 6 秒后照常返回）。旧被控端
    对 `screenShape` 返回 `INVALID_REQUEST`，控制端即停止该请求，改用 heartbeat 或按请求的朝向估计。
  - 先发被控端；新手机连旧电脑时不出现入口，旧手机连新电脑行为不变。
  - **电脑作控制端（2026-11-11）**：Desktop 用同一组消息查看另一台电脑上的设备画面，协议、relay 与
    IPC allowlist 均无改动。呈现在远程任务的右侧栏页签（`live-screen`，标题取插件名），位置和布局对齐
    本机插件任务页；设备出现时自动打开一次，顶栏另有找回 / 切换设备的入口。`screens` 里绑定到该任务、
    正在运行的设备才算，与手机同为 15 秒一读，仅主窗口在前台且对方声明 `liveScreens` 时读取——每次读取
    都会让对方电脑询问插件，后台窗口不读，回到前台再读。
    - 页签里的连接由 Main 的 `remote-desktop-viewer/embedded.ts` 持有（`LIVE_SCREEN_EMBED` 本机 IPC，
      只接受设备画面目标，整屏远程桌面仍只在独立查看窗口里）：目标里的 `screen` 由 Main 绑定，页面发出的
      `start` 必须带同一 `{plugin, id}`，否则拒绝（`DESKTOP_UNAVAILABLE`）；页面导航、崩溃、本机锁屏或
      换账号即交还租约。同一页面对同一设备复用一条连接，重新打开时先交还上一份租约再开始下一份。
    - 不发送 `lockOnExit` / `idleTimeoutMinutes`、退出不锁屏、不做自动解锁与剪贴板同步，也不轮询
      `frame`（设备画面只有 WebRTC 视频）。页签不可见超过 30 秒即断开：一台电脑同一时间只服务一路远程连接。
    - 鼠标左键转为 `touch`，其它鼠标键不发送；滚轮与触控板不发 `scroll`（被控端会以 `INVALID_REQUEST`
      结束会话），而是合成两指 `touch`：平移，按住 Ctrl（触控板捏合即如此到达）为捏合，停 120 毫秒后抬起，
      与插件自己的页面一致；只支持单指的设备用一指。`keyboard` 为真时点按画面后才转发 `key` / `text`。
      截图取页签里当前画面、存入本机剪贴板，不经过对方电脑。新电脑连旧电脑时不出现入口。
    - 被控端每秒重发一次静止画面，新连接才能马上拿到第一帧：画布自上次采集后没有重画时，
      `requestFrame()` 不产生帧，所以先把画面原样重画一遍。2026-11-11 之前的被控端只在设备画面变化时
      才有第一帧，控制端为此把设备画面的连接等待放宽一分钟（时钟每分钟会变一次）。
