# 跨端协议兼容

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改插件分发来源边界、device-link 协议／relay／隧道 payload／IPC
> allowlist，或任何改动客户端与服务端之间 wire protocol 的地方之前

客户端与服务端分别维护本仓所需的 wire Bean、validator、parser 与 builder，不共享代码仓库
或发布节奏。真正危险的是单端改变既有 wire 语义，或在不兼容变更中缺少协同；这类问题在
单仓 typecheck／单测里发现不了，只有真实连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

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

## 任务列表标签目录

`sessions:list` 第三个参数可追加 `tagCatalog: 1`。支持的主机仅对该请求返回
`{ format: 'session-tag-catalog-v1', sessions, tags }`；任务行的 `tagIds` 是响应内
目录索引，保留全部任务、标签与顺序。共享 DeviceLinkClient 解包后，上层仍读取原数组。
新控制端兼容旧主机的数组回复；旧控制端不声明此字段，新主机仍返回数组。
缓存／outbox 重发先解包并重新检查任务可见性，再从可见行生成目录，不能残留隐藏任务的标签。
此扩展不改变 relay、帧限制或服务器权限，也不靠截断数据降低体积。

标签的可选 `nameCustomized` 标记区分显式改名与预设本地化。新版更新请求仅在明确改名时
提交 `nameCustomized: true`；旧端换色时携带相同原名不会误置标记。缺省字段沿用旧显示规则。

## 远程桌面临时分辨率

被控端以可选能力 `resolutionRestore` 声明系统分辨率的连接级恢复支持。
新版控制端仅在该能力为真时发送 `resolution { temporary: true }`；响应为原 lease
及更新后的显示器尺寸、`controlling: false`，控制端刷新画面并重新取得操作权，不结束连接。
被控端在首次调整前保存原模式，多次调整不覆盖；结束、超时、撤权或接管后先恢复，
恢复失败保留原值，下次连接前重试。在途原生写入完成前不得开始恢复。

旧被控端缺少该能力时，新控制端只允许已有 `viewerDisplayRestore` 能力覆盖的临时调整，
不得退回会留下系统分辨率变化的旧路径；不支持的选择返回“不支持”。旧控制端的无
`temporary` 请求及响应保持兼容，其旧行为不代表新恢复能力已生效。此扩展不修改 relay。

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
决定，调整数值无需两端同时发版。

新控制端经 `remoteDesktopVideoSettingsWire` 同时发送档位与旧 `bitrate`（auto→0、saver→2M、
hd→20M）：旧被控端只校验 `bitrate` 并忽略 `quality`，无需新增能力声明。新被控端优先读取
已知档位；档位缺失或不认识时按旧 `bitrate` 换算（0→auto、2M→saver、8M／20M→hd），因此旧
控制端与未来新增档位都能降级连接。两者都无效时仍返回 `INVALID_REQUEST`。此变更不改 relay、
不新增 channel，服务端无需改动。

被控端在应用控制端 offer 前，仅为带 `settings` 的请求给视频编解码追加 `x-google-start-bitrate` /
`x-google-min-bitrate` / `x-google-max-bitrate`，避免近静止画面因发送量过低导致带宽估计塌到
百 kbps 级、分辨率被锁在低档。这些是 libwebrtc 对发送端生效的本地提示，不改变协商出的编解码；
不识别它们的控制端不受影响，旧控制端（无 `settings`）的 offer 原样使用。

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
