# MCP Apps

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

页面 iframe 沙箱允许 `allow-scripts allow-same-origin allow-forms`；`allow-forms` 仅让 submit 事件分发，
页面在监听器中 `preventDefault()` 后通过工具桥接提交；宿主在 window 冒泡监听末尾（含页面自己的 window 监听器之后）取消尚未取消的默认提交，
并令直接 `form.submit()` 不执行；`method="dialog"` 只关闭对话框、不导航，保留原生行为。前置代码在显式 open 和隐式 write/writeln 替换文档后恢复监听。Desktop（本机与远程）和 Mobile
始终保留 CSP `form-action 'none'`，禁止任何地址的原生表单提交，不新增网络出口。
旧执行端和旧查看端没有该沙箱能力，依赖 submit 事件的插件需声明 `minCindyVersion: 0.1.122-beta`，两端升级。

McpAppDocument 增量增加可选的 sdk: { source }，由执行电脑从与 AppBridge 同版本的
官方依赖提供，随临时 View 转发，不写入卡片。新查看端为所有页面准备表单前置代码和 SDK importmap，
无须检测初始 HTML 的 JavaScript；作者已有的 imports、前缀及 null 映射优先，BOM/doctype 保持正确位置。
本机 SDK 从内存按同源地址供给，远程/Mobile 沿用 sdk.source，不新增缓存、操作或传输字段；
open 结果沿用现有 invokeTransfer gzip 协商，自建中转继续透明转发既有 invoke/invoke-result。
旧查看端忽略 sdk，旧 Host 缺字段时新查看端照常打开文档；此时 SDK 地址不可用，只使对应 import 失败，
不影响自带 SDK、作者映射或不用 SDK 的页面。显式或隐式整页替换、外部模块和计算 import 均无需源码探测。
页面本身的远程预算维持原限制；页面合格但附带 SDK 超限时，仅省略 sdk 并记录明确原因，仍打开页面。
由于不再检测是否使用 SDK，此取舍优先保证存量页面可用；该 View 若依赖裸 SDK import，导入会失败。
完整宿主 SDK 能力需执行端和查看端都升级，插件 minCindyVersion 为 0.1.122-beta。
重复 ui/initialize 仅更换当前 View 的文档代次：取消旧请求、审批并丢弃旧回复，已发出的初始工具输入/结果不重放，未发出的在初始化后送达，
保留卡片、已授予的附件投影与最新 hostContext；不改变安装批准、持久记录、channel 或手机原生配置。
新 Host 的每个事件都携带 generation（首份文档为 0）。查看端在转发前按当前代次丢弃途中旧回复；
事件缺 generation 表示旧执行端，新查看端不按代次过滤、保持旧行为；旧查看端忽略该字段。完整换页隔离仍要求执行端和查看端均升级。

标准 MCP Apps 使用 `io.modelcontextprotocol/ui` 扩展及官方 `2026-01-26` 协议。
客户端新增独立 `maker:mcp-apps:v1` channel，复用 device-link 的同账号调用与错误协议，
不改变已有 channel、relay 帧或服务端 schema；Mobile 原生承载与指纹影响见本节末尾。
App 卡片是既有 assistant 消息 content 的可选 `mcpApp` 字段，且必须有 Main 写入的
`agentMeta.mcpApp` 标记；旧客户端不解析该字段，仍可阅读原工具返回的文本。
新控制端连接旧 Host 时拒绝该 channel 并提示更新执行电脑，不回退到执行任意 HTML。
完整交互需要执行电脑和查看端都支持 MCP Apps；共享任务访客不开放该入口。
共享访客的消息历史与推送只携带 `content.mcpAppHistory: { version: 1, title, text }`，
不发送完整 `mcpApp`、调用参数、服务器身份、schema、structuredContent 或 View-only `_meta`；
`text` 仅来自结果的 text 块。同账号与本机继续读取完整记录，持久化数据不变。
新查看端将摘要呈现为原有只读卡片；旧查看端不支持该摘要时不提供交互，完整只读显示需更新查看端。

查看端只传标准 JSON-RPC 和界面环境；执行 Host 持有 MCP 连接、账号归属、工具可见性与
审批决定。View 绑定 owner、task、card、caller 与配置版本，清空、回退、账号切换或配置
撤销后旧操作失效。轮询可有界重试，工具调用、消息发送与创建申请不自动重放。
远程外链动作单独传给控制端，在当前查看设备打开，不在执行电脑打开。
新远程查看端打开前通过同一 channel 的一次性 `authorize-link`（`viewId` / `linkId`）
向执行 Host 复核当前卡片、账号、配置与未结束的外链请求，且只接受显式
`{ authorized: true, validForMs: 30000 }` 回执。Host 原子认领请求并把原 10 秒待授权
计时替换为 30 秒结果等待，拒绝重复认领；控制端用单调时钟把整个授权往返计入
有效期，在打开浏览器前拒绝过期回包。期限内仍由 `link-result` 返回实际打开结果，
结果丢失或 View 销毁会失败收尾。旧 Host 拒绝该增量操作、回执缺失或没有有效期时不打开外链，
该次请求按失败收尾，完整外链交互需更新执行电脑；不降级为跳过授权，也不自动重放。
旧查看端可继续连接新 Host 并忽略新增回执字段，完整打开前复核需查看端更新；
没有修改既有请求字段、channel、权限范围或原生指纹。
兼容矩阵、可选能力声明与验证入口见 [MCP Apps 接入](../../mcp-apps.md)。
Desktop 远程卡片复用查看端 Main 验证真实 frame 的通道；本机 IPC 的 `deviceId` 只选择
目标，不跨 device-link 传递。Main 保存远端 View 绑定，顶层 Renderer 只提交界面控制，
不能通过通用 `deviceLink.invoke` 发送 MCP Apps RPC，也不能提供 HTML 或指定 frame 的
目标 View。新查看端 Main 可连接既有 v1 Host，外链仍要求 `authorize-link` 明确回执；
Mobile 和旧查看端的 wire 保持原样，完整 frame 边界需更新 Desktop 查看端。
没有新增 channel、allowlist、relay 或原生配置。回归见 `remoteViews.test.ts`。
本机与远控 Desktop 的 open IPC 只返回 `viewId`、`transport: "sandbox"` 与 `prefersBorder`，
用于同版本 Main/Renderer 切换到 Main 验证真实 frame 的直连通道。凭证读取的 HTML、CSP 与
资源策略只由 Main 供给隔离 frame，不进入顶层 Renderer。该描述符不向远程设备返回；
Mobile 和 Desktop Main 之间的远程 v1 仍传完整文档，原有 channel 不变。Mobile 在原生
HTML 资源模块增加独立 App 资源额度和内联承载视图，
以不同来源隔离 proxy/App，并保留卸载后的有界 teardown；这改变 iOS/Android runtime
fingerprint，须遵守 [冷更边界](../mobile-development.md#原生配置与-runtime-fingerprint冷更边界)。
旧 Mobile binary 保留卡片文本并提示更新手机，不回退到同源或 opaque-origin srcdoc。
