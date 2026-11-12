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

尚未发布的本机插件界面增量在 v3 `mcpApps.host` 声明视图、位置、命令和能力，仍引用
`mcpApps.ui.resources` 并复用标准 AppBridge。`open-resource` 仅本机支持真正的无任务来源；
原远程操作继续要求真实任务，不扩大 device-link allowlist、relay 或 Mobile 原生能力。
receipt v2 新增可选 `approvedHostUi`，只承认当前 Host 理解且确认界面实际展示过的主体；
旧 receipt、旧页面批准及旧提示界面不自动授予新宿主操作，原工具和页面批准继续可用。
原生控件订阅/状态沿现有管子与本机用途受限 IPC，消息正文不新增落库前查询。
`message.menu` 复用贡献项的显式批准和原动作执行；只接菜单动作，关闭的菜单不成为状态消费者。
作者契约与兼容范围见[插件界面扩展](../../../apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-host-ui.md)。

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


## 单卡页面状态

执行端增量接受 `cindy/view-state/set`，参数仅 `{state: JSON对象或null}`，整体替换。
初始化成功且读取恢复值成功时，在 `hostCapabilities.experimental['cindy/view-state']`
声明 `{version:1,maxBytes:65536,maxSessionBytes:1048576}`，仅在该次
`hostContext['cindy/view-state']` 交还快照。查看端自报同名字段和未来标准viewState被剔除，
环境更新不能覆盖；读取失败／超时不声明能力，不能让页面覆盖未见到的旧值。
保存确认只在事务提交之后，单页一个在途批次及一个最新待写批次，最多32个未完成请求；
合并请求共享提交结果，不自动重试。错误-32602为值或额度不合法，-32603为暂不可存，
卡片／账号失效沿既有权限错误。只接受深度16／8192节点内JSON，拒绝本机resource_link，
因此既有跨端本机文件隔离扫描不需放宽。状态只交该页，不进消息、模型或MCP服务端。

状态在执行端账号库独立表持久化，按消息绑定任务、serverRevision及插件实例；读取不写库。
删除消息整批清理、删除任务及旁聊同事务清理，账号库就绪一次补扫其它deleted任务；
清空、rewind、归档、卸载保留。并发是后提交覆盖，既有开页不会收到更新广播。
数据库沿用现有migration准入规则：已升级的库不能由不支持该migration的旧版程序打开；
不能把跨端可选字段兼容当作数据库可降级，也不得删除migration或手改schema版本绕过准入。

新增消息仍装进既有op:message，初始化响应仍走现有poll；remoteViews仅清理链接状态，
不投影掉扩展字段。原始状态请求不需要手机／远程查看新增操作、白名单、资源模块或原生配置。
新执行端+旧查看端按既有JSON透传可用；旧执行端不声明能力，新页面必须降级。
自建中转继续透明转发已有加密invoke/invoke-result，不新增relay帧或服务端字段；
官方／自建中转的手机和双控制端互通仍需实机验收，单元测试不能替代该验收。
请求失败只影响本次保存，不关闭peer或共享relay、不发起后台重放；一台查看端静默不得影响另一台。
执行端先升级即可使用原始请求；JS／React 辅助模块的查看端供给与兼容见下节。

实现：mcp-apps/viewState.ts、viewStateStore.ts、host.ts、service.ts；DB事务在
localDb/worker/opHandlers/mcpAppViewState.ts，由文件worker与inline worker共用。
回归：viewState.test.ts及localDb/client的tx.test.ts，覆盖回执、合并、读取失败、恢复与删除。

## 内置页面状态辅助模块

临时 `McpAppDocument.sdk` 新增可选 `addons['cindy/view-state']: { source, reactSource }`，
由执行端提供固定的两个 ESM 模块；不改变官方 `sdk.source`，不写卡片、不改状态 RPC。
新 Desktop/Mobile 查看端将它们按同源固定路径供给，importmap 名称为 `@cindy/ext-apps`、
`@cindy/ext-apps/react`。作者 exact/prefix/null/scopes 映射保留；不注入 React 或替换官方 SDK。
远程预算先移除 addons，再沿既有 SDK/HTML 预算降级；坏 addons 元数据不丢原 SDK。
旧查看端忽略 addons，旧执行端不提供 addons；模块缺失时页面用动态 import catch 保持本地 UI。
模块存在仍须按初始化能力保存，读失败未声明能力时不写。隐藏后停止计时器与新请求。

沿用既有 open/invoke-result 业务 payload 和 invokeTransfer 压缩，不改 device-link 顶层字段、
allowlist、签名或 relay 解析。官方和自建中转均透明转发既有加密消息，无新增中转适配；
服务端不参与模块解析。执行端与查看端可独立升级，完整模块使用需要双方支持。
Mobile 只增加现有原生 startApp manifest 的两个 JS 文件和共享 importmap，原生 API 不变；
发版判断仍以同环境 fingerprint 对比为准。PAGE-GENERATION 的 CDN 随对应客户端发版更新。
