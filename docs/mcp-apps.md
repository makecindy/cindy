# MCP Apps 接入与验证

Cindy 实现通用 MCP Apps Host。业务服务器按官方协议提供工具与 HTML 资源，
可以使用官方 MCP Apps SDK，也可以自行实现标准消息；无需修改 Cindy 前端，
也无需把页面做成 Cindy `.cindy` 插件。
基准为 [官方 `2026-01-26` 规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)，
Host 与 View 互操作使用 `@modelcontextprotocol/ext-apps@1.7.5`，MCP SDK 保持现有 1.x。
模型 facade 在首次 MCP 请求（包括 `initialize`）时登记连接，未使用的桥接工厂不占 Host 连接额度。
代理关闭时释放连接；仍被打开的 View 使用的连接保留到该 View 关闭。
标准初始化回复逐字保留上游 MCP 的可选 `instructions`，由 Main 的认证连接读取；
协议版本与 capabilities 仍由官方 SDK 协商。初始化失败会返回明确的 RPC 错误。

## 任务停止与服务端取消

Claude / Pi 的取消通知以及收到的标准 MCP `notifications/cancelled` 会转给上游服务。
Cindy 会在用户停止 Codex 任务时尽力通知自定义 MCP 服务，但不保证服务端操作会被撤销。
收到 `turn/interrupt` 确认后，宿主只取消发出停止时该任务实例、该线程仍在进行的 App 外壳
`tools/call`，通过现有 AbortSignal 和上游 `notifications/cancelled` 传递，不等待工具结果、
不重放或重试；内置服务、其它线程和发现请求不受影响。没有可靠线程归属或停止未获确认时不猜测取消。
Codex 原生未必自行发送 MCP 取消；服务仍须限制长操作，并区分“停止等待”和“撤销已执行操作”。

## 插件的交互页面

首个支持版本为 `0.1.122-beta`（`PLUGIN_UI_MIN_CINDY_VERSION`）。声明交互页面的包须填写
不低于它的 `minCindyVersion`；`0.1.122-beta.1`、`0.1.122` 满足，`0.1.121`、`0.1.121-beta` 不满足。
该下限用于打包校验和市场兼容版本投影，不新增客户端安装闸门。

插件继续通过 `ghost_info` / `ghost_call` 发现与执行 main.js 工具，不向 Agent 增加 MCP 服务。
v3 顶层 `mcpApps.ui.resources[]` 声明作者指定的 `ui://` URI、包内静态 HTML 的 `file`、页面 CSP 和 `prefersBorder`；`mcpApps.ui.tools` 按原工具名原样保存标准 `_meta.ui`（`resourceUri` / `visibility`）。多个工具可以共用资源；仅供页面的工具不出现在模型清单，
也不能经 `ghost_call` 调用。未关联的旧工具默认仅供模型使用。

Main 为已批准页面能力的插件建立进程内 MCP 服务：`tools/list` 投影标准 `_meta.ui`，
`resources/read` 返回 `text/html;profile=mcp-app` 和资源 `_meta.ui.csp`；AppConnection
通过官方 SDK InMemoryTransport 连接。页面使用官方 App SDK 或标准 JSON-RPC，无需 Cindy API。
不读取 `mcp.json`，不启动额外 Node MCP 进程，也没有插件 MCP 专用的远程连接或认证。

`ghost_call` 完成后，宿主将同一份输入和结果写入标准 App 卡片，模型结果剥掉根 `_meta`。
页面调用只允许同插件且 `visibility` 包含 `app` 的工具，审批通过后由 Main 签发一次性
调用凭据，绑定任务、卡片、实例和批准版本。执行仍走 `ghost_call` 的准备、权限与 main.js
派发链，沿用联网凭证、设置、文件、作品库和媒体能力的现有规则。页面不能自行提供 Agent
附件或 `save_dir` 过户凭据。页面工具结果不会再生成第二张 App 卡片。

普通安装确认列出交互页面；新增资源、页面域名或工具的 app 访问权限需要确认。只改 HTML 内容不扩权；同一文件的 URI 改名不扩权，改名同时新增域名或 app 工具权限仍需确认。
`mcpApps` 是 Cindy 的清单扩展，并非 MCP Apps 标准包格式。资源的 `file` 不透传到 `_meta.ui`；`domain` / `permissions` 校验并保留，但一期不授予相应浏览器能力或指定源。未知 `mcpApps` 扩展保留为数据。
服务端 `defaultInstall` 下发的插件，交互页面能力随下发方静默授予：首次默认安装、组织默认接管、
同源静默更新以及仍具默认资格的恢复都随真实包批准写入 `uiCapabilityApproved`，不另询问、不出待确认提示条。
旧 Host 安装缺该事实时，Main 依据当前默认资格、来源账本、owner、实例与 revision，复用市场更新事务
重新校验当前发布包后补齐。普通市场手动安装、自定义市场、本地包、Forge 或已失去默认资格的插件不代批；
Server 审核和展示 manifest 不是授权依据。
CSP 域名不得超出 `network.hosts`。旧 Host 保留 v3 顶层未知 `mcpApps`，但不加载页面；升级后
未具备默认下发资格且缺 `uiCapabilityApproved` 的插件仍可执行原工具，仅显示文字。用户通过执行电脑、同账号远程查看端或手机的任务提示条/插件详情确认
后，下次调用即可显示页面，不改变当前任务工具注册。旧 Host 不识别 visibility，作者不能
依赖旧 Host 隐藏工具。停用、卸载、更新、账号切换与睡眠撤销页面；晚到的调用结果不再交付。

卡片由宿主显示插件名与信任等级。页面进度与本机文件只读地址见下文。
同账号手机与远程 Desktop 复用 plugins 远程管理事务和现有插件确认界面。Host 快照中的
可选 `uiCapabilityApproval:true` 表示支持；`approve-ui` / `defer-ui` 携带 `uiConsentVersion:1`，
与操作 fingerprint 绑定。三端使用同一份页面、域名及页面可调用工具事实（含默认 model+app）。
共享任务访客与供应商分享访客不能确认；Main 在写入前和写入中复核 owner、实例、revision。
断线或超时不是拒绝，丢失回执只查询原操作，不重发批准；“以后再说”在同一执行电脑、
账号、插件版本的本次运行内由各查看端共享。

| 控制端 / 执行端 | 行为 |
| --- | --- |
| 新 / 新 | 可在任务提示条或插件详情确认交互页面 |
| 新 / 旧 | 未声明 capability 时不发送新操作，提示更新执行电脑 |
| 旧 / 新 | 原插件管理继续可用，泛化安装确认不能新增页面批准 |

本期不经 device-link 传输插件文件。初始卡片或后续工具结果含本机媒体/Library 引用时，
远程 Host 返回 `MCP_APP_FILES_LOCAL_ONLY`，查看端保留文字并显示“文件内容请在执行电脑查看”，
不将坏图交给页面。不引用这些文件的标准页面继续交互；未声明 downloadFile 的 Host 仍明确拒绝下载。

### 页面尺寸与操作确认

内联高度范围为 80–5000 像素，超出部分在卡内滚动。离屏页面仍卸载，边缘留 80 像素缓冲；
卸载撤回该页面待确认的操作。仅宽度或尺寸上限变化会更新尺寸上下文，退出全屏重新发送内联尺寸。
短时间连续增高或来回振荡会锁定高度并记日志，宽度变化后重新测量。不要同时使用 `100vh`
和 SDK `autoResize`；它会把 Host 分配的高度再次当内容高度反馈。内容多时使用全屏。

插件页面与自定义 MCP 页面操作在卡片标题下及输入框上方浮层显示同一个待确认请求；
浮层不挤压对话区，多个请求合并呈现。页面调用与 AI 调用同一工具时审批一致，由任务权限模式决定。
插件页面调用本插件 app-visible 工具时，Main 用可信插件身份构造 `ghost_call` 参数，复用
`getDesktopMcpToolApprovalPolicy` 分类。Ask 下 `auto-approve` 直接放行，`prompt` 提供
允许一次、拒绝和“本任务总是允许”，`prompt-each-time` 不提供总是允许。
工具策略的自动放行例外继续生效；其他调用在 Auto 下走统一审阅并注明“由插件交互页面发起”。
完全访问跳过页面操作审批，切换后通过同一交互请求放行已等待的审批。点击、加载时脚本和定时器调用处理相同，不把用户操作当作工具授权。
页面的总是允许只保存在 Host 内存，限同任务、同服务、同工具的页面调用，与模型调用授权独立；
重启、任务结束/清空、服务配置变化或插件撤销后清除。自定义 MCP 的审批行为不变，逐次确认或
破坏性工具不提供总是允许。远程 Desktop 和 Mobile 复用同一交互请求通道，无新增协议。
插件内部能力仍保留各自权限检查，页面工具审批不能抵消工作目录写入确认。系统选文件/另存为
是选择动作；安装及交互页面能力批准是一次性授权，完全访问不替用户确认。SSH 任务不得借完全访问
静默读取控制电脑文件的既有边界不变（插件页面不支持 SSH 任务）。
作者格式与示例见[插件 Node 与交互页面手册](../apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-node-worker.md#交互页面桥接原有工具)。

## 协议兼容矩阵

卡片中的完整工具结果以 1 MiB 持久化预算为界；超限处理见下文「接入」。

| 官方协议项                | Cindy 行为                                                                                                                                         | 验证                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Client extension / MIME   | 声明 `io.modelcontextprotocol/ui` 与 `text/html;profile=mcp-app`                                                                                   | HTTP、SSE 官方 SDK 互操作        |
| 工具发现                  | 解析 `_meta.ui.resourceUri`，兼容 `ui/resourceUri`；读取 `ui://` 资源                                                                              | metadata / URI 单测              |
| 工具可见性                | 默认 model+app；App-only 不给模型，model-only 不给 View                                                                                            | 官方 SDK 互操作、远程授权回归    |
| 资源读取                  | `resources/read` 支持 text、base64 blob；优先读取内容 metadata，缺失时查 resources/list                                                            | 资源 / MIME / 大小 / base64 单测 |
| 初始化                    | 官方 AppBridge 协商版本、Host/App capabilities、Host context                                                                                       | 独立官方 App SDK                 |
| iframe proxy              | Host、外层 proxy、View 相互隔离；保留标准 sandbox-ready 通知与完整 HTML；桌面通过不同 custom origins 提供同一 HTML 和 CSP headers                  | 真实 Electron 集成               |
| 工具输入 / 结果           | initialized 后先给完整 arguments，再给完整 ContentBlock、structuredContent 和 View-only `_meta`；模型结果去掉根 `_meta`                            | 初始化 / 顺序 / 结果互操作       |
| 工具输入片段              | 可选；当前在工具调用时发送完整输入，无 partial 通知                                                                                                | 完整输入顺序测试                 |
| 取消 / 销毁               | 标准 cancelled 与 resource-teardown；等待响应，有界退出，撤销本地供片                                                                              | 官方 SDK 与 Electron 集成        |
| App 调工具                | 只连接产生该卡片的 MCP server；复用任务权限卡；发起审批前、审批后与结果返回前再次核对归属、清空与配置                                              | 可见性 / owner / 撤销 / IPC 回归 |
| MCP 资源与通知            | 转发 resources/read/list/templates、工具列表、prompts/list 与 list_changed；不开放任意 server 或 endpoint                                          | 官方 SDK、连接和操作测试         |
| `ui/open-link`            | 仅 http/https，无内嵌凭证；在当前查看设备的系统浏览器打开，失败返回 RPC 错误                                                                       | controller / Host / URL 单测     |
| `ui/message`              | 支持 text、resourceLink；原生命令转为普通文字，历史保留原文；保留 user role 和真实 App 来源，不作为主人授权；入队及最终派发前重新核验卡片和 View   | 官方 SDK 互操作、来源与发送回归  |
| `ui/update-model-context` | 支持 text、structuredContent；按 View 替换最新值，不启动模型；下次发送或插话附加外部应用上下文，接受后消费这份快照，失败保留；不进入 system prompt | 官方 SDK、发送链回归             |
| 显示模式 / 尺寸           | Desktop inline+fullscreen，Mobile inline；返回实际模式；size-changed 调整高度；Host context 同步模式变化                                           | 互操作、controller 生命周期      |
| 主题 / 环境               | Light/Dark、CSS variables、locale、时区、尺寸和设备能力通过 Host context 传递                                                                      | Electron 中主题切换、类型检查    |
| CSP / 权限                | 按 connect/resource/frame/baseUri domains 构建 CSP；默认拒绝未声明网络；权限声明为空，拒绝摄像头、麦克风、定位和剪贴板                             | 注入单测、真实 Electron 阻域     |

“符合标准”包含如实协商可选能力，并不表示 Host 宣称支持所有可选能力。View 对接的 AppBridge 当前不声明
sampling、downloadFile、pip、图像/音频 `ui/message` 或图像/音频模型上下文。App 必须先检查
Host capabilities；不支持的调用明确失败，不静默丢内容。工具结果本身仍完整交给 View。
后续标准新增版本需要升级并重新验证 SDK；使用上述稳定协议的新 App 不需要业务特例。

桌面允许 App 内的嵌套 iframe 加载该资源声明的 `frameDomains`，并核对所属 App 和当前账号。
这项授权只适用于资源的后代 frame；App 自身和外层 proxy 仍保持原导航边界。
未声明域、不同协议、其他 App 的供片地址和本地文件不会因此获得访问权限。

Desktop（本机和远程卡片）的 App RPC 双向传输由可信 proxy 直接发给 Main，不经过顶层 Renderer。
open IPC 只返回 `viewId`、`transport: "sandbox"` 与 `prefersBorder`；私有 HTML、CSP 和
资源策略只由 Main 供给隔离 frame。远程 v1 仍向 Mobile 与查看端 Main 发送完整文档。
Main 按 Chromium 的真实请求 frame、所属窗口、账号与供片记录验证通道，内部鉴别值不进入
HTML、preload 返回值或 JavaScript Request。顶层 Renderer 的 message/poll/link-result
操作被拒绝；它只观察初始化、尺寸、显示模式等界面状态，不能伪造 App 调用或 Host 结果。
回归见 `sandboxProtocol.test.ts`、`sandboxBridge.test.ts` 与真实 Electron 沙箱验证。
其中 `host-context-changed` 只接受 Host 轮询返回的事件；App 自报的同名通知不能改变
卡片显示模式，App 的初始化和尺寸通知仍正常转发。真实沙箱验证同时覆盖伪造通知被拒绝
与标准 `ui/request-display-mode` 成功后的模式同步。
远程 Desktop 的专用本机入口仅允许打开、取消、环境和显示状态及关闭；Main 取得远端文档后
绑定本机账号、窗口、任务、设备和远端 View，只将真实 frame 的请求转发到既有 device-link。
通用 `deviceLink.invoke` 不再转发 MCP Apps channel，Renderer 也不能提供远端 HTML、
重绑 View 或直接打开 App 外链。外链只能来自 Main 保存的轮询事件，在执行 Host 明确复核
该 `linkId` 后由查看端 Main 打开。关闭期间保留 frame；窗口重载/崩溃仅取消和回收本窗口的
加载及 View。短暂断连只重试该 View 的读取轮询，最多 30 秒，不重放工具/消息，不重置
其他控制端或 relay。回归见 `remoteViews.test.ts` 与 `deviceLinkIpc.test.ts`；双机实测待补。
App 发起的工具调用与工具、资源、模板、提示列表及资源读取在上游完成后，交付结果前再次核验
当前 View、卡片、账号、服务器配置和取消信号；撤权后的晚到结果被丢弃，不重放上游调用。
工具发现完成后、发起权限请求前也执行同一复核，避免已撤权的 View 弹出审批。
回归见 `viewAuthorization.test.ts`。

Mobile 扩展已有原生 HTML 资源模块，分别在两个 loopback 端口提供可信 proxy 与 App，
两者同站但不同源；App iframe 使用 `allow-scripts allow-same-origin`，保留 localStorage /
IndexedDB 的来源能力，同时不能访问 proxy 或跳转顶层页面、打开弹窗。原生 HTTP 响应提供
App 的完整 CSP，proxy 的资源地址由宿主固定，不能被普通桥消息替换为同源内容。
原生 App 资源与普通 HTML 预览分别计数：App 最多 16 个来源服务，容纳 4 个活跃 View 的
双来源与退出期间的余量，普通预览仍限制为 4 个。原生内联 slot 承载根级 React host 持有的
同一个 WebView；卡片离屏或实际页面卸载后，先将内容移回屏幕外 host，保留消息回调，
收到 teardown 响应或满 1 秒后移除 WebView、停止两项资源服务并清理专属缓存。退后台
关闭旧 View，原生资源最多保留本次后台代次 1 秒；回前台打开新 View，不重放工具调用。
这改变两端 runtime fingerprint，必须有针对冷更的明确确认并发布原生新包；不能仅 OTA 交付。
旧安装包缺少 App 承载能力时保留已保存文本并提示更新手机，不回退到同源或 opaque-origin
`srcdoc`。下次进程首次打开时清理中断遗留的本功能随机目录。iOS 使用非持久 WebView
数据存储；Android 不使用会清空其他 View cookie 的 incognito 开关，只删除本 View 的
cookie，并避免本进程重用已发放的 App 端口。资源来源先加载可信初始化页，同步清除
localStorage/sessionStorage、等待所有旧 IndexedDB 删除成功后才加载原始 App HTML；
删除失败或被阻塞时不运行 App，由初始化超时报错。实际存储清理与端口重用隔离仍须
Android 原生验收。Android 的 WebView 导航回调没有
`isTopFrame`，因此声明的 `frameDomains` 仍按域校验，不把缺失字段当成顶层导航；
iOS 另保留显式顶层请求拦截；可信 proxy 同时检查实际 `event.origin`，同一 WindowProxy
导航到声明的第三方 frame 域后也无法获得 App 桥。回归见
`apps/mobile/src/__tests__/mcpAppCard.test.tsx` 与 `mcpAppNativeDocument.test.ts`。这些测试
使用 JS mock/VM，不是原生存储、内联 slot、异步 teardown 或系统返回手势的真机证据。
手机卡片只在消息列表项可见或被定位时打开 View，离屏释放并保留高度占位，重新进入时
重新读取；打开期间离屏会取消加载并回收晚到的 View，不重放 App 工具调用。

## 接入

在 Cindy 设置中添加普通自定义 MCP，选择 Streamable HTTP 或 SSE 地址及所需认证。
凭证留在 Main 的现有密钥存储中，不进入 iframe。Claude Code、Codex、Pi 都通过同一
Host facade 调用自定义 MCP；支持 Apps 的工具执行时生成独立卡片，历史卡片可重新连接。
不支持 UI 扩展的普通 MCP 保持文本工具使用方式。
模型侧 facade 继承下游 harness 实际声明的 client capabilities（含其他 extensions），
再追加 Apps extension；roots、sampling、elicitation 与普通服务器回调只返回产生该
连接的 harness，客户端通知（如 roots/list_changed）沿同一连接转发。回调返回前
再次核验账号与服务器配置；取消按请求 ID 转发，不重放。View 的 AppBridge 不因此
获得 sampling 等可选能力。
模型侧 facade 如实透传上游 capabilities；补全、资源订阅/退订、日志级别、普通扩展请求
与 MCP task 方法仍由同一认证连接处理，资源更新、日志和 task 状态通知返回原模型连接。
进度 token 映射及取消跟随单次请求；异步结果返回前再核对账号和服务器配置。
工具调用仍检查 model 可见性。MCP task 异步调用沿用上游结果，不额外生成 App 卡片；
这些模型侧能力不扩展 App 沙箱已声明的可选能力。

SSH 远端使用既有认证桥和 Session instance 路由；只暴露实际配置的自定义 server，
仍拒绝无关的本机 MCP。伙伴的自定义 server 还需出现在冻结的工具装配名单里。
设备互联和手机端只负责显示与转发，不下放凭证。远程调用授权已做 loopback 回归；
尚未验证真实 SSH 主机与真机 Mobile 的端到端行为。
共享任务访客在 Desktop 和 Mobile 只显示卡片名称、已保存结果中的 text 块和主人专属
操作说明，不挂载交互 View、不请求 MCP Apps channel；没有文字结果时仍保留名称与说明。
历史、增量推送和离线队列在 Host 的共享访客 wire 边界统一投影为仅含版本、名称和公开
文本的 `mcpAppHistory`；不下发调用参数、服务器身份、schema、structuredContent、
View-only `_meta`、嵌入资源或未知附加字段，持久化的房主完整记录不变。房主本机及同账号远控
继续使用交互卡片，Host 的访客拒绝规则保持不变。回归见两端 `McpAppCard` 测试与
`packages/maker-shared/src/__tests__/mcpApps.test.ts`。

资源上限为 4 MiB；每个远程查看端最多同时打开 4 个 View，本地查看端 16 个。
远程文档（含 HTML、CSP、policy 与 viewId）和 poll 的完整事件数组按 UTF-8 JSON 字节
计量，上限为 4 MiB 减 64 KiB，给 invoke-result 与路由封装留出余量；多字节文本、
JSON 转义、数组括号和分隔符均计入。超限文档在保留 View 前明确拒绝；事件背压
只作用于该 View，确认已消费事件时回收相同的 UTF-8 字节，不重建共享连接。
持久卡片按完整 `{mcpApp: record}` 的 UTF-8 JSON 字节计量，上限 1 MiB，
为 4 MiB View/device-link 传输中的历史行转义、初始化和输入/结果封装保留余量。
结果使卡片超限时，在写入前替换为标准 `isError` 与 `MCP_APP_RESULT_TOO_LARGE`，
实时及重开 View 使用同一有界结果；原工具返回给模型的内容保持不变。
输入或工具 metadata 本身超限时拒绝存卡，不写入超大历史，也不阻止原工具执行。
Desktop 卡片仅在可见时打开，离屏或窗口隐藏时释放 View，重新可见后重新加载。
主动关闭时，控制器先发送标准 `ui/resource-teardown`，从发送时起最多等待 1 秒，
收到对应 JSON-RPC result/error 或超时后再让 Host 释放 View；并发关闭等待同一次清理。
Desktop 在此期间保留隐藏 iframe 与回执监听。Mobile 由根级 host 保留同一个原生
WebView 与回执监听，消息卡片卸载时先移回屏幕外，再按同一上限回收；实际原生运行仍待验收。
回归见 `packages/maker-shared/src/__tests__/mcpAppController.test.ts`。
承载本地或远端卡片的 Renderer 重载、崩溃或销毁时，Main 同时回收该 Renderer 的 HTML
供片和 Host View，立即释放额度，并取消该查看端尚未完成的加载，拒绝晚到 View；同文档
导航、子 frame 导航、其他窗口和设备的 View 及仍被使用的连接不受影响。
回归见 `sandboxProtocol.test.ts` 与 `openLifecycle.test.ts`。
单次模型上下文按请求参数的 UTF-8 JSON 字节计量，上限 128,000 字节；每个任务的
完整上下文数组上限 512,000 字节，包含 JSON 转义、数组括号和分隔符。更新与发送
使用相同的计量方式，替换旧值释放预算；超限拒绝保留原值，不影响其他任务或账号。
Host 最多保留 256 份待发送上下文；达到条数上限或任务聚合字节将超限时，先回收卡片失效、任务归档、账号或配置
变化留下的旧值，再判断额度。关闭 View 不清除仍有效的上下文，并发更新不被旧清理覆盖。
回归见 `contextBudget.test.ts`。发送与插话在实际派发前重新核验快照对应的卡片、账号与
MCP 配置；普通发送在 metadata、附件及视觉准备后再次复核，插话也覆盖视觉准备后的
边界。复核不消费上下文，派发失败保留仍合法的更新，接受后只消费本次捕获值。
只复核 App 上下文时保留原有主人意图，不把外部 App 文本提升为授权；宿主明确返回的
空意图仍会清除旧授权。回归见 `makerSendTransaction.test.ts`、
`pluginTaskAuthorshipWiring.test.ts` 与 `packages/maker-core/src/session.origin.test.ts`。
Host 资源加载最多 90 秒，远程打开
请求等待 120 秒；文档到达后再给 App 45 秒初始化。控制端取消或丢失打开回执时，
使用可选 `openId` 和 `cancel-open` 回收该次加载或晚到 View，不影响其他查看端。
旧 v1 Host 不支持取消操作时仍由既有空闲租约回收，收到晚到回执时控制端主动销毁。
连接暂时中断只重试读取轮询，最多 30 秒；后续独立请求可重新建立 MCP 连接，
已发出的工具调用和消息不自动重放。
长轮询等待前后均复核当前卡片、账号与配置；撤权后不交付已排队或晚到的外链与通知。
本机 Desktop 在实际打开外链前再次复核 Host 的 View/card。远程 Desktop 由查看端 Main、
Mobile 由共享控制器，在调用当前查看设备的浏览器前通过 `authorize-link` 复核执行 Host 的
View/card 及仍在等待的 `linkId`。Host 一次性认领请求，将原 10 秒待授权计时替换为
30 秒结果等待；回执携带 `validForMs`，控制端用单调时钟计入整个往返时间，
打开前再检查有效期及查看端 View 未关闭。重复认领、过期回包、拒绝、超时、
未知操作或缺少有效期回执均不打开、不自动重试该动作，并向 Host 报告外链失败；
旧执行端需更新才能为新查看端完成复核，旧查看端需更新才会执行这一步。
回归见 `viewAuthorization.test.ts` 与 `mcpAppController.test.ts`。
App 消息排队期间只在 Main 保留当前卡片/View 的私有 guard；正常 drain 和排队插话
均在最终派发时重新核验，插话也在 Session 异步准备之后检查。guard 不进入公开队列
投影、历史或持久快照；恢复后的 App 队列行无法重建活授权，会明确失败，需要从当前
卡片重新触发。旧版 App 来源标记只用于拒绝无 guard 的旧行，不能授予发送权限。
模型工具发现完成后、返回工具清单或写入待执行卡片前复核账号与配置；配置在存卡期间失效时，
已写卡片收尾为标准错误，取消请求收尾为取消，不调用或重放工具。
回归见 `preCallValidation.test.ts`。
工具在页面加载期间完成或取消也会在初始化后正确交付；任务在加载期间被清空、
服务器被撤销时，Host 会拒绝展示并清理 View。
保存晚到结果失败时，Host 会释放该账号、任务和卡片的所有 View，并保留原错误；
初始化输入及结果/取消通知在发送前重新校验当前卡片。清空、回退或删除后的旧 View
不能收到晚到数据，其他卡片的 View 继续工作。

## 本地模拟申请表

```powershell
pnpm.cmd --filter desktop mcp-apps:mock
```

脚本输出随机 loopback 端口的 HTTP 与 SSE 地址。把其中一个地址手动添加为自定义 MCP，
让模型调用 `draft_form` 即可显示表单。模拟服务器使用官方 registerAppTool、registerAppResource
和独立 App SDK，页面无需联网下载代码。脚本不修改用户设置。

1. AI 给 title/body 初值。
2. 用户核对修改，`ui/update-model-context` 只更新下一次发送的上下文；发送或插话被接受后消费本次快照，失败时保留供重试。发送期间的新更新留给下一次发送，原生命令不消费上下文。
3. 点击创建后调用 App-only `create_application`，返回内存申请编号和 `sent:false`。
4. 点击“请 AI 继续修改”才发送消息并启动后续模型轮次。

这验证了于浩博讨论中的“AI 预填 → 用户核对 → 创建申请”流程。模拟创建不发送真实站内信，
不连接业务生产接口；真实 GM App 尚需业务服务器提供标准工具与资源。

## 独立实现的数据看板

```powershell
pnpm.cmd --filter desktop mcp-apps:mock --raw
```

同样输出随机 loopback HTTP/SSE 地址；添加为普通自定义 MCP 后调用 `open_metrics`。
看板的 View 只使用标准 JSON-RPC/postMessage，不依赖 Cindy API 或官方 View SDK；
服务器使用普通 MCP SDK 的低层 handler，不使用 MCP Apps 注册 helper。
它与申请表复用同一生产 Host，覆盖分页发现、blob HTML、resources/list metadata、
App-only 刷新、完整工具结果、模型上下文、消息、显示模式和尺寸通知。
测试还使用 text HTML、read-level metadata 和旧 `ui/resourceUri` 组合验证兼容读取。

## 一键协议验证

```powershell
pnpm.cmd --filter desktop test:mcp-apps:conformance
```

顺序运行协议、连接、授权与 IPC 回归，再分别启动真实 Electron 沙箱加载官方 SDK 申请表
和独立 JSON-RPC 看板。HTTP/SSE、text/blob、metadata 来源、分页与变更通知、取消、
销毁、显示、主题和 CSP 都纳入覆盖。前序两种 App 的沙箱检查通过，
逐项证据与边界见 [本地协议验证记录](./mcp-apps-validation.md)。

## 检查入口

```powershell
pnpm.cmd --filter desktop exec vitest run src/main/mcp-apps/__tests__ --maxWorkers=2
pnpm.cmd --filter @cindy/maker-shared exec vitest run
pnpm.cmd --filter desktop test:mcp-apps:sandbox
pnpm.cmd --filter desktop typecheck
pnpm.cmd --filter mobile typecheck
pnpm.cmd --filter @cindy/maker-shared build
pnpm.cmd --filter @cindy/device-link build
pnpm.cmd check:i18n
pnpm.cmd check:i18n-glossary
```

Electron 检查启动独立隐藏测试窗口与唯一临时 profile，加载生产 Host/proxy 和两个 App，
验证预填、修改、创建/刷新、Light/Dark、跨 origin、无 preload、声明的 connect/resource/frame/baseUri
域可用、未声明域无网络请求、导航阻断、销毁和 owner 切换。测试结束关闭自身进程并清理
唯一临时目录，不启动、重启或修改当前 Cindy。
这是独立页面沙箱集成证据，不等同于完整 Cindy 卡片的 Light/Dark 实机目检；Mobile 真机
与真实 SSH 主机仍需验收。


插件页面按工具策略和任务权限模式审批后，取得绑定本卡文档的一次性调用票据；票据只绑定身份，不替代审批。
`pick`、另存为、工作目录写入、联网域名与派活等能力仍执行各自原有检查，model-only 工具继续拒绝。
可选 `tool-progress` 数值在页面提供 `_meta.progressToken` 时转成标准 `notifications/progress`，
200ms 合并一次；无数值的旧消息仍只续命，结束或撤销后不继续通知。

本机插件卡的标准文件 `resource_link`（本插件媒体地址或 `library:<相对路径>`）经归属复核后，
在 `_meta["cindy/file"]` 得到同卡来源下的只读 URL、MIME 和大小。`ghost_call.attachments` 作为
`toolInfo.tool._meta["cindy/attachments"]` 的标准资源链接补充到 Host context。只签发本卡输入或
结果中出现的资源，不开放任意路径查询；View 的 connect-src 为读取本卡文件追加 `'self'`，
该源只有本卡文档和签发文件。真实 Chromium frame、owner、卡片和插件版本共同守门；Range
沿用现有媒体流式响应，关闭 View 中止在途读流。远程端和手机暂不签发本机文件地址。
对话交接的非媒体副本以 `handoff:<uuid>` 资源链接写进 `cindy/attachments`，签发方式相同；
副本过期或被删时，卡片里（附件列表、入参或结果）的 `handoff:` 链接只保留名称、类型和大小、不带地址，View 照常打开；Library／媒体链接仍严格拒绝。

### 插件页面文件能力

本机插件 View 可消费标准 `resource_link`，宿主在 `_meta['cindy/file']` 附加同卡源的
只读地址、类型和大小；只授权本卡入参、工具结果和选择/上传得到的本插件文件。
Range 可用，connect-src 的 `'self'` 只覆盖本卡文档和随机票据文件，不是任意本机
文件代理。页面关闭、插件停用/更新、文件删除后地址失效。

`pick(mode:'file')` 在宿主流式导入媒体或 Library；`fetch(as:'library')` 流式下载；
`upload.library` 复用现有 multipart 与凭证/401 路径（不改公共传输）。上传单件
64 MiB、总 128 MiB、最多 4 件；读取阶段报告真实字节，网络发送阶段不报告虚构百分比。
Library 导入/下载沿用 8 GiB 流上限；媒体导入沿用 50 MiB 单件、1 GiB 寄存配额。
页面分片建议原始字节 ≤2 MiB，View 单条消息含 JSON 总共 ≤4 MiB。

本机插件卡声明草案标准 `downloadFile` capability，处理 `ui/download-file`：
EmbeddedResource 或本卡授权文件，一次最多 16 件，每件系统另存为对话框就是确认，
不代理任意网址。未提供本机处理器的 Host、手机和远程查看端仍不声明能力，调用
得到标准不支持错误。没有新增跨端协议、数据库状态或非标准 View 方法。

`ui/message` 中获本卡授权的本插件媒体图片走正常消息附件链（含排队和历史恢复），
保留外部应用来源，不转成主人授权；其它链接保持现状，模型上下文更新不接收图片。
验证覆盖官方 App SDK 和直接 JSON-RPC；file input 用独立 Electron/CDP 验证，拖放
验证到 DOM 事件。系统选择/另存为对话框仅测试进程替换，原生点击与 OS 拖放未验证。
