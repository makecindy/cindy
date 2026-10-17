# 跨端协议兼容

## MCP Apps

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
兼容矩阵、可选能力声明与验证入口见 [MCP Apps 接入](../mcp-apps.md)。
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
fingerprint，须遵守 [冷更边界](mobile-development.md#原生配置与-runtime-fingerprint冷更边界)。
旧 Mobile binary 保留卡片文本并提示更新手机，不回退到同源或 opaque-origin srcdoc。

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改插件分发来源边界、device-link 协议／relay／隧道 payload／IPC
> allowlist，或任何改动客户端与服务端之间 wire protocol 的地方之前

客户端与服务端分别维护本仓所需的 wire Bean、validator、parser 与 builder，不共享代码仓库
或发布节奏。真正危险的是单端改变既有 wire 语义，或在不兼容变更中缺少协同；这类问题在
单仓 typecheck／单测里发现不了，只有真实连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

## Model Access 复杂价目

保持 V5，新增可组合的 `display_pricing` 能力声明，复用 `X-Cindy-Model-Capabilities` 与
`Vary`。服务端只向声明支持的 V5 下发 `displayPricing`，旧 V5 和 V1–V4 不新增字段；
新客户端接受旧服务端的无字段响应。缺失、null、空价目或无法理解的价目结构仅省略展示块，
不拒绝模型或整份目录；新增对象属性忽略，未知单位原样保留，未知 priceType 不猜成 exact。
模型必需字段及其它协议校验保持原规则。
Gateway 边界对整块报价校验，非法或无有效币种即整体省略，保留模型。币种和折扣随同次
模型快照投影，成功刷新缺字段会移除旧展示；没有新权限、数据库迁移或独立价格缓存。
两端可独立升级，完整展示需两端支持。字段只用于报价展示，不参与账单或调用授权。

## 群聊邀请公开链接

device-link-server 的公开页 `<deviceLinkBase>/chat-invite/join#<token>[?app=cindy|cindycn|cindydev]`
与 Desktop 粘贴解析共用同一规则：口令为 43 位 base64url，只放在 fragment；URL 无 query、无用户信息；
fragment 只允许一个闭集 `app` 提示，不允许额外 `#` / `?` 段；协议为 https，仅本机回环地址允许 http。
页面在电脑上唤起既有 `cindy://chat-invite/<token>`，手机不唤起。客户端解析见
`packages/device-link/src/chatInvitation.ts`（`parseChatInvitationToken`），继续接受裸口令与
`cindy://chat-invite/<token>`；链接主机只校验形状，从不作为请求地址，也不据此切换 Chat Server
或登录区域，口令只以请求正文发给当前账号的 Chat Server。

发布顺序：先发布接受 https 粘贴的客户端，并保留「伙伴 → + → 输入邀请链接…」；sh-dev、sh-prod、
sgp-prod 都部署该页面后，才把 `createInvite` 生成的链接切换为 https。旧客户端点击 https 链接
经页面转到 `cindy://` 仍可用，但粘贴 https 链接需要新版客户端。Chat Server API 不变。

## 群消息附件的结构化投影

Chat Server 群消息投影（Desktop IPC 与 `bot-group-chat` 远程资源共用 `BotGroupMessageView`）的
`content` 不再包含 `[附件: 文件名]` 占位行，附件只在 `attachments` 里。尚未取到电脑的服务器附件也
保留一项，`url`、`path` 为 null，并带可选 `state: 'loading' | 'unavailable'`；取到后同一 `id` 换成
完整附件、`state` 缺省。新版手机解析该字段，在原位置显示「加载中」/「暂时无法加载」，点开说明状态而不当作
可打开的文件；旧手机忽略该字段，把这一项显示为带文件名的文件条，旧版 Markdown 回退仍为 `📎 文件名`。手机直连同样只从 media 块投影附件，正文不再拼 caption。给伙伴的上下文文本不变。
不改 channel、能力、服务端 schema、数据库或 Mobile 原生指纹。

## 手机直连群的设置管理

### 群解散与个人列表移除

`GET /me` 明确声明 `groupLifecycleVersion: 1` / `conversationListStateVersion: 1` 才启用对应动作。
缺能力或旧副本拒绝时显示不可用，不回退为 archive 或兼容 delete。服务端合同及迁移由
`xindong/cindy-server#921` 提供；该 PR 的实际启动迁移核验与部署仍为独立上线条件。

`POST /conversations/:id/dissolve` 带 operationId 与正整数 expectedRevision，只允许 joined owner
（包括合法伙伴主人代演），且 kind 必须是 group。`dissolved_at` 是不可撤销的终态，归档只是其
旧客户端只读兼容投影。保留原历史权限，停止现有执行与分工、失效邀请均由服务端事务负责；
Desktop 收到终态后还会中止本机未完成的规划，沿原 lease 链停止执行；本机终止规划无需追加取消规划写入。

`POST /conversations/:id/list-state` 带 operationId、hidden 与本人列表 expectedRevision（初始0）。
它只移除本人账号跨设备列表，不退出、不删历史、不停止其他人的执行。已退出者通过
`GET /conversation-list-state` 获取状态，无需先读已无权限的群快照。启动及重连先取个人状态，
只合入更新的修订；成功回包或本人 human actor scope 的 `conversation.list.changed` 才清理本地
列表、选择与未读镜像，失败保留列表。手机同时订阅群和本人 human scope，代演不替换账号订阅。
同账号并发全量同步共用一次请求；普通聊天刷新复用已同步状态与事件，启动、重连及手机主动刷新重新读取。
同步失败不把缓存标记为已就绪。手机列表重新挂载时先纳入已有个人状态，直连离线也不恢复旧电脑回包。
actor scope 遇到 RESET_REQUIRED 时，在在途读取完成后重新读取个人状态，再按服务端 head 续订；
Desktop 与 Mobile 均受当前账号、socket 身份保护。个人移除成功时由仍挂载的聊天页完成返回列表，
设置面板因列表更新先卸载不会吞掉成功导航，离开页面后的旧回包也不能改变新页面。
手机收到跨设备本人 hidden 事件也由当前聊天页返回列表，本机回执与事件共用一次导航；
设置面板每次关闭/身份切换都会清空 busy，旧打开周期的请求不能覆盖新周期状态。
Desktop 解散或变更期间遇到在途 heartbeat，会合并排队一次后续租约检查，避免漏掉权威终止。

现有 `bot-group-chat` 投影可选追加 supportsDissolve、supportsListRemoval、supportsGroupLeave、dissolvedAt；远程资源
动作 `dissolve` / `leave` / `hide` 分别转发相同的服务端动作。hide 的 opaque result 返回
`{listState:{conversationId,hidden,revision}}`，手机按修订合入同一账号投影，阻止旧电脑列表复活。
Desktop 既有群变化推送新增 list 类型及可选 listState；旧窗口忽略未知类型仍会刷新列表。
旧客户端与服务端可独立升级；完整行为要求服务端全副本及使用的客户端均支持。无新增 channel、
SQLite schema、Mobile 原生依赖或 fingerprint 输入。

现有 `bot-group-chat` 数据可选追加 `supportsSettingsManagement`。仅服务器群的新版 Host
声明该能力，手机读取最新群详情和已有成员角色后才开放管理。设置动作可带
`expectedRevision`，Host 在调用服务前核验，群信息 PATCH 和归档继续携带该编辑版本给
Chat Server。新增资源动作 `add-member` (`botId`) 只邀请一个本机可见伙伴，不替换成员名单；
移出仍使用已有 `remove-member` 和 actor ID。旧手机忽略能力并保留原动作；新版手机遇到旧
Host 显示更新提示。账号切换、关闭设置、断连或撤销设备使旧读取和未发出的操作失效。
管理电脑按当前群 ID 精确读取，不以截断的群列表作为存在性门槛。普通内容刷新保留同一次
设置页已核实的管理资格，实际发送前仍复核电脑身份和最新权限；新详情确认撤权或群不可见后禁用。
Chat Server 返回的 `REVISION_CONFLICT` 保留为公开错误码，新手机显示冲突提示并保留草稿，
旧客户端沿用未知错误码的通用失败提示，不自动重试写操作。
复用原有 collection、channel、订阅、账号和群权限，不扩 IPC allowlist、relay、服务端
schema、数据库或 Mobile 原生指纹。完整管理需要两端客户端更新。

## 实时生成速度

既有 maker status 可选携带 `tokenSpeed`（`rate`、`average`、`tokens`、`elapsedMs`、
`streaming`），由主机计算；Codex 使用真实输出用量与配对生成时长，最近三个有效区间按
时长加权（包含请求后的首响应等待，排除工具与审批等待）。Claude Code / Pi 使用基于
`pi-token-speed` 的流式文字／思考／所有工具参数估算，从首个内容块开始，工具调用生成
结束即暂停。两种口径不能直接作为模型性能横向排名。收尾 `rate` 仍携带平均值以兼容旧端；
新端只更新本轮平均，保留最近速度及曲线，不把最终校准当作新的速度样本。
仅用于显示，不参与费用、缓存或上下文计数。新客户端校验数值，非法即丢弃；旧主机省略时
沿用原 usage 计数路径，旧客户端忽略新增字段。主机检测到挂起或时钟异常时，本轮后续帧不再携带该字段并标记
`generationReliable: false`，客户端据此丢弃已保留的速度。无需服务端更新、新通道、权限或
数据库 migration。

## 任务列表提前同步聊天正文

同账号控制端声明 `session-list-messages-v1` 后，`sessions` 订阅同时接收普通用户／助手
已保存的完整正文、状态与删除事件，复用原有 channel。仅列表接收的 payload
带 `listMessage: true`，不建立活跃控制意图，也不因正文到达自动拉取整段历史。工具正文、
思考、附件及超过 200,000 字符的异常长消息仍按需读取；列表显示行数不变。
共享任务访客和供应商分享不扩展订阅范围。旧控制端未声明能力时保持原来的路由。
流式增量、SDK 收尾与在途正文补偿只走详情订阅；列表仍显示原活动简介，不缓存未完成前缀。
列表离线补发按 `sessions` topic 回放，现有每设备队列上限为 2 MiB，容纳 200,000 字符
正文最坏情况下的 JSON 转义体积；仍受 128 条／5 分钟限制，超预算或过期后由打开时的
历史核对补齐，不承诺无期限离线预收。桌面预收正文在现有
缓存写锁内合并并保留结构化历史，从未打开的任务同样计入现有内存回收预算。

断档之后（App 冷启动、Mobile 断线重连后的列表重拉、Desktop 重连 bootstrap），控制端对
最近活动的至多 5 个任务用现有 `messages:view` 读取最新一页，写入原有历史画面缓存；
活动版本取 `updatedAt` 与轮次起止时间的较大值，运行中的轮次每次断档后都重读，已打开的
任务由其自身视图读取。打开任务时若恢复的历史画面落后（来自磁盘，或视图离开期间保留），
raw store 中晚于画面末尾的普通用户／助手行接在其后显示，直到最新页覆盖。仅控制端行为，
不新增 channel、能力或主机改动。

收到轮次结束落库的 `lastTurnEndedAt` 更新时，两端也只补读该任务的最新一页，并按活动版本
去重；简介变化不触发补读。手机合并短时间内的补读请求，已打开任务仍由自身视图读取。
重连补读与完成补读合并时保留两者的并集，指定的已完成任务不受最近 5 个任务的预算挤占。
桌面打开时合并预收正文与磁盘旧历史，不因已有一条新消息跳过其余缓存。
两端缓存可选保存本地正文接收标记 `cacheReceipt` 与最新页读取起始标记 `readReceipt`：
旧历史中的同 ID 正文不能遮住读取开始后收到的新正文，后续权威读取可接管。缓存延迟写回
也保留期间收到的正文；删除、rewind 和账号隔离继续遵守既有作废屏障。标记使用运行期 ID
及递增序号，不依赖墙钟；同运行期按序号比较，不同旧运行期之间无法证明顺序时保留历史画面。
当前运行期的新推送可接管恢复的旧画面，成功的权威读取接管旧标记。桌面延迟恢复的磁盘行
只覆盖有可比较且更早标记的同 ID 行，不覆盖无标记的实时正文。
标记不作为主机消息修订号，不改变网络协议或扩展流式订阅范围。

`messages:list` / `messages:view` 的 options 可选携带 `messageBodies: { version: 1, known }`，
known 是消息 ID 与主机提供的 SHA-256 正文指纹对。支持的主机在授权、净化之后返回
`message-bodies-v1` 包装，只省略指纹吻合的正文，顺序、分页与消息元数据始终重新读取。
共享 DeviceLinkClient 从本次请求固定的正文快照还原后再交给两端界面。缓存不命中或正文
变更时仍发送全文；旧主机返回普通页面，新控制端兼容；旧控制端不请求此格式。
传输去重仅保留有界内存，两端持久展示缓存继续使用原有账号隔离与删除屏障。
不修改 relay、不新增权限、数据库 migration 或 Mobile 原生指纹。

## 大文本预览的文件传输回退

`text-file:read-preview` 接受可选 `allowFileTransfer: true`。仍先执行原绝对路径、
访问策略和 10 MiB 大小校验；成功结果的 UTF-8 JSON 大于设备消息预算（4 MiB 留出
64 KiB 封装余量）时，仅向显式支持的调用方返回 `{ success: true, transferRequired: true,
size, limitMb }`，不把正文塞入消息。未声明支持的本地／旧控制端仍收到原有结果。
新手机收到标记后，使用既有 `xdt-file` 文件通道及版本缓存取件，并携带 `maxBytes=10485760`；
读取前后校验取消、账号和实际大小，结束时释放取件暂存及 OSS 对象。文本已有独立展示缓存，
其更新等待主机版本复验后再复用对应字节，避免把旧快照反复写回。无新增存储目录或通道。

旧 Host 忽略新增请求字段，新手机继续接收原正文／错误；收到明确的 `PAYLOAD_TOO_LARGE`
时可走同一文件回退，权限、缺失和连接错误不触发回退。旧 Host 若不能返回明确超限错误，
仍需更新 Host 才能消除此失败；不以超时为由重发或绕过文本授权。完整修复需要两端更新，
不需要服务端或 Mobile 原生构建变化。

## invoke 结果传输编码（弱网减流量）

控制端 `invoke` payload 可选携带 `transfer: { gzip?: 1, ifNoneMatch?: string }`：注入了解压
能力就声明 `gzip: 1`；本机持有同一被控端、同一 channel 与 args 的上一份大结果时，带上它的
内容标签。被控端照常执行 handler，只改写发出的 ok 结果：序列化后不小于 4096 个 UTF-16 code unit 的结果附带
`transfer.tag`（SHA-256）；标签与 `ifNoneMatch` 相同时回 `{ result: null, transfer: { tag,
notModified: true } }`；否则在控制端声明可解且压缩确有收益时回 `{ result: null, transfer:
{ tag, gzipBase64 } }`。共享 DeviceLinkClient 在交给调用方之前还原成普通结果，并只用发请求
时固定的缓存快照还原，回包前被淘汰也不影响；标签对不上时返回错误，不返回旧数据。
缓存快照在本地准入队列出队、实际发送时读取，结果解码后才释放准入配额：
等待期间已有同键结果到达时，后续请求能携带最新标签，避免重复整包；不跳过远端 handler。
解压有输出上限（4M 字符，与传输层单条逻辑消息同量级）：解码器边解边计数，超过即中止并
返回错误，不先整段展开；被控端对超过上限的结果不编码，仍走原有的超限处理。

handler 每次都执行，`notModified` 只省略字节完全相同的结果，因此对所有 channel 语义不变，
不需要逐 channel 登记。控制端缓存按设备、channel、args 键控，最多 32 条、约 8 MB，只在内存，
随客户端 `stop()` 清空；共享任务与供应商分享等跨账号 peer 不使用该编码。旧被控端忽略
`transfer` 回普通结果；旧控制端从不携带 `transfer`，被控端也就不会编码。Desktop（同时作为
被控端与控制端）注入 zlib 与 SHA-256，Mobile 只注入 pako 解压（已有依赖，不改原生指纹）。
relay 不解析隧道 payload，无服务端改动、数据库 migration 或部署顺序要求。实现见
`packages/device-link/src/invokeTransfer.ts`，回归见同目录 `__tests__/invokeTransfer.test.ts`
与 `client.test.ts`「invoke 结果传输编码」。

Desktop 的压缩保持 gzip level 4 与同步发送／错误处理契约，手机与电脑、电脑与电脑
共用这一实现。收益按 gzip 的 base64 长度与原始 JSON 的 UTF-8 **字节数**比较，缩小超过
10% 才采用；大小门槛、解压上限与缓存预算仍按原有字符数计。Node 编解码及数字统计复用
`@cindy/device-link/node-compression` 独立入口，跨平台主入口与 Mobile 不加载 Node 模块。
DEBUG 统计只记原始／gzip／wire 字节与压缩耗时，不记录正文或凭证。
回归见 Desktop `device-link/__tests__/transferCodec.test.ts`（实际 zlib／pako 解码）。

Mobile 开启本地诊断时，在原有 30 秒／卡顿区间统计内汇总 `relayTransfers`：每个 channel
首次写入 socket 的请求数、收到的响应数、还原正文前的响应 payload UTF-8 字节数、
`notModified` 与 gzip 命中数。前者不把准入等待或取消算作已发送，也不重复计重传；
后者不包含 envelope、分片头、ACK 与重传字节，不是总线上流量。peer 直连不经过此计数。
传输行按响应 payload 字节数降序只保留前六个通道，`relayTransfersOmitted` 标明省略的
通道数；与 push／invoke 列表一起保持在单条日志的 120 值预算内，不能当作全部通道总量。
旧 `invokeCount` 仍是业务调用次数，不能与已发请求数混用。不开诊断时不序列化计量，
不记录请求参数、正文、设备／任务 ID，不改变传输协议或恢复策略。

## 群执行终态与错误展示

发送前拒绝、SDK 错误、正常完成和宿主超时进入同一个执行收尾入口；首个终态及提交正文固定，
同一执行／epoch／operationId 重发只取回回执，不重新执行模型，也不因迟到事件再次停止专线。
主动停止沿既有服务器取消语义结束，不生成失败。

Chat Server 新增只读 `/conversations/:roomId/execution-failures`：按成员和历史可见范围返回
当前未删除源消息的完整失败状态及白名单类别。主群和 Thread 的 IPC 返回可选
`executionFailures`，真实消息分页保持原义；各端合并消息页后复用 shared 投影生成提示。
旧服务仅在路由 404 时回退读取最近 `/executions`，不声称覆盖旧服务未提供的执行；其它错误
继续进入既有读取恢复。旧服务器仍接受原有 detail，新服务器仍兼容旧客户端的 `/executions`。
设备互联由宿主投影成原有消息视图，旧手机无需理解新字段；旧宿主的历史通知继续显示。
原始错误不跨群传输，无新增鉴权能力、数据库 migration、运维配置或 Mobile 原生改动。

## 支付宝已付下一期的升级拒绝

升级报价和确认可返回 HTTP 409 `PLAN_CHANGE_RENEWAL_PREPAID`。Desktop Main 仅放行该
明确错误码，仍脱敏服务端 message；Renderer 显示本地化提示“下一期费用已提前支付，请等待
本期结束后再进行升级。”，不从错误文本反推业务状态。确认阶段收到该拒绝时也结束本次
支付展示，不将其当作网络未知结果重新确认。具体实现和回归见
`main/billing/index.ts`、`renderer/features/billing/usePlanChange.ts` 与对应测试。

旧客户端仍按 HTTP 409 拒绝操作，显示通用冲突提示；新客户端连接旧服务端保持原行为。
需服务端与客户端均更新才有完整限制和具体提示，不要求同步部署，也不新增订阅状态。
支付宝恢复续订的截止资格由服务端下发 `resumable`，客户端不另算 24 小时规则。

## Desktop 远程新建菜单

同账号控制端通过新增只读 `ghosts:composer-list(workingDir?)` 异步取得执行主机的插件菜单。
响应仅含名称、ID、实例键、namespace、指令、工具声明、图标、Skill 存在标记与目录过滤后的启用状态，
不传安装路径、批准记录、配置或凭证。目录禁用按实例键匹配，不用裸 ID；旧主机可以不带实例键和 namespace。
无项目时不传参数；共享任务访客不开放此通道。
远程清单按序列化后的 UTF-8 字节限制为 1 MiB，为传输封装预留空间；保留所有插件的基础信息，
先容纳工具声明、再容纳图标。超出剩余预算的可选字段整项省略，工具声明缺失时复用现有
`ghost_list` 按需查询，图标缺失时显示通用图标。基础信息本身超限则明确失败，不截断插件列表；
本机清单不受此远程预算影响。
切换设备、目录或账号后丢弃旧响应；打开菜单、重连或点击重试时重读，不阻塞菜单展开。
旧主机拒绝未知通道时显示读取失败与重试入口，不用控制端清单替代；插件入口需要执行主机支持此通道。

Mobile 的 `+` 插件入口复用同一清单与发送期指令模板。列表随草稿末尾的 `$` 查询词展开，
选择后把插件指令放到消息开头，保留正文与富文本引用；移除 `$` 触发词或清空草稿后收起。
旧主机拒绝清单通道时，发送链保留原文，不能阻断 `$100` 等普通文本；权限、断连或清单校验错误仍上抛。
排队编辑通过 `maker:input:update-content` 分别传递模型文本与原稿。旧主机只支持
`maker:input:update-text` 时，普通文本仍可保存；需要插件展开的编辑保留草稿并提示不支持，
不把机器指令写入用户原稿或历史。
实现与回归见 `apps/mobile/src/session/composerPlugins.ts`、`apps/mobile/src/device-link/mobileMakerTransport.ts`
及 `apps/mobile/src/__tests__/composerPluginTransport.test.ts`。

计划模式复用 `maker:create-session` 的既有可选 `planMode` 参数；新主机创建任务记录时将显式值
与任务元数据一次写入既有 `planModeEnabled` 字段，写入失败复用创建清理路径，不在创建后另行补写。
控制端临时镜像与首条消息采用同一选择。未携带参数的旧控制端
保持原行为；旧主机虽接受启动参数，但不保证持久化初始选择，完整行为需更新执行主机。
附件复用现有出站上传与接收落盘协议，上传完成后才发送远端引用；移除新建页的旧图片限定，
不增加媒体协议字段、数据库迁移、服务端能力或 Mobile 原生改动。SSH 的附件限制保持原行为。

## 账号用量上限的自动继续

输入投影 `AgentInputProjection` 新增可选字段 `usageLimitWait: { resumeAt } | null`，与 `error`
同时出现，表示被控端会在 `resumeAt` 自动继续该任务；旧被控端缺省，控制端按无等待处理。
新增 invoke `maker:input:cancel-usage-limit-wait(sessionId, opts?)`（Desktop preload、Mobile
transport 与 device-link 的 core / review-input / mobile allowlist 均已登记），只撤等待、保留错误
与 typed recovery，返回最新投影；控制端只在投影带等待时显示取消入口，因此不会对旧被控端发起
该调用。自动继续复用既有 `CONTINUE_AFTER_ERROR_PROMPT` 与 `agentMeta.autoResume`，
`autoResumeInfo.reason` 新值 `usage-limit-reset`，旧客户端按普通自动续跑行显示。
Claude Code 终态 error 事件可带 `usageResetAt`（unix ms）。服务端无需改动。
供应商组自动换电脑(2026-10-09，`docs/product-rules/provider-groups.md` §6.1)复用同一条续跑路径，
`autoResumeInfo` 新增可选字段 `agentSwitch: { from, to, cause }`(cause 为 `usage-limit` / `auth` /
`unavailable` / `overload`)，Desktop 与 Mobile 据此显示「{from} {原因}，已换到 {to} 继续」；字段缺失或
不合法时照常显示 `usage-limit-reset` 的文案，旧客户端忽略该字段。P1 不改远程 Agent 协议：被分配到别的电脑的
任务就是普通的远程 Agent 任务。分享的人这边的自动换电脑(P2c，2026-10-10)另加可选字段 `groupSwitch: { cause }`
(不带电脑名称)，Desktop 与 Mobile 显示「已自动换一台电脑继续」；旧客户端忽略，显示「用量已恢复，已自动继续」。
换电脑期间不报错(2026-10-10)：被控端判断供应商组会先试着换电脑时，输入投影里先不带这次 `error`(也不带
`usageLimitWait`)，改带 `autoResumePending`，其中新增可选字段 `groupSwitchPending: { cause }`，次数字段为 0、
`error` 只用于控制端认出随后的终态 event 是同一次失败的回声；新 Desktop 与 Mobile 据此显示「正在换一台电脑继续」，
并且不论哪种 Agent 都不再用这次终态 event 点亮横幅。换成了投影直接进入续跑；没换成投影恢复带 `error`。旧客户端忽略该
字段，按普通「重新连接中」显示(不带次数)；旧 Desktop 控制端对 Claude Code / Pi 仍会被终态 event 短暂点亮横幅，
下一份投影即收回。只改投影内容，不新增 invoke 或推送通道，服务端无需改动。
连不上先等它恢复(2026-10-11)：等原电脑恢复期间，`autoResumePending` 是一次普通的重连进度(`attempt` 1–5、
`maxAttempts` 5、`sessionTotal` 0，不带 `groupSwitchPending`)，新旧端都显示「重新连接中 n/5」；发送前等的时候同样挂在
还没派出的这一轮上(不带 `error`)。开始换电脑时回到上面的 `groupSwitchPending`。恢复后在原电脑续跑，续跑记录的
`autoResumeInfo` 新增可选字段 `agentReconnect: { computer }`(读不到名称时为空串)，新 Desktop 与 Mobile 显示
「已重新连上 {电脑}，继续运行」；旧客户端忽略该字段，显示「用量已恢复，已自动继续」(与 `agentSwitch` 相同)。
同样只改投影与记录内容，服务端无需改动。
换不换统一成一个判定(2026-10-11，`provider-group/failurePolicy.ts`)：`agentSwitch.cause` / `groupSwitch.cause` /
`groupSwitchPending.cause` 新增取值 `failed`(那台出了别的问题，如 Agent 意外退出、服务报错且重试用尽)，新 Desktop 与 Mobile
显示「{from} 出了问题，已换到 {to} 继续」；旧客户端不认识的原因整条忽略，活动行显示「用量已恢复，已自动继续」，进行中行按普通
「重新连接中」显示。`provider-group:remote` 的 `cool` 仍只报那台账号的问题(`usage-limit` / `auth` / `overload`)，不变。
本机远程 Agent 任务连续拉不到那台而结束时，终态 error 的 `reason` 由 `remote_agent_closed` 改为 `remote_agent_lost`(只在本机
与它的控制端之间流转，用于判定「只是连接断了」；渲染端两者都按错误码给文案，旧端不受影响)。

## 插件远程授权的实例身份

远程授权中的 `ghostId` 绑定实际安装的物理 storage part，不使用裸逻辑 ID 替代企业实例。
企业键 `_ns__<namespace>__<id>` 最长 167 字符；只对该合法键扩展校验，其他 OAuth
事务、设备与启动 ID 仍限 128 字符。签名 transcript、v3 字段及频道不变，不能截断或
增加 alias fallback。Desktop 与 Mobile 复用同一握手 parser；长企业键要求控制端也具备
该校验能力，旧端的短键行为保持不变。

## 代输入（2026-10-13）

产品规则见 [`../product-rules/input-handoff.md`](../product-rules/input-handoff.md)，共享类型与 parser 在
`packages/device-link/src/inputHandoff.ts`。

- **卡片快照** `InputHandoffSnapshot`（`kind: "input_handoff"`）随既有交互推送下发，控制端按字段透传、
  不做结构化拒收。新能力一律加**可选**字段：`picture`（本步按截图作答，像素不在快照里）、`liveView`
  （可打开单窗口实时画面）、`deviceCode`（`{ code, url, origin }`，设备码登录）、`holder`、`remoteInput` 等。
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

## Agent 跨设备历史发现与搜索

`cindy_helper` 的 `list_history_devices` 使用现有同账号设备目录；`list_sessions` 和
`search_chat_history` 新增 `device` 参数，默认 `local` 保留原行为，`all` 查询本机和在线且
允许访问的电脑，也可指定目录返回的设备 ID。跨设备响应按设备分组；`limit`、排序、
`nextCursor` 和搜索相关性均属于单台设备，翻页使用该组设备 ID 和游标，不能把一个游标
用于所有设备。离线、禁用、撤权、超时或不支持的设备明确列入结果，`partial` 表示覆盖不全；
目录失败仍可返回本机结果，但不能声称已搜索全部设备。搜索候选池上限仍以每组的
`pool_capped` 表示，不保证无限召回。

新增只读 `local-db:history:query` channel，仅接受 `list_sessions` 或
`search_chat_history`，复用原工具的参数校验、本机查询和输出格式。远端不允许继续转发，
不加入 unlinked/shared-task 白名单，不增加自动重试、缓存或聊天同步。沿用同账号
device-link 授权、撤权与 owner fence；仅有归属范围权限的调用方不能扩展历史范围。远端任务
列表及搜索两路召回在排名、限量和分页前应用同一条伙伴可见性条件，隐藏任务不占分页名额，
游标和候选池信息只基于可见结果。指定 `session_ids` 时也由源端 SQL 统一过滤，隐藏、归档、
失去伙伴关联及不存在的 ID 均不产生命中；不通过请求前的存在性检查返回不同错误，混合查询
仍返回其中可见任务的结果。普通回复、缓存回复与离线重发仍重新核验；页内任务若已
变为隐藏，整页返回 `NOT_FOUND`，不发送该页的内容或过期分页信息，调用方可重新查询。
列表中的 `parentSessionId` 与页内任务共用一次源端可见性查询，不可见或已不存在的父任务
引用省略；缓存与排队回复也重新投影。向量可用性探针与 KNN 使用同一可见范围和查询过滤，
仅有隐藏向量与没有向量时返回相同诊断；只存在于隐藏任务的目录与不存在的目录也不可区分。

远程结果中的任务 ID 为 `deviceId::sessionId`，可直接供现有 `get_chat_history` 读取。
搜索上下文每条最多 2000 字符，省略时带 `remoteContentTruncated`；完整阅读继续使用历史
读取接口。超出传输预算返回明确错误，调用方缩小 `limit` 或 `context_radius`，不能静默
当作未命中。旧被控端返回 `CHANNEL_NOT_ALLOWED` 时标为 `REMOTE_UNSUPPORTED`，其他设备
仍正常返回；完整跨机发现和搜索需要两端均支持此 channel，旧工具调用默认本机不变。
本次不改服务端和数据库 schema；手机与 IM 通过所在电脑的 Agent 使用能力，无新增界面。
SSH 主机不自动成为设备目录成员。实现与回归见 `mcp-integrations/historyDevices.ts`、
`localDb/ipc/historyQuery.ts` 和 `packages/lizi-mcps/src/__tests__/historyDevices.test.ts`。

## Agent 跨电脑管理定时任务与发消息

产品规则见 [`../product-rules/agent-user-parity.md`](../product-rules/agent-user-parity.md)。

**定时任务不新增 wire。** `cindy_scheduler` 的 `schedule_list` / `get` / `list_runs` 新增 `device`
（`local` 默认、`all`、设备 ID），`schedule_update` / `pause` / `resume` / `delete` / `run_now` 新增
`device`（`local` 默认或设备 ID）。非本机请求走用户远程控制定时任务时已有的
`maker:schedule:*` channel，参数形状不变，被控端仍由原 IPC 入口校验并执行。`schedule_list` 的
`query` 文本筛选在发起端对返回结果做，不改请求。`device` 缺省时返回形状与原来一致，三个读取工具
都只多出 `scope: "local"`。跨电脑读取按电脑分组，离线、未开启远程控制、撤权、超时、不支持的电脑逐台
列出，`partial` 表示覆盖不全。`schedule_update` 跨电脑时拒绝 `bindToCurrentSession` 和
`intervalMs` 以外的 `null` 清空（JSON 边界表达不了「带 key 的 undefined」），明确报
`INVALID_PARAMS`，不写出与意图不符的任务。其它电脑返回的定时任务与运行记录里，`targetSessionId` / `sessionId` 加上 `deviceId::` 前缀（与历史
查询同一约定），跨电脑 `schedule_update` 收到同一台电脑前缀的 `targetSessionId` 先去掉再发送，指向
别的电脑的拒绝。被控端对 `preRunHook` 是整对象替换：跨电脑改它必须
显式带 `timeoutMs`（数值，或 `null` 表示不限时，后者发送为不带 `timeoutMs` 的整对象），否则报 `INVALID_PARAMS`（省略会清成不限时，发起端先读后写又会覆盖并发修改）。被控端不认识这些 channel（早于完整控制面的旧版本）时
返回 `CHANNEL_NOT_ALLOWED`，发起端报 `REMOTE_UNSUPPORTED`。

**发消息新增 `maker:session:handoff`。** `send_to_session` 的 `target_session_id` 传
`deviceId::sessionId` 时，发起端向目标电脑发一次请求
`{ sessionId, message, sender: { sessionId, title? } }`；目标电脑用本机 `send_to_session` 的同一条
通路投递到既有任务（恢复、繁忙排队、落库一致），返回
`{ ok, agentKind, wakeKind, targetTitle, targetLastUserSendAt }` 或 `{ ok: false, errorCode, message }`。
约束：只投递到既有任务，不新建；目标 id 带设备前缀时拒绝，不向第三台电脑转发；恢复不在运行的
任务时按它落库的权限档启动；来源任务 id 由被控端加上服务端认证的控制端设备 id 前缀，发送方自带
前缀被拒绝；隐藏的伙伴任务沿用远程可见性检查，返回 `NOT_FOUND`，可见性查询未就绪时 handler
直接拒绝。仅同账号已建链设备可用（含手机等同账号控制端，它们本来就能用 `maker:send`），不进
unlinked / shared-task 白名单，共享任务对端被 handler 再次拒绝。

**新旧版本。** 旧被控端没有 `maker:session:handoff`，返回 `CHANNEL_NOT_ALLOWED`；发起端报
`REMOTE_UNSUPPORTED` 并说明消息没有发出，不退回成 `maker:send` 或 `maker:input:enqueue`
（那两条通路会把消息标成用户在另一台电脑上输入）。旧发起端不会发这个 channel，行为不变。
allowlist 指纹随新增 channel 变化，两端版本不一致时沿用既有提示。不改服务端与数据库 schema。

**失败与重试。** 两类请求都经 `remoteInvoke` 发出，建链与连接恢复沿用它的既有策略：与目标电脑
没有链路时会先建链（与历史查询相同，`device="all"` 会与每台在线电脑建链），发送前的
`LINK_NOT_OPEN` 重开后重发一次，其余不重放；工具层不另加重试或缓存。`maker:session:handoff`
的隧道超时为 65s：被控端要等目标任务的发送锁并在需要时恢复 Agent 后才回执，默认 30s 会把已送达
的慢恢复报成结果未知。请求已发出但没有可信回执时，发消息报 `DELIVERY_UNKNOWN`，定时任务写操作报 `REMOTE_TIMEOUT`
或 `REMOTE_RESULT_UNKNOWN` 并说明可能已生效，由 Agent 先查询再决定。「没有可信回执」包括：
超时、在途断连、本机账号在回执前切换、目标电脑报内部错误或 Agent 未就绪、定时任务写操作
收到写入前拒绝（参数错误、不存在、scheduler 未就绪）以外的任何 IPC 错误，以及被控端 dispatch 在
handler 完成后复核可见性与账号失败（`[NOT_FOUND] Session does not exist`，定时任务 handler
自己的不存在是 `Schedule not found`，据文案区分；发消息的目标不存在由 handler 以数据返回，
隧道层 `NOT_FOUND` 一律按结果未知）。能证明没有进入目标任务的错误（离线、未开启、链路未建立、对方不支持、目标不存在或已归档）
才报「没有发出」。发消息的账号 owner 检查用同一份记录覆盖整次调用：读来源任务标题前记录，
发送前与收到回执后各核对一次；回执到达时账号已切换的按结果未知处理，不返回其中的任务信息。
发消息没有幂等键，结果未知后的重发可能重复，工具说明要求先读聊天记录确认。
定时任务仍用默认 30s，与被控端等待 scheduler 就绪的 30s 相同，对方刚启动时可能超时。

按故障半径三问：触发条件是单个请求失败；本改动不新增恢复动作，不重建 link、不断开 relay；
多台电脑的读取每批最多 3 台并发，一台失败不影响其它组。已知外溢：这些请求的 `INVOKE_TIMEOUT`
与用户远程控制同一台电脑的请求共用设备级熔断计数，连续超时会让那台电脑被判为暂无响应
（既有行为，未改动）。「两台控制端共享同一被控端」的回归未新增，沿用 `remoteInvoke` 既有覆盖。

**审批。** `cindy_scheduler` 与 `cindy_helper` 是整体静默的可信 server；跨电脑写操作
（`schedule_update` / `pause` / `resume` / `delete` / `run_now` 带非本机 `device`，以及
`send_to_session` 的 `deviceId::sessionId` 目标，以及 `archive_sessions` / `unarchive_sessions`
含非本机设备前缀的 ID）在 `mcp-tool-approval-policy.ts` 里按内层动作
判为逐次审批，交给任务权限档；本机调用与跨电脑读取仍静默。

手机与 IM 通过所在电脑的 Agent 使用这些能力，无新增界面。实现与回归见
`packages/lizi-mcps/src/scheduler/_devices.ts`、`mcp-integrations/schedulerDevices.ts`、
`mcp-integrations/sessionHandoffRemote.ts`、`maker-ipc/sessionHandoffIpc.ts` 及各自的测试。

### Agent 跨电脑归档与取消归档

`archive_sessions` / `unarchive_sessions` 原位接受 `deviceId::sessionId`。本机批次仍调用
`setSessionsStatusInDb`，保持原子性；`local::sessionId` 是本机别名，先规范化再检查重复和当前任务保护，
不允许嵌套设备前缀。远程复用已有 `local-db:sessions:patch-meta(id, { status })`
与目标电脑的 `patchSessionMetaInDb` 生命周期服务，状态仅为 `archived` / `active`。没有新 channel、
allowlist、数据库 migration 或第三台电脑转发。复合 ID 不交给本机服务，无本机回退。

最小批次合同：一次只能指定同一台电脑，混合本机/远程或多设备批次写入前返回 `INVALID_ARGS`。
远程按输入顺序执行，首次失败停止，无回滚、无自动重放。失败 `data` 中 `changed` 为已确认完成项，
`failed_session_id` 为失败或结果未知项，`remaining_session_ids` 为未执行项；各 ID 保留设备前缀。
`partial` 表示已有确认完成项或失败项结果未知，不能把整个远程批次当作事务。

沿用同账号远控、双方允许控制、owner 检查与目标可见性。跨电脑写入进入当前任务权限档，
本机操作保持原样。离线、禁用、撤权、不支持分别明确返回；旧宿主拒绝 `patch-meta` 时返回
`REMOTE_UNSUPPORTED`。已支持这个 channel 和生命周期保护的旧宿主无需新增协议即可执行。
目标服务的不存在与已删除/专属生命周期限制返回 `NOT_FOUND` / `PRECONDITION_FAILED`；
隧道在处理后复核账号/可见性的 NOT_FOUND、超时、在途断连、错误回执与内部错误均按
`REMOTE_RESULT_UNKNOWN`，说明该项可能已生效，调用方先查状态再决定是否重试。
本机发送前的 `BACKPRESSURE` 返回 `REMOTE_UNAVAILABLE`；目标返回的 `BACKPRESSURE` 或
无法确认为写入前拒绝的 `PRECONDITION_FAILED` 也返回 `REMOTE_RESULT_UNKNOWN`，因为写入后的
回执查询可能失败（后者可能由 worktree mutation 包装查询错误）。即使 `changed` 为空也标记 `partial: true`。
同一账号快照覆盖整个远程批次，切账号后停止并不返回旧账号的标题/目录。

取消归档不发送旧消息、不启动任务执行、不恢复暂停自动化。成功后另调既有 `send_to_session`
继续投递；该通道仍按目标当前状态与已保存权限执行。手机/IM 经执行电脑的 Agent 使用同一工具，
没有新增 UI；SSH 工作目录任务仍由其所属 Desktop 管理状态，不将 SSH 主机视为 device-link 设备。
不改变共享连接的重试、超时或恢复策略。回归见 `archiveSessionsTool.test.ts`、
`sessionStatusRemote.test.ts`、`sessionsUpdate.test.ts` 和 `mcpToolApprovalPolicy.test.ts`。

## Desktop 设备互联 Review

桌面控制端的 /review 通过 maker:review:start 请求被控 Desktop 执行。证据收集、Reviewer
任务创建、只读生命周期和 Review 卡片持久化始终发生在被控端；结果沿现有 session、message
和 maker:event 推送回控制端，不新增独立结果协议。该 channel 仅加入
packages/device-link 的 invoke allowlist，仍受控制租约、会话可见性和被控端 Review 输入
保护约束；SSH remoteHostId 不因此获得 Review 能力。

旧被控端不认识该 channel 时返回 CHANNEL_NOT_ALLOWED，控制端沿用 Review 失败提示，
不得回退到控制端本机执行。Review Reviewer session 的后续输入仍被远程 Review 外部输入门禁拒绝。
控制端先整批校验 Review 请求，再复用现有上传／被控端物化链路。控制端外部文件与内联
内容在上传前通过原生确认，文件只上传已授权的只读快照；被控端的工作区不授予控制端同名
路径的读取权。禁止把控制端本机路径当作被控端文件。被控端自身仍需本机确认的工作区外
成果不自动放行；确认尚无远控入口时返回权限错误。归属未解析的任务不启动 Review，只有
明确归属本机才调用本机入口；已知远端归属在重连期间仍沿用远端。写请求不新增自动重试，
90 秒超时仅作用于该请求，超时不代表被控端未创建 Reviewer，应先查看任务里的 Review 卡片。

## SkillHub 发布失败原因

发布错误继续使用 `{ error: { code, message } }`，Desktop 保留已知业务码与具体原因，
同步用于进度事件和 IPC 结果回退；短原因也展示。未知 4xx 错误保留业务原因，网络故障、
限流和服务不可用各自提供重试建议。缺少标准错误码的 HTTP 403 也归为权限不足，不引导编辑请求。
只有明确的业务拒绝原因可展示原文；认证、权限不足（含 `NOT_AUTHOR`）、凭证配置、只读能力、限流、
服务不可用及未预期的内部异常使用恢复文案，不展示原始诊断，包括异步结果与复制内容。
init/commit 的服务端拒绝在主进程过滤非公开详情；非标准 `HTTP_*` 回退也不透传原始 message，
未知但符合错误体契约的 4xx 业务码仍保留公开原因，客户端使用固定提示补足空详情。
主进程的本地可见范围拒绝只返回 `INVALID_VISIBILITY`，由 Renderer 使用当前语言的恢复提示，
不透传硬编码英文；服务端的可见范围业务原因仍可展示。
新服务端的 `SKILL_DELETED`（409）表示同名技能已删除但名称仍被占用，客户端引导改名；
新客户端兼容旧服务端 `FORBIDDEN` + “已删除的 Skill 不能继续发布”。旧客户端遇到新错误码
仍可按原有通用提示降级，不要求同步发布。

后台处理失败复用扫描结果的 `gates[].issues[]`（severity、code、message），客户端
同时识别失败项的 issue 错误码与旧版错误码检查项名称，展示具体原因与相应修改建议，
避免把包校验或名称冲突描述为安全审核失败；只对失败检查项进行该分类，已通过项、
warn/warning 状态检查项、等待或处理中的检查项和 warning issue
不参与失败分类。`package-validation`、`publication`、`publication-processing`、`upload-processing`
表示发布处理检查项，其中未知错误使用内部失败的公开恢复说明，并移除诊断路径与证据；
普通安全扫描的 findings 继续保留具体原因与相对文件位置。旧客户端本来就能
展示 issue。服务端只向上传者返回会话原因，公开目录权限不变；未知内部异常仍返回公开的
重试说明。实现与回归见 `shared/skillhubPublishErrors.ts`、`publishService.test.ts`、
`PublishDialog.feedback.test.tsx` 和 `ScanResultDialog.test.tsx`。

## 电脑互联的消息文件与历史变更

跨电脑任务复制使用同账号业务通道 `maker:task-copy`，受信 Renderer 使用 `task-copy:request`。
不开放裸导入、数据库或路径写入；共享访客不准入。该通道与旧 `maker:task-migration` 交接协议
隔离，旧端拒绝时提示升级，不退回旧交接协议或控制端执行。新端也不接收旧协议的 activate。
源任务和文件保留可用，自动任务及消息渠道不转移。数据复用 peer 附件与 OSS；复制记录及目标回执
仅用于幂等重试，不管理源任务执行权。写请求不进入自动重试白名单，无需服务端变更。
`preflight` 检查目标实时资源；文件描述可为单附件或有序分段附件，每段复用已有协议和校验，
复制不设固定总量上限；`estimate` 超过 `TASK_MIGRATION_MAX_FILES`（50 万）个项目文件时返回
`MIGRATION_TOO_MANY_FILES`，控制端据此不开始复制，旧源端不返回该错误码。
整组 Orca 沿用可选 `teamMigration: true` 能力声明，缺省不支持；
`receive.files.additionalWorkspaces` 沿用同一文件描述，manifest 记录成员到目录的映射。
双方必须支持复制通道；收到整组能力声明才发送团队，不尝试部分导入。
运行中取消由源端状态的可选 `cancellable` / `cancelling` 声明，旧源端缺省时控制端不提供取消。
源端状态的可选 `skipped: { total, entries[{ path, code }] }` 列出本次复制跳过的条目，旧源端缺省、旧控制端忽略；
新源端会发送项目内链接链与断开链接，旧目标仍按旧规则拒收（`MIGRATION_EXTERNAL_LINK`），需更新目标。
manifest 的可选 `destination`（`{ kind: 'dialogue' }` 或 `{ kind: 'project', path }`，`path` 为相对用户目录的
文件夹名数组）只在未选目标项目时决定落点；旧目标忽略该字段，旧源端缺省时新目标仍用 `task-copies/projects`。
范围、恢复与源目录保护见 [同机移动与跨电脑复制任务](../product-rules/task-device-migration.md)。

设备互联生成文件沿用远端文件服务的 stat 与修改时间，控制端按被控端消息时间窗校验命令产物；
仅有文件存在、缺失时间戳或读取失败不构成命令产物证据。不增加 relay 协议字段。
SSH 保持仅展示经过存在性复核的工具产物，不把 Desktop 消息时间与 SSH 主机文件时间比较。
历史变更在既有只读 `git-review:remote-op` 上追加 `turn-list` / `turn-get`，
按被控端任务 ID 读取已保存的摘要和精确差异，沿用 gzip 与 OVERSIZE 边界，不截断补丁。
`maker:turn-change-set:updated` 仅向同账号设备推摘要，归属 `session:<id>`，沿用账号和任务可见性复核。
共享任务访客不接收该推送（含离线补发），其既有读取与操作权限不变。
旧主机不认识新 op 时保留原无卡片行为，不回落读取控制端本机记录；完整历史变更展示需要两台
电脑升级。旧控制端忽略新增摘要推送，原行为不变。
撤销／重新应用追加独立写通道 `maker:turn-change-set:apply`，参数为任务 ID、变更 ID 和
`undo` / `reapply`；只读 remote-op 不接收写操作。被控端复用本机冲突、运行状态、路径和
快照状态校验，并在队列和 Git 预检后复核远程授权；本机 IPC 的受信窗口检查保持不变。
旧主机拒绝新通道时显示操作失败，不回退本机。写请求不加入自动重试或读取合并白名单；
摘要推送和重连后的重读恢复显示，超时不能证明操作未执行。
本次覆盖 Desktop 设备互联；SSH 任务没有本机历史变更快照，仍不显示该卡片；
Mobile 未新增卡片入口。服务端无需改动。

## 远程任务文件夹下载

聊天里的「下载到本地」把远程文件或文件夹存进控制端的系统下载文件夹。既有
`file-browser:remote-op` 的 `caps` 追加可选 `dirExport: true`，并新增两段式 op：
`exportDirStart { workdir, relPath }` 校验目录在工作目录内（含 realpath）后立即返回
`transferId`，被控端在后台把目录打成 tar（保留符号链接与可执行位），按 2GB 分段推给
**发起调用的控制端**（目标取自 invoke 上下文的 `controllerDeviceId`，共享任务访客拒绝）：
每段先试直连附件，失败回落 OSS，与跨电脑复制任务同一套分段描述（`MigrationFile`）。
`exportDirStatus { transferId }` 幂等返回 `state`（packing / sending / done / error）、
进度字节、跳过条目数，`done` 时附分段引用；终态保留 10 分钟，控制端 2 分钟不来轮询即视为
放弃并中止。控制端取件后从直连收件箱移出（不在收件箱滞留）或下载并删除 OSS 对象，再解包。

旧被控端不声明 `dirExport`（或回 `unknown op: caps`），控制端提示更新远程电脑，不退回逐个
文件拷贝；嵌套 SSH 工作目录回 `REMOTE_UNSUPPORTED`。旧控制端不调用新 op，行为不变。
SSH 远程不经 file-service，直接在 SSH exec 通道上流式传回远端 `tar` 输出。未新增 channel、
relay 类型、allowlist 或持久化 schema，服务端无需改动；Mobile 未接入。实现见
`apps/desktop/src/main/file-browser/chat-download.ts`、`dir-export.ts` 与 `dir-archive.ts`。

## 任务列表标签目录

`sessions:list` 第三个参数可追加 `tagCatalog: 1`。支持的主机仅对该请求返回
`{ format: 'session-tag-catalog-v1', sessions, tags }`；任务行的 `tagIds` 是响应内
目录索引，保留全部任务、标签与顺序。共享 DeviceLinkClient 解包后，上层仍读取原数组。
新控制端兼容旧主机的数组回复；旧控制端不声明此字段，新主机仍返回数组。
缓存／outbox 重发先解包并重新检查任务可见性，再从可见行生成目录，不能残留隐藏任务的标签。
此扩展不改变 relay、帧限制或服务器权限，也不靠截断数据降低体积。

标签的可选 `nameCustomized` 标记区分显式改名与预设本地化。新版更新请求仅在明确改名时
提交 `nameCustomized: true`；旧端换色时携带相同原名不会误置标记。缺省字段沿用旧显示规则。

## 远程桌面退出与断线锁屏

远程桌面的 `start` / `heartbeat` 可追加布尔 `lockOnExit`。新版 Desktop 与 Mobile
提前同步退出锁屏策略，被控端在本机断开、信令断开或现有心跳过期时本地执行锁屏；
存活连接的 resume / takeover 和显示器切换不触发。锁屏期间重复断开或心跳过期
不能取消锁屏，撤权与认证身份变化仍可取消。旧请求缺少字段时保留原行为（旧手机的
`privacyScreen.lockOnExit` 继续兼容），新字段优先于该隐私屏幕附带偏好。
旧被控端忽略新字段，主动退出仍发送原 `stop.lockScreen`；断网兜底需要被控端升级。
不带 `lockScreen` 的协议 `stop` 仍用于重连和切显示器的清理，不执行锁屏。
Desktop 本地关窗不等待远端停止回执，后台清理只作用于原 peer / lease，不重置共享链路。
此扩展沿用已有业务通道，不改变 relay、服务端协议或权限范围。

## 远程桌面临时分辨率

被控端以可选能力 `resolutionRestore` 声明系统分辨率的连接级恢复支持。
新版控制端仅在该能力为真时发送 `resolution { temporary: true }`；响应为原 lease
及更新后的显示器尺寸、`controlling: false`，控制端刷新画面并重新取得操作权，不结束连接。
被控端在首次调整前保存原模式，多次调整不覆盖；结束、超时、撤权或接管后先恢复，
恢复失败保留原值，下次连接前重试。在途原生写入完成前不得开始恢复。

旧被控端缺少该能力时，新控制端只允许已有 `viewerDisplayRestore` 能力覆盖的临时调整，
不得退回会留下系统分辨率变化的旧路径；不支持的选择返回“不支持”。旧控制端的无
`temporary` 请求及响应保持兼容，其旧行为不代表新恢复能力已生效。此扩展不修改 relay。

### 切换显示时保留视频

被控端以可选能力 `liveDisplaySwitch` 声明：原生画布截屏（macOS、Windows 原生、Hyprland）
切换显示时可以保留同一条视频连接。新版控制端仅在该能力为真时，给 `resolution { temporary: true }`、
`viewerDisplay`、`restoreViewerDisplay` 附加 `keepVideo: true`（只接受布尔值）。被控端实际保留了
视频才在响应里附加 `videoKept: true`；控制端以这个回执为准，缺失时按原流程重建视频。
能力只说明显示器支持原生截屏，不代表本次连接在用它：切换前主进程通知截屏页暂停“5 秒无新帧即停流”，
切换后由截屏页确认当前确实是原生截屏且视频流仍在，才算保留；浏览器截屏、流已结束或确认超时一律
按原流程拆掉重建。
旧被控端丢弃不认识的 `keepVideo`，照旧拆掉重建；旧控制端不发 `keepVideo`，新被控端照旧拆掉重建。
切换失败仍只结束本次远程桌面 lease。不修改 relay、IPC allowlist 或协议版本；先发被控端。
Mobile 与 Desktop 远程桌面窗口都按上述规则发送 `keepVideo` 并以 `videoKept` 回执为准；两端还按电脑和
显示器记住上次的系统分辨率或「适配画面」尺寸（各自本地保存，不进协议），下次连接拿到操作权后重新套用，
选回电脑原分辨率或恢复原始比例时清除。
实现见 `apps/desktop/src/main/remote-desktop/controller.ts`，回归见同目录 `__tests__/controller.test.ts`
与 `packages/device-link/src/__tests__/viewerDisplay.test.ts`。

## 远程桌面窗口操作

新增可选能力 `windowActions`，只在支持的主机上发送 `windowAction`：`list` 返回有界窗口
列表，`activate` 只接受当前系统枚举的窗口 ID，`desktop` 切换临时空工作区并支持恢复。
三种操作均要求当前同账号控制 lease；撤权后的迟到回复不得暴露窗口标题或继续操作。
新手机对未声明能力的旧电脑保留原快捷键；旧手机仍可连接新电脑。本扩展只走既有业务
隧道，不新增 relay 消息类型、不修改服务端授权或协议实现。

可选能力 `workspaceNavigation` 与 `omarchyMenu` 分别声明左右桌面切换和 Omarchy 菜单。
新控制端仅在能力为真时发送 `windowAction` 的 `workspaceLeft` / `workspaceRight` /
`omarchyMenu`；缺省保留旧工具栏，不向旧主机发送新动作。旧端的 `desktop` 语义不变。
工作区切换作用于采集屏幕，菜单使用本机固定入口，所有操作沿用控制 lease 与撤权检查。

## 远程桌面画质档位

`offer.settings` 的画质由码率改为档位 `quality: "auto" | "saver" | "hd"`（自动／省流／高清）。
控制端只表达意图，具体的码率上限、降级取舍（`auto`/`saver` 先降分辨率保帧数，`hd` 锁分辨率
降帧数）、截屏分辨率与 JPEG 预算由被控端 `apps/desktop/src/shared/remoteDesktopQuality.ts`
决定，调整数值无需两端同时发版。控制端处于后台观看（`presentation` 已开启，如手机画中画）
期间，被控端临时按 `saver` 档的码率／帧率上限编码，回到前台即恢复所选档位；这是被控端本地
行为，控制端发送的档位不变，也不新增协议字段。

新控制端经 `remoteDesktopVideoSettingsWire` 同时发送档位与旧 `bitrate`（auto→0、saver→2M、
hd→20M）：旧被控端只校验 `bitrate` 并忽略 `quality`，无需新增能力声明。新被控端优先读取
已知档位；档位缺失或不认识时按旧 `bitrate` 换算（0→auto、2M→saver、8M／20M→hd），因此旧
控制端与未来新增档位都能降级连接。两者都无效时仍返回 `INVALID_REQUEST`。此变更不改 relay、
不新增 channel，服务端无需改动。Desktop 远程桌面窗口的主进程会先用 `parseRemoteDesktopRequest`
校验 renderer 请求（解析结果只保留档位），转发给被控端前必须再经 `remoteDesktopVideoSettingsWire`
补回旧 `bitrate`；否则旧被控端对每次 offer 都返回 `INVALID_REQUEST`，视频退回截图中转。

被控端在应用控制端 offer 前，仅为带 `settings` 的请求给视频编解码追加 `x-google-start-bitrate` /
`x-google-min-bitrate` / `x-google-max-bitrate`，避免近静止画面因发送量过低导致带宽估计塌到
百 kbps 级、分辨率被锁在低档。这些是 libwebrtc 对发送端生效的本地提示，不改变协商出的编解码；
不识别它们的控制端不受影响，旧控制端（无 `settings`）的 offer 原样使用。

## 远程桌面查看窗口隐藏时暂停视频

被控端以可选能力 `viewerHidden` 声明支持 `{ op: "viewerHidden", lease, hidden }`：控制端窗口
隐藏、最小化、切换 macOS Space 或被完全遮挡时，被控端截屏页把当前视频发送端的
`encoding.active` 置为 `false`，原地停发视频；音频、输入、数据通道与 lease 不受影响，
`hidden: false` 原地恢复，不重新协商。被控端等截屏页确认编码器已应用才回复成功，未应用（含截屏页忙）
时返回错误，控制端据此重建视频。请求只要求当前 lease，不要求操作权；每次新 offer
从未暂停开始，控制端在视频重新播放后按当前可见性重发。显示切换期间同样接受该请求。

新版 Desktop 控制端仅在能力为真时发送，并在持续隐藏 1.5 秒后才暂停（macOS 原生全屏切换
会短暂报告 hide/show），显示时立即恢复；恢复失败时重建视频连接，不让画面停在旧帧。
截图中转模式在隐藏期间停止拉取，不涉及协议。旧被控端无该能力，控制端不发送、照旧完整推流；
旧控制端不发送，新被控端行为不变。只走既有 relay 业务请求，不加入媒体数据通道白名单，
不修改 relay、服务端或 IPC allowlist；Mobile 未接入。实现见
`apps/desktop/src/renderer/features/remote-desktop/viewerController.ts` 与 `captureHost.ts`。

## 远程桌面控制请求走媒体数据通道

被控端以可选能力 `channelRequests` 声明：媒体连接的 `input-v1` 数据通道还接受
`{ type: "request", id, request }`，并以 `{ type: "reply", id, ok, result | error }` 回复。
可走通道的请求限于 `REMOTE_DESKTOP_CHANNEL_OPS`（`control`、`presentation`、`hostMute`、
`privacyScreen`、`windowAction`（不含 `list`）、`displayModes`、`clipboardSync`、
`clipboardVersion`），单条不超过 32 KB，id 为 1–64 位 `[A-Za-z0-9_-]`。

旧被控端收到不认识的通道数据会结束会话，因此控制端只在能力为真、视频已在播放、请求
lease 与当前 lease 一致时才走通道，否则照旧走 relay。被控端主进程对通道请求做与 relay
相同的发送方、lease 与撤权校验；不在白名单内或并发超限时回错误码而不结束会话，控制端
改走 relay；回复超过上限时只有 `displayModes`、`clipboardVersion` 改走 relay。请求送达后
其余失败不自动改走 relay 重试，超时按结果未知处理。
旧控制端不发通道请求，新被控端行为不变。此扩展不修改 relay、服务端或 device-link 帧格式；
iOS 原生接收器新增 `sendRequest`，属于冷更新。
Desktop 控制端由主进程决定并校验每个请求（lease、操作权记录、剪贴板权限都不变），白名单内的请求交给
远程桌面窗口经它的媒体数据通道发出，回复再交回主进程（`remote-desktop-viewer:channel-request` /
`channel-reply`，仅限该窗口）；窗口没有发出（无视频、能力缺失、lease 或代次不符、通道拒收）时主进程照旧
走 relay，已发出的请求不经 relay 重发，窗口退场时在途请求按结果未知结束。

## 远程桌面随连接自动给操作权

被控端以可选能力 `autoControl` 声明（仅当本机能注入输入，即 `canControl` 为真）：`start`、`viewerDisplay`、
`restoreViewerDisplay` 与 `resolution { temporary: true }` 接受 `control: true`（只接受布尔值），被控端在同一个
请求里启动输入并以 `controlling: true` 回复，控制端不再单独发 `control`。启动输入失败（缺权限、输入不可用）
时租约照常返回且 `controlling: false`，控制端再发 `control` 取得具体错误。操作权仍由被控端持有：它决定输入
助手的启停，手机画中画后台观看照旧经 `presentation` 收回，回到前台再取回；Agent 让位仍只看实际输入。

控制端仅在能力为真时发送 `control: true`；会话层只在请求过时接受 `controlling: true` 回复。旧被控端丢弃不认识的
字段并回复 `controlling: false`，控制端按原流程补发 `control`；旧控制端不发该字段，新被控端行为不变。
Desktop 控制端主进程把带 `control: true` 的回复与 `control` 回复同样记录，用于本机剪贴板判定。

Mobile 的「仅查看」改为纯本地开关：只停止转发输入、关闭键盘与鼠标按钮，不再向被控端发 `control: false`；
被控端仍持有操作权。退出仅查看时若被控端已不再给操作权（输入失败、溢出释放、后台观看），才重新请求。
不修改 relay、服务端或 IPC allowlist；需被控端和控制端都更新才省掉这次往返。

## 手机首页会话活动快照

### 可见历史优先读取

`local-db:messages:view` 的可选 `{ lazyDetails: true }` 启用轻量历史投影：
被控 Desktop 先读取分组所需字段，再只按 ID 读取本页可见正文和卡片。
隐藏子代理记录通过 `messages.deferred` 保存范围，展开后由既有
`local-db:messages:work-details` 分页读取；可选 `parentToolUseId` 限制到该子代理及其后代，
不会顺带加载同一时间段的其它子代理。摘要可携带轻量文件产物候选及排除信息，
文件卡原有的存在性、时间窗与权限校验不变。媒体和文档交付仍保留原始可见来源。

旧控制端不请求该选项，收到原有投影；旧主机忽略选项，新控制端继续兼容原投影和原有
raw history 降级。任务列表活动推送不变，当前轮的正文、工具卡和可见进度继续实时更新。
没有新增 channel、relay 类型、数据库 schema 或 Mobile 原生依赖，云端无需改动。

### 运行中工作组的单行活动与就地更新

同账号控制端读取最新一页时可再带 `{ workLines: true }`。被控 Desktop 只为顶层、无嵌套、
运行中的工作组摘要附加可选 `lines`：最多 5 行，用与两端相同的共享投影（Codex 拆行、
重复读取去重）从完整记录算出，并从组尾向前有界地补读，直到凑足 5 个展示活动。每行只含
工具名、按完整输入解析后再截短的展示描述、状态、是否失败，或思考开头的单行文字；不含
工具结果、diff 与完整输入。每行和整窗都有严格的 UTF-8 字节上限，超出时逐级缩短文字与
列表（列表保留条目数），最后只保留工具名。控制端据此显示运行中的最近 5 行，不再为预览
读取 `work-details`。

轻量读取为每行附带仅在主机内使用的正文戳（长度与末尾片段），参与工作组修订号，使后续
全文覆盖、后台完成等原地改写也会改变修订号；该字段不进入线上内容。它是近似判据：长度
与末尾 24 个字符都不变的原地改写检测不到；读取正文本已发生，额外成本只是逐行的少量计算。

声明过 `workLines` 的控制端，折叠工作组的活动通知改为新推送 `maker:history-work-patch`
`{ version: 1, sessionId, baseRevision, item }`：仅当它上次收到的最新一页里，除这一个运行中
条目外的所有条目指纹都未变（指纹在库级写入计数后缀之前计算）时才发送，`baseRevision`
是该条目上次送达的修订号。控制端只在条目存在、修订号与范围起点一致、且没有读取进行中时
原地替换，其余情况退回原有的页面刷新；新分组、正文、卡片、清空或回退都继续走
`maker:history-view-changed`。思考增量按与投影相同的空白归一化计算可见前缀，只在这一行
还会变化时触发通知。

旧控制端不带参数，收不到 `lines` 与新推送；旧主机忽略参数：新 Mobile 只显示卡头（与此前相同），
新 Desktop 继续用原有 5 条明细预览。共享任务访客与供应商分享不启用这两项，读取与授权路径不变。
没有新增 relay 类型、数据库 schema、权限或 Mobile 原生依赖，云端无需改动。

现有 `maker:list-active` 的可选 `{ summary: true }` 响应在运行标记之外增加
`activityPhase` / `activityAttention` 两个可选字段。被控端从现有会话活动投影提供这两个
状态字段；活动服务已就绪但该会话不在活动账本中时，明确返回 `idle` / `false`，不下发活动正文。
手机首页拿到明确字段时修正本地可能漏掉收尾推送的红点；读取期间
若收到更新的活动推送，仍以推送为准。旧被控端不提供字段时，手机保留原有推送路径；旧控制端
忽略新增字段。未新增 channel、relay 类型、持久化状态或权限。

新版手机可选请求 `{ summary: true, snapshotVersion: 2 }`。新版被控端只对该请求返回
`{ format: 'active-sessions-v2', sessions: [...] }`，表示运行时列表完整；手机据此将仍在任务
列表、但已不在运行时列表的同设备任务活动状态清为 idle。读取期间有更新的活动推送时，
不得用旧快照覆盖。旧被控端忽略新参数并返回原数组；手机遇到数组时不根据缺席清除。
旧控制端仍请求、接收原数组。该扩展不修改 relay、授权或持久化格式。

## Agent 运行时版本读取

`maker:agent:binary-version` 已在 device-link 只读白名单内。可选第二参数
`{ checkLatest: true }` 让被控端再比较当前更新通道的线上清单，响应追加 `latestVersion`、
`updateAvailable` 与 `latestCheckFailed`（没读到清单时为真，此时“无更新”无法确认）。
不传参数时只读本地版本，三个字段为 `null` / `false` / `false`。旧被控端忽略参数且不返回
新字段，控制端按无更新、未失败处理；旧控制端忽略新增字段。关于页的重启更新入口
`update-harness-relaunch` 不在白名单内，远程端不能重启被控 Desktop。实现见
`apps/desktop/src/main/maker-ipc/binary-version.ts`。

## 远端目录浏览盘符列表

`fs:list-dir` 响应追加可选 `drives: { name, path, current }[]`，只由 Windows 被控端回传：
经 PowerShell 读取 `GetLogicalDrives` 盘符表，不访问磁盘，断线网络盘不会卡住探测。结果缓存
30 秒，过期先回旧值并在后台刷新；首次枚举最多等 1.5 秒，超时、失败或为空时省略 `drives`，目录列表
照常返回。超时额外回可选 `drivesPending: true`，新版手机据此在当前目录自动再拉，旧控制端忽略。
`path` 是 host-native 根路径，控制端直接用它再调 `fs:list-dir`，不自行拼路径；当前
位于未枚举到的盘或 UNC 共享时补为当前项。新版手机在至少两项时于「上级」下显示盘符切换；
旧被控端不回字段时保留原逐级浏览，旧控制端（含 Desktop 添加远程项目对话框）忽略该字段。
未新增 channel、relay 类型、allowlist、权限或持久化状态，服务端无需改动。

## 远程任务自动跟进绑定

Desktop 的任务行、置顶卡片与任务顶部通过既有 `maker:schedule:list` 读取当前绑定。
请求第二个参数可带 `{ sessionBindings: true }`；新主机在隧道序列化前只保留未过期且有
`targetSessionId` 的条目，以及 `id/name/status/targetSessionId/cronExpr/manual/recurring/intervalMs`
显示字段，避免完整 prompt、脚本和执行配置占用消息预算。第一参数仍是原有列表过滤器。
不截断绑定列表，投影后仍受原有隧道消息大小限制。

旧主机忽略第二参数，控制端兼容完整数组并在本地投影；旧主机的超大完整列表仍可能超过
传输限制，此时保留已有镜像，后续既有 push／重连重新读取。旧控制端、Mobile 与本机未声明
该选项时仍获取原有完整列表，不增加 channel、权限、relay 类型或服务端发布依赖。
手动、单次与相对间隔优先于兼容 Cron 占位值。远程绑定只显示提示，不跳到本机管理页。

## 自动化检查恢复投影

运行状态和已读回执保留历史事实。当前警告只保留未被**同一自动化**更新成功运行恢复的失败；
另一自动化成功不能清除它。任务列表红点与任务内警告共用此恢复判定；已恢复的失败即使
历史记录仍未读，也不再贡献任务列表红点或完成未读点。新的失败与真实任务终止错误仍须
正常标红。检查受阻与实际执行失败分别显示；原有运行历史页面及其已读状态保持不变。
轻量侧栏协议新增可选 `failureKind` / `failureRecovered`，旧端忽略，新端缺省按普通失败处理。

前置检查仍遵守 exit 0 放行、exit 2 跳过、其他值阻止执行。脚本可在 stdout 单独输出一行
`CINDY_PRECHECK_OK`，表示检查完整完成（包括正常无事可做的跳过）。只有 exit 0/2 且输出未
截断时记录可选 `checkSucceeded: true`；错误、超时、取消和退避跳过不构成恢复。
该标记只恢复此前的检查故障，不恢复 Agent 执行失败；旧脚本不输出、旧客户端不识别均不影响
原有退出码语义。实现见 `scheduler-host/pre-run-hook.ts` 与 `scheduler-host/storage.ts`。
macOS/Linux 上命令先经 `sh -n` 语法预检：shell 语法错误的退出码同为 2，不预检会被误记为
跳过而让任务悄悄停摆。保存时直接拒绝（INVALID_PARAMS），已保存的旧命令在运行时按失败记录并提醒。

## 用量历史跨设备合并

新增只读 invoke `maker:usage:device-rows`（Desktop ↔ Desktop，已登记 allowlist）。请求可选
`{ sinceDay: 'YYYY-MM-DD' }`；被控端回 `{ format: 'usage-device-rows-v1', todayKey, sinceDay,
rowsGz }`，`rowsGz` 为本机 `daily_spend` / `daily_model_usage` / `daily_session_usage` 原始行
及全部记过用量任务的当前标题、模型、供应商、上下文与最后活跃时间 JSON 的 gzip + base64
（任务元数据不分增量区间，每次都是完整集合，控制端整体覆盖；不在集合里的任务连同旧行丢弃）。
任务元数据与 `local-db:sessions:list` 走同一远端 Bot 可见性判据，隐藏伙伴的任务及其行不外发；
压缩后仍超帧预算回 `{ format, oversize: true }`。只含按天 × 模型、按天 × 任务的 token 与金额及任务展示元数据，不含消息内容或凭证；handler 无 sender 依赖、无副作用。控制端按账号缓存每台电脑最近一次读到的行，
增量从缓存 `todayKey` 前一天起拉；被控端回的 `sinceDay` 与请求不一致时按全量替换。
新增端到端可选能力 `background-link-v1`（`DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1`，link-open 与
link-accept 双向声明，不改 relay）。Desktop 控制端在本机没有订阅对端任何 topic 时建链即声明
（`apps/desktop/src/main/device-link/backgroundLink.ts`，所有建链与自动重开入口共用这一判据）；新被控端
见到后不装 legacy `'*'`，不亮被控横幅、不转发推送、不挡无人值守更新重启，控制端之后显式 subscribe
照常生效。旧被控端忽略该能力、照旧装 legacy `'*'`，所以用量读取走 `remoteBackgroundInvoke`：
0.1.93 及更早的正式版或版本未知的电脑不建链；新建链路时对端未在 link-accept 声明支持，且本机仍无订阅，
就立即关闭这条链路并按需要更新处理，同一版本不再重试。已就绪的链路直接复用。
旧控制端与 Mobile 不声明该能力，行为不变。
旧被控端回 `CHANNEL_NOT_ALLOWED`，控制端把该电脑标为需要更新，不影响其它电脑；旧控制端
不调用新通道，行为不变。手机不参与读取，也未新增入口。本机 `maker:usage:history` 仍只对
受信 renderer 开放。不改 relay、帧限制或服务器权限，服务端无需改动。实现见
`apps/desktop/src/main/usage/usageDeviceRows.ts` 与 `peerUsageSync.ts`。

## 图片交付与缺失源文件

### 远程文件连接复用与版本缓存

`device-link:file-peer` 的 `caps` 追加可选 `idleMs`、`sessionBound: true`。新控制端
仅在 Host 明确声明后，于 `offer` 携带 `sessionBound: true`，双方取消空闲倒计时，
按远程会话生命周期释放独立文件连接。不主动预热：普通读取只复用已建立的文件通道，
首次需要传文件时才建立。运行时断开通知宿主回收，下次取件按需重建，不新增应用层心跳。
传输期间的路径采样独立于调试记录开关，供慢链路回退使用；关闭调试只省略详细进度日志。
采样随传输结束停止，不在空闲文件连接上循环探测。
Desktop 显式断链、账号变化、共享连接离线，以及 Mobile 退后台、设备切换、断链时释放。
取消同时覆盖排队与尚未拿到连接 ID 的请求；迟到的协商结果不能重新建立连接或触发 OSS。
Desktop 取件取消后仍允许原账号发送已有 `close` 清理通知，包括迟到的 offer 回包与
已完成读取留下的空闲连接；其他请求继续受取消和设备代次限制。切账号后旧通知不发送，
不借新账号清理旧连接，不增加重试、心跳或共享 relay 重连。

旧控制端未发送 `sessionBound` 时，新 Host 仍按 5 分钟空闲关闭；新控制端面对未声明
该能力的 Host，按 `idleMs` 提前一个命令预算（15 秒）关闭，最长 4 分 45 秒，未声明
`idleMs` 时仍按 30 秒处理。正在传输的源文件仍保持 60 秒无进展清理，
不因延长空闲复用而延长。服务端无需改动，不更改旧端必填字段或 Mobile 原生指纹。

`device-link:media:fetch` 的 `prepareOnly` 结果和文件 `open` 结果追加可选 `version`
（64 位十六进制摘要）。Host 每次先走原授权解析，再从打开的文件句柄取
dev/ino/size/mtime/ctime，连同解析后的路径生成不透明版本。SSH 的不可变本地副本
例外：由 materializer 用远端主机、工作目录、相对路径及远端 size/mtime 生成源版本，
prepare/open 复用该源版本并校验副本大小，不使用带登录代次的本地路径或 LRU 时间。
缓存仍按稳定账号隔离，原有代次取消校验保留；不把版本当作授权凭据。
新版控制端只有两次版本一致且传输成功才保留私有缓存副本。同账号文件预览优先显示
已有本地副本，prepare 授权与版本查询放到后台；共享任务仍先复验权限。
缺失／非法版本的旧端不启用此缓存，旧控制端忽略新增字段。
缓存按稳定账号、目标设备、完整媒体 URL 隔离（含 SSH 与目录约束），跨重启保留，
不设时间 TTL、16 MiB 单文件门槛或条目数门槛。账号代次用于拒绝迟到结果，不能进入
持久缓存键。Desktop 图片等媒体复用 `cindy-media` 的 `integration-cache` 索引和
既有 512 MiB 缓存预算，真实文件探测后流式入仓；超过预算的单份媒体不额外缓存。
手动清理的 `remote-media` 不可变图片副本不占此自动回收预算，包括与其他集成共享的字节。
只对 `remote-file` 独占的可再生缓存按 LRU 自动回收，SQL 删除时复验 pin 和其他引用。
HTML 等普通文件复用 `remote-file-cache` 的 4 GiB 总量上限、LRU 与启动残片清扫；
同源新版本成功保存后清旧版本，不在媒体目录另存字节。

Mobile 复用 `remote-media` 磁盘缓存，放入 realm/账号 SHA-256 命名空间；无固定容量
门槛，仅在现有传输空间预留不足时按 LRU 清理（保留 256 MiB，并考虑下载与消费者副本）。
访问顺序落盘，新版本完整保存后再替换旧条目；版本进入物理文件名，避免异步复制撞上覆盖写。
下载尺寸在原子移入前校验，同版本或无版本刷新被截断时也不得覆盖旧文件。
系统清掉目录后，下一次取件自动重建。两端消费者均拿独立副本，清缓存不删正在预览的副本。
强制刷新只跳过旧副本的读取，成功后仍更新缓存，避免下次普通打开又命中损坏副本。
完整文件读取统一复用版本缓存，覆盖 inline 小文件、peer 下载及已经完成的 OSS 回退下载。
`device-link:media:fetch` 在 `prepareOnly: true` 时接受可选 `metadataOnly: true`：
仍先授权并从打开的文件句柄取版本，但小文件也只返回 `transferRequired: true` 与元数据。
两端共用读取策略：小文件先查同一版本缓存，未命中再以原 `prepareOnly` 请求取 inline 字节；
大文件沿用 peer／OSS 读取。同账号旧 Host 忽略 `metadataOnly`，新控制端接收原 inline／OSS 结果；
共享任务的旧 Host 使用闭集参数白名单，两端访客不发送 `metadataOnly`，沿用先授权的 inline／OSS
读取。新 Host 同时接受布尔型 `metadataOnly`，不改变成员、附件归属及工作目录校验。
旧控制端不传此字段，新 Host 保持原行为。两段式导出缺版本而准备阶段有有效版本时，必须确认
导出前后主机版本、大小及导出大小一致才交付；不一致报 FILE_PEER_CHANGED 并释放导出暂存，
复验异常或取消也不交付，避免外层缓存发布未确认字节，后台沿用旧副本。无版本旧 Host 保持原读取方式，
不将其结果登记为主机版本缓存。缓存存储失败不阻断正常读取。
Mobile 的文件浏览器原图、PDF、下载／分享使用完整文件路径，先取当前账号、设备、
完整 URL 对应的本地缓存，再后台检查版本；每次读取独立复验，取消或过期的旧读取不压住重开后的检查。
不增加跨请求复验接管或自动重试。连接恢复也放到缓存读取之后。
HTML 由预览层复用同一账号磁盘缓存并持有独立快照；后台取件跳过传输层的旧快照，
避免将旧内容再次写回预览缓存。空文件以明确的 expectedSize === 0 为依据保存。
相对路径到主机 URL 的映射只保留在进程内；Mobile 重启后的首次相对路径读取仍需在线查询
URL，之后复用持久字节。本次不新增持久 URL 索引，冷启动离线相对路径预览不在覆盖范围内。
Desktop 完整文件与远程 HTML 预览复用现有磁盘副本，后台检查变化；HTML 的大小／mtime
仅用于快照展示和传输上限，不作为后台跳过读取的版本判据。复验绕过外层 size／mtime 命中，
device 仍可复用主机确认版本的字节，SSH 重新读取；新版原子保存前保留旧副本。HTML 直接通过
现有磁盘索引定位副本，不再另维护进程内元数据索引和刷新集合。两端 HTML 先显示缓存，再在
本次打开的后台读取中比较入口 HTML 内容；不同且新版快照准备完成时自动切换，相同或失败不重载。
更新仅在当前仍停留于入口文档时应用；已导航到内页则保留当前页面，新缓存供下次打开使用。
Mobile 直接复用后台准备好的快照；Desktop 缓存入口通过现有鉴权的本地预览服务读取一次更新结果，
确认变化后重载。没有持续监听或轮询，检查完成后的修改需从 Cindy 重新打开；手机也可手动刷新，
跳过旧副本并在成功后更新缓存。只改配套资源不触发入口重载。图片、PDF 保持后台更新供后续打开使用。
预览持有自己的副本，关闭时释放本次打开的新旧快照，不删除可复用的源缓存。
零字节 HTML 配套资源也可按版本缓存。
回归覆盖见 [Mobile 快照测试](../../apps/mobile/src/__tests__/mobileHtmlPreview.test.ts) 与
[Desktop 预览测试](../../apps/desktop/src/main/file-browser/__tests__/html-preview.test.ts)。
Mobile 分享及 HTML 资源复制在完成、失败、取消后释放传输暂存；独立消费者副本继续由原持有者管理。
音视频播放继续用保留的流式地址，不为了缓存而预先下载整份媒体；完整下载仍按上述规则。
不可变聊天图片与目录维持已有专用缓存；Mobile 限量文本预览先显示缓存（包括绝对路径），
后台读取后更新当前文本，失败不遮住已有内容，文本不改为无界整文件下载。
主机确认 BINARY_FILE／OVERSIZE 后撤销下次打开使用的文本缓存，但不清空当前显示的快照。
不增加缓存目录、额度、通道、服务端改动或 Mobile 原生指纹；完整优化需要两端客户端更新。

网络帧仍是旧版可读的 16 KiB，不增加 wire 通道。新版接收运行时仅在本地桥接声明
批量写入时，把已到达帧合为至多 256 KiB 后串行写盘；仍按实际写入块数归还流控额度，
EOF 必须等全部写入完成。桌面与手机使用同一实现；不改 Mobile 原生指纹。

媒体取件沿用既有 `MEDIA_FETCH_FAILED` 错误包；源图片不存在时，Host 在消息中附加
`[MEDIA_SOURCE_MISSING]` 稳定标记，不回传本机路径。新版 Mobile 据此提示重新导入，
旧版继续按通用加载失败处理；新版连接旧 Host 时也保留通用失败回退。不改变 relay、
取件权限、缓存键或重试范围，不需要服务端同步上线。

## 图片标注区域说明

`maker:input:enqueue` / `maker:input:steer` / `maker:input:update-content` 的队列附件
（`AgentInputSerializedFile`）追加可选 `annotationRegions: { x0, y0, x1, y1 }[]`：标注图
（`annotated: true`）烧录时由笔迹归纳的外接框，归一化坐标（0..1，原点左上，两位小数，
每张图至多 6 处）。只经既有 device-link 隧道与 IPC 透传，不新增 channel、relay 类型或
持久化 schema。消费端 `buildMakerUserMessage` 一律经 `sanitizeAnnotationRegions` 校验，
有合法区域时在原标注说明后另起一行按本条消息内图片顺序描述区域；仍然每条消息至多一条说明。
旧主机忽略该字段，只注入原固定说明；新主机收到旧控制端（不带该字段）的消息时，说明与
旧版逐字节相同。remote 会话剥离 `annotationSourceUrl` / `annotationStrokes` 时保留区域字段。
Mobile 以同一归纳算法在上传后的附件（含持久发件箱 `DurableUpload`，可选字段、旧记录缺省）
上携带该字段；底图本身已是烧录图、旧红线位置不可知时不带区域。服务端无需改动。

## 附件类型与直连附件体积

Mobile 发送的队列附件（`RemoteSerializedAttachment.category`）与 Desktop `AgentInputFileCategory`
对齐，追加 `'file'`：认不出的扩展名不再拒收，按通用文件以 `application/octet-stream` 上传。
主机只按 `category === 'image'` 分流，其余一律作为文件路径交给 Agent，并以 `originalName`
落地保留扩展名，新旧主机都已认得 `'file'`。

附件不设产品层体积上限。直连附件（`cindy-peer-attach://`）的引用去掉固定 2GB 上限，只要求
安全整数；接收端不设收件箱总量上限，只按剩余磁盘空间准入（未写完的上传按剩余待写字节预留）。
OSS 保底仍受服务端 presign 单对象上限（`OSS_ATTACHMENT_MAX_BYTES`，2GB），超过它的附件
没有保底，只能直连发送。`device-link:file-peer` 的 `caps` 追加可选 `largeAttachments: true`；
发送端（Mobile 与 Desktop 控制端）仅在对端声明该能力时直连超过 2GB 的附件，旧主机未声明时
直接放弃直连且不计入失败冷却，随后按 OSS 上限提示失败。旧控制端忽略新增字段，行为不变。
文件读取（`open`）仍沿用 `FILE_PEER_MAX_BYTES`。不新增 channel、relay 类型或持久化 schema，
服务端无需改动。

直连附件上传的提速同样按能力协商：Desktop 主机的 `caps` 追加可选 `streamAttachments: true`，
表示它接受同一附件最多 `PEER_ATTACHMENT_STREAM_WINDOW`（3）个写入块同时在途，并接受以
RPC 二进制正文传来的块（`write` 不带 `data`，原始字节紧跟该请求的最后一个 JSON 分片发送，
单块不超过 1 MiB；在途写入的等待按窗口放宽为 45 秒）。接收端仍按发送顺序逐块落盘、要求
偏移连续，`finish` 照旧校验大小与 SHA-256。旧主机不声明该能力：发送端继续逐块等确认并用
base64 `data` 字段，不向旧主机发送二进制帧（旧运行时收到会关闭连接）。旧发送端不读新字段，
新主机继续接受 base64 块。Mobile 发送端暂沿用逐块方式。不新增 channel、relay 类型或持久化
schema，服务端无需改动。

## 任务复制的外置会话记录与超限大小

`maker:task-copy` 的 `caps` 追加 `externalTranscripts: true`。源端在每次准备时询问；目标声明后，
32 MiB 以上的原生会话记录不放进任务包，`receive` 的 `files` 追加可选 `transcripts: MigrationFile[]`
（至多 256 个，逐项校验大小与分段之和；源端准备时超出即报 `MIGRATION_NO_MEMORY`，不先上传），顺序与对应关系记在随包的 `workspace.json`
`transcripts[{path, file, bytes}]`；`path` 是包内会话记录引用的路径，目标只把它当映射键，
落盘文件名由目标按序号生成。`preflight` 的 `resources` 追加可选 `transcriptBytes`，目标据此预检
暂存与用户目录所在磁盘。旧目标不声明能力，源端继续随包携带；旧源端不发新字段。

状态追加可选 `errorSize: {needed, limit}`：源端判定内存超限时的字节数，与 `errorPath` 同样只随
`error` 下发并一并清除。目标端失败只回传错误码，原始报错与数字记在目标日志。

## 任务复制失败的问题路径

`maker:task-copy` 的状态（`TaskMigrationView`）在 `error` 之外追加可选 `errorPath`：源端打包时
文件名不可移植、仅大小写不同或链接越界，导致复制失败的那一项的项目内相对路径（`/` 分隔，至多
1024 字符）。只在 `error` 存在时下发，进入下一阶段或重新发起复制时与 `error` 一并清除；源端复制
记录里同名可选字段，旧记录缺省。旧源端不下发，控制端只显示错误提示；旧控制端忽略该字段。
不新增 channel、relay 类型或持久化 schema，服务端无需改动。

## 远程任务的后台任务状态与停止

Desktop 控制端在远程任务的输入框状态栏显示后台任务提示：进入任务、前台 turn 结束、设备重连或
窗口重新可见时，读取已登记的只读 `maker:session-background-activity` 与
`maker:session-background-tasks:list`（两者登记为后台 invoke，让位于用户操作），之后在「在线 + 可见 +
无前台 turn」期间每 15 秒复查；
不依赖镜像事件，断连或停读时清空提示。读取失败（含旧被控端）按无后台任务处理。

同账号 invoke allowlist 新增写通道 `maker:agent-task:stop`（单个后台任务）与
`maker:session-background-tasks:stop`（全部停止，关闭被控端会话进程），入参与本机 IPC 相同，
handler 无 sender 依赖；不加入共享任务访客白名单，不进入自动重试。任务卡、后台任务面板与状态栏
的停止按归属粘滞路由到被控端，不回退本机。旧被控端回 `CHANNEL_NOT_ALLOWED` 时提示升级远程电脑；
旧控制端行为不变。Mobile 未接入，服务端无需改动。实现见 `makerTransport.ts` 与
`useRemoteSessionBackgroundTasks.ts`。

## 远程 Agent：Agent 在另一台电脑运行

同账号的 A(任务、项目文件与命令所在)可以让 B(打开了「允许远程控制」)用 B 自己的 Agent 程序、
登录(含 Claude 订阅)、供应商与网络运行 Agent。新增 invoke channel `maker:remote-agent:v1`
(`packages/device-link/src/remoteAgent.ts`)，只进同账号 allowlist，不进共享任务清单；被控端
`dispatch.ts` 对共享任务访客再拒一次。

- **方向**：A 始终是发起方。`open / call / reply / push / close / upload / caps` 是 A → B 的指令，
  `poll` 按游标拉取 B 的 NDJSON 事件流：同一台 B 上的全部任务共用一个 poll(一次带上各任务游标，
  最多 64 个；无新数据时 B 挂起最多 10s)。A 登记新任务时可再发一个覆盖全部任务的 poll，两个 poll
  返回的数据可能重叠，回包里的 `from` 标明数据起点，A 按 `from` 去重、游标只进不退；B 不认识的任务
  或超出已写范围的游标回 `missing`。B 需要 A 处理的事(权限确认、执行器与 MCP 的 HTTP 请求、
  Codex exec-server 的 WebSocket 帧、`cancel`)都作为事件流里的反向请求，A 用 `reply / push` 回传。
- **幂等**：`poll` 按游标幂等，只有它在 peer reset 后自动重读(`isPeerResetRetryableInvoke`)；
  `open` 按 runId、`call` 按 callId、`reply` 按 requestId、`push` 按 seq 去重，不自动重放；
  该 channel 的结果不进全局去重缓存。
- **大小**：内联载荷 1MB，更大的 gzip 后按 512KB 分段 `upload`(单个载荷 64MB)；单次 `poll`
  每个任务最多 512KB、合计 1.5MB(B 轮流决定从哪个任务开始取，积压多的任务不会一直挤占额度)；`push` 单帧 1MB、单次合计 3MB，超长 WebSocket 消息拆段(`more: true`)。
- **前向兼容**：A 解析事件流时忽略不认识的行类型；B 对不认识的 op / 方法回 `REMOTE_AGENT_INVALID`
  / `REMOTE_AGENT_UNSUPPORTED`。旧版 B 回 `CHANNEL_NOT_ALLOWED`，A 提示对方版本过旧，不回退到本机运行。
- **凭证**：模型请求只由 B 上的 Agent 用 B 自己的登录与供应商发出，任何凭证不进事件流；B 本机
  隧道每个任务一个随机令牌，只监听 127.0.0.1。
- **Codex 依赖**：B 的 Codex 通过 app-server 的实验接口 `environment/add` + `environments` 把 A 注册为
  exec-server 执行环境，A 为每条连接起本机 `codex exec-server --listen stdio://`。该接口随 Codex 版本
  可能变化，升级 Codex 时需回归 `remote-agent/__tests__/codexHosted.e2e.test.ts`。A 的中继按方法语义
  过本机闸门(`controller/execServerRelay.ts`)：当前固定 Codex 0.159.2 的 `fs/open` 只读，文件写入使用
  `fs/writeFile` 的 `dataBase64`，没有 `fs/writeBlock`；协议依据为
  [固定版本源码](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec-server-protocol/src/protocol.rs#L558)。
  `fs/readFile`、`fs/open` 的缺省/read 模式与目录读取按读取，显式非 read 的 open 模式仍从严按写入；`fs/walk` 按
  目录级读取，`fs/getMetadata`、`fs/canonicalize` 等只看元数据的不过闸门，其余 `fs/` 方法按写入；
  升级 Codex 后核对 exec-server 新增的方法，只读的要显式归类，否则会被当成写入拒掉(#5764)。
- **影子目录与配置同步**：`open` 载荷除项目说明文件(含 `.claude/CLAUDE.md`、`.claude/rules`、
  `.codex/skills`)外还带 `ancestorFiles`(项目上级目录里的
  `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` / `AGENTS.override.md`，按层级 `up`，最多 24 级)与
  `personal`(A 的个人配置：Claude Code 的 `~/.claude/CLAUDE.md`、`skills/agents/commands/rules`、`settings.json`
  里的权限规则；Codex 的 `AGENTS(.override).md`；Codex / Pi 的个人 Skill 放在 `.agents/skills`、
  `.codex/skills`；不含 hooks / env)。两者缺省按空处理。B 把影子目录按
  A 的真实路径逐级镜像在 `<runs>/workspaces/<控制端>/<任务>/fs/` 下，`open` 回包的 `mirrorRoot` 告诉 A
  镜像根，A 据此把影子路径逐级映射回真实路径；项目里已有的同名文件以项目为准。A 收集这些文件时跟随
  符号链接(与本机 Agent 加载一致，只防链接绕回上级目录与指向整个用户目录)，额度先给入口文件(SKILL.md、
  子代理、命令、规则、提示词模板)再给附属文件；供应商分享的受邀者任务不把凭证类文件放进载荷
  (`provider-sharing.md` §9 第 7 条)。
  可选的 `importFiles`(2026-10-10 新增)：Claude Code 说明文件里 `@` 导入的文件，`base: workspace` 相对影子
  目录(可带 `..`，B 只写在镜像根内)，`base: session` 相对会话目录(个人说明导入的 ~/.claude 下的文件，不进
  镜像根)；A 把导入改写成在 B 上也能找到的相对路径。旧 B 不认识这个字段，导入照旧找不到；个人配置的新
  子目录旧 B 同样丢弃，都不影响其它内容。受邀者的导入文件只收 Markdown / 纯文本，所有 Markdown 里指向
  会话目录外的 `@` 引用一律断开。
- **本机虚拟工作区**：A 在 open 前先调用 caps，只有 B 回包声明
  virtualWorkspace: true 才发送 open；旧 B 或未声明能力的 B 直接提示升级，不能静默降级到
  暴露 A 真实路径的合同。支持时，B 使用不含 A 真实目录名的固定短父级层级，继续承载最多 24
  级祖先说明文件，并回显 virtualWorkspace、extraDirs、writableDirs。Agent prompt、文件
  引用、工具路径诊断与命令输出使用 B 本机虚拟路径；包含本机路径的文本结果会做投影，写回时再
  还原到 A 的真实路径，二进制内容保持原样。A 的真实目录继续用于权限 gate、执行与变更抓取，
  路径别名不增加授权。执行平台与 shell 保留 A 的实际值，以免跨 macOS / Windows / Linux 选错
  命令。此增量不修改 channel、relay、协议版本或服务器，也不是 OS 虚拟化。
  本机 MCP 的 snake_case / camelCase 路径参数（含工作目录、插件目录交接、文档输入输出）在 A 执行前还原；
  参数复用结果侧的路径字段判据，覆盖 `output_dir`、`screenshot_out_file`、`out_file`、`absPath` 等已有字段，并兼容 `debug_image_out`；还原后的路径仍由各本机工具执行原有的目录范围与权限检查。
  `get_current_session_id` 等工具的 JSON 文本及 Skill/命令的 JSON 输出先解码字符串再投影，保持合法转义与原有格式。
  MCP 的 JSON/SSE 结构化结果保留路径字段语义，并传给路径字段内嵌的数组；普通正文仍逐路径 token 投影，避免空格后的分隔符漏转或正文被当成完整路径。
  已明确为路径的参数、路径字段内嵌的数组与命令内的完整路径保留中文和空格，空格之后的子路径也必须转换成目标电脑的分隔符。
  "script" 字段同时承载脚本源码和可执行文件路径；只有完整值对应 A 上已存在的文件或目录时才整体转换，否则按正文逐路径 token 投影，避免改写脚本里的参数与 URL。
  JSON 标量/独立数组不自动提供路径语义；无字段名的字符串只有在完整值对应 A 上已存在的文件或目录时才整体转换，否则逐路径 token 投影，避免改写正文中的 `/api/v1` 或相对参数。明确的路径字段不依赖文件存在性，仍支持尚未创建的目标。
  普通输出和文件正文无论引号内外都逐个路径 token 投影，不把以路径开头的整段当成单一路径；命令只安全引用替换的目录前缀，保留后缀的变量和命令替换语义。
  命令后缀按执行端 shell 的引号与转义边界扫描；转义引号前的反斜杠不得变成路径分隔符。权限检查继续使用映射后实际执行的命令。
  分隔符按路径写法认：Mac / Linux 路径只认 `/`，Windows 文本里的 `\Users`、`C:/Users` 不是 A 上的 `/Users`，不得再投影。
  B 是 Windows 时，Agent 在 bash 命令与正文里写的转义分隔符 `\\` 同样还原(bash 里它就是一个反斜杠)；后面不是目录名的 `\\`
  仍按转义原样保留。
  Agent 取到的当前目录可直接用于后续工具，A 的任务语境、执行 cwd 与权限检查始终使用真实目录。
  B 回传的工具文件路径、文本文件链接与图片源路径在 A 的事件落库和广播前还原，文件卡及预览读取 A 的真实文件。
  行内代码含空白时，只有完整引用对应 A 上已存在的文件或目录才整体还原；否则逐路径 token 投影，保留命令参数。明确的链接目标与结构化路径不依赖文件存在性。
  流式正文按来源、轮次和子代理 parentUuid 分别暂存未传完整的文件引用，同一流的工具和终态边界补齐尾段；全局终态与关闭清空所有流，独立后台提示不打断正文路径。
  `status { isRunning: false }` 也在转发前补齐尾段，不依赖后续 `done` 或关闭；仅前台顶层停止状态清空所有流，后台或子代理停止只补齐自身流，运行中或未声明停止的状态不打断正文路径。
  `file://` 与 `xdt-file://` / `xdt-audio://` 的文件路径按 URL 语法转换，HTTP 和 `cindy-media://` 地址保持原样。
  正文与命令里的目录前缀只按完整目录段匹配，与文件操作的路径解析一致：以工作目录名开头的同级目录(`xxx.git`、
  `xxx-v1`)按上级目录投影，不能切成「工作目录 + `.git`」，否则文字与命令落在 `xxx.git`、文件工具却写进 `p.git`；
  空白、引号与句末标点后面是否接着同级目录名(`xxx copy`、`xxx (1)`)，投影给 B 前在 A 上按磁盘核对。
  命令按执行端 shell 的引号语义识别边界：引号内空格属于完整目录名，不依赖目标已经存在；紧接前缀的变量与
  未引用的通配符由 shell 展开，保持原语义，不把它们当成静态目录名。
  Agent 写回文件(Claude Write / Edit / NotebookEdit、Pi `fs.write`、Codex `fs/write*`)时，按写入前的文件内容查回
  路径的原写法(分隔符、Git Bash `/c/…`、`/tmp`、大小写、符号链接)，完整原样往返及能按上下文定位的未改内容保留原写法；
  多种原写法折叠成同一虚拟文本且缺少可定位上下文时，不能保证任意重写逐字节无损。Edit 按 Agent 读到的投影视图
  检查唯一性与批量替换，避免同一虚拟路径的多种原写法漏改；新出现的路径
  沿用 Agent 的分隔符，A 为 Windows 时不把 `/` 改成 `\`，避免源码字符串里出现 `\f`、`\b` 等转义。Codex 的
  `fs/write*` 的路径和命令在权限检查前改写，原内容只在授权通过、实际转发前读取，凭证类文件不预读。正文、代码段与链接里还原的路径同样沿用 Agent 的分隔符，
  Markdown 不会把 `\.git` 当转义吞掉；结构化路径字段仍用 A 本机写法。
  事件身份、Agent 元信息、权限与提问的回执不改写，原生 Agent 会话继续使用 B 的虚拟路径；计划审阅的计划正文与
  计划文件按 A 的真实路径展示和保存，用户改过的计划及要求修订的反馈交回前换回 B 的虚拟路径。旧消息不回填。
  回归见 `remote-agent/executor/__tests__/virtualWorkspace.test.ts`、`remote-agent/executor/__tests__/pathFidelity.test.ts`
  与 `remote-agent/__tests__/eventProjection.test.ts`；固定 Codex 的真实写入协议回归见
  `remote-agent/__tests__/execServerProjection.e2e.test.ts`。
- **执行环境**(2026-10-07 裁决)：A 上的命令(Claude 的 Bash、Pi 的 `exec.run`、Codex exec-server、
  搜索)沿用 A 的 Desktop 完整环境，与本机 Agent 一致：真实用户目录、临时目录、`SSH_AUTH_SOCK`、
  git / gh / npm 配置与用户自己的环境变量照常可用，不另造假 HOME，也不剥离凭证类变量。任务由 A 的
  用户发起，风险与本机 Agent 相同，由 A 的任务权限档与执行器 gate 把关；上面「凭证」一条只指模型
  登录与供应商凭证，命令输出照常经事件流回到 B 上的 Agent，与本机 Agent 把输出交给模型相同。虚拟化
  只作用于 Agent 看到的路径文本：用户目录、临时目录已有别名，PATH 里其余目录在设置虚拟根时登记
  (`executor/workspace.ts` 的 `setVirtualRoot`，回归见 `executor/__tests__/executor.test.ts`)。
- **回退**：`REMOTE_AGENT_METHODS` 含 `previewRewindFiles` / `commitRewindFiles`，B 在 `describeHandle`
  里声明支持后 A 才提供回退；文件按 A 本机的保存点链回退，对话由 B 截断。B 不支持时 A 关闭回退并提示
  升级那台的 Cindy。
- **持久化**：A 的 `sessions.agent_device_id`(migration 0123)记住 Agent 所在电脑；旧版本读不到该列，
  按本机任务处理。服务端代码无改动。
- **供应商授权(「允许被远程调用」)**：B 在模型供应商设置里逐个打开，默认关；B 没开「允许远程控制」时
  这一行仍显示但开关不可用，并提示先开启远程控制(供应商分享入口也在这一行)。授权按账号存在 B 本地(`remote-provider-access-prefs.json`)，凭证与路由细节不出 B。
  `maker:provider:list` 每条供应商附带 `remoteInvocationEnabled: boolean`，**只作标记、不裁剪目录**：
  远程控制与 Mobile 仍看到全部供应商，忽略该字段即可。A 的远程 Agent 入口(模型选择器左侧栏、换模型、
  协同 Worker(含 Worker 自己选的那台)、定时任务读的那台目录)只用值为 `true` 的供应商，缺少该字段按未开放。B 是最终裁决方：
  `open` 时把来源落到已开放的供应商上(A 没指定来源时只在已开放的里按默认规则挑)并以显式来源启动；
  `setModel` 显式换来源时同样核对；关掉后进行中的这一轮照常结束，下一次 `send` 被拒。拒绝统一回
  `REMOTE_AGENT_PROVIDER_NOT_ALLOWED`，A 按 `chat.remoteError` 提示去那台电脑打开开关或换模型。
- **已建任务换 Agent 所在电脑**(2026-10-07)：选模型时可把 Agent 挪到本机或另一台电脑，与任务中途换
  引擎同一套意图——下一条消息发送时落地，原生会话在原来那台、接不上，一律全量交接 + 全新原生会话，
  并插 `agent_switch` 边界行。`maker:switch-session-agent` 新增可选第 7 参 `{ agentDeviceId: string | null }`
  (null = 任务所在电脑)；不带 = 位置不变(旧控制端与内部调用都走这里，A 不做推断)。pending 意图投影与
  边界行内容只在换电脑时多出 `agentDeviceId` / `fromAgentDeviceId`、`toAgentDeviceId`、
  `fromAgentDeviceName`、`toAgentDeviceName`，旧端忽略即可(旧端的分隔条显示成「从 X 切换到 X」)。
  Agent 要落在另一台电脑时，A 在**选择时**就读那台的目录核对(在线、供应商已开放、有这个模型)，不留
  发送时才在那台失败、且之后每次发送都重试的意图；本机窗口拿到 `REMOTE_AGENT_DEVICE_UNREACHABLE` /
  `REMOTE_AGENT_MODEL_UNAVAILABLE`，device-link 控制端降级为 `PRECONDITION_FAILED`。Mobile 与桌面同一套
  模型列表：A 自己的供应商之外，另列其他同账号电脑已开放远程调用的供应商(Mobile 直接经 device-link 读那台的
  `maker:provider:list`，不新增 A 侧 channel)；同一台电脑内换模型不带位置，换到另一台电脑先二次确认、再带
  `agentDeviceId`(null = A)。共享任务访客不能换电脑。
  桌面远程控制 A 上的已建任务(2026-10-09)与手机同口径：A 投影的任务带 `agentDeviceId` 字段(含 null)才开放，
  控制端直接经 device-link 读第三台电脑的 `maker:provider:list`，A 自己的目录照远程控制列全部供应商，换位置同样
  带 `agentDeviceId`(null = A)，换后档位记在控制端为那台电脑单独记的一份(改回 A 时写 A 的镜像)。
  同账号收到的可用分享全部列为候选(2026-10-14)，不要求任务已在分享上运行；已暂停或已移除的分享仅保留当前 /
  待切换位置，沿用既有不可用提示。分享按账号授予，控制端复用自己的已收到列表、分享目录与 Agent 能力通道，
  新落点再经既有 `maker:provider-share:received-catalogs` 核对被控端已加载且未暂停该分享；
  跨区启用标记是设备本地状态，不能仅凭控制端名单放行，也不触发新的跨区授权。查询失败时仅保留当前 / 待切换位置。
  创建、换位置和发送仍交给任务所在的 A 校验与执行，不新增 channel 或授权。控制端自己暂不作为新落点列出；
  Agent 正在控制端读不到目录的位置上时维持原有的 A 目录列表。控制端尚未收到的分享不凭任务记录授予访问。
  实现见 `apps/desktop/src/renderer/lib/controlledTaskAgentLocation.ts`，回归见
  `controlledTaskRemoteAgentPanel.test.tsx` 与 `remoteAgentRelocationWiring.test.ts`。
  桌面远程控制下新建任务(建到 A 上，2026-10-09)同样开放：判据与手机新建相同(A 的 `maker:provider:list` 带
  `remoteInvocationEnabled` 布尔标记，共享任务访客与 SSH 不开放)，模型面板先列 A 的全部供应商、再列其他同账号电脑
  已开放的供应商；选中后草稿的模型目录改按那台，`maker:create-session` 带 `agentDeviceId`，权限档沿用 A 的草稿值，
  不把那台的模型写进 A 的新建草稿记忆；默认来源解析、提交的来源与协同 Worker 收窄都只用那台已开放的供应商。
  落点范围与已建任务相同(包括同账号可用分享，控制端自己暂不列出)；协同草稿与它不互斥(与桌面本机新建一致)。回归见
  `controlledDraftRemoteAgentWiring.test.ts`。
  Mobile 新建任务(2026-10-08)同样列出这些供应商与分享来的供应商，选中后 `maker:create-session` 带
  `agentDeviceId`(与桌面新建同一参数，A 已接受)；只有 A 的 `maker:provider:list` 带 `remoteInvocationEnabled`
  布尔标记时才提供(该标记与远程 Agent 同一版加入，旧 A 不列)。手机不按 A 的目录与登录校准这份选择，由运行 Agent
  的那台在首条消息时核对；A 声明 `supportsOrcaWorkerAgentDevice` 时协同草稿与之不互斥(见下一条)，旧 A 仍互斥。
- **协同 Worker 的 Agent 位置**(2026-10-10)：远程供应商与本机供应商一视同仁，每个 Worker 可以单独选 Agent 所在
  电脑或分享，缺省跟 Lead。`maker:worker:create` 与 `maker:session:enable-orca`(首个 Worker)新增可选
  `agentDeviceId: string | null`：不带 = 跟 Lead(旧控制端行为)，null = 任务所在电脑，string = 同账号电脑的设备 id
  或 `share:<id>`。旧 A 会静默丢掉这个字段、把 Worker 建在 Lead 那里，所以 A 在 `maker:get-capabilities` 声明
  `supportsOrcaWorkerAgentDevice: true` 后，控制端(桌面远控、Mobile)才在 Worker 的模型面板列远程供应商、才发这个
  字段；这两个协议位是整台 A 的，控制端用 A 一定注册的 Claude Code 读(Worker 选的 Agent 可能只装在 Agent 所在
  电脑上)。开启协同提交前再按能力核对一次，降级的 A 直接失败、不静默建错；控制端读不到 Lead 所在位置的目录时
  (控制端自己、只有 A 收到的分享)维持 A 的目录、不发这个字段。A 在占槽与启动前读那台的目录，读不到回
  `REMOTE_AGENT_DEVICE_UNREACHABLE` / `REMOTE_AGENT_SHARE_*`；与运行设备(`executionDeviceId`)同给、SSH Lead 回
  `INVALID_PARAMS`。Worker 列表(`local-db:orca-workflows:list-workers-by-lead` 的 `session.agentDeviceId`)只在 Agent
  不在任务所在电脑时带值，旧端忽略即可。Lead 的 MCP 工具同步：`list_available_models` 可选 `agent_device_id` 并返回
  `locations`，`create_worker` / `create_workers` 可选 `agent_device_id`(`"local"` = 任务所在电脑)。不新增 channel，
  allowlist 不变。回归见 `orcaWorkerCreationService.test.ts`、`CreateWorkerPopover.test.tsx`、Mobile
  `orcaTeam.test.ts` / `useOrcaWorkerForm.test.tsx`。
- **账号余量**(2026-10-09)：这一轮消耗的是 Agent 所在那台(B)的账号，桌面底部用量 chip 与手机任务菜单都改读 B 的
  余量，不读任务所在电脑(本机或被控电脑)的同名账号。直接经 device-link 调 B 已有的 `maker:usage:*` 读取与推送
  (与模型选择器读 B 的余量同一份镜像)，不新增 channel；任务价值与上下文仍读任务所在电脑。远程控制的任务把 Agent
  放在第三台电脑时读第三台，放在控制端自己时读本机；挂着换位置意图时桌面 chip 按意图里的电脑显示。分享来的供应商、
  共享任务访客与没指定来源的远程 Agent 读不到那份账号，只显示任务价值。桌面判定见
  `apps/desktop/src/renderer/lib/usageAccountLocation.ts`，手机见 `apps/mobile/src/session/sessionUsageAccount.ts`。
- **供应商分享(另一个账号用 B 的供应商)**：契约见 `docs/provider-sharing-contract.md`，产品规则见
  `docs/product-rules/provider-sharing.md`。relay 新增 `Envelope.providerShare` 范围与能力 `provider-share-v1`
  (`packages/device-link-protocol/src/providerShare.ts`，两仓同文件)，与 `sharedTask` 并列、同一帧不能同时带两种范围；
  客户端只在 relay 的 hello-ack 声明该能力后才发带范围的帧，本地 peer key(`providerSharePeer.ts`)只在 socket 边界编解码、
  不上 wire。Desktop 在 hello 与控制端 `CONTROLLER_CAPABILITIES` 里追加声明 `provider-share-v1`(append-only)；B 只接受声明了它的
  受邀者 link-open，并只建后台链路。受邀者只能 invoke `maker:remote-agent:v1`、`maker:provider:list`(只返回分享的那个
  供应商)，以及按该供应商收窄的 `maker:get-capabilities` / `maker:list-available-agents` / `maker:agent:status`
  (旧版分享者回 `CHANNEL_NOT_ALLOWED`，受邀者的模型列表读不到这个分享)，订阅与其他 channel 一律拒绝，撤权后迟到的结果改写为 `ACCESS_REVOKED`。受邀者的任务把 `sessions.agent_device_id`
  记成 `share:<shareId>`(不改 schema)，旧版本读到它按连不上的电脑处理。受邀者对端的 `open` 载荷按白名单复核
  (hooks / env / apiKeyHelper 剥离、越界 `@` 引用与 `!` 命令语法中和、不加载 B 的个人化与托管 Skill)，只能恢复自己建立的会话；
  B 上受邀者会话的 Agent 自带工具按白名单开放(产品规则 §9 第 5 条，不改 wire)；受邀者电脑上的 `cindy_exec` 在任务的
  Agent 位置是 `share:` 时为 Claude Code 追加 `WebFetch`(在受邀者电脑抓取，tools/list 追加项)：旧版受邀者不列，受邀者就没有
  WebFetch；旧版分享者上它与自带 WebFetch 并存。两种组合都不报错，也不改 wire；
  remote-agent wire 本身不变(2026-10-15 起受邀者可多调一个 op `reshare`、open 多一个可选 `reshareKey`，channel 白名单不变，
  见「供应商组：转分享需原主人逐人同意」)。新错误码 `REMOTE_AGENT_SHARE_PAUSED` / `REMOTE_AGENT_SHARE_REMOVED` / `REMOTE_AGENT_SHARE_UNAVAILABLE`
  只在受邀者本机产生(分享者电脑回 `ACCESS_REVOKED`、relay 回 `REMOTE_DISABLED` 时改写成 `UNAVAILABLE`)；
  控制这台电脑的旧版手机没有对应文案，显示通用的发送失败提示。分享出去的 `maker:provider:list` 去掉分享者的账号身份
  (`subscriptionAccount` / `openAiAccount` 与名称里的登录名、邮箱，`@cindy/device-link` 的 `scrubSharedProvider`)，
  分享者电脑、受邀者电脑与手机各过一遍。手机经同账号新 channel `maker:provider-share:received-catalogs`(进同账号 allowlist)
  读取被控电脑收到的分享及其目录；旧版电脑回 `CHANNEL_NOT_ALLOWED`，手机按没有分享处理。跨区域(P3)经服务端开关开放，
  受邀者用第二条 relay 连接(`ProviderShareGuest` 认证)，见契约 §6。
- **暂不支持**：分叉、审查、复制到其他电脑、导出 `.cshare`(Agent 会话记录在 B)，入口隐藏、
  主进程拒绝。
- **移动项目可用**：B 上的影子目录只按「控制端 + 任务 id」定址(虚拟工作区为必需能力)，与 A 的工作目录
  无关；A 换目录后关闭空闲 handle，下次发送按新目录重建，B 上的会话记录原样续用。

## 协同远端 Worker：Worker 在另一台电脑运行

Orca 原地 Agent 切换补充边界：执行设备任务按既有 `orca_remote_lead` 判定，
与 `orca_role` 一样拒绝用户换 Agent 位置，不新增 wire 字段或版本要求。
Mobile 对已在另一台电脑运行的 Orca Agent，按所展示的模型目录所在电脑查询
`maker:get-capabilities`；登记切换仍发给任务所在电脑。旧端保持原能力校验，
不会因目标电脑未注册该 Harness 而回退到别的电脑执行。

Desktop 本机 `maker:switch-session-agent` 的可选第 7 参增加
`confirmedContextWindow`（正整数），仅供同 Agent 选模保留已核对的窗口。
Renderer 与本机 Host 同包升级；不向 device-link 发送该字段，Host 对远程传入
显式拒绝，沿用 SET_MODEL 的本机确认边界。无此字段仍可登记选择，但 Orca
发送时若需要未确认的窗口重建，会保留意图并拒绝发送，用户可重新选择后确认。

与上一节方向相反：协同的 Lead 与团队留在 A，单个 Worker 的任务、目录、命令与文件都在 B(运行设备)。
B 上的 Worker 是一条普通任务，`sessions.orca_remote_lead`(migration 0124，JSON 见
`apps/desktop/src/shared/orcaRemoteWorker.ts`)记录派活电脑与 Lead；派活、停止与回报复用现有会话通道。
方案与产品决策见 [`../orca-cross-device-worker-plan.md`](../orca-cross-device-worker-plan.md)。

- **新增 channel**(`packages/device-link/src/orcaRemoteWorker.ts`，只进同账号 allowlist，不进共享任务清单)：
  `maker:orca:remote-worker:caps`(能力探测，回 `{ version }`)、`…:open`(按 A 给定的任务 id 新建 Worker 任务，
  幂等；超时 60s)、`…:release`(结束协同，任务与文件保留，幂等)。B 侧实现见
  `apps/desktop/src/main/maker-ipc/orcaRemoteWorkerHost.ts`。
- **幂等 open 的终态检查**：同来源、同 Lead 且未 release 的已有任务也必须仍为 `active`；
  已归档／软删除时拒绝并返回既有 `PRECONDITION_FAILED`，不新建、不复活。A 保留未确认创建
  收据，恢复仅解除未关联标记。该检查使用 B 的现有 status 列，不新增 wire 字段或改变版本；
  旧 B 仍保留原行为，B 更新后生效。
- **实际档位**：`open` 回包可选 `effort` 是 B 已保存的解析结果，同 ID 重试也从已有任务读取。
  空字符串保留无档位状态；旧 B 不返回该字段时，A 保留原来的请求值降级规则。字段增量不改协议版本，
  旧 A 忽略它，新 A 不向旧 B 要求新增请求字段。
- **实际 Fast 状态**：`open` 回包可选 `fastMode` 是 B 已保存的布尔值，新建和同 ID 重试均取真实任务，
  A 的代理任务和创建结果沿用它，显式 `false` 不被请求中的 `true` 覆盖。旧 B 缺省时，A 保留请求值的
  降级规则；旧 A 忽略新增字段，版本与请求不变。完整状态一致性需要 A/B 均更新，服务端无需改动。
  此字段不改变 B 的模型准入：当前显式开启不支持的 Fast 仍在创建前拒绝，不新增静默降级。
- **来源身份**：派活电脑取 server 盖章的 `src`(`DeviceLinkInvokeContext.controllerDeviceId`)，不采信载荷自报；
  非 device-link 调用与共享任务访客一律拒绝。`open` 指定的 `workingDir` 与 `maker:create-session` 同口径经
  B 的目录守卫(`device-link/dispatch.ts` 的 `PATH_GUARDED_CHANNELS`)；不指定则由 B 分配任务目录。
- **旧端降级**：旧版 B 没有这三个 channel，回 `CHANNEL_NOT_ALLOWED`；A 据此把该电脑显示为「需要更新」，
  **不回退**到普通 `maker:create-session`(普通任务没有防嵌套与来源标记)。B 新、A 旧时 B 不受影响。
- **可选运行设备**：`maker:orca:execution-devices`(只读)由 A 本机界面与控制端共用，返回
  `{ devices: [{ deviceId, name, platform, supported }] }`；逐台探测 caps，旧版标 `supported:false`，
  探测失败的不列出。共享任务访客拒绝。
  Mobile 使用同一只读通道获取 A 视角的设备，模型与 Agent 从所选运行设备读取。
  新手机连接旧 A 收到 `CHANNEL_NOT_ALLOWED` 时隐藏设备选择，原来的 A 本机 Worker 创建不变。
  首个与追加 Worker 都沿用既有可选 `executionDeviceId` / `workingDir` 字段；「对话」不传目录，
  「指定目录」传 B 上的绝对路径，由 B 校验；失败不回退 A。
- **A 驱动 B 的其余通道**全部是已有同账号 channel：`maker:input:enqueue`(按 `clientId` 幂等，
  `durableDelivery`)、`maker:input:get-projection`(投递回执)、`maker:list-active`、`local-db:sessions:get`、
  `local-db:history:messages`、`maker:abort-session`；B 不需要知道「这是协同派活」，只认来源标签。
- **恢复暂停**：B 的 `INPUT_ENQUEUE` 按已有自动消息来源判据处理 `origin.kind`，Orca 派活不解除
  崩溃恢复后的队列暂停；普通手机／桌面用户输入仍可解除恢复暂停，用户 Stop 暂停不受影响。
  不新增 wire 字段或改变版本，A 的既有派活载荷不变；旧 B 保持其原有行为，需更新 B 才有此修复。
- **收尾限制**：当前 abort/release 不取消未消费的远端派活，结束协同后队列仍可能继续执行。
  远控入队后的来源不足以可靠区分 Lead 派活与用户输入，本轮不通过清空队列规避；待专门设计
  持久投递归属、取消回执与释放边界后修复，详见 `orca-team-architecture.md` 的已知限制。
- **B 侧约束**：带标记的任务不能再开启协同(`assertLeadCollabProjectEnabled` 统一拒绝 Worker 与远端 Worker，
  覆盖 IPC、远程与 Agent 工具入口)，不能复制到其他电脑(`task-migration/service.ts`)；侧栏照常显示，
  任务头标注「来自 X 的协同」，结束后显示「协同已结束」。

## 供应商组：同账号直连(P2a)

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §4、§5、§6.1、§10。组所在电脑 O 把某个供应商建成组后，
同账号另一台电脑 C 上选了 O 的这个供应商的新任务：C 问 O 该用哪台，再自己直接连到选中的组内电脑运行。

- **新 invoke channel `provider-group:remote`**(`packages/device-link/src/providerGroup.ts`，进同账号 allowlist)，被控端
  `dispatch.ts` 拦截执行，不落 ipcMain handler；供应商分享受邀者(不在 `PROVIDER_SHARE_CHANNELS`)与共享任务访客一律
  `CHANNEL_NOT_ALLOWED`。请求 `{ action, ... }`，结构与校验在 `apps/desktop/src/shared/providerGroup.ts`(两端同一份)：
  - `pick { sessionId, providerId, agentKind, model, exclude[] }` → `{ kind: 'member', member: { key, kind, agentDeviceId, providerId }, label }`
    / `{ kind: 'unavailable' }` / `{ kind: 'none' }`(没有组或供应商没开放远程调用)。组员坐标是 O 视角(`local` = O 自己)，C 换算成
    本机位置；选中即给那台记 30s 临时占用；
  - `cool { providerId, memberKey, cause: 'usage-limit' | 'auth' | 'overload', resetAt? }` → O 短暂冷却那台，未带模型的旧报告最多信 2 分钟；
    连不上不报，只由 C 自己避开(组内状态以 O 为准，C 那边的问题不记进组里，2026-10-11)。`exclude` 非空(C 这一轮试过
    不行再来问)时 O 不用短时缓存、现读组内电脑的最新状态再选，请求格式不变；
  - `cool-model { providerId, memberKey, cause: 'usage-limit', model, resetAt? }`（2026-10-17）→ O 只冷却对应模型，
    `resetAt` 最多信 8 天，无时刻则 30 分钟；Claude 家族别名共用一个范围。新 C 连接旧 O 收到
    `unknown provider group action` 时，只回退一次 `cool`，重置时刻压到未来最多 2 分钟；其他失败不回退。
    旧 C 连接新 O 的无模型报告只保留短冷却。完整模型隔离需 C/O 更新；手机仍由被控电脑执行，无新 channel 或服务端改动。
    本地 `provider-group-cooling.json` 的成员值从旧数字扩为范围到时刻的对象（空键是全账号）；新版加载旧数字最多保留
    2 分钟，降级旧版忽略对象并依据配额/实际报错重新判断，不影响任务与组配置。回归见 `router.state.test.ts`、
    `coolingStore.test.ts`、`remoteHandler.test.ts` 与 `remote-agent/__tests__/groupRelay.test.ts`。
  - `leases { seq, entries: [{ sessionId, providerId, memberKey }] }` → 整体替换 C 正在运行的经组任务，`seq` 只增(C 按时间生成，
    重启后仍增大)，乱序旧包丢弃，150s 不刷新作废；只用于分摊负载；
  - `view { providerId, model? }` → 组设置与组员状态(`ProviderGroupView`)；省略 `model` 时只按组级状态返回，
    发送前检查带上当前模型时，组所在电脑按该模型重新计算额度。带 `model` 的回包回显同一个 `model`，调用方只在回显一致时
    使用模型级状态；旧组所在电脑忽略这个可选字段、没有回显时只沿用离线、不可用和组级冷却等不依赖模型的状态，
    对可用或满载状态按模型额度未知处理，不会把旧端的组级可用状态误当成模型级状态。
  - `session-group { sessionId }`(只读，2026-10-11)→ `{ group: { groupDeviceId, providerId } | null }`：发给**任务所在的电脑**
    (不论它有没有组)，回答这个任务此刻归哪个组，坐标是那台视角(`groupDeviceId` 为 null = 那台自己建的组)。手机与桌面远程控制
    的模型列表据此把归组的任务显示在组那一项下、在组那一项里选模型时留在此刻运行的那台(provider-groups.md §10)。不读写分配器、
    负载与绑定。旧版本回 `CHANNEL_NOT_ALLOWED`(没有这个通道)或 `[INVALID_PARAMS] unknown provider group action`(有通道没有这个
    动作)，控制端一律按没归组处理，即与改动前相同。
  旧 O 回 `CHANNEL_NOT_ALLOWED`：`pick` 按 `none` 处理，任务照旧直接在 O 上运行。
- **`maker:provider:list` 新增可选字段 `group`**：只对同账号调用方、只加在建了组且「允许被远程调用」的供应商上：
  `{ strategy, autoSwitch, members: [{ key, kind, agentDeviceId, providerId, label?, paused }] }`(并发上限与权重不外发)。
  组摘要列着组内电脑，受邀者与共享任务访客拿不到：分享投影里去掉，`scrubSharedProvider` 再兜一层(分享者电脑、受邀者电脑与
  手机各过一遍)。旧控制端与手机不认识就忽略；新控制端据此在模型列表与设置页收起组员(只看在线电脑的目录)，新手机在模型列表
  里同样收起(2026-10-11)。O 改组后经
  `maker:provider:changed` 推送让同账号电脑重读目录。
- **远程 Agent open 载荷新增可选 `groupAssigned: true`**(`remote-agent/wire.ts`)：任务由供应商组分配到这台(本机的组或另一台的组)，
  这台直接运行、不再进入它自己的组(防转圈)。旧被控端解码时丢弃(它本来没有组)。
- **本地数据**：C 上经另一台电脑的组分配的任务绑定存 `provider-group-remote-bindings.json`(按账号，与本机组的
  `provider-group-bindings.json` 分开，降级后旧版本读不到它，不会误认成本机的同名组)。因组内电脑被移出或组被删除而
  解除过绑定的任务按组记在 `provider-group-released.json`(按账号，2026-10-10)，老任务纳入组时据此跳过(provider-groups.md
  §6、§9.4)；旧版本不读也不改写它，降级再升级后记录仍在。本机删组或移出组员时，解除记录改为与绑定删除一起
  原子写入 `provider-group-bindings.json` 的可选 `released` 字段，避免账号切换或中断造成半完成；读方合并两处记录，
  显式重新分配给同一个组时清除该组记录。旧文件缺字段视为空，旧版本写绑定仍保留未知根字段；旧版本运行期间不识别
  这些新增的内联记录，升级后解除记录优先于旧版恢复的同组绑定。损坏绑定文件保留并拒绝覆写。组所在电脑的冷却按账号存 `provider-group-cooling.json`
  (`{ cooling: { [providerId]: { [memberKey]: until } } }`，只存未到期的，2026-10-11)，重启后照样避开；旧版本不读它。
  不改数据库与服务端。
- 实现：`apps/desktop/src/main/provider-group/`(`remoteHandler.ts`、`remoteClient.ts`、`externalLoad.ts`、`leaseReporter.ts`、
  `service.ts` 的组来源)；回归见同目录 `__tests__/remoteGroup.test.ts`、`remoteHandler.test.ts`、`leaseReporter.test.ts`，
  `device-link/__tests__/providerShareDispatch.test.ts`(受邀者拒绝与不泄露组摘要)。

## 供应商组：同一台电脑的几个账号按电脑聚合（2026-10-15）

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §10。组成员的键与分配不变，只给展示与计数补两项可选字段：

- 组设置成员新增可选 `providerName`(加入时那台电脑上这个供应商的显示名快照，保存时以候选目录为准)；同账号目录里的组摘要
  (`maker:provider:list` 的 `group.members[]`)与 `provider-group:remote` 的 `view` 成员状态也带可选 `providerName`
  (状态优先用那台电脑当前的供应商名)。按显示名校验(去空白、≤128、无控制字符)，不合格就丢弃。
- 分享来的组员新增可选 `hostDeviceId`(分享者那台电脑的设备 id，本账号收到的分享里本来就有)：加入时取自候选目录，
  保存时渲染端给的值以目录为准、渲染端漏带时沿用已存的；旧组由 `removedShares.ts` 的 `recordShareHosts` 在对账已收到的
  分享时补记(只补名单里有的，没变化不写)。随组摘要发给同账号电脑(含手机)，不显示、不用于连接；只接受设备 id 格式，
  其余组员类型上的这一项丢弃。物理电脑键：分享来的有它时按它，没有时按分享各算一台。
- 旧端忽略这两个字段(旧版本读写组设置会丢掉它们，升级后由对账与下次保存补回)；新端读到旧组所在电脑的回包没有
  `providerName` 时用组设置里的快照，都没有时界面写「账号 N」。不新增 channel，不改 relay、服务器或数据库。
  组摘要本来就不发给受邀者，受邀者的匿名状态也不带这两项。
- **给受邀者的 `groupSize` 与匿名状态改为按物理电脑**：`sharedProviderGroupSize` 用 `providerGroupDeviceCount`，
  `readSharedGroupStatus` 把同一台电脑的几个账号合成一项(`sharedGroupComputerStates`，取最能接任务的状态)，两者项数一致，
  仍满足 `readProviderShareGroupStatus` 的「状态数 = 台数」校验；新旧受邀者都按原格式读，只是项数变少。
- 实现：`shared/providerGroup.ts`、`provider-group/router.ts`、`ipc.ts`、`directory.ts`、`removedShares.ts`、
  `reshareRuntime.ts`、`sharedStatus.ts`、`remoteHandler.ts`，界面聚合在
  `renderer/features/provider-group/providerGroupPresentation.ts`，手机计数在 `apps/mobile/src/session/remoteProviderGroups.ts`；
  回归见 `shared/__tests__/providerGroup.test.ts`、`provider-group/__tests__/` 下 `ipc`、`directory`、`removedShares`、
  `sharedStatus`、`remoteHandler` 测试与界面、手机同名测试。

## 供应商组：Claude 订阅额度筛选与用量均衡（2026-10-12）

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §5。选电脑仍由组所在电脑完成：先排除额度耗尽的成员，
再按所选策略分配；新策略 `usage` 只用于 Claude Code 订阅组。

- **可选策略枚举扩展**：本地组配置与同账号组摘要的 `strategy` 增加 `usage`，原默认 `least` 不变。
  旧版桌面读取未知策略时归一化为 `least`，旧版手机不依赖这个字段；远程 `pick` 仍由组所在电脑执行，因此
  旧控制端连接新组所在电脑也能使用新策略。组所在电脑降级后按 `least` 分配，旧版再次保存组设置会写回 `least`。
  2026-10-15 起配额排序（快到期先用、已用百分比低的先用）对所有策略生效，设置界面不再提供 `usage`；枚举值与归一化
  保持不变，已存的 `usage` 照常读写，挑法与 `least` 相同。这只改组所在电脑本机的选择，不新增字段、不改通道。
- **复用已有同账号通道**：向成员电脑调用 `maker:usage:claude-subscription`，参数 `[member.providerId]`；本机走同一
  订阅 reader。只信与请求一致的 `providerId` 回显；旧端未回显时仅允许默认 `anthropic`，具名账号按未知用量处理，
  避免旧端忽略参数后拿默认账号的额度代替。通道不可用、失败、超时或快照过期时按未知处理，分配照常进行。
- **隐私与状态**：额度快照只留在组所在电脑的内部目录中，不加入 `ProviderGroupView` 的额度字段或供应商目录，不传给受邀者；
  分享来的成员不调用此通道。同账号不带 `model` 的 `view` 仅复用已有 `cooling` / `coolingUntil` 表达总窗口耗尽，带 `model`
  的发送前查询只在回显模型一致时临时表达该模型的额度状态，不能改变其他模型的可用性。账号切换时丢弃旧读取，不扩大 allowlist
  或凭证访问。
- 不新增 channel，不改 relay、服务器、数据库或持久冷却格式。实现：`provider-group/usage.ts`、`directory.ts`、`runtime.ts`、
  `router.ts`、`remoteClient.ts`、`remoteHandler.ts`、`service.ts`；额度判定与自动继续复用 `shared/accountUsageLimit.ts`。回归见
  `provider-group/__tests__/usage.test.ts`、`router.usage.test.ts`、`runtime.test.ts` 与 `scheduler.test.ts`。

## 供应商组：受邀者经组所在电脑中转(P2b)

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §4「分享的人(中转)」、§8、§9。受邀者 G 用组所在电脑 O
分享出去的供应商，而 O 把它建成了组：O 的远程 Agent 被控端按组选一台组内电脑 M，自己作为 M 的控制端中转。G 与 O 之间的
`maker:remote-agent:v1` 协议完全不变(中转对 G 透明)；O 与 M 之间沿用同一协议，新增下面三项可选内容：

- **open 载荷新增可选 `relay`**(`remote-agent/wire.ts`，`REMOTE_AGENT_RELAY_KEY_PATTERN`，16–64 位 `[A-Za-z0-9_-]`)：O 为受邀者取的
  不透明键(按受邀者派生，不含分享与成员信息)。M 收到带 `relay` 的 open 一律按受邀者隔离运行(即使控制端是同账号的 O)：
  受邀者目录、会话索引、续接校验按(控制端, relay)分开。数量上限按认证的直接连接设备合计，分享 peer 取其 deviceId，
  同一设备跨供应商、分享入口及 relay 共用额度；默认单设备 16、提供方整机 64（可配置），不会因 relay 获得额外额度。O 同时带
  `groupAssigned`，并把 `sessionId` 换成按(受邀者, 任务 id)派生的 id、`providerId` 换成 M 上的供应商。旧 M 丢弃这个字段，
  所以 O 只把受邀者任务交给 caps 声明了 `guestRelay` 的同账号 M；分享来的 M 本来就把 O 当受邀者隔离，不要求这个能力。
- **提供方远程任务数量设置**：沿用 `maker:remote-agent:v1`，不加必填字段；`caps.maxRuns` 返回当前单设备上限（1～1000，旧解析器可读）。
  超限仍回 `REMOTE_AGENT_BUSY`，message 用 `[DEVICE_LIMIT]` / `[TOTAL_LIMIT]` 区分原因，旧端继续按忙碌处理。
  本机 `provider-share:command` 与同账号管理通道增加 `get-run-limits` / `set-run-limits` / `reset-run-limits`；
  `set-run-limits.limits` 只包含用户编辑过的 `perDevice` / `total`，写入端在锁内合并当前值并验证大小关系；
  未编辑字段不落盘，继续跟随默认值或此前显式设置。两个字段同时提供仍兼容。
  不向受邀者开放。旧端不认识这些管理命令时显示需要更新，不回退伪造成功。设置只影响新增实例，不中断存量。
  大额度下控制端仍按每批最多 64 个任务轮转 poll，不提高 wire 上限。
- **caps 新增可选 `guestRelay: true`**(`RemoteAgentCaps`)：被控端能按受邀者隔离运行(供应商级授权与受邀者出站边界都已接上)。
- **新 op `forget { relay }`**(`parseRemoteAgentRequest`)：O 删除受邀者后请 M 清掉替它运行过的任务、受邀者目录与会话记录；
  只作用于调用方自己的 relay。旧 M 回 `REMOTE_AGENT_INVALID`(它从没接过被中转的任务)。
- O 不信任 G 带来的 `relay` / `groupAssigned`：受邀者的这两个字段只会让任务按普通受邀者在 O 本机隔离运行，不能借此逃出
  受邀者隔离；O 的组路由只用 O 自己的组设置与记录。
- `forget` 的通知名单从 O 发出 open 那一刻起记(含启动失败、还没有原生会话 id 的 M)；没通知到的 M 持久记在 O 的受邀者
  会话索引(`forgetPending`)里，之后自动重发。open 的结果不明(超时、断链)时 O 先用同一个 runId 发 `close` 再换下一台；
  这些都只用已有的 op。
- 中转不解码消息与附件、不落盘(载荷原样按同一 callId 转给 M)；推帧按任务串行；M 报出的路径类错误(分享暂停、远程调用
  关闭、连不上、太忙等)转给 G 时统一成 `REMOTE_AGENT_UNAVAILABLE`。
- **控制端拉取器修正**(与本节同批，`remote-agent/controller/poller.ts`)：一个 poll 带回数据后，若有任务没被仍在途的 poll
  覆盖就立刻再发一个。此前同一台电脑上已有空闲任务挂着长等待时，新打开的任务带回第一段数据后要等旧的长等待超时
  (最长 10s)才能拿到 `started`。只影响控制端本地调度，不改 wire。
- 不改 relay、服务器与数据库。实现：`remote-agent/host/runHost.ts`(中转与 M 端隔离)、`host/groupRelay.ts`、
  `provider-group/guestRelay.ts`(选电脑)；回归见 `remote-agent/__tests__/groupRelay.test.ts`(三端同进程)、
  `provider-group/__tests__/guestRelay.test.ts`、`remote-agent/__tests__/poll.test.ts`。

## 供应商组：受邀者运行中换电脑(P2c)

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §6.1「谁来执行换电脑 · 分享的人」。上一节的中转任务在组内
电脑 M 上因那台本身的原因失败时，交接要用到对话记录，只能由受邀者 G 执行；组所在电脑 O 只负责告诉 G「需要换一台」并在
G 重新打开时换一台。G 与 O 之间新增四项可选内容，O 与 M 之间不变：

- **open 载荷新增可选 `acceptsGroupSwitch: true`**(`remote-agent/wire.ts`，只认 `true`)：G 声明认识下面的凭证状态。新 G 打开
  远程 Agent 任务时一律声明；O 只在中转任务上使用。旧 O 丢弃这个字段。
- **事件流里的凭证状态 `{ t: 'state', state: { providerGroupSwitch: <token> } }`**(`REMOTE_AGENT_GROUP_SWITCH_STATE_KEY`，
  凭证格式同 `REMOTE_AGENT_RELAY_KEY_PATTERN`)：O 看到 M 转来的终态错误(或一轮进行中 M 的任务意外结束；组选中 O 本机、任务在
  O 本机运行时同样适用)、按组口径判定是那台的问题、并确认组里还有能接的电脑后，**先**追加这条状态，**再**转出原来的错误；判定与选电脑期间 M 转来的后续内容按原顺序
  暂存，不乱序。只发给声明了 `acceptsGroupSwitch` 的 G；旧 G 只看到原来的错误(行为同 P2b)。G 取走凭证、不并入任务状态
  (`controller/startRemote.ts` `takeGroupSwitchState`)。O 丢弃 M 转来的同名状态，M 不能替 O 发凭证。
- **open 载荷新增可选 `groupSwitchToken`**：G 自动交接(全量交接 + 全新原生会话)后重新打开时带回凭证。O 只认发给这个受邀者、
  这个任务(按 O 侧的 `hostSessionId`)且未过期(10 分钟)的凭证，用一次即作废；有效时选电脑避开这一轮已经换下来的组内电脑，
  无效时按普通新任务选。凭证只影响选哪台，不扩大任何权限；它与 `relay` / `groupAssigned` 一样不转给 M。
- 同一轮每台组内电脑最多换一次(O 按(受邀者, 任务)记录)；那台上一轮正常结束或距上次换电脑超过 30 分钟算新的一轮。
- **send 选项新增可选 `groupNewRound: true`**(`RemoteAgentWireSendOptions`，只认 `true`)：G 上的用户亲自接手(发消息、重试、
  换模型)后、且这个任务收到过凭证时，下一次 `send` 带上它，O 据此清掉这个任务这一轮已经换下来的电脑，也算新的一轮。
  O 读完即去掉，不交给 Agent、不转给 M；旧 O 丢弃这个字段(手动重试仍沿用旧的一轮，直到正常结束或 30 分钟)。它只影响
  这个受邀者自己这个任务的换电脑记录，不扩大任何权限。组设置关掉了自动换电脑时 O 照常冷却出问题的那台，但不发凭证。
- G 只在持有凭证时才换电脑：分享暂停、删除、撤权等来自 O 本身的错误没有凭证，照旧交回原有处理。
- **续接回到原来那台、那台接不下时同样发凭证**(2026-10-11)：G 续接一个经组运行过的任务(带 `resumeSessionId`)，O 只能回到
  当初那台(会话在那台上)；那台接不下、且按同一个判定是那台的问题时，O 在 `start-failed` **之前**追加同一条凭证状态。G 的
  `startRemote` 在任务开始之前也会取走凭证(`takeGroupSwitchState`)；随后的打开失败由 G 的启动重试认领凭证
  (`claimGuestStartSwitch`)，先交接(全量交接 + 全新原生会话)，再在同一个分享位置带凭证作为全新任务重新打开，只试这一次。没有新字段；旧 G 只看到原来的启动失败。组为受邀者的全新任务选中 O 本机、O 的 Agent 却没能
  启动时，O 与组内电脑接不下一样在启动阶段换下一台(受邀者无感，旧 G 同样享受)。
- 不改 relay、服务器与数据库。实现：`remote-agent/host/runHost.ts`(暂存与发凭证、校验凭证)、`host/groupRelay.ts`、
  `provider-group/guestRelay.ts`(运行中失败的冷却)、`provider-group/guestSwitch.ts` 与 `provider-group/service.ts`(G 侧凭证与
  自动交接)、`maker-ipc/sessionAgentSwitchHandler.ts`(仅内部可用的 `forceRelocation`)；回归见
  `remote-agent/__tests__/groupRelay.test.ts`、`provider-group/__tests__/service.test.ts`、`guestSwitch.test.ts`。

## 供应商组：转分享需原主人逐人同意(2026-10-15)

产品规则见 [`provider-sharing.md`](../product-rules/provider-sharing.md) §4.3 与 [`provider-groups.md`](../product-rules/provider-groups.md)
§4。组所在电脑 O 的组里有分享来的组内电脑 M(O 的账号是 M 的受邀者)，O 又把组所在的供应商分享给了 G：G 的任务要经 O 中转到
M 上运行，必须先由 M 的主人逐人同意(按 G 的账号，不按设备)。O 与 M 之间沿用 `maker:remote-agent:v1`，新增三项可选内容；
G 与 O 之间不变。受邀者能调用的 channel 不变(仍是 `maker:remote-agent:v1` 的新 op，不改 `PROVIDER_SHARE_CHANNELS`、
`REMOTE_INVOKE_ALLOWLIST` 与 allowlist 哈希)。

- **caps 新增可选 `reshareConsent: true`**(`RemoteAgentCaps`，`parseRemoteAgentCaps` 白名单只认 `true`)：M 能记下并核对转分享的
  同意。只回给受邀者对端(同账号控制端经组使用不需要同意)。O 只给声明了它的 M 报人；未声明的旧 M 给不出同意，O 不把受邀者的
  任务分给它，设置页提示那台需要更新。O 在每次 open 前现查(含绕过分配的已有绑定续接)，不能沿用降级前的能力或同意缓存。
- **新 op `reshare { entries: [{ key, name, avatar? }] }`**(`parseRemoteAgentRequest`)：O 把它此刻分享的人整体报给 M(整体替换
  调用方上一份；调用方按本地 peer key 的(分享、成员、设备)区分)。`key` 是 O 按(O 的分享 id, G 的成员 id)派生的不透明键(格式同
  `REMOTE_AGENT_RELAY_KEY_PATTERN`，同一个人从哪台设备来都相同)；`name`(≤128 字符，无控制字符)与 `avatar`(只收 https)由 O 转述，
  只用来让 M 的主人认出是谁。最多 256 项、键不能重复。回包 `{ entries: [{ key, state: 'pending' | 'approved' | 'rejected' }] }`
  (`parseRemoteAgentReshareResult`，不认识的状态与请求外的键丢弃)。M 只接受受邀者对端，其他调用方回 `REMOTE_AGENT_INVALID`；旧 M
  不认识这个 op 同样回 `REMOTE_AGENT_INVALID`。替换语义使重复发送安全；O 只在本机分享快照已拉到时才报，避免空名单清掉已有同意。
  单次请求上限是 wire 防护，不是分享人数上限：超过 256 人时，O 先从 M 的 caps 读取 `reshareBatch: true`，再用不透明的
  `batch: { id, index, count }` 按 256 人分片顺序发送；每片响应只带当前片的状态、同一批次信息与 `complete`，最后一片才表示接收端已整体替换。
  M 可以乱序接收并在内存暂存，缺片或未收齐时保留上一份已落盘审批名单；未完成批次 10 分钟后过期，新批次替换同一来源的旧批次。
  批次数不设按人数的固定上限，接收端按序列化字节总预算限制未完成批次，超预算返回可重试的忙碌错误；已完成批次在过期前对重复片段回同一完成状态，避免重试重新创建待处理批次。
  没有 `reshareBatch` 的旧 M 不能安全接收大名单，O 标记需要更新且不发送任何部分名单。
- **open 载荷新增可选 `reshareKey`**(`remote-agent/wire.ts`，同 relay 键格式)：O 把受邀者任务转给分享来的 M 时带上这个人的键
  (同账号组内电脑不带；G 自己填的不转发)。M 收到受邀者对端带 `relay` 的 open(即被转来的任务，含续接)时，只有主人同意过
  (调用方, `reshareKey`)才运行：带了 `reshareKey` 而没同意回新错误码 `REMOTE_AGENT_RESHARE_NOT_ALLOWED`(带这个字段即表示 O 认识它)；
  没带(旧 O)回已有的 `REMOTE_AGENT_PROVIDER_NOT_ALLOWED`，旧 O 照常换组里下一台、转给 G 时统一成「暂时不可用」。
  主人撤回同意时 M 立即结束这个人经组转来的任务；M 在所有异步查询结束后、登记任务前再次核对同意，核对与登记之间不等待。
  O 收到 `REMOTE_AGENT_RESHARE_NOT_ALLOWED` 时重新核对同意情况，之后不再选它。
- O 移出最后一个组引用时，在本机组设置里原子记下待清空代次；`reshare` 空名单得到有效回包后才删除该代次，失败每分钟重试，
  重启后继续。重新加入时先清空再报人；迟到的确认不能吞掉再次移出的新代次。不新增 wire 字段，沿用整体替换的幂等语义。
- O 给 G 的匿名组状态(`groupStatus`)里，没同意过 G 的分享来的电脑显示 `unavailable`(那台给不出同意时 `needs-update`)，与实际
  分配一致；`groupSize` 不变。
- 已知局限：M 只能按 O 自报的 `relay` 认出被转来的任务；改过的 O 不带 `relay` 时 M 分不出(防误分享，不防恶意，与供应商分享
  「默认信任分享对象」一致)。更早的 O(P2b 之前)不带 `relay`，M 同样分不出。
- 不改 relay、服务器与数据库(M 的同意记录在本机 `provider-share-reshare.json`)。实现：`packages/device-link/src/remoteAgent.ts`、
  `remote-agent/host/runHost.ts`、`host/groupRelay.ts`(`reshareKeyFor`)、`device-link/providerShareReshare.ts`(M 侧记录)、
  `provider-group/reshare.ts` 与 `reshareRuntime.ts`(O 侧报人与缓存)、`provider-group/guestRelay.ts`(选电脑)；回归见
  `packages/device-link/src/__tests__/remoteAgent.test.ts`、`remote-agent/__tests__/groupRelay.test.ts`、
  `provider-group/__tests__/reshare.test.ts`、`guestRelay.test.ts`、`device-link/__tests__/providerShareReshare.test.ts`。

## 供应商分享：受邀者不看分享者的电脑名，组只给台数(2026-10-10)

产品规则见 [`provider-sharing.md`](../product-rules/provider-sharing.md) §5.1、§6 与 [`provider-groups.md`](../product-rules/provider-groups.md)
§8、§9.7、§10。受邀者只知道是谁分享的、分享的是哪个供应商；本节登记组台数，2026-10-12 增加的匿名状态见下一节。

- **分享投影里的 `maker:provider:list` 新增可选 `groupSize`**(正整数，1–512)：分享者把这个供应商建了组、且仍「允许被远程调用」
  时，`projectProviderListForShare` 按本机组设置填上(目录里原有的值一律先去掉)。`scrubSharedProvider` 在分享者电脑、受邀者电脑
  与手机各过一遍，只留合理的整数(`readProviderShareGroupSize`，`packages/device-link/src/providerShareCatalog.ts`)。旧受邀者不认识
  就忽略；旧分享者不带，新受邀者当作没有组。
- **分享链接的 `deviceName` 填固定占位 `Cindy`**(`PROVIDER_SHARE_NEUTRAL_DEVICE_NAME`)：字段仍必填(服务端与旧版受邀者按必填非空
  字符串处理)，只是不再上传分享者的电脑名。被控电脑转给手机的 `maker:provider-share:received-catalogs` 里的 `deviceName` 同样填
  占位(服务端仍存着旧链接里的电脑名)。新版本界面一律不读这个字段；旧版受邀者会显示占位(新链接)或原来的电脑名(旧链接)。
- **同账号的组摘要(`group`)里 `kind: 'share'` 的组员不再带 `label`**：旧版本加入时存的快照是分享者的电脑名。新控制端按自己收到的
  分享(分享属于账号)显示分享者昵称；`provider-group:remote` 的 `view` 里这类组员的 `label` 改为分享者昵称，旧控制端照常显示它。
- 换 Agent 位置的分隔条：目标是分享(`share:<id>`)时不写 `toAgentDeviceName`，显示成「已改到另一台电脑上运行」；
  供应商组换电脑的活动记录里分享来的电脑写分享者昵称。
- 不改 relay、服务器与数据库。实现：`device-link/dispatch.ts`(`projectProviderListForShare`)、`provider-group/remoteHandler.ts`
  (`sharedProviderGroupSize`)、`provider-group/directory.ts`(`memberLabel`)、`device-link/providerShareRuntime.ts`；回归见
  `device-link/__tests__/providerShareDispatch.test.ts`、`provider-group/__tests__/remoteHandler.test.ts`、`directory.test.ts`、
  `packages/device-link/src/__tests__/providerShare.test.ts`。

## 供应商分享：按需查看匿名组状态(2026-10-12)

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §8、§9.7、§10。

- 受邀者读现有 `maker:provider:list` 时可在 `args[0]` 加 `includeSharedGroupStatus: true`。只在分享详情使用；
  普通目录读取不探测组员，避免组之间相互读取目录时递归。供应商始终取实际分享授权，不信任请求中指定的供应商。
- 新分享者在这一条供应商上附加可选 `groupStatus`：长度与 `groupSize` 一致的状态数组，只允许
  `available / busy / cooling / offline / paused / unavailable / needs-update / unknown`。序号由界面按数组位置生成，
  不传组员名称、标识、来源、任务数或用量；不扩展 `provider-group:remote` 的受邀者权限。
- 由实际受邀者分配器读取组状态并按同一能力条件检查能否接分享任务，状态与能力读取各有 3 秒等待上限；
  超时／失败为未知，不改变分配与冷却。读取期间组设置或账号变化丢弃快照，分享撤销后不返回在途结果。
  `scrubSharedProvider` 在各跳按白名单重建数组；不合法的单项替换为 `unknown`，长度不符则不带字段。
- 匿名能力探测按当前账号运行期共用最多 4 个物理在途槽，同电脑跨刷新复用查询；等待超时不释放仍在途的槽，
  未发出的排队查询 3 秒后取消。已结算的能力结果短存 15 秒，迟到结果可供下一次详情读取使用；不缓存组状态，
  不跨账号复用或继续发出旧账号的排队查询，不改变底层 device-link 超时、重连或 wire 格式。
- 兼容：旧分享者忽略查询选项，新受邀者显示未提供状态；旧受邀者不发选项、行为不变。手机沿用目录清洗但
  本期不增加状态入口。无组的供应商不带状态，不改服务器、relay、数据库或既有 channel 白名单。
- 实现：`provider-group/sharedStatus.ts`、`guestRelay.ts`、`device-link/dispatch.ts`、
  `packages/device-link/src/providerShareCatalog.ts`；回归：`sharedStatus.test.ts`、`providerShareDispatch.test.ts`、
  `providerShare.test.ts`、`SharedProviderGroupStatus.test.tsx`。

## 同账号供应商组：版本与分享兼容提示(2026-10-12)

- 同账号组详情的 view 请求可选带 includeGuestSupport: true，才按现有远程 Agent 能力查询核对能否接收分享任务。
  普通状态与任务分配不增加能力探测，不修改实际分配、冷却或权限。单台查询最多等 3 秒，失败或超时为未知。
- 能力读取器跟随当前账号的组 router 运行期，跨详情刷新、跨组按电脑复用在途查询与 15 秒短缓存，最多 4 个物理在途槽。
  等待超时不释放仍在途的槽，未发出的排队查询到期取消；迟到结果供下一次详情读取使用，避免后续电脑反复排队超时。
  不跨账号复用，不缓存忙闲等组状态，不改变底层 device-link 超时、重连或 wire 格式。回归见 `router.test.ts`。
- 成员状态可选携带 appVersion（不超过 64 字符的应用版本）与 guestSupport（supported / needs-update / unknown）。
  本机版本由应用提供，同账号设备版本复用设备目录；分享来源没有版本则省略。能力按真实声明判断，不按版本号猜测。
- 新端白名单解析；旧组所在电脑忽略选项、未带字段时不推断版本或兼容状态，未知信息放在悬停说明里，旧控制端忽略新增字段。
  成员信息仍只对同账号可读，受邀者匿名状态数组不携带这些字段。异步查询期间换账号或撤销远程调用权限后丢弃回包。
  没有新 channel、服务器改动或数据库迁移。回归覆盖目录、组状态、同账号请求解析及本机和远程两处界面。

## 供应商分享：受邀者自己的运行数(2026-10-10)

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §5「分享来的电脑」与
[`provider-sharing.md`](../product-rules/provider-sharing.md) §7.4。受邀者把分享加进自己的供应商组时，组页面要显示这台在跑几个，
包括本账号不经组直接用的任务。

- **分享投影里的 `maker:provider:list` 新增可选 `guestRunning`**(非负整数，0–4096)：分享者电脑按调用方(同一分享、同一成员，
  不分设备)统计此刻正在运行一轮的远程 Agent 任务，在 `projectProviderListForShare` 里填上(目录里原有的值一律先去掉)。
  任务转给了组内电脑的按那台报来的状态算。只计调用方自己的任务，不含分享者本人(同账号控制端)与其他受邀者。
  `scrubSharedProvider` 在分享者电脑、受邀者电脑与手机各过一遍，只留合理的整数(`readProviderShareGuestRunning`，
  `packages/device-link/src/providerShareCatalog.ts`)。同账号目录不带这个字段。
- 兼容：旧受邀者与手机不认识就忽略；旧分享者不带，新受邀者按经本组的计数显示(与之前一致)。被控端的远程 Agent 服务
  没接上 `turnRunningControllers` 时同样不带。
- 不改 relay、服务器与数据库，不新增 channel。实现：`remote-agent/host/runHost.ts`(`turnRunningControllers`)、
  `device-link/dispatch.ts`(`providerShareGuestRunning`)、`provider-group/directory.ts`(`reportedRunning`)、
  `provider-group/router.ts`(`memberRunning`)；回归见 `device-link/__tests__/providerShareDispatch.test.ts`、
  `remote-agent/__tests__/guestHost.test.ts`、`provider-group/__tests__/directory.test.ts`、`router.test.ts`、
  `packages/device-link/src/__tests__/providerShare.test.ts`。

## 供应商组：同账号电脑上的运行数(2026-10-10)

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §5「本机与同账号电脑」。组所在电脑要显示组里每台
这个供应商实际在跑几个任务，含那台自己用的、不经组的与替分享的人跑的。

- **同账号电脑读的 `maker:provider:list` 新增可选 `runningTurns`**(非负整数，0–4096，`PROVIDER_RUNNING_TURNS_FIELD`，
  `packages/device-link/src/providerGroup.ts`)：被控端在 `decorateProviderListWithGroups` 里给每个允许被远程调用的供应商
  填上这台电脑上用它正在运行一轮的任务数(没在跑的为 0；结果里原有的值一律先去掉；读不到时整个目录都不带)。
  计数(`provider-group/localLoad.ts`)= Agent 在本机运行的本机任务(按任务记录的来源，没记来源的按本机实际会用的来源；
  Agent 在另一台电脑、分享来的电脑或 SSH 主机上的不算) + 远程 Agent 服务在本机运行的任务(`turnRunningProviders`，
  转给组内另一台的不算)。只给同账号电脑：`scrubSharedProvider` 去掉这个字段，受邀者与手机转交的分享目录都不带。
- 组所在电脑读本机的数直接现算，读同账号电脑的从目录取(`readProviderRunningTurns`，只认合理整数)；分享来的电脑仍只认
  `guestRunning`，不认 `runningTurns`。
- 兼容：旧电脑与手机不认识就忽略；旧被控端不带，新组所在电脑照旧只算经本组的。`decorateProviderList` 改为可异步，
  只在本机内部接线，不影响 wire 形状。
- 不改 relay、服务器与数据库，不新增 channel。实现：`remote-agent/host/runHost.ts`(`turnRunningProviders`)、
  `provider-group/localLoad.ts`、`provider-group/remoteHandler.ts`、`provider-group/directory.ts`(`localRunning`)、
  `maker-ipc/register.ts`(接线)；回归见 `provider-group/__tests__/localLoad.test.ts`、`remoteHandler.test.ts`、
  `directory.test.ts`、`remote-agent/__tests__/guestHost.test.ts`、`device-link/__tests__/providerShareDispatch.test.ts`、
  `packages/device-link/src/__tests__/providerShare.test.ts`。

## 供应商组：同账号电脑报告经组的用量(2026-10-11)

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §7。组所在电脑 O 的「用量」块里「自己」要等于全组的总和，
同账号电脑 C 经 O 的组、直接连到组里别的电脑(不是 O 本身)运行的那部分 O 经手不到，由 C 报告。

- **`provider-group:remote` 新增 `action: 'usage'`**(同一 channel、同一同账号 allowlist，受邀者与共享任务访客照旧
  `CHANNEL_NOT_ALLOWED`)：`{ action: 'usage', seq, sinceDay: 'YYYY-MM-DD' | null, rows }` → `{}`。
  - `rows` 每行是数组 `[day, providerId, memberKey, kind, model, turns, inputTokens, outputTokens, cacheReadTokens,
    cacheCreateTokens, sdkCostUsd, lastAt]`，最多 3000 行；供应商与组内电脑都是 O 的坐标(`memberKey` 是 O 组里的稳定键)。
    结构与校验在 `apps/desktop/src/shared/providerGroup.ts`(`parseProviderGroupRemoteRequest`、`providerGroupUsageRowsForWire`)。
  - 语义是整体替换：O 删掉 C 报过的、`sinceDay`(含；null = 全部)起的行，再写入这一份；重复送同一份不多算。`seq` 只增
    (C 以时间生成并以已持久化的上次序号为下限)，同一账号里乱序到达的旧份丢弃；换了账号之后到达的不收。
  - O 丢掉 `memberKey === 'local'` 的行(分到 O 本身的那部分 O 自己记过)；不按此刻有没有组筛，组删了又建时整份报告
    也不会抹掉那几个供应商的历史。
  - C 侧：任务此刻所在电脑与供应商和绑定那台对得上才算经组(绑定没清掉的空档里不报)；每轮记进按账号的账本(`group` 行，
    只用来报告，不算进 C 自己的供应商)，防抖 5s 报从那天起的一份；启动(账号确定)
    后整份报一次补上次没送到的；送不到按 30s 起、最长 10 分钟退避重报，不截断单日或未报告的旧日期。
  - 日期归一：`day` 是报告端本地日期，但接收端按 `lastAt` 在自己的时区重新计算日期；增量请求和替换时各多带两天，
    避免跨时区的午夜边界漏掉或重复历史。
- **超出单次 3000 行或 UTF-8 字节预算时用新动作 `usage-part` 分批传完整报告**：
  - 请求 `{ action: 'usage-part', seq, sinceDay, offset, total, rows }`；每批仍最多 3000 行，整份最多 20000 行，
    同时按实际 JSON 序列化后的 UTF-8 字节数切批（包含转义开销），请求预算取可靠消息/普通帧上限的较小值再预留 64 KiB 给 invoke 头；offset 按实际批次行数推进。
    与按使用方账本的保留上限一致。回包 `{ seq, received, committed }`，`received` 是本批结束的行偏移。
  - O 按账号、报告电脑隔离暂存，每台只留一份；从 offset 0 开始顺序收取，同一份的 seq、sinceDay 和 total 必须一致。
    收齐后才整体替换并登记去重序号。缺批、乱序、暂存过期(10 分钟)或 O 重启都要求 C 从头重报，旧账本不变；
    更新的整份报告可替换未完成的暂存，已提交的旧序号不会重复记账。
  - C 每批发出前重查账号仍有效，回执不足或任一批失败保留重报意图，用新序号从原起始日重新报告；
    故障只作用于这台组所在电脑的这份用量，不重建 link 或 relay，不影响任务及其它控制端。
- **兼容**：
  - 旧 O(认识 `provider-group:remote`、不认识 `usage`)回 `[INVALID_PARAMS] unknown provider group action`，更早的回
    `CHANNEL_NOT_ALLOWED`：C 都按不支持处理，30 分钟后再试，不影响任务；这部分用量在 O 上缺，直到 O 更新。
  - 旧 C 不报：O 上缺这部分，其余照旧。
  - 认识 `usage` 但不认识 `usage-part` 的 O 拒绝新动作；C 按不支持处理并保留完整重报意图，30 分钟后再试，
    不回退成部分 `usage` 报告。行数和字节数都在预算内才继续使用原动作。小报告无需双方同时更新，大报告在 O 更新后补报。
  - `maker:provider:list`、relay、帧限制、服务器与数据库都不变。
  - 降级：已发布的受邀者账本(`provider-share-usage.json`)行键与合计不变，各台组内电脑的分布放在行里的 `byMember`，旧版本
    照常累计合计并原样写回，降级不丢用量(降级期间记的回来后算没区分电脑)。`byMember` 每行保留最多 512 个电脑键；
    满容量后已有电脑继续累计，新电脑只加行合计、查询算没区分电脑；旧文件已超容量时保留前 512 个分布，其余仍计入总量。
    写入、重启和再次落盘都不丢整行分布，回归见 `device-link/__tests__/providerShareUsageStore.test.ts`。按使用方的账本(`provider-usage-by-party.json`)
    还没进正式版：从带这次改动的构建降到它之前的构建时，同一天同模型分在几台电脑的行会合成一行(只剩其中一台的数)，
    `group` / `reported` 行也会被当成「我的其他电脑」，属于已知的降级损失。
- 实现：`apps/desktop/src/main/provider-group/usageReporter.ts`、`usageReportRuntime.ts`、`remoteHandler.ts`(`usage`)、
  `remoteClient.ts`(`usage` / `usage-part`)、`remoteRegistration.ts`，`apps/desktop/src/main/usage/providerPartyUsageStore.ts`
  (`groupReport` / `replaceReported`)，`maker-ipc/sessionProviderPartyUsage.ts`(`groupUsageReportOf`)；回归见
  `provider-group/__tests__/usageReporter.test.ts`、`remoteHandler.test.ts`、`usage/__tests__/providerPartyUsageStore.test.ts`、
  `maker-ipc/__tests__/sessionProviderPartyUsage.test.ts`。

## 供应商组：同账号任意电脑管理(2026-10-14)

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §9.8、§10 与
[`provider-sharing.md`](../product-rules/provider-sharing.md) §4.1 第 4 步、§7.1。同账号电脑 C 管理组所在电脑 O 上的组与分享，
组设置与分享仍保存在 O 上。

- **`provider-group:remote` 新增 `action: 'manage-group'` / `'manage-share'`**(同一 channel、同一同账号 allowlist，
  受邀者与共享任务访客照旧 `CHANNEL_NOT_ALLOWED`)：请求 `{ action, command }`，`command` 与本机命令同构，结构与校验在
  `apps/desktop/src/shared/providerManagement.ts`。`manage-group` 只收 `get` / `candidates` / `save-if-current` / `delete-if-current`；
  `manage-share` 只收 `owned` / `own-usage` / `usage-history` / `create-link` / `approve` / `reject` / `set-member` / `reshare-decide`，其余回
  `[PERMISSION_DENIED]`。回包 `{ result, respondedAt }`，`respondedAt` 只用于把链接有效期换算到 C 的时钟。
  - `usage-history`(2026-10-17，供应商组 §7)：只读，`{ action, providerId }`，回这个供应商用量的按天明细
    `{ providerId, todayKey, coverageStart, self, relays, members }`(结构在 `apps/desktop/src/shared/providerShare.ts`)，
    日期是 O 的本地日期，金额在 O 上估算；`members` 只含 O 上这个供应商的分享里现在的成员。最多 5,000 行，按日期从新到旧
    截取，最新一天允许只保留一部分，再按实际 UTF-8 JSON 字节数裁剪，均用 `coverageStart` 标出保留下来的最早日期，
    整包为单帧 2MB 预留 invoke 信封空间。旧 O 不认识该动作，`parseProviderShareCommand` 回
    `[INVALID_PARAMS] Unknown command`，C 的 Main 把 `manage-share` 的这个回包统一成 `[UNSUPPORTED_CAPABILITY]`(与
    `unknown provider group action` 同一处)，管理页退回 `own-usage` 与 `owned`(range=all)的所有时间合计并提示更新 O，不重试。
    旧 C 不发这个动作，照旧读 `own-usage` / `owned`，O 对两者的回包不变。
  - O 在执行前后核对账号未切换；`approve` / `reject` / `set-member` 先刷新快照，申请或成员不在 O 的分享里回 `[NOT_FOUND]`；
    `owned` 的回包只含 `{ ready, shares }`，不带 O 自己的弹窗安排。不再转发给第三台电脑。
  - `reshare-decide` 只修改 O 当前账号的本机转分享记录，写锁内和返回前继续核对账号边界；撤回由 O 停止对应中转任务。
    旧 O 不认识该动作时明确拒绝，C 不重试、不改为在本机执行；完整转分享管理需要 O 更新。
    远程修改组后由 O 刷新转分享名单，逐人同意明细仍只附在 O 本机设置页的组视图里。
  - C 不重放写请求；生成的链接在 C 的 Main 登记后才能复制。
  - 添加组所在电脑已可用的供应商仍经 `candidates` 查询；受邀者预览和申请不在管理通道内。远程管理页的分享链接入口
    禁用并引导在 O 的模型供应商设置中输入，获批后回到可用列表添加，避免申请与跨区启用记录误落到 C。
  - 组保存与删除必须携带编辑时的 `expectedConfig`（完整组配置，`null` = 当时尚未建组）。O 在已有跨进程文件写锁内
    重读并比较，不一致回 `[PROVIDER_GROUP_CHANGED]`，不写入、不清理任务绑定。C 重新读取详情、提示本次操作未执行，
    不自动重试写入。建组电脑自己的设置页使用同一条件写入，存储格式不变。
    独立动作名保证旧 O 明确拒绝，不能忽略新增条件后无条件写入；新 O 拒绝旧 C 的 `save` / `delete`，回
    `[UNSUPPORTED_CAPABILITY]`。完整编辑需两端更新；只读查询、分享者操作与组的分配使用不受影响。
- **审批弹窗跟着生成链接的电脑**：服务端 `POST /links` 与 owner 列表的每条申请追加 `linkId`（一次性随机邀请口令的
  SHA-256 小写十六进制摘要，不是邀请口令）。O 执行 `manage-share` 的 `create-link` 后，7 分钟窗口内这条链接的新申请在 O 上只推
  `REQUESTED { quiet: true }`(进管理页与提示点，不弹窗、不发系统通知)。O 本机生成链接只清除旧版按供应商静默的窗口，
  保留其它链接的精确归属；C 的关注也按 O + 供应商 + linkId 匹配，不能接管本机或第三台电脑生成的链接。C 在同一窗口内经
  `manage-share owned` 向 O 读取分享申请，不能从 C 的 REST 分享列表找 O 的申请（服务端按当前设备隔离列表）。
  新申请经 `REQUESTED { hostDeviceId }` 在 C 上弹窗，同意 / 拒绝经 `manage-share` 转交 O。
  本机与每台关注电脑各自只保留一个在途读取；一台离线或迟迟不回包时，其他电脑与本机照常继续拉取，不重建 link 或 relay。
  失败或 `ready=false` 不当作空名单清理待审批申请，成功快照只清理对应电脑的申请；账号切换或运行时重建后的旧回包作废。
  同账号重连保留窗口期内的关注与去重状态，即使 C 本机没有分享也继续拉取。
  归属按账号保存，完整进程重启时在第一轮快照之前恢复；旧版无 linkId 的关注只接无标识的旧申请。
  这两个字段只在本机 Main → Renderer 之间，不跨设备；本机 `owned` 结果另带 `quietRequestIds` / `watchedRequests` 供审批宿主重载时使用。
- **兼容**：旧 O 回 `CHANNEL_NOT_ALLOWED` 或 `[INVALID_PARAMS] unknown provider group action`，C 显示「建组电脑需要更新」，
  不影响组的分配与使用。旧 C 不发这两个动作，仍只能只读查看。O 只在执行过 `manage-share` 的 `create-link` 后才静默，
  旧 C 管不到 O，弹窗行为与之前相同。linkId 是 additive 字段，旧客户端忽略；新客户端本机生成及读取仍接受缺字段的旧服务端。
  跨电脑生成必须收到合法 linkId，O 在返回/登记链接前检查，C 在保存关注/登记复制前再次检查；缺字段回
  `[UNSUPPORTED_CAPABILITY]` 提示更新，非法字段拒绝，不回退到按供应商关注，不重放写请求。服务端先部署到供应商所属区域
  的全部副本，再发布客户端；完整精确归属要求 O、C 都更新。服务端仅返回已有摘要，无数据库 migration、鉴权或 relay 帧变化。
  本机绑定的可选解除记录见上方 P2a「本地数据」。
- 实现：`apps/desktop/src/main/provider-group/management.ts`(O)、`managementClient.ts`(C)、`remoteRegistration.ts`，
  `apps/desktop/src/main/device-link/providerShareHost.ts`(静默与关注)、`providerShareRuntime.ts`；回归见
  `provider-group/__tests__/{managementClient,ipc,stores}.test.ts`、`device-link/__tests__/providerShareRuntime.test.ts`、
  `renderer/features/provider-share/__tests__/ProviderShareGlobalHost.test.tsx`、`providerShareFormat.test.ts`。

## 事实来源

| 内容                     | 权威来源                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| hook 双工任务协议        | 客户端 `packages/slack-hook-protocol`；服务端仓同名本地 package，desktop hook-control 与 slack／telegram／x hook server 分别消费本仓实现                                                   |
| device-link relay 层定义 | 客户端 `packages/device-link-protocol`；服务端仓同名本地 package，客户端重连、IPC allowlist、隧道 payload 在 `packages/device-link`                                                        |
| Plugin 交付与 manifest   | 客户端 `packages/plugin-protocol`；服务端仓同名本地 package，desktop、`packages/cindy-tools` 与 plugin-server 分别消费本仓实现                                                             |
| 模型目录                 | 客户端由 `packages/model-providers/src/modelAccessBean.ts` 与 `modelAccessValidator.ts` 维护；model-access-server 在服务端仓维护对应 Bean／validator，双方只共享稳定 wire 语义，不共享实现 |
| Skill Hub                | Desktop 的 `apps/desktop/src/main/skillhub` 与 `shared/skillhubCatalog.ts`；服务端仓 `packages/skill-hub-protocol` 与 `cindy-skill-hub-server`                                             |
| 插件来源                 | 客户端不预装插件；一律通过 SkillHub 或用户手动安装 `.cindy` 包                                                                                                                             |

## 1. 两仓本地协议演进

### 官方 Telegram 进度消息由客户端渲染（`telegram-progress-ops-v1`）

双向能力，只在 telegram 连接上声明，且必须与 `msg-op-v1` 同时协商。协商后桌面端用与个人
bot 同一份过程载体与渲染（见 `docs/product-rules/telegram-bot-parity.md` 第一节）经
`msg.op` 驱动进度消息；服务端只执行，`turn.progress` 照发但只用于续 lease（私聊草稿模式
例外，仍由服务端按 `turn.progress` 出草稿）。全部为可选字段增量：

- `MessageOpPayload.purpose?: 'turn-progress'`：有它时 `requestId` 必填，只用于
  `send` / `edit`（parse 强制）。服务端据 requestId 核验设备归属，把新消息登记为该轮进度
  消息，终稿后照旧清理；本轮不归客户端承载或已收口时回 `PROGRESS_UNAVAILABLE`。
- `MessageOpResultPayload.errorCode?: string | null`：服务端自判拒绝码（开放集合，常量
  `MESSAGE_OP_ERROR_*`）；`channelErrorCode?: number | null`：Telegram 原生 error_code
  原样透传，`error` 放渠道原文。
- 幂等：服务端按 opId + 内容指纹去重；回执未知（含 `OUTCOME_UNKNOWN`）时客户端原样重发
  同 opId 同正文，不换号、不换正文。服务端有应答时只回显原结果；也没有应答时每个 opId
  只重新执行一次，之后回显缓存的 `OUTCOME_UNKNOWN`。卡片与终稿段最多原样重发 2 次，仍未知
  就放弃（终稿以 `clientFinal.complete=false` 交回）；进度首帧每个节流窗口重发一次。

任一侧缺席时行为与本能力出现前逐字相同；无数据库迁移、Mobile 冷更或部署顺序要求。实现见
`hook-control/telegramTurnCarrier.ts`、`telegramMsgOp.ts` 与
`packages/lizi-im/src/telegram/outboundPolicy.ts`。

同一轴上另有三个独立协商的能力（都要求同时协商 `msg-op-v1`，任一缺席该段照旧由服务端
渲染）：

- `telegram-final-ops-v1`：普通成功轮次的终稿经 `purpose: 'turn-final'`（`send` 带
  `finalPart`；协议形状仍允许 `media`，但服务端一律拒收，桌面端也不发：带附件的轮次整轮随 `turn.end`
  交给服务端，因为持久出箱只存终态文本，本端上传附件中途退出会丢附件）发布；
  `TurnEndPayload.clientFinal?: { complete }` 告诉服务端是否全部确认。complete 时服务端
  不再渲染、提升续跑锚点并做收口副作用；否则删掉已落地的客户端终稿段并照旧自己发布。
  私聊草稿模式下服务端对终稿 op 回 `TURN_UNAVAILABLE`（终稿随草稿通道由服务端发布），
  桌面端按停手码交回。桌面端发布前先把不带 `clientFinal` 的 `turn.end` 写进持久出箱，
  崩溃重放走「交回服务端」那一版，终稿必达不降级；本进程仍在发布时重连不重放这份兜底帧。
- `telegram-card-ops-v1`：执行中交互卡经 `purpose: 'interaction-card'`（带
  `interactionId`；收口 `edit` 带 `interactionClosed` 并清空按钮）发布；按钮 token 即
  buttonId，回调仍由服务端转成 `interaction.decision`。协商后桌面端不再为这类卡发
  `interaction.request` / `interaction.cancel`，op 被明确拒绝时才回落旧帧。
- `telegram-commands-v1`：新增 `provider.commands.set` 帧（默认菜单有且仅有一份，
  command / description 遵守 Telegram 限制），服务端执行 `setMyCommands`；只管理默认菜单与
  `zh` / `ja` / `ko`，每次全量重写，其它语言码（含显式 `en`）忽略。菜单只存服务端
  内存、不落库：desktop 每次握手重发，服务端重启后到桌面重连前用服务端默认菜单。

新增拒绝码 `TURN_UNAVAILABLE`（终稿 / 卡片 op 时这一轮已收口或不属于该设备）。`msg.op`
各 purpose 允许的动作与附属字段由 parse 强制联动，放错位置一律拒收。

### X 回复链的结构化输入

服务端负责 X 事件、账号绑定、真实回复链读取与预算、可靠派发和回传；Desktop 的
`hook-control/xPrompt.ts` 负责模型提示词格式。可选 `source.xContext` 提供
`requesterId`、`requesterName?`、`truncated`，`threadContext` 沿回复顺序排列并包含
链尾当前消息；各条可选 `messageId / replyToMessageId / authorId` 记录平台事实。
`triggerMessageId` 对应末条，`userText` 为完整请求正文，不含模板说明。

新客户端在展示元数据截短前校验当前消息身份及相邻回复关系，并组装一次模型 prompt：
顶部请求者、按序历史、链尾当前请求。沿用历史随机栅栏、逐行作者与缺失提示；排队及恢复
直接复用已组装结果，不重复拼接。展示沿用原有有界快照，不拿其截短正文重建模型输入。
X 快照有请求正文时，按原始 triggerMessageId 排除引用列表中的当前请求，避免与卡片正文
重复显示；模型组装仍读取完整 wire 回复链。旧条目缺少消息 ID 时保留，不按正文猜测去重。
这里只改变每条消息的文本组装与展示元数据，不修改主 Agent system prompt、权限或 UI 结构。

新服务端继续发送兼容 `prompt` 给旧客户端；新客户端遇到旧服务端、旧持久任务或不完整
结构化字段时原样使用该 prompt。两仓可独立升级，无数据库迁移、Mobile 冷更或部署顺序要求。
服务端兼容模板不再是新客户端格式的正本。

- 两仓同名协议 package 是各自消费者的本地实现，不允许跨仓源码 import、Git submodule 或
  运行时共享依赖。客户端重连、IPC allowlist 与隧道 payload 留在
  `packages/device-link`，不在客户端另造一套协议。
- append-only、带旧端降级路径的兼容变更允许客户端和服务端分阶段升级；只有实际使用新
  字段、消息或校验能力的消费仓需要发布。
- 不兼容 wire 变更、device-link 新增 relay kind 等必须声明升级窗口，并协调所有相关
  消费方；不能把“两仓独立发布”误读成允许单端改变既有字段语义。
- 改动一端协议实现时必须核对另一端同名实现和消费者。需要相同约束的 parser／validator
  应在两仓分别落地，并用相同的有效／无效 fixture 覆盖边界。
- 新业务域的契约优先放进所属业务仓库；不要建立新的公共协议仓来重新引入发布耦合。

### Skill Hub 目录与管理契约

- 原作者发布更新比较：服务端摘要新增可选 `isCreator`，仅表示当前成员是原始上传者，
  独立于组织归属 `isMine` 和管理员管理权 `canManage`。Desktop 自动提示只使用
  `isCreator === true` 的新鲜服务端结果；缺字段、离线、摘要不完整均为未知。
  `GET /skills/:slug/files?version=...&includeHashes=1` 需认证及该 Skill 的管理权，
  返回每个文件原始字节的可选 `sha256`；普通 files 请求保持原预览结构。
  `fileHash` 仍是 ZIP 校验和，绝不作为本地 `folderHash`。
  新包在校验时写入现有 release.fileIndex；历史包按需校验不可变 ZIP 并回填 JSON，
  不改数据库 schema、版本或下载计数。两仓分别保留同名 `published-content.json`
  fixture，覆盖文本、二进制、空文件及 ZIP 元数据变化。
- Desktop 的 `skillhub:compare-published` 只开放给受信任的本地 Renderer，
  Main 从发送窗口的最新扫描记录解析路径、slug 和 catalog，不接受 Renderer 指定远端
  身份；读取前后复核账号代次、项目授权和目录身份，不扩展 device-link allowlist。
  比较遵循现有打包排除规则，包含 SKILL.md 的 version 字段；2,000 文件限额只计算
  实际打包的普通文件，不计目录和符号链接。审核中优先比较已提交版本，Main 与 Renderer
  共用 `skillhubPublishedStatus.ts`，统一识别机审、人工审核、隔离及历史状态别名。
  公开目录仅以已有列表版本判断下载更新，不逐项比较发布内容。本地列表先以批量同步确认
  原作者；本地列表和详情在进入、切换及回到窗口时复用同账号 30 秒内的比较结果，
  本地写入主动失效对应 Skill 缓存，最多并行 3 个比较，离页取消未开始的请求，无后台轮询。
  `unavailable.reason` 可选为 `service`，仅用于 Main 确认的网络失败、408、429 或 5xx；
  此时同账号队列冷却 30 秒，之后在下一次进入/聚焦时重试。缺字段、本地读取、摘要或身份
  失败只影响该 Skill，本地修复/保存立即清除其缓存，不阻塞其它 Skill。
  冷却仅影响发布差异提示，不停用列表、编辑、下载或手动发布能力。
  差异预览锚定线上具体版本；二进制、大文件或无法完整校验的文本仅展示变更和大小，
  文本预览总计最多 4 MiB、单文件 1 MiB、远端预览最多 16 次。更新仍复用原发布审核流程，
  下载覆盖仍复用用户确认和备份。新旧两端可分别升级，旧端缺少摘要时不推断相同或不同。

- Desktop 本地技能管理用扫描条目 `id` 区分不同 scope / 项目中的同源记录；启停与卸载
  的本地 IPC 可选携带 `skillId`，Main 同时匹配路径、当前发送窗口的扫描记录和项目授权，
  缺省字段保留旧调用行为，不向 device-link 新开放管理能力。启停偏好仍按物理身份共享；
  `activation-preferences.json` 的可选 `discoveryPaths` 按物理路径保存已扫描的绝对发现
  路径数组，可选 `revisions` 记录每次停用意图的代次；缺省兼容旧偏好。卸载清理只在
  设置锁内匹配原代次及入口快照后清除旧偏好，不覆盖后续启停。启动时复核指向，启用时
  删除该身份的入口记录，重命名时
  同事务迁移到新入口。活动任务在启动时另存规范化物理身份快照，菜单过滤不重新解析
  停用别名；同时冻结词法入口到物理身份的映射，在写原生配置前剔除改指向的入口，
  使原生停用目标与菜单快照一致。插件托管技能只能在所属插件管理，详情禁用开关，Main 拒绝独立启停。
  卸载由 Main 原生确认框授权，默认取消；确认后再次核对发送窗口、账号、项目与文件
  身份，导航或身份变化撤销确认。同一窗口最多一个待确认卸载，取消不产生文件或注册副作用。
  物理卸载的清理快照汇总已扫描 scope 的同源发现链接，外部导入只移除所选 scope 的入口
  与对应词法注册记录，不追加其它范围的全局候选。斜杠详情路径携带 scope 与工作目录，
  同源多副本按范围和最近项目匹配；旧路径无法唯一消歧时不任意选择副本。SkillHub
  项目目录包含置顶任务和已创建但尚未发消息的项目任务，不沿用侧栏的展示排除规则；
  仍只扫描本地目录，并由 Main 的项目目录白名单复核。
  worktree 同时保留分组后的基仓与任务实际 cwd：分组路径只作目录归并，不能代替
  原生技能发现路径。Renderer 项目目录和 Main 白名单使用同样的两组路径，排除远程任务。
  扫描结果可选携带按物理路径关联的 `registrySkillName`，市场详情按此原始注册 slug
  与 catalog scope 匹配；批量 sync 的生产方与 registry 回填消费方同样使用此键，
  保留实际目录名用于本地展示。更新同一 catalog 的 published 注册记录时保留该来源身份，
  仅刷新下载版本和内容基线；切换 catalog 安装则记录新的 catalog + installed 来源。
  authorId 与 Hub 摘要保持相同 owner slug，不把组织 ID 替换为当前成员 ID。未注册或旧扫描缺少该字段时，
  只按精确名称匹配，不用大小写折叠推断两个目录属于同一市场技能。
  源目录形状不能单独证明归属：同一分组必须有直接、非符号链接的发现入口，才可按独立
  实体卸载；检查覆盖入口、发现根及引擎配置目录各级，拒绝其中的符号链接，保留发现
  布局以上的已跟踪项目别名兼容。外部入口移除及清理重试保留源文件和按物理身份共享的
  停用偏好。安装、学习、导入、重命名及卸载共用小写归一的名称锁，一次操作的多个锁名
  按相同规则去重；大小写敏感卷上的同名大小写变体也保守互斥。
  名称锁之外，安装、学习、导入、重命名、卸载及清理重试还持有跨进程 lease：复用现有文件锁协议，
  在 Electron `appData/Cindy/shared-skill-mutation-locks` 下按归一名称的哈希共享锁文件，
  不随正式版/dev/isolated profile 的 userData 改变。名字相同但目录不同也保守串行；
  导入别名、重命名等多名称操作按同一顺序获取，拿不到锁不变更文件。卸载覆盖物理源名
  及清理快照中每个发现别名；执行中的短期 lease 持有到本次清理尝试结束，未完成时以
  `pending/<名称哈希>/<token>.json` 持久屏障继续阻止冲突写入，直到清理完成。进程退出
  只回收短期 lease，不删除屏障；屏障只存操作 token 和名称哈希，不存用户路径或账号。
  锁只协调采用此协议的 Cindy 实例，不约束外部 CLI。
  后台扫描补链、孤儿注册清理及原生发现根的补链/断链清理也必须参与同一 lease，
  并在锁内重验注册快照及源/入口文件身份，不能根据锁外扫描结果直接写入。安装、
  导入、学习流程中的嵌套补链只复用当前异步调用链仍有效的 lease，释放要等借用者结束；
  独立窗口及释放后的迟到回调必须重新获取，拿不到锁的维护留待下次扫描。
  卸载持锁后的快照包含每个已知 scope 的同名兼容入口，覆盖 UI 扫描后刚完成的补链。
  自动同步的取消/失效清理同样获取 lease；锁被占用时交回既有重试流程，不当作清理成功。
  卸载在改动前将身份及副作用快照写入当前 profile 的 `skillhub/uninstall-cleanups`，
  先写回执、再建立屏障、再移到回收站；恢复不重放回收站操作，只按旧入口与目标身份逐项
  清理。注册记录在注册表锁内比较旧快照，来源恢复或替换时保留其链接、注册与偏好。
  清理完成状态必须先落盘，随后才移除屏障及回执；最终删除失败只重试收尾，不重放清理。
  窗口导航/关闭只撤销授权，不删除回执。`skillhub:scan` 可选返回当前 profile/data owner
  的 `pendingCleanups: [{ token, name }]`，并向当前窗口重新发放重试授权；不同窗口互不
  覆盖授权。此字段不开放远程管理能力。
  卸载遇到目录大小写变体时按实际文件身份匹配清单，并使用清单原始名称清理记录及自动同步偏好。
  原子编辑的 `*.xdt-tmp` 和重命名的 `SKILL.md.xdt-rename-<UUID>` 是内部保留文件，
  共用 `packageIgnore` 从浏览、哈希、发布快照与 ZIP 中排除；即使备份清理被文件锁阻止，
  也不得上传旧内容，不因清理失败回滚已经提交的重命名与偏好。
- `scope=market|team` 是公开与组织目录的通用读取上下文；列表得到的 scope 必须贯穿详情、
  文件、版本、扫描、下载、Learn 和批量同步。同 slug 在不同 scope 下是两条独立远端记录；
  但全局 Skill 发现路径仍按 slug 只有一个安装槽，自动同步配置重复同一 slug 时由首个有效项
  选定该安装槽的目录来源，不得尝试把两个 scope 同时安装到同一路径。
- Desktop 与 Mobile 的 `/learn hub:<slug>` 兼容语法统一归一为 `market`；目录来源明确时使用
  `/learn hub:<scope>:<slug>`，并把 scope 原样传入 Learn 请求和后续文件读取。
- 单条详情、批量同步等原生管理读取省略 scope，不得把省略值当成 `market`。本地 registry
  对已发布旧版客户端遗留且缺少 scope 的安装记录一次性回填为 `team`；新记录显式保存
  来源目录，原生管理记录则以逐条迁移标记保留缺省 scope。迁移状态不得只存在 manifest
  顶层，否则降级客户端新增的无 scope 条目在再次升级时无法被识别。
- `isMine` 表示归属当前个人或组织，逐 Skill 写权限只看服务端 `canManage`，客户端不得用
  账号级写能力与 `isMine` 推导管理权。
- 发布版本的 `/versions` 条目和 `/scan?version=...` 响应可附带 `rejectionReason?: string`。
  该字段由服务端按既有 `canManage` 授权，仅返回被拒版本的原因；客户端按目标版本展示
  人工反馈，并保留独立的自动扫描详情。旧服务端缺少该字段时继续展示状态与扫描结果，
  旧客户端忽略新增字段；与 `visibilityReview.reason` 的公开可见性审核含义互不替换。
  手动查看拒绝原因按当前拒审版本请求原生 `/scan`，版本、管理权限或账号代次变化后
  丢弃迟到响应并隐藏旧反馈；发布轮询绑定启动时的账号代次，在账号切换期间或代次
  变化后停止请求与事件派发，不能将前一账号的审核反馈带入后一账号。
  `/scan` 与 `/versions` 的 Desktop IPC 同时校验可信顶层 sender、参数类型／长度／目录枚举，
  并在账号切换后丢弃在途响应。人工拒审原因只对应原生 `rejected`；`failed` 的处理失败和
  旧扫描状态 `blocked` 不代表人工审核拒绝，不应套用人工反馈文案。
  市场预览中可管理的拒审或处理失败版本也省略目录 scope 走原生管理读取；目录读取仅开放已批准
  版本，普通目录扫描仍保留原 scope。发布进度推送逐帧验证接收窗口为可信应用页面，
  不向辅助窗口或已导航到外部内容的窗口发送私有反馈。
  推送附带可选 `ownerStamp`（复用 `DataOwnerPushStamp`）；接收端同时校验 Skill 和账号代次，
  丢弃已在 IPC 队列中的旧账号事件。弹窗在异步刷新后及交付结果前再次校验账号代次。
  整次发布在首次异步身份读取前捕获发起账号代次；提交成功后的本地对账保留成功语义和
  原发布者身份，但过期发布不再派发进度或启动轮询，也不能停止新账号已启动的轮询。
  进度回调与 IPC 标记之间同步复核发起代次，不能给旧发布重新标上当前账号。
  认证区域变化也是代次边界，即使 membership ID 相同：显式登录、恢复和运行期刷新
  均推进 owner generation，主实例与共享 userData 的被动实例一致；同区域普通刷新不推进。
  区域、令牌与代次同步提交时立即发送新认证快照，不等后续迁移或投影收尾的 await；
  即使同 owner 的稳定投影不进入 teardown 边界，新区域请求返回前也已发布新代次。
  显式登录的主实例先清理上次登录的灰度标记，再提交并推送新认证快照；被动实例
  继续只读共享配置，不替其他实例清理持久标记。
  因此现有请求 scope 与推送 stamp 即可拒绝旧区域反馈，无需修改 wire 字段或持久账号键。
  已打开的自动结果也保存 owner snapshot，在新代次的首次渲染中隐藏旧反馈；同 ID
  跨区域切换不依赖按 dataOwnerId 重挂路由，普通同代次刷新仍保留当前结果。
  发布弹窗同样绑定打开时的账号代次；跨代次立即隐藏并关闭，旧发布 IPC 的成功、失败、
  异常返回和等待中的提交／取消确认均失效，不能让新区域的弹窗进入旧发布的扫描阶段。
  本地改名在 IPC 入口捕获完整账号 scope，在扫描授权等待后及持有文件锁实际变更前
  复核；旧代次不能写盘。已经提交的改名仍是有效本地事实：同本地 owner 跨区域时，
  仍挂载的详情页保留并交付新路径（包括迟到的成功回执）以修复导航，但不继续旧发布；
  不向不同 owner 或已经卸载的详情页交付，刷新导航期间也复核本地 owner。
  旧接收端忽略新增元数据，旧的无标记事件沿用现有兼容读取；首次发布的同版本拒审例外
  仅适用于 `rejected`，不能把处理失败 `failed` 或旧扫描失败 `blocked` 套进该例外。
  人工拒审原因缺省时始终明确提示缺省，即使已有自动扫描失败项；扫描发现继续独立展示，
  不能替代审核方提供的拒绝原因。管理读取失败版本不会改变其原始状态或套用人工拒审文案。
  `/scan` 读取失败与“已拒审但未提供原因”分开：详情和预览均回退为状态暂不可用，
  不因请求失败合成 `rejected`；成功读取的旧记录仍保留真实状态与缺原因提示。
- Skill 标签全部由 Platform 管理；客户端通过 Skill Tab 已有的 `/categories` 能力获取可选标签，
  发布和编辑时只在兼容字段 `tags: string[]` 中提交已存在的稳定 slug（可为空数组），不提交标签名称或多语言内容。
- 服务端返回的 `tags` / `categories` 字段继续保持 wire 兼容，客户端不得再引入作者标签语义。
- Cindy Skill Hub 客户端与服务端在首次对外发布前同步收紧以上契约，不为未发布过的中间
  协议增加 fallback；已经发布的旧客户端仍使用原有 XD Skill Hub endpoint，不受此契约影响。

## 2. 插件来源

- 客户端不包含内建插件种子，不在安装包中预置插件，启动期也没有播种
  （provisioning）逻辑。
- 插件运行时保留，用户通过 SkillHub 或手动安装 `.cindy` 包；没有任何插件时启动和
  开发不应因此失败。
- 不要重新引入预装／播种机制或私有种子 submodule；需要推荐插件时走 SkillHub 的
  分发与用户主动安装流程。

## 预创建 worktree 的终止确认

同账号设备互联新增 `worktree:cancel-precreated`，参数仍为 `sessionId` 加 `path` 或
`recoveryKey` 二选一，成功回执沿用严格的 `{ discarded: true, branchDeleted?: boolean }`。
主机在与创建共用的任务锁内检查任务归属，再按创建 ID 持久标记取消、回收未认领目录。
迟到的 worktree 创建和任务启动均检查该标记；有内容改动、运行时占用或真实任务时仍保留。

Mobile 对所有预创建恢复记录（含未收到创建回包的 `reserved`）只接受此终止确认，不用一次 `NOT_FOUND` 授权
旧式删除。旧主机拒绝未知 channel 时保留记录，不回退 `discard-precreated`；旧控制端
继续使用原 channel。完全恢复需要两端均更新，服务端与 Mobile 原生配置无需改动。
恢复仅作用于该任务 ID，不重启 peer 或共享 relay，也不将创建请求加入自动重放。
终止确认后先持久保存草稿的取消状态和原项目目录，再删除回收账本；再次提交使用新任务 ID。
手机发件箱保留原持久键与附件目录，只原子替换记录中的远端任务 ID，写入失败仍可恢复原草稿。

## 3. Ghost manifest 与 Cindy 专属界面能力

- `ghost.json` 的跨消费者字段、v2 兼容映射与枚举属于 Ghost manifest 协议，客户端正本位于
  `packages/plugin-protocol/src/manifest.ts`；Desktop 在
  `apps/desktop/src/shared/ghost.ts` 维护运行时 validator。除明确登记的 Desktop-only
  能力外，两份实现及相同的有效／无效 fixture 必须同步，作者契约同时写入
  `FORGE_GUIDE`。
- `mainView` 是通用的 Cindy Host 界面能力，不是 `xd-sites` 专用 API；v2 的 `main-view`
  只保留输入兼容。协议中不出现 `xd-sites` 的端点、OIDC 流程或业务模型。具体插件可通过
  其它已声明且经运行时守门的能力调用自己的服务，基座只负责声明校验、导航和沙箱承载。
- `mainView.icon` 是主视图入口的 Host 系统图标枚举，只作用于该入口；根级 `icon` 仍是插件
  品牌图片协议。字段白名单、默认回退与完整枚举见 `FORGE_GUIDE` §4.20，不能用图片路径或
  未声明别名绕过枚举。
- Plugin Market、仓库 CI 与 Desktop 不得用当前 Host 能力清单拒绝未知扩展字段、
  能力动作或订阅事件；未知声明保留为数据，由实际运行客户端决定是否支持。
  已知字段形状、安全路径和整体协议格式仍须校验。新增能力不要求发布入口先登记；
  只有改变既有字段结构或安全语义时才需要协调协议升级。
- 插件必须检测接口并处理不支持响应，局部降级或提示升级。`minCindyVersion` 不能替代
  这些处理：手动导入、旧版或其它安装渠道仍可能将包交给不适配客户端。

## Review 清单

1. 改动是否触及跨端 wire protocol？是兼容独立升级，还是需要协调窗口的不兼容变更？
2. 两仓本地协议实现是否保持兼容，旧端降级行为与分阶段发布顺序是否明确？
3. 是否把本可归属业务仓的代码放进协议 package，扩大了不必要的耦合面？
4. 客户端是否在 `packages/device-link` 之外另造了协议或绕过 relay 层定义？
5. 插件能力是否通过 `.cindy` 包和 SkillHub／手动安装分发，而不是重新引入预装、播种或
   绕过插件权限边界？
6. 修改 Ghost manifest 时，协议正本、Desktop 镜像、`FORGE_GUIDE` 与相关测试是否同步？
   若服务端严格校验该字段／枚举，发布顺序是否已协调？

协议改动按 [`desktop-development.md`](desktop-development.md) 跑相关测试，并与服务端确认
兼容。

## Model Registry V3：权威协议与旧端下发

- 权威协议位于 `model-registry.json` 的逐模型 `nativeApi`，与窗口、参考价和输出上限同目录维护。`nativeApiRules` 仅按指定 providerId + modelIdPrefix 覆盖未来家族成员；精确声明优先，显式 null 表示待核实，退役项禁止继承家族规则。跨厂商不根据同名猜测。
- 新客户端请求 `/api/model-catalog/catalog?registrySchemaVersion=3`。V1/V2 继续可读；Server 任意版本缺少某条原生协议时，使用 Cindy 本地声明。V3 的明确协议修正、显式 null 与退役优先；删除字段或遗漏规则不再清空本地协议知识，撤销须用精确条目的 null／retired 表达。仅原生协议作此字段级补全，价格、窗口、可用性与完整目录的 revision、LKG、冲突拒绝仍用既有策略。
- Server 支持 V3 后，仅给明确请求 V3 的客户端返回 nativeApi/nativeApiRules；无参数／V1／V2 请求必须返回旧版本并去掉新字段，ETag 按实际响应格式隔离。不得直接把 V3 制品目录原样发送给旧客户端。
- UI 的 CatalogModel.nativeApi 是主进程按实际 provider/model 投影的结果。Pi 的 piApi 是执行配置，不能反过来当作模型原生协议。界面只展示简短的协议名、原生支持／兼容模式，不展示目录实现与抓包说明。
- 默认开关按原生协议与 Harness/出站协议比较：兼容路径默认关闭；已有用户显式偏好优先。逐引擎服务端显式 defaultEnabled 保留策展覆盖能力。Google 原生模型推荐 Pi，Messages 推荐 Claude Code，Responses 推荐 Codex，Chat Completions 推荐 Pi；推荐必须在可用候选内。
- 此客户端改动不代表 Server 已部署 V3。发布目录前须验证旧客户端降级、新客户端 V3、更新/撤销/冲突与相应 ETag 四项；不能只修改 bundled 数据宣布线上生效。

### Cindy 本地协议声明的维护（2026-09-05）

`packages/model-providers/catalog/model-registry.json` 的 `nativeApi` 与 `nativeApiRules`
也是客户端执行策略的本地基线，不依赖 Gateway 提供原生协议。Pi 的
`catalog/provider-models.json` 和官方运行时内置模型表用于核对协议及 serializer 参数；
核实后写入 Registry，不在 UI 中反推 Pi 配置。Gateway 的 `perAgent.pi.wireProtocol`
仅是末级执行提示，不能覆盖本地已声明的原生协议，也不能填充 UI 的原生协议字段。

| 已核对的本地模型家族      | Cindy 原生协议基线 | 本地参考                                                  |
| ------------------------- | ------------------ | --------------------------------------------------------- |
| Claude、MiniMax           | Anthropic Messages | Pi 原生 provider 表、现有 Cindy 直连配置                  |
| GPT、Grok                 | OpenAI Responses   | Pi 原生 provider 表、现有 Cindy 直连配置                  |
| Gemini                    | Google Gemini      | Pi 原生 Google provider 表                                |
| DeepSeek、Qwen、Kimi、GLM | Chat Completions   | Pi 本地目录对应 provider；不使用同名聚合商条目            |
| 腾讯 HY                   | Chat Completions   | Cindy 原有 HY3 协议声明；Pi HY4 的协议记录交叉核对        |
| Muse Spark                | OpenAI Responses   | Cindy 原有 Muse Spark 1.2 声明；Pi 同型号协议记录交叉核对 |
| Muse Wonder               | OpenAI Responses   | Meta Model API 官方模型页，与 Muse Spark 同用 Responses   |

新增家族规则仅匹配指定 provider 路由与命名空间，不能扩到任意 BYOM 或同名聚合商。
精确条目可覆盖家族规则。当前本地维护的 Registry 条目均有显式协议声明；
Seed 2.1 Pro 按火山方舟官方示例选择 Chat Completions 为 Cindy 的标准接入协议，
依据与全路由覆盖验收见 model-catalog-maintenance.md。
价格、窗口、推理档位不随此次协议补全修改；协议默认开启策略仍保留用户显式覆盖。

### 远程桌面虚拟显示尺寸回执

`viewerDisplay` 成功响应可附加 `viewerDisplayRequest: { width, height }`，回显本次请求。
`display.width/height` 始终是系统实际逻辑尺寸，用于画面与输入坐标；macOS 可能选择同一比例的较小逻辑模式。
客户端仅在回执匹配请求、实际尺寸为有效整数且比例一致时接受这种差异，仍校验 lease 与控制状态。
缺少回执的旧服务端保持原来的精确尺寸判断；显式 `resolution` 模式不放宽。
旧客户端仍可处理原来成功的精确尺寸响应；系统调整后的尺寸需要控制端和被控端同时更新。
不修改请求格式、relay、IPC allowlist 或协议版本。

## 伙伴公开生成状态

`SessionActivityPayload.workingPhase` 与 Remote Resource `display.generation`
（`phase` / `startedAt`）为可选、瞬时的公开生成类别，不包含 assistant 旁白、工具参数或推理。
生成结束、等待交互或失败时撤掉生成状态；头像连接状态仍由设备目录和连接层判断。
列表失效沿用 `maker:remote-resources:changed`，未打开聊天也能重读当前状态；不新增 relay
消息或权限。各端文案沿用已有 `working:<botId>/<phase>` 只读资源和宿主按轮次、语言共用的
润色缓存。未知类别显示本地通用生成文案；缺字段的旧主机仍走原有摘要/公开阶段回退。
旧控制端忽略新增字段，普通聊天不受影响。完整的列表状态一致性需主机和控制端均带此改动；
服务端无需升级，移动端无原生 fingerprint 变更。正文过滤仅影响伙伴视图，不删除持久消息。

`compacting` 是上述公开阶段的一员，由运行时 `Compacting...` / `Compacting context…`
状态触发，`compact_boundary` 或恢复生成结束它；不读取压缩摘要。该阶段使用客户端固定的
“正在整理对话…”本地化文案，不走模型润色，仍沿用原有文字切换节奏。

## 伙伴通知深链

手机推送 `deepLink` 仍是 `/sessions/<sessionId>?deviceId=<hostDeviceId>`。会话属于伙伴的
canonical 主任务时，宿主额外追加 `resourceCollectionId=teammates&resourceId=<botId>&resourceKind=bot`，
与伙伴名册打开聊天时的路由参数相同：手机据此按伙伴聊天呈现（伙伴页头、导航与已读），并继续做既有的
会话来源与主机校验；这些参数不授予任何权限。已发布的手机版本本来就识别这组参数，不需要升级；
不识别它们的旧控制端仍按普通任务打开。拼接后超过 `NOTIFY_DEEP_LINK_MAX_LENGTH` 时回退为原深链。
委派的独立 Session 任务和普通任务不带这组参数。不修改 notify 帧结构、relay 或协议版本。

## 伙伴群聊手机端（Remote Resource 与群推送深链）

群聊以新的 Remote Resource collection `bot-groups`（`resourceKind: bot-group`，无 placement）接入控制端，
列表项的 `links` 以 rel `member` 指向 `teammates` 中的成员。新增可移植原语 `bot-group-chat`：主机只对声明它的
控制端在 `get` 中输出该块，`data` 为 `@cindy/maker-shared/botGroupChat` 的 `BotGroupRemoteChatData`
（主机路径置空，只给文件夹名）；未声明的控制端只拿到 `markdown` 块的可读摘要。动作 id 见同文件
`BotGroupRemoteActionId`，被拒时以群聊错误码作为 registry 错误 message。变化沿用
`maker:remote-resources:changed`（collection + 该群 ref）。

分工停下时的手机推送沿用 notify 帧与 `session-needs-reply` 类别，深链为
`/companions/groups/<groupId>?deviceId=<hostDeviceId>`，`collapseId` 为 `(设备, 群)` 摘要。旧手机不识别该深链，
点开只进入 App；旧主机没有该 collection，新手机不显示群聊入口。未新增 channel、allowlist、relay 类型、
notify 类别或协议版本，服务端无需升级；Mobile 无原生 fingerprint 变更。

群附件按字段追加演进：`send` 动作的 input 可选携带 `attachments`（与会话消息相同的上传引用形状，
`cindy-peer-attach://` / `cindy-oss-attach://`，最多 20 个）；主机只接受该手机自己的上传，不接受主机路径。
消息追加 `attachments`（图片给 `cindy-media://` 地址，`path` 一律为 null）。`BotGroupRemoteChatData` 追加
`supportsAttachments: true`，新手机只在看到它时提供附件入口；旧主机不回这个字段，新手机不会把附件发给会丢掉
它们的旧主机。旧手机忽略新字段，Markdown 摘要里列出附件名。图片缩略图沿用既有 `device-link:media:fetch`。
未新增 channel、allowlist、relay 类型或协议版本。

## 伙伴记忆远程页面与资源内搜索

伙伴设置主资源（声明 `form` 的控制端）追加 `memories` list 块，入口指向 `settings:<botId>/memory`；
原 `memory` 表单（开关与 USER.md）不变。列表页按类别输出多个 `list` 块：块 `title` 为类别名，`data.count`
为该类条数，条目追加可选 `subtitle`（正文开头）与 `timestamp`（毫秒）。详情页
`settings:<botId>/memory/<entry>` 由 `entry` 表单（标题、正文）与 `remove` 动作组成，revision 即该条
`updatedAt`，动作经既有 `bindResource` 绑定该值；主机服务在存储锁内再次核对。`entry` 取文件名去掉
`.md`，拼出的 id 超过 160 字符时改为 `h<12 位摘要>`。记忆已不存在时回 registry `NOT_FOUND`，其余 provider
失败仍按既有边界显示为 `INTERNAL`，控制端据复读判断冲突，不依赖错误码。

`maker:remote-resources:get` 请求可选携带 `query`（同 list，最长 1000 字符，空串等同未传）。新增可移植
原语 `search`：主机只对声明 `search` 的控制端输出该块（`data.query`、`data.placeholder`），控制端仅在看到
该块后带 `query` 重读同一资源。旧控制端不声明也不传 `query`，列表页原样可用；旧主机忽略 `query`，也不
提供记忆页面，新手机显示原有升级提示。未新增 channel、relay 类型、allowlist、权限、数据库迁移或
Mobile 原生 fingerprint 输入，服务端无需改动。

任务迁移业务通道的 `move-project` action 在任务所属宿主复用项目移动校验与更新，
仅接受任务 ID 和明确的目录（null 表示移到对话）。不开放远程 sessions 原始 patch；
旧宿主拒绝未知 action，不回退到控制端本机执行。

## 伙伴学习保存回执

消息 `agent_meta` 追加可选 `botLearning` 数组，仅承载已保存的记忆/技能标题、类型、稳定键与新建/更新动作。
执行宿主沿用 `local-db:messages:created` 广播完整原消息更新；桌面和手机只在该消息正文底部呈现两行。
旧端忽略字段，新端对无字段历史不推测保存结果。不新增远程 channel、数据库 schema、服务端能力或原生指纹。
桌面能力页新增仅限可信本地 renderer 的 `local-db:bots:skills:list` 读取伙伴自有技能；
远程端继续使用已有 `settings:<botId>/skills` 资源，不扩 IPC allowlist。
SSH 继续沿用现有伙伴远端技能限制，不读取控制端本机资料；设备互联由执行宿主保存与复盘。

## 远程模型目录按显示设置过滤

`maker:provider:list` 在执行主机完成既有授权和账号快照读取后，先按同一快照中的
`modelVisibilityOverrides` 与模型 `defaultEnabled` 过滤，再通过原有响应格式传输。
判定复用共享 `isModelVisible`：用户显式开关优先，否则跟随目录默认；不限制已开启模型的
数量、不修改用户偏好。聊天模型按 agent/provider/model 区分，媒体模型沿用主机的显示设置键。
未开启模型的详情不再传给控制端；供应商结构、连接状态、顺序及开启模型的能力配置保留。
投影中的既有 `modelVisibilityOverrides` 补齐有效开关布尔值（含默认关闭项），不回写偏好。
Mobile 据此区分已关闭与已删除的旧选择：保留任务或草稿原模型身份，发送前提示重选，
不自动替换模型、不清空草稿，也不为旧选择重新传输关闭模型的详情。

这是执行主机的投影修复，旧 Mobile 和远控 Desktop 无需新增能力协商即可接收。
不增加分页、客户端重组或重试，不提高传输大小上限；本机 Desktop 设置仍读取完整目录。
“关闭后必须重选”的提示与发送前检查随 Mobile 更新；旧版控制端仍沿用各自既有选择处理。

### 伙伴群聊成员操作与发送错误（#5604–#5606）

`bot-group-chat` 数据追加可选 `supportsMemberRemoval`；仅为 true 时手机调用
`remove-member({ actorId })`，主机复用现有 Chat Server 单成员 remove 与管理权限校验。
成员投影中的 actorId/actorKind 在手机保留，真人不作为分工负责人/步骤候选；缺字段的
旧本地伙伴保持原行为。旧手机继续用 `set-members`，新主机只校验其中新增的本机伙伴，
不丢弃既有真人/外来伙伴 ID。新版手机连旧主机时不调用新动作，伙伴管理沿用旧入口；
真人移出需升级主机，不能用整份伙伴名单差分假报成功。

群错误仍以稳定码作为 Remote Resource 错误 message，新增附件、鉴权、群服务不可达、
历史迁移、权限、归档及结果未确认等分类；新版双端本地化，旧端遇到未知码保留原通用失败提示。
不透传服务器正文或异常文本。仅群 send 的 invoke 预算增加到 180 秒，不改变其他动作、
共享连接、自动重试或授权。超时不能证明操作未执行，重试沿用 clientId；当前账号主机进程
合并相同在途请求并缓存最近成功回执，服务器 operationId 仍是最终幂等依据。
不新增 IPC channel、数据库迁移或 Mobile 原生指纹输入。

### 服务器伙伴群讨论与分工补全

Chat Server `/me` 追加 `capabilities.groupDiscussionParity: 1`。Desktop 只在该能力存在时发送
可选 `mentionsAll`、`planningMode`，辅助判断后用 `continue({automatic:true})`，停止判断用
`messages/:id/cancel-planning`。旧服务器继续收到旧形状；能力协商并不恢复旧服务端缺失的行为。
整个服务端集群升级后再发布客户端，不能在新旧副本混用时提前承诺该能力。

领取执行追加可选 `attachment_after_seq`，按伙伴/群/授权版本/分工步骤隔离成功投递水位。
缺字段时沿用旧读取范围；新客户端以此翻页收集未见附件，保留每轮 40 个上限及缺失名称提示。
`cindy.group-notice` v1 的 integration 卡映射到已有 plan-failed/member-failed/member-timeout
展示提示，仅承担文案，不授予执行权限。Mobile 继续消费主机既有群资源投影，无新增原生能力。

### 伙伴群聊引用回复（`cindy.quote` v1）

主时间线的引用回复不使用服务器 `replyToId`：现行服务端要求它与 `threadRootId` 指向同一 Thread，
主时间线会返回 `REPLY_THREAD_MISMATCH`。客户端在现有 `postMessage.content` 的 `card` 块里写入
`namespace: "cindy.quote"`、`schemaRevision: 1`，`data` 为 `messageId`、`authorName`、`authorKind`
（`user`/`bot`）、`excerpt`（≤280 字）、`attachmentCount`、`attachmentName`、`seq`，`fallback` 为
语言中立的 `> 作者: 摘要`。服务端 schema、migration 与权限不变；`plainText` 收录 fallback 以便搜索。
构造与严格解析只在 `packages/maker-shared/src/botGroupQuote.ts` 一处，Desktop main 与 Mobile 直连共用。

- 发送：渲染进程 IPC `maker:bot-group:send` 的 `BotGroupSendInput` 追加可选 `quote: { messageId }`；
  main 按当前账号 `GET /conversations/:room/messages/:id` 读取同群原消息后构造卡片，不信任调用方摘要。
  不可用时返回新增错误码 `QUOTE_UNAVAILABLE`（旧渲染层按未知错误显示通用失败）。设备互联 `send`
  动作本次不追加 `quote`，手机暂不发起引用；如需开放，须先加 Host 能力位，避免旧电脑静默丢引用。
- 读取：`BotGroupMessageView` 追加可选 `quote`（含仅手机直连使用的 `originalDeleted`）。手机解析电脑投影时用
  共享 `parseBotGroupQuoteView` 逐字段校验并保留 `quote`，同时保留原有的 `deleted` 墓碑供删除降级。识别出的卡片
  不再拼进 `content`；其它 revision 或字段不合规时整块按普通文本显示 fallback。旧手机经电脑读取时
  忽略新字段、只见正文；旧客户端直连或旧电脑看到 fallback 加正文。
- 伙伴上下文：群消息数据块里的消息追加 `quote`，仍在 `untrustedJsonBlock` 内；不改变 `mentions`。
- 后续：若服务端放开主时间线 `replyToId`（能力协商后），客户端可同时写 `replyToId` 获得外键约束与
  删除感知，卡片继续承担快照与旧端兼容；两者并存时以 `replyToId` 为准。

## 委派任务与自动任务的完成通知策略

既有 `SessionActivityPayload` 可选字段 `completionNotification` 影响远端桌面、手机与飞书完成通知：
`pending` 表示该轮终态回传正在判定，`teammate` 表示同一委派执行结果已成功交回伙伴，
`silent` 表示本轮完成静默（即使保留历史未读，也不重新弹出、响铃或发外部通知）；
缺省或未知值按普通任务完成通知处理。完成 phase、摘要和 attention 在 pending 阶段照常发送，
回传决定通过同一活动通道更新；执行宿主等到真实 `done` 的回传边界再决定，前置
`status: Done` 不能提前消费归属。本机外部通知共用这一决定；控制端的手机/飞书调用
在活动仍运行或 `pending` 时等待同一活动通道更新，已回传伙伴或本轮静默则取消调用。
没有活动记录（例如静默完成的清除帧早于 renderer 的 done 回调）不能当作新完成的证据。
`silent` 随未读账本和重连快照保留，新一轮运行清除；聊天过程与历史未读不受影响。已读、断开、
新一轮运行、报错或待交互使旧完成调用失效，不延迟错误与待答通知，也不更改任何未读。
控制端桌面仅对已观察运行的任务补发必要 fallback 一次，重连的
基线终态不补发历史提醒。错误与待交互不受此字段影响。

新控制端连接旧执行端时，明确的普通未读完成仍按原规则通知；旧控制端忽略该字段或未知枚举，
仍可能发独立完成通知，完整远端去重和保留旧未读时的静默需要两端更新。
手机外部推送在执行端及远控 Desktop 的通知出口完成去重，手机无需新增协议处理；
移动列表继续原 phase/attention 语义。无需服务端、数据库 migration 或 Mobile fingerprint 改动。

## 伙伴创建时选择模型

伙伴 `create` 表单块在 data 追加可选 `creationModelChain` 元数据，表示支持创建选模并给出默认首选。
旧端忽略该元数据，不会在通用表单中显示 JSON。新 Mobile 看到它才显示现有选择器；
显式选择时动作输入追加 `modelChain`（单条既有 BotModelRoute 的 JSON），省略即跟随伙伴默认。
选择不改全局默认。
主机复用设置页的模型可用性验证；旧手机省略字段照常创建，新手机连接旧主机保留原创建流程。
丢失回执后的重试仍沿用原 requestId 和原模型选择，不覆盖已创建伙伴。
无新增 channel、权限、数据库 migration、服务端改动或原生 fingerprint 变化。

## 移动插件只读权限摘要

plugin-capabilities.data 可选追加 permissions（title/description 字符串数组），仅由 Host 从
PC 同源 ghostPermissionItems 声明摘要投影并排除 tool，以请求 locale 使用 PC 文案插值。
包含作者声明的 OAuth scope，不包含凭证、已存配置值或本机路径；不表示已授予运行权限。
旧控制端忽略该字段，新手机遇到旧 Host 缺字段或格式不完整时明确未提供，不推断无权限。
空数组仅表示 Host 明确投影的声明为空。工具、about 和 version 使用原字段。
不增加 channel、allowlist、relay 帧、授权或协议版本，服务端无改动，Mobile 指纹不变。


## 移动插件 Details 事实

同一 plugin-capabilities.data 可选追加 details（key/title/value 数组），由本插件 InstalledGhost
投影 PC 同源版本、作者、签名来源、标识、包含能力与面板声明。签名标签复用 shared ghostTrustLabelKey，
不传签名文件、批准记录或密钥标识，不用作者自报推断官方。安装目录按用户明确要求单独只读投影本插件
的 ghost.dir，仅走原同账号、当前 owner 的资源通道；不提供路径写入或文件操作，不扩 IPC 白名单。
当前 PC 窗口的停靠位置不在此声明投影内，有面板只报告存在，无面板沿用 PC 文案。
旧 Host 缺字段时新手机仅显示原有 Version 与资源 Identifier，说明其余数据未提供；旧控制端忽略新增字段。
服务端、relay、协议版本及原生 fingerprint 均不变。


### Cindy AI 企业周期配额

云端组织账号优先通过 Model Access `GET /api/model-access/quota` 查询本人周期配额，
不再假定推理入口暴露 LiteLLM 管理 API。返回 spend/maxBudget/budgetResetAt/currency；
沿用现有 account-usage IPC 和账号作用域缓存，所以设置卡片与任务用量提示使用相同来源。
服务端尚未提供接口（404），或明确返回 501/MODEL_ACCESS_QUOTA_NOT_SUPPORTED（Nova），
才使用原有网关查询。鉴权失败、上游故障或响应无效均显示不可用，不回退或借用其他身份数据。
本接口尚无当日统计，todaySpend 为 null；未设周期上限时不伪造有限配额。
本地手填网关和个人计费路径保持原协议。无新环境变量或数据库变更。

管理员取消周期上限后，主进程明确清空当前 owner 的配额缓存，并通过现有
`usage:claude-account-changed` 广播 null；renderer 同步清除当前 owner 的快照与热缓存。
已有未知载荷消费者会忽略 null，新旧有限配额快照字段不变；网络失败仍保留既有缓存策略。

配额读取 IPC 返回 null 仅表示当前无可用快照，不清除 renderer 已缓存的同账号额度；只有权威 clear 读取结果或显式 clear push 才清除缓存。

`maker:usage:account('claude-code', 'cindy-quota-state-v1')` 为可选读取能力：有限额度保持原快照，权威不限额返回 `{ quotaState: 'unlimited' }`，暂无当前账号快照返回 null。无该能力参数的旧消费者仍只收到快照/null；旧主机忽略该参数，新消费者对其 null 保留旧缓存。本地重新挂载和远程读取均查询该状态，避免错过 clear 推送；仅权威 clear 可淘汰同账号缓存。

企业凭据迁移：`/quota` 查询不依赖本地推理凭据；仅在当前进程、当前账号已成功同步服务端凭据，且实际 endpoint 与本次同步一致时，允许 404/明确 501 后的旧直连回退。持久化凭据不能作为本轮同步成功的证明。网关 endpoint 或身份代次变化时，失效当前账号额度并丢弃旧代次在途结果；失效结果通过既有 null push 通知，可选状态读取返回 `{ quotaState: 'invalidated' }`，与 unavailable null 区分。新本地/远程消费者将 invalidated 和 unlimited 都作为权威清缓存；未携带能力参数的旧消费者保持 snapshot/null 返回。此处不变更凭据存储、推理回退或额度计算口径。

额度身份隔离使用主进程 `ownerGeneration` 与 `dataOwnerId`，覆盖同 membership 跨认证 realm 切换及同账号修复；凭据状态与额度快照使用同一身份键。
远程 transport-timeout 出站退避重连成功、或普通同账号 peer 入站 link-accept 成功后，Main 通过本地 `device-link:peer-link-reopened` 推送 `{ deviceId }`，preload 暴露可选 `onPeerLinkReopened`，仅目标设备触发排队补读。被取消的重连代次不发通知。该事件不进入 relay wire、不增加远端 IPC allowlist，也不改变 Mobile/旧消费者的请求协议。

## 同账号设备版本与移除

设备列表展示现有 `appVersion` 和完整 `deviceId`；版本沿用现有 hello 字段，不改协议版本。
服务端在 hello 时保存版本，离线目录也可返回；历史设备首次重新上报后补齐。未知值不伪造。

在线与离线设备均可确认移除。服务端保留移除标记、清理路由与推送 token，关闭连接时使用
4410。新客户端将其投影为 `device-removed`，停止自动重连并显示重新登录提示；显式登录
可再次登记。本地任务与文件不删除。旧客户端可继续重试，但服务端标记阻止重新登记。

部署先迁移数据库并升级全部 device-link 服务实例，再开放新版客户端的在线删除入口；
新版客户端遇到旧服务在线删除冲突时保留设备并提示服务尚未升级。服务端迁移、回退边界
见 `cindy-server/docs/device-link-server.md`。删除失败不清理本地远程任务分片，重复点击在
请求期间被挡住；取消确认不发起删除。UI 继续复用语义颜色与标准确认弹窗。
确认删除同时阻止在途冷缓存回填、清理该设备磁盘缓存并作废删除前的目录读取；
目录暂时不可用时，其他离线设备继续保留缓存。

## 云端伙伴：从任意电脑更换主力电脑

`maker:companion-cloud:caps` 的 `companionCloud` 从 1 升到 2，新增两个同账号 device-link channel：只读的
`maker:companion-cloud:targets`（主力电脑视角下可接手的电脑）与写入的 `maker:companion-cloud:hand-over`
（`[botId, targetDeviceId, options?]`，在主力电脑上走原有交出流程；`options.whenBusy` 为 `wait` / `stop`，老主力电脑忽略；隧道超时 7 分钟），以及合并 Cindy 的 `maker:companion-cloud:merge`（`[keepBotId, fromBotIds]`，只在本机运行保留的 Cindy 时执行，隧道超时 10 分钟）和合并前请来源 Cindy 的主力电脑先同步的 `maker:companion-cloud:flush`（`[botId]`，只在本机是它的主力电脑时执行、不改主力电脑，忙碌时 `BUSY`，隧道超时 7 分钟；版本 < 2 或连不上的主力电脑不请求，合并按云端已有内容进行）。接手方仍只要求版本 ≥ 1，
所以新旧电脑之间照常能互相交出；发起方读到主力电脑版本 < 2 时不提供远程更换，提示先更新那台电脑，
不退回成直接改服务器上的主力电脑。旧发起方不知道新 channel，行为不变。两个 channel 不进共享任务访客白名单，
不改 relay 帧、服务端 schema 或 Mobile 指纹。本机 IPC `maker:companion-cloud:transfer` / `:devices` 换成
`:switch-home` / `:home-choices`，并新增 `:attachment`、`:cindy-copies`、`:merge-cindy` 与 `maker:companion-avatar:resolve`，只在同一个 Desktop 内的 preload 与 Main 之间使用。
伙伴资料快照 `companion.profile.v1` 新增可选的 `templateId`；新增偏好键 `companion.todo.v1:<id>`、`companion.routine.v1:<id>`、`companion.workbench.v1`，
旧客户端不认识这些键，接管时忽略。镜像上传的房间消息可带 `media` 块；旧客户端按文件名显示。手机端同样不改原生指纹。

## 伙伴导入的消息机器人分类

`companion-import` Remote Resource 的 client primitives 可追加 `companion-import-bots-v1`。只有声明它的控制端
（以及本机界面与 `import_agent`）的预览才会收到 `category: 'bots'` 条目及其可选 `platform` / `owner` 字段，导入时
会先在来源 Agent 里停用这些机器人再由伙伴连接；旧控制端的预览校验不认识新分类，所以照旧把 Telegram / Discord
放在 `connections`、不停来源，也不出现飞书 / 企业微信 / 钉钉条目。分类随预览快照与加密检查点保存，开始导入和恢复
都按当时的分类执行。不改 relay 帧、服务端 schema 或 Mobile 原生指纹。
