# 跨端协议兼容

## 常用界面偏好的同账号副本（2026-10-31）

新增精确 push channel `device-link:account-preferences:sync:v1`，使用既有同账号已认证
envelope，只在已知在线、未撤权的普通设备间交换；共享任务与供应商分享 peer 不参与。
该 channel 单独进入 unlinked push 白名单，关闭远控不会关闭偏好复制；不开放全局设置
invoke，也不改变远控授权。状态只包含语言、浅深色模式和七个侧栏显示字段的显式覆盖。
Desktop 参与全部九键，Mobile 应用语言与浅深色模式，并保留其余已知字段供副本合并。
主题文件、壁纸、项目路径、手动置顶顺序与凭证不进入该资源。

字段按持久化逻辑计数和节点身份合并，恢复默认保存 null 墓碑；同字段并发以节点身份
确定裁决，不依赖不同设备的墙钟。初次迁移只认领一次本机旧偏好；未完成迁移的电脑
不发送空的初始状态。上线、重连、保存和有界兜底交换小快照，`requestReply` 的回复
不再索取回复；失败只影响该偏好副本，不重连共享 relay 或重放任务操作。
账号代次、异步落盘和撤权边界在应用前复核。未知版本或字段不解释为空配置，旧端忽略
新 channel 并保留本机偏好，无服务端部署先后要求。两端均更新后才具备完整偏好同步。

官方与自建 relay 都使用既有通用 push 转发，不解析新增 channel 或状态，因此无需
修改中转内核、REST、签名格式或协议版本。验证包括共享客户端与自建 relay 单测，以及
`pnpm --filter @cindy/device-link-relay run interop` 的真实加入、签名通信和重连。
用户实际设备间的最终体验仍需发布后验证；自动化结果不代表正在运行的安装版已更新。

## 项目置顶跟随所属电脑（2026-10-31）

同账号 invoke 白名单新增 `sidebar-settings:get-project-pins`、`sidebar-settings:apply-project-pins`，
push 白名单新增 `sidebar-settings:project-pins-changed` 并入 `sessions` topic。项目所在电脑（宿主）
沿用 Main 中 owner 作用域的置顶列表作为正本：GET 只返回其中的 `local:` 项目键与宿主 owner 代次；
APPLY 只接受 1–64 个显式 `local:` 键的置顶或取消，复用本机侧栏的 promote / remove 语义与窗口广播，
不收会话 id、SSH 或其他设备的键，也不改动其余条目的顺序。宿主还没有持久的置顶列表、且它自己的
侧栏在本次运行中尚未报告旧版渲染端置顶已迁移或无需迁移时，APPLY 返回 `PRECONDITION_FAILED`，以免
远程写入先让 Main 成为正本、导致旧版暂存被丢弃；本机项目置顶集合确有变化时才推送完整快照，会话
置顶与其他设备项目的变化不发帧。

控制端只在设备合格（在线、允许远控、未撤销）期间读取，生命周期与远程项目别名一致：bootstrap、
周期对账、peer reset 与重连时重读，断线保留最近快照，关远控、撤销或移除设备时清除。推送与写回
结果会作废更早发出的 GET，宿主 owner 代次只增不减。宿主的 `local:<path>` 映射为控制端的
`device:<id>:<path>`。控制端本机置顶列表中该设备的 `project:device:` 条目，在宿主首次可写时一次性
转交（APPLY），成功后把设备写入控制端 owner 作用域的 `projectPinHostDeviceIds`；此后这些条目只决定
本机显示顺序，宿主不再置顶的条目随即清理。宿主暂不可达时，这些条目代替最近一次置顶结果显示，
但不会新增仅存在本机的置顶。Windows 宿主的盘符与 UNC 路径按不区分大小写匹配，并以控制端侧栏
的写法显示。转交没有墓碑：很晚才升级的控制端会把它的旧置顶交给宿主，可能恢复在别处取消过的置顶。

兼容：旧宿主对新通道返回 `CHANNEL_NOT_ALLOWED`，控制端保留原有的本机置顶；旧控制端不调用新通道，
宿主照常工作。完整同步需要项目所在电脑与查看端都更新。SSH 项目（`remote:`）的置顶和手动置顶顺序
仍按设备保存；宿主上与本机项目同路径的 SSH 项目，在控制端已合并为同一 `device:` 项目，按本机项目处理。
手机目前没有项目置顶入口，本次不改 Mobile。官方与自建中转沿用通用 invoke / push 转发，不解析新增
channel，无需修改中转内核、帧格式或协议版本；共享客户端测试、自建中转测试与
`pnpm --filter @cindy/device-link-relay run interop` 结果记录在 PR 中。
恢复只影响单台设备的元数据读取：不重建 link、不重放写操作，转交与过期排序项清理失败都按 10 秒起的退避重试。

## Desktop 群聊消息的即时投影（2026-10-31）

既有 `maker:bot-group:changed` 可选追加 `messages`（已授权的 `BotGroupMessageView[]`）和
`historyRevision`。只向原账号窗口广播，且只合并到同一房间、相同投影代次的已显示主群；
未知代次、切账号或撤权继续由完整读取重建／清空。旧成功读取被较新的增量超越时丢弃，
权限拒绝仍立即清空。WS 消息仍先持久化再 ACK；消息投影不等待执行／安排／已读的完整刷新。
贴回来源可复用实时投影或原有 30 秒内的已校验消息缓存；过期／缺失时重新鉴权读取。
贴回成功后的 HTTP 单条授权读取提供断线兜底；失败不构造消息。旧客户端忽略可选字段，
原有完整刷新继续执行；旧 Host 无字段时新客户端同样回退。无新 channel 或 allowlist。
手机经原 remote resource 失效通知重新读取，新增正文只进入本机账号窗口，不改变远控权限。
本机已读回执／已认证 actor `read.changed` 可直接更新缓存读位；不完整的旧格式、偏好变更、
真实连接中断、重连和撤权保留原快照校准；从未连通的握手失败不反复作废已校验的 HTTP 缓存。无服务端 REST/WS 帧、数据库 schema 或原生指纹变化。


## Chat Server 只读工作发现与定向通知（2026-10-29）

`/me.capabilities` 新增 `workAvailabilityVersion:1`、`workNotificationsVersion:1`。
`POST /executions/availability {botIds}` 每批 1–128 个本人伙伴，返回 `{items:[{botId,enabled,pending}]}`。
它只检查普通和成员加入队列，不写执行/回执，不获取租约。pending 只是提示，实际领取仍使用原单伙伴 `/executions/claim`，
其请求体、鉴权、epoch、幂等、60 秒租约及失联后的显式重试行为不变。

主人 actor 流新增 `work.available {work:[{botId,conversationId}]}`，覆盖未打开群及普通、计划、真实入群、重试和前序结束。
通知可重放且不构成执行授权。Desktop 只唤醒对应伙伴，批量只用于无副作用的发现；真实响应逐伙伴处理，不等待聚合租约结果。
同一伙伴最多一项领取或忙碌扫描；探测不占用该位置，新工作可以越过慢探测。旧探测的空结果不能覆盖期间到达的提示。
完整空队列证明且可靠通知在线时最长 60 秒空闲退避；其余空领取/旧服务端/断线上限 15 秒，含抖动和调度误差。
普通错误按伙伴退避；401 续期期间暂停新后台请求，成功后沿用原重发，失败进入退避；429 立即更新共享截止时间。
主力登记子请求和认证后的重发均在发送前检查门禁，成功不清除已有 Retry-After。已在途结果仍接收，已有心跳继续原规则。
云端伙伴运行时以独立的后台身份 API 接入安装归属 GET/POST `/preferences`、自动主力确认和删除登记重试；
同路径的资料同步、消息镜像以及用户明确操作继续原通道，不按 URL 一刀切限流。

新端在能力缺失或只读探测 404 时回退原 claim。服务端同时声明 `personalMask:1` 时也不使用探测：
AI 代答与私人汇总只能由空闲的 `/mask/executions/claim` 发现，探测与 `work.available` 均不覆盖它们。
旧客户端忽略新能力与事件；Mobile 无执行器协议变化。手机不运行伙伴：本人 actor scope 中只含 `work.available`
的批次直接 ACK，不重读列表或历史，混合批次照常刷新（[`chatServerSubscription.ts`](../../apps/mobile/src/chat/chatServerSubscription.ts)）。
推荐先部署全部服务端，再发客户端；旧 dispatcher 混合窗口依靠兜底，不承诺即时唤醒。没有环境变量或 Schema 变化。
actor 游标只保存在当前账号运行时，重连续读、重启从零；RESET_REQUIRED 与 CURSOR_AHEAD 都有恢复入口。
RESET_REQUIRED 跳过的通知可能含主力迁移的 `actor.changed`，因此先重读伙伴与主力电脑，再从新游标续订和领取。

设计与验收不变量见 [工作轮询设计](chat-work-polling.md)。新增能力只优化发现，不引入批量领取或自动恢复执行协议。

## X 视频分块转传

内联附件受 48 MiB 单帧限制，用不上 X 自身的上限。x-hook-server 的 welcome 增量声明 `x-media-relay-v1`，
客户端在接活时取快照：声明了就用 `x.media.init / append / finalize / abort` 逐段发送，每段等
`x.media.result` 确认，server 立刻转给 X、不落库；成功后把 media id 放进 `turn.end.xMediaIds`。未声明时
继续内联 10 MiB 以内的视频，超限提示未发出。旧 server 不会收到新帧，旧客户端忽略该能力，部署先后不影响。
两仓的共享解析入口核对分段 Base64 字符、补位及解码后大小，4 MiB 可用、多一字节即拒收；不靠总帧上限替代分段限制。
明确停止同时取消该 request 的上传；断线只结束该连接上已开始的上传，不取消 Agent 仍在生成、重连后才开始的上传；
换账号及关闭 dispatcher 才结束全部当前上传，
不重建其他连接、不自动重传。图片和 GIF 仍内联，Telegram 与 Slack 不变，不新增 IPC 或持久化。持久出箱里的 `xMediaIds` 是普通字段，
服务端重放时直接引用，media id 有效期 24 小时。回归见 `hook-control/__tests__/xMediaRelay.test.ts`、
`outbound.test.ts`、`dispatcher.test.ts` 与协议包的 `protocol-x-media.test.ts`。

## 任务顶栏 PR 汇总与关联管理

`git-context:pr-status` 的成功结果可选追加 `checks`，包含当前 head 的检查总数、失败、
通过、进行中与跳过／中立数；缺字段或 null 表示不可用，旧客户端忽略。沿用 60 秒缓存、
在途合并和前台 90 秒刷新；客户端请求过期数据时等待本次刷新，不额外增加轮询。
每个 PR 仍只调用一次 REST 与一次 GraphQL。评论只读取原有前 100 条的解决状态，
存在下一页时将未解决数标为不可用，不为数量汇总额外翻页。

新增同账号 `git-context:pr-refs:manage` 接收任务 id 与 list/add/remove/restore/pin/unpin/reorder，
只管理任务关联，不修改 GitHub。`reorder` 的 ids 必须覆盖同一固定组的全部 active 行，
不得重复、跨任务或包含已移除行；重写 priority 与 manuallyAdded，不改 schema。该管理通道
尚未发布，以 reorder 替代 prioritize；两端随本分支一起更新，旧已发布主机仍走不支持分支。新增链接经宿主 GitHub PR API 验证后保存；共享任务访客
不在此通道的授权范围。旧主机拒绝新通道时明确显示不支持，既有 PR 查看与跳转照常工作。
SSH 任务继续在保存任务的 Desktop 管理关联；无需工作目录文件访问或服务端改动。
只读 review 任务可查看关联列表并打开 PR，不提供管理写操作。
Mobile 继续消费既有引用与状态，暂不新增管理界面。
官方与自建中转均沿用通用 invoke 转发，新增通道只在客户端宿主 allowlist 判定，
不改变签名、帧格式或连接恢复，无需更新中转内核。已运行共享客户端测试
`pnpm --filter @cindy/device-link test`、自建中转测试
`pnpm --filter @cindy/device-link-relay test`，以及真实互通验证
`pnpm --filter @cindy/device-link-relay run interop`。

`session_pr_refs` 增量保存固定、优先顺序、手动添加与移除标记；自动提取不会清除用户的
移除决定，恢复需显式操作。已有行按原先最近提及排序，固定最多三条。
手动操作成功后主动使该任务的远程引用缓存失效；其他控制端沿用前台 90 秒刷新，不新增 push topic、连接恢复或请求重放。降级旧客户端会忽略
新增管理字段，因此旧客户端可能重新显示已移除的引用；记录保留，重新升级后恢复选择。
验证入口：`sessionPrManagement.test.ts`、`gitContextPrStatusService.test.ts`、`GitContextBadge.test.tsx`。

## 设置页中我分享的供应商

Desktop 的本机分享命令与既有同账号供应商管理通道增量支持 `shared-provider-ids`，
只返回当前电脑已建立分享的供应商 ID 与就绪状态，包含已暂停的成员，不含仅有链接或申请的项。
查询读取分享运行时快照，不延长快速轮询窗口，不计算用量；原来的 `owned` 与分享管理页行为不变。
新控制端遇到旧电脑不认识此命令时，回退到 `owned`，两次读取至少相隔 90 秒，避免持续续期
60 秒快速轮询窗口；页面隐藏时停止定时与事件读取，重新可见后刷新。
不增加 IPC channel、设备权限、分享授权、重试或持久化；旧控制端继续使用原命令，双方可独立升级。
回归入口：`providerShareManagement.test.ts`、供应商组 `ipc.test.ts`、`OwnRemoteProviders.test.tsx`。

## 本机应用使用远程供应商

`remote-agent` caps 增量增加可选 `localApplication: true`。协商成功后，open 的
`options.localApplication` 携带 MCP 名、`hostToolsOnly` 和授权存储键的 SHA-256 摘要；
不携带调用方的 MCP URL、令牌或存储路径。接收方严格验证字段，并从自己的受控存储根
按控制端／中转身份派生应用目录，再构造到反向隧道的工具入口。

控制端及供应商组中转均要求实际执行端声明该能力；旧端不支持时拒绝启动，不丢弃隔离
声明继续执行。新端收到无该字段的旧请求保持原行为。应用的客户端工具经既有 MCP 通道
返回原调用方；`client-only` 禁止原生文件／命令反向请求。无需服务端或 Mobile 变更，
不扩大 IPC allowlist、设备权限或分享范围，不新增重放策略；一次来源失败不重启其他连接。
回归见 `local-agent/__tests__/remoteCatalog.test.ts`、`remote-agent/__tests__/roundtrip.test.ts`
与 `groupRelay.test.ts`，公开应用合同见 [本机 Agent API](../local-agent-api.md)。
## 插件私有文件读取的缺失判定

`fs-request` 的 `root:data / op:read` 在确认为 ENOENT 时，向既有
`{ok:false,message}` 回执增量添加 `errorCode:NOT_FOUND`。旧插件继续读取原字段；
新插件仅可据该错误码初始化缺失记录，不得把权限、路径或未知读取错误当成空数据。
旧宿主缺少错误码时保持未核实状态，不解析人类文案推断文件缺失。
实现及回归：`fsSlot.ts`、`fsSlot.test.ts`。

## 本机应用的可见任务（2026-10-28）

本机 Agent API v1 的 `session/open` 响应可选追加 `cindySessionId`。应用授权记录可选
保存 `createVisibleSessions: true`，缺省与旧授权均为关闭；旧客户端忽略新增响应字段，
不改变既有令牌、恢复句柄与工具策略。每次 open 创建新任务，调用方不能指定已有 Cindy 任务。
设置操作 `local-agent:set-create-visible-sessions` 只接受本机受信 Renderer，不进入
device-link 的 invoke 白名单。普通任务及消息沿用现有多端同步路径；本机应用来源使用
已有 `sourcePlugin` 元数据的 `local-app:` 前缀。旧查看端可能按插件显示来源，
不影响正文或执行授权；更新后显示本机应用。协议与验证入口见[本机 Agent API](../local-agent-api.md)。

## 群主与伙伴成员归属（2026-10-28）

Chat Server 的 group 新建者和新任 owner 仅允许 human；非真人目标返回既有错误体中的
`HUMAN_OWNER_REQUIRED`（400）。伙伴实际加入群前，服务端在群锁内确认真人主人已加入且未禁用，
否则 `BOT_OWNER_NOT_IN_GROUP`（409）；真人离群同时撤销其伙伴的成员与待接受邀请。
不新增字段、IPC、能力协商、环境变量或数据库迁移，direct 与 channel 行为不变。
先升级全部服务端副本，再升级客户端；旧服务副本在滚动期间仍可能接受旧规则请求。
旧客户端可能仍展示伙伴转让入口，新服务端统一拒绝；新 Desktop 还会过滤按钮，并在 Main
校验最新成员快照，连接旧服务端时也不再提交非真人转让。新错误复用本地化权限提示，旧客户端
按原通用失败提示降级。存量伙伴群主仍可由所属真人代为转让给已入群真人，不自动改写历史归属；
没有批量清理线上数据。回退旧服务会恢复旧的宽松规则，不保证继续维持该限制。

## 灵动岛摘要的纯文本标记

既有 `local-db:sessions:activity` 可选追加 `summaryFormat: 'plain-text'`，仅标记
`compactDetail` 已经由所属 Host 转为显示文字。Desktop 控制端经活动 store、远端输入
投影与 Main IPC 校验保留标记；运行及完成卡片只折叠空白、限制长度，不再解析 Markdown。
缺省或未知值继续走旧摘要兼容转换：压平截断的组件块不显示源码，前置正文保留，
仍有围栏上下文时沿用共享 parser 保护代码引用。无法恢复正文时复用本地化“完成”。

旧控制端忽略可选字段，新控制端接受旧 Host 的无标记摘要；双方可独立升级。
旧 Host 已经压平的代码示例无法可靠还原格式，完整字面符号保留需双方更新。
不新增 channel、权限、连接恢复、持久化、服务端或 Mobile 原生配置；回滚时忽略标记，
保持旧摘要显示。回归见 `activityTextStream.test.ts`、`service.test.ts` 与
`agentIslandRemoteSessions.test.ts`。

## 同 Harness 换电脑接续原生记录

`remote-agent` caps 增加可选 `nativeHistoryTransfer: true`，仅同账号 owner 可用；缺省、旧端或分享中转继续使用 handoff。
发送端在查询能力前同时拒绝来源与目标的 `share:<id>` 任务位置及已解析的分享 peer；不以跨账号对端自报能力作为原生历史传输授权。
同通道新增 `native-history` 操作，携带任务 ID 与 export/import/read/write/restore/release 命令。
接收端自行决定原生目录，不接收目标路径；Pi 源路径必须在本机 Pi home 内。临时句柄绑定账号代次、控制端与任务，
每段至多 512 KiB，顺序与 SHA-256 完整性校验通过才导入；原生 ID 重新生成，源记录不修改。
Pi 只改写副本首行的 session ID 与 cwd，使其指向接收端工作目录；消息、工具结果、分支与压缩记录保持原字节。
临时转录放 userData/native-history-transfers 的私有目录，结束后清理，空闲 10 分钟回收。
16 个传输的上限同时计算创建中的快照，创建失败释放名额。Claude 原生迁移通过已有 vendorOptions 传递内部
`_cindyRequireNativeResume`：适配器等待 CLI 的初始化握手并拒绝静默新建，恢复失败交回宿主切换事务。
该标记覆盖手动、配额均衡与启动失败换电脑；普通 Claude 无效会话自愈保持原语义。启动迁移无法保存原子回退所需的边界时，先还原源位置与 ID，再返回失败，不打开副本。
这些命令不加入只读／断链自动重放名单。恢复失败回落已有的原子 resume fallback，不把切账号或清空历史当普通失败。
失败目标的关闭仅作尽力清理，断链错误不能阻止配额探测还原源路由或手动切换提交原子摘要回退；清理等待后仍须复核账号与历史代次，取消与改选继续阻止迟到提交。
配额探测成功后，正式路由写入若失败，同样关闭目标并还原源位置/原生 ID，再向调用方报错，不保留无边界记录的半切换状态。
边界消息增加可选 `nativeHistory: restored | fallback`，桌面与手机在 fallback 时显示「已用摘要接续」；旧客户端忽略新增字段，
仍能读取原有 handoff/resumed。无服务端、数据库 schema、环境变量或 Mobile 原生配置变化。
回归：`relocateNativeHistory.test.ts`、`nativeHistoryTransfer.test.ts`、`nativeHistoryStorage.test.ts`、`sessionAgentSwitchHandler.test.ts`、device-link `remoteAgent.test.ts`。
配额均衡的同账号提议复用既有 `kind: auto`，桌面与手机不弹常规换电脑确认。实际需要摘要时，宿主通过既有 permission
确认卡（`hostOwnedConfirmation: native_history_fallback`）询问，支持同账号远控回答；取消、超时保留原电脑与原生记录。
旧客户端已支持 auto 和通用 permission 卡；共享来源仍沿用原来的 ask/记住偏好，不自动扩大授权。

## 插件宿主模型选择器（新增接口，尚未发布）

`PluginPagePoll` 新增可选 `modelPickers`，Host 绑定原插件安装与页面，手机及远程桌面
设置页使用执行电脑的统一模型目录，只把用户确认的完整 route 通过原页面回传。
远程设置的密封命令增量为 `answer-model-picker`；原有命令、权限、安装批准与账号凭证合同不变。
未更新的控制端忽略可选字段，Host 在 90 秒后取消；新插件检查 `cindy.pickModel` 是否存在，
不把目录读取或选模当成执行授权。两端都更新后才具备原生选模回执，不需要服务端变更。
新增 Renderer IPC 仅本机宿主使用，不进入 device-link 通用 invoke/push 白名单；跨设备
复用既有插件页面资源与密封设置链。正文详见 [插件规则](plugin-security-and-authoring.md#宿主统一模型选择器新增接口尚未发布)。

## 浏览器扩展桥接迁入宿主

随包浏览器扩展的本机桥接从插件自带的 Node 接线进程迁入宿主（`main/browser-extension/bridge.ts`）。
线协议 `cindy-browser-extension/3`（协议号 3、签名线合同 0.4.13、回环端口 18810–18819、
`/health` `/poll` `/ack` `/authorize` `/result` `/learning/*` `/native/bind`）逐字不变：已装的
扩展 0.3.x / 0.4.x 不用更新即可连到宿主；`/health` 的 `plugin` 字段改为声明插件的 id（Cindy
Chrome 仍是 `my-browser`）。Native Messaging 的注册文件布局（`<App Support>/Cindy/browser-native/`
与各浏览器 profile 的 `NativeMessagingHosts/<name>.json`）与插件时期相同，已配对用户升级后无需
重新配对。

宿主只在已装、启用且 v3 清单声明 `browserExtension` 的插件存在时启动桥接；旧版插件不声明，宿主
不占端口，插件自带接线进程照旧工作，用户升级宿主不会断连。插件新版声明后由宿主接线，插件停止
自带监听，交错更新期间两边都写同一份 Native Messaging 清单。管子新增上行 `browser-extension-request`
与下行事件 `browser-extension-relay`；旧宿主对未知上行类型返回错误，插件须按运行时能力探测降级到
自带接线进程，不得把拒绝当作已连接。Browser Use 的 `BackendKind` 新增 `user-browser`：旧设置文件
的 `kind` 原样读取，未知值仍回落 `external`；回退旧版本时该值被当作默认处理，不丢其它偏好。

站点名单已取消（2026-10-30）：线上的 `policy` 字段保留，宿主在 `/ack`、`/authorize` 与 `setPolicy`
应答里恒给「全部允许」，旧扩展照常解析；旧插件推送的 `setPolicy` 应答成功但不生效；宿主缓存文件
只保存配对，旧版本存下的名单读到即忽略。事件 `browser-extension-policy-request` 沿用原名，现在只
在没有配对缓存时用来索要配对。

## 接受已保存的伙伴模型

既有 `local-db:bots:update` 可选接收 `acceptSavedModelSelectionVersion`（读取到的正整数
Profile 版本）。它是显式接受模型的意图；宿主重新校验模型可用性、版本及账号，在同一保存
事务中推进版本并为跟随专线登记 `pendingBotProfileVersion`。旧版无标记 baseline 不因普通
重试、能力修改或来源不可用而被删除；路由切换尚未就绪时保留恢复记录。

不新增 channel 或权限。旧调用方省略字段保持原有行为；旧宿主不支持该恢复意图，不能将
返回成功视为完成恢复，必须读回版本及发送结果。现有 `update_teammate_profile` 显式提交
`modelChain` 时走同一接受入口，包括重复选择当前值；省略模型字段不改变恢复状态。

## 设置中的引擎更新准备

Desktop 新增本机 `update-harness-prepare` IPC（Claude Code/Codex、用户看到的目标版本），
只供可信应用顶层 renderer 在重启确认前准备下载，不暴露到 device-link allowlist。
原 `update-harness-relaunch` 追加可选 `preparedVersion`：宿主只接受本轮准备成功的目标，
下次启动只消费缓存，避免确认期间清单变化又触发启动下载。省略参数的旧设置入口仍写
原 scoped 修复标记，回复保持兼容。应用更新 IPC、手机与设备间 wire protocol 不变；后台归档只放新缓存目录，旧客户端
忽略它，不改变原安装目录、凭证、数据库或持久偏好。

## 任务链接保留所属电脑

任务查询返回可选 `sessionUrl`，沿用 `cindy://session/<id>?device=<deviceId>`。
桌面外部打开与冷启动缓存的 session payload 新增可选 `deviceId`，Main、preload 和
Renderer 均保留它。导航先与本机设备 ID 比较；远端链接先登记现有会话 origin，
再通过原传输层读取，不把相同 ID 的本机伙伴任务当作目标。设备判断沿用入口导航器的
最新点击判据，迟到结果不覆盖后续点击。没有设备参数的旧链接保持原导航流程。
设备比较与链接生成均使用 auth 注册的本机标识，包含隔离开发实例的覆盖值。
外部入口与正文链接按设备和任务 ID 一起挑选远端镜像；显式 origin 优先于其它设备
的同 ID 分片，快照刷新不会将后续读取改到另一台电脑。
不增加 IPC channel、远程授权、重试或连接恢复；离线目标仍由现有传输层报告。
回滚后新增查询字段可忽略，但旧 Desktop 从外部打开远程链接仍有丢失设备参数的限制。
回归入口：`deepLink.test.ts`、`deepLinkIslandEntryBridge.test.ts`、
`botSessionOwners.test.ts`、`orcaSessionIdentity.test.ts`。

## 失败自动任务的人工续跑依据

既有输入队列投影增量携带可选 `errorCanContinue: true`：只由宿主确认当前错误属于
已落库且已释放恢复记录的自动任务输入。新控制端不再从历史用户消息推断，旧宿主缺省
该字段时不提供此 fallback；原有 retry token 与历史错误卡仍沿用旧路径。
旧控制端忽略新增字段。标记仅随当前错误存在，清错、下一轮输入和控制操作失败都会清除，
不落盘、不保留旧 run，不新增 channel、权限、服务端或原生指纹变更。

## 手机经电脑确认群消息已读

群 Remote Resource 投影新增可选 `supportsReadReceipts`，仅云端群声明。
新手机通过现有 `maker:remote-resources:invoke` 的 `read` action 提交实际可见的
`messageId`；宿主复核群可见性及账号代次，再复用 `chatServer.manage` 的读位确认，
不信任客户端提供的序号、不读取或确认尚未显示的新消息。旧宿主没有能力标记时，
手机保留原本地未读缓存行为；旧手机忽略新字段。`send.quote` 转交既有发送验证与水合入口。
不增加 IPC 白名单、身份权限或原生依赖，不重置连接、不重放发送操作；单群读位失败
留待该群下次可见或重连刷新，不影响其它设备连接。

## 设备模拟器官方 ID 更新

市场请求携带 `x-cindy-plugin-migrations: simulator-id-v1` 表示客户端支持这一次官方
`baguette-simulator` → `cindy-simulator` 安装身份迁移，不是权限或发布者凭证。
Server 保留原市场资源 ID 和不可变旧 Release；无能力声明的客户端继续获取旧 ID 包。
有声明的客户端获取新 ID 包，列表、详情、下载的 ghostId 必须与选中包的 manifest.id 一致。
新客户端访问旧 Server 时仍按旧 ID 运行。只有 Server 全量升级且客户端支持已发布后，
才可审核上架新包；不能只靠引用改名宣称旧安装已迁移。
回滚 Server 前须通过既有版本选择恢复旧 Release；不可在新包仍为 current 时回滚到不识别迁移的 Server。
迁移过的客户端保留新安装和原数据键，不会自动降级成旧 ID 或再装一个旧副本。
事务失败回滚是恢复尚未提交的旧安装，不是支持任意降级客户端二进制。迁移后不得退回不认识
该 receipt 字段的客户端并重建注册表；回退应保留这段兼容读取能力，避免重新派生数据键。

## 手动对齐 worktree 源分支

`worktree:list-branches` 的 IPC 响应可选追加 `remoteDefaultBranch`
（完整的 `refs/remotes/origin/*` 引用）；仅 UI 查询补充，失败不影响本地分支列表，
创建使用的 `listBranches()` 保持原样。列表仍按原有约定懒加载。
本地支持刷新；控制端查询 `worktree:branch-sync-status`，旧被控端返回
`DEVICE_LINK_CHANNEL_NOT_ALLOWED` 时隐藏刷新按钮，缺少可选字段时不显示远程分组，
本地分支选择与创建保持原行为。新被控端继续接受旧请求。
状态查询只读本地 Git；缺本地 tracking ref 不代表远程分支不存在，仍允许拉取。
仅拉取确认远程分支不存在后，在本次胶囊选择内置灰；换分支或重新挂载即重新判断。
同步仅由用户点击触发，按配置的 tracking remote/ref（否则 origin 同名分支）拉取一个显式
refspec，再按需快进本地分支。
手动 fetch 使用 `--progress`，连续 60 秒没有新增对象、接收字节或解包进度才超时；
重复进度行与普通输出不续期。本地探测仍有 5 秒上限，超时沿用整棵进程树清理。
单次命令用 `-c fetch.unpackLimit=1` 让小批对象也经过会报告字节进度的 `index-pack`，
避免单个大对象被 `unpack-objects` 静默接收时误判停滞；不修改用户 Git 配置。
新版控制端在 `worktree:sync-branch` 请求追加可选 `waitForResult: true`，被控端至多等待
10 秒，未完成时返回 `{ pending: true, operationId }`。后续请求带同一 `operationId`，
只等待原操作，绝不重新 fetch；句柄绑定账号代次、控制设备、仓库和分支。
运行中操作上限 64 个；已完成结果独立保留最多 64 个、最长 5 分钟，超量淘汰最早完成者，
不占用运行配额，也不淘汰运行中的操作。轮询连接错误后保留已收到的句柄，用户再次点击
只续接原操作；收到终态、终态错误或切换选择后清除句柄，不自动重放初始写请求。
未知、过期或不匹配的句柄报 `branch-sync:changed`，不自动重新执行。每次 invoke 仍沿用
90 秒传输预算，不修改共享链路的超时、重试或恢复策略；两个控制端的句柄互不通用。
旧控制端不传新字段，新被控端仍返回原终态；新控制端连接旧被控端时接受原终态，沿用旧端
Git 超时。长下载的完整体验需要两端更新。失败不重放写请求、不重置 peer 或 relay；
创建和发送不等待同步，不改用其它源引用。手机本轮不提供入口。无服务端或数据库变更。
实现见 `apps/desktop/src/main/worktree/branchSync.ts`；真实 Git 回归在
`branchSync.git-integration.test.ts`。

## IM 状态表情由客户端声明

官方 Slack / Telegram 的 `hello` 新增可选 `statusReactions`：`queued`、`error` 为
1–64 字符且不含空白的平台原生表情名称；`processing` 为 1–16 个名称，
`expressiveError` 为可选的 1–64 个名称。两仓 `slack-hook-protocol` 的类型、校验和
有效/无效 fixture 同步维护。客户端 `hook-control/statusReactions.ts` 生成平台配置，
Telegram 复用个人 bot 的变体池；X 不发送该声明。

服务端在已认证 hello 的同步段按设备登记，早于 welcome/派发；后续 hello 整体替换，
省略字段清除旧声明。任务使用原路由设备的配置，断线保留最近声明供收口；进程重启后
由重连恢复，在此之前使用兼容默认值。服务端继续负责状态生命周期、实际表情清理与
平台 API 拒绝时的一次标准回落，成功和取消不新增表情。样式不能改变权限或消息归属。

新客户端连旧 server：旧校验器忽略可选字段，照常使用旧样式；旧客户端连新 server：
使用兼容默认值。无需新消息类型或协议版本，无数据库、环境变量、Mobile 原生配置变化，
两仓可独立发布/回滚。完整效果要求两端支持，之后换肤色或表情池只需改客户端。
本次声明仅包含状态表情；进度和终稿文案继续复用已有客户端渲染，服务端命令文案未迁移。

## Session 显式项目归属（2026-10-30）

Session 列表与搜索摘要新增可选 `projectDir`，数据库 migration 0137 新增可空
`sessions.project_dir`。项目任务的缺省/null 继续按 `workingDir` 归组；
`workspaceKind: dialogue` 始终表示不绑项目，不从执行目录推断归属。新值只用于项目身份，
命令、文件、Git 与权限仍使用实际 `workingDir`。新客户端兼容旧宿主缺字段；旧客户端
忽略新字段，执行目录与项目不同时仍显示旧分组，需升级查看端获得一致归属。
没有修改 device-link allowlist、账号边界或任务路径权限。

灵动岛沿用同一归属：本机元数据读取和移动更新保留 `projectDir`，远程任务经现有
Renderer → Main 输入附带可选 `projectDir`，旧输入缺字段时回落到执行目录。
该字段只影响项目名称；伙伴群名和无项目任务的显示规则保持原样，不新增 channel 或能力。

手机首页与桌面远程镜像的既有列表缓存保留可选 `projectDir`（含显式 null），路径不截断，
旧缓存缺字段时继续回落到执行目录。移动菜单由共享组件按同一归属规则禁用当前项目，
避免把仍在 checkout 执行的任务误移回项目根目录；不新增缓存或存储版本。

跨电脑复制未另选目标项目时，沿用既有 destination 描述传递源项目的相对路径，
优先读取显式归属（不折叠已登记的 worktree 项目）；旧任务仍从 cwd 推断。
归属只决定目标项目位置，打包与恢复仍使用实际执行目录，不扩充复制协议或权限。

本机 Agent 工具的新建模式中，省略 `project_path` 继承来源归属，字符串选择已有项目，
显式 `null` 创建不绑项目的任务；适配层必须保留缺省与 null 的区别。
无法确定来源归属时明确失败，不以新执行目录猜测或登记项目。
不绑项目且未传 `working_dir` 时复用既有托管目录创建流程；传目录或使用 worktree 也不改变归属。
创建回执返回 `project_path`、实际 `working_dir` 与 `workspace_kind`；
`list_projects` / `create_project` 保留 `working_dir` 并新增 `project_path` 回执。
`send_to_session` 的既有任务投递不要求项目，跨电脑投递合同不变。

## 手机读取项目别名（#6916）

同账号 device-link 只读白名单增加 `local-db:project-aliases:list`，返回宿主现有的
`{ projectKey, alias, updatedAt }[]`；远程响应只包含宿主 `local:` / `remote:` 项，
控制端 `device:` 覆盖名保留在本机。本机 Renderer 的列表结构和范围不变。
`local-db:project-aliases:changed` 作为无数据的失效通知
加入 `sessions` topic；写入完成后带捕获的账号代次转发，手机收到后重读宿主。
不开放远程 `set/delete`，不改变路径、项目分组键或任务归属，不涉及服务端及数据库迁移。

手机只采用响应中 `local:` 项，并用来源 deviceId 和规范化路径隔离；不把宿主的 SSH／
另一台电脑的查看端别名套到本机项目。该平面投影继续兼容既有最近工作区入口；
首页、详情和项目筛选采用文末的主机平台/账号快照，同时保留此处的别名搜索能力。
共享展示函数兼容两种只读投影；完整项目成员含不同本地/SSH 身份时保持目录名，
不能因搜索、状态或置顶筛选借用剩余一条的别名。
订阅完成、前台恢复、链路重连及设备恢复可达时重读；旧账号／旧连接的迟到回复丢弃。
恢复只影响单台设备的元数据读请求，不重置共享连接、不重放写操作；瞬时失败保留本次
挂载内的快照并最多重试两次。清除别名回到目录名。

远程任务搜索在宿主的完整可见候选集合中匹配本机项目别名，再排序和截断结果，避免
手机首页 200 条缓存漏掉旧任务。沿用既有搜索请求与响应，项目／状态等筛选不变；
别名命中不生成任务标题高亮，不将本机别名套到 SSH 项目。旧宿主／离线仍可补充缓存命中，
但完整别名搜索需要宿主升级；不要求手机加载全量任务。

新手机连接旧宿主遇到通道不支持时显示目录名；旧手机忽略新增通知，仍可读取既有结构的搜索结果。
完整同步需要两端都有此改动。没有 Mobile 原生依赖／配置变更。

## Device Link 局域网优先直连

可靠链路的 `link-open/link-accept` 增加可选能力 `direct-link-v1`。双方均支持且已完成
现有授权与可靠握手后，字典序较小的 deviceId 后台发起 WebRTC DataChannel；信令通过
既有 relay `push` 的 `device-link:direct-signal` channel 发送，含 offer/answer/close、
随机通道 ID 及两端当前 transport stream。客户端验证账号范围、双方能力、链路就绪与
stream 匹配后才处理；信令不进入业务可靠 FIFO，也不走直连。超时或信令丢失由独立退避
重试恢复，普通业务继续走 relay，不产生新 invoke 白名单权限或服务端协议版本。

直连重试保留 5 / 10 / 20 / 40 / 60 秒的指数退避档位，每次在当前档位的 80%～100%
区间随机错峰（含 60 秒封顶档），避免多个 peer 同时失败后集中重新协商。平均间隔约为
原固定档位的 90%；稳定连接满 60 秒后重置退避，撤权、断链或停止时仍取消待重试。

数据通道 `device-link-v1` 只使用可靠有序 SCTP；同一完整 envelope 拆为不超过 16 KiB 的
二进制片，首字节 0/1 表示续片/末片，剩余字节是 UTF-8。单条最多 `MAX_FRAME_BYTES`，
重组有字节、分片数和超时边界；在原可靠层接收之前重组，序号、去重与 ACK 语义不变。
桥接在途字节与 SCTP bufferedAmount 一起参与背压，平台静默失效同样会触发原有中继回退。

旧端不声明能力，双方仍走 relay；只升级一端不会启用直连。Desktop 与 Mobile 均接入，
同账号远程供应商沿用这条共享路径；跨账号供应商分享和共享任务继续由 relay 逐帧授权。
不改数据库、服务端、Mobile 原生依赖或配置。Mobile 使用现有 WebView，iOS 的 WebKit
网络行为参考 [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。
平台不可用或系统阻止局域网访问时沿用 relay，不能阻断业务。真实跨设备、iOS/Android
前后台及系统网络权限的发布验收必须另记实测证据；浏览器本机 smoke 不等同于真机通过。

## 自建中转服务（`packages/device-link-relay` 与客户端接入）

方案见 [`docs/self-hosted-relay-plan.md`](../self-hosted-relay-plan.md)。内核实现与官方 relay 相同的 v1 线协议
（`@cindy/device-link-protocol`），**不改 `PROTOCOL_VERSION`、帧格式或官方 relay / 服务端**。新增内容只存在于自建中转上：

- 认证方案 `Authorization: CindyRelay <设备凭证>`（WebSocket 升级与 REST 共用）。`DeviceLinkClient.authorizationScheme`
  增加可选值 `CindyRelay`，现有调用不传时仍为 `Bearer`。自建中转拒绝 `Bearer`；凭证无效时 REST 返回
  401 `RELAY_CREDENTIAL_INVALID`，刻意不用 Desktop `serverApiFetch` 会触发刷新/登出 Cindy 账号的三种错误码。
- hello-ack 的 `capabilities` 为空：客户端据此不发 `notify`、不发 `sharedTask` / `providerShare` 帧；
  中转收到带这两种范围的帧回 `BAD_REQUEST`，不转发。`userId` 为主人账号，`deviceId` 由凭证绑定，不信任自报。
- 官方 REST 同形：`/devices`（GET/PATCH/DELETE）、`/media/presign-put`、`/media/presign-get`、`DELETE /media`。
  媒体地址指向中转自身（带签名、短期有效、一次性上传、支持单段 Range）；`/ice-servers` 返回 404（客户端退回公共 STUN）；
  `/push-token` 返回 204 不保存；`GET /provider-shares` 返回空列表。
- 自建中转独有：`/api/device-link/relay/info`、`/relay/pair`（加入）、`/relay/admin/*`（仅主人设备凭证）、
  `/relay/blob/*`（媒体签名地址）。官方 relay 没有这些路径，客户端只在自建模式下调用。

- 设备签名（[方案 §16](../self-hosted-relay-plan.md)）：经自建中转转发的对端帧多一个顶层字段
  `auth: { t, b, r, c, s }`，中转原样转发、不解析（超过 512 字符或不是对象时回 `BAD_REQUEST`）。
  - `DeviceLinkClient` 的可选项 `frameAuth` 负责签名与核对，只在 `sendEnvelope` 和 `handleMessage` 两处生效。
  - 官方中转时它返回 null，wire 与旧版逐字节一致。
  - 签名覆盖的字段与序列化规则以 `packages/device-link/src/selfHostedRelayAuth.ts` 为准，改动它就是改协议，Desktop、Mobile、中转必须一起改。
  - 中转新增 `GET /api/device-link/relay/certs`（主人签发的设备证书）。
  - Desktop 与 Mobile 都在分发前核对入站帧，包含权限请求文案；证书未就绪时拒绝当前帧，
    未知设备或已知设备签名不符时有界刷新，不重连共享链路。Mobile 复用已有纯 JS 加密实现。
  - 签名上下文 `cindy-relay-frame/2` 包含接收端启动挑战 `r`，避免接收端重启后旧请求再次执行。
    共享客户端消费保留的 `device-link:relay-auth` push 请求/响应；仅认证请求允许空挑战，
    不进入业务分发、不建立控制链路、不改变远控开关。待发队列按稳定签名身份和设备隔离，超时/断线/换身份后不发送旧请求。
    接收端重启且证书迟到时仅发有界认证探测；验签通过的新挑战只可恢复本机仍有效的原 `link-open`，保持请求 ID、签名身份与期限，不能恢复任意旧业务写操作。
    中转已有 push 与 opaque auth 转发足够支持，无需新增协议 kind 或修改路由；互通同时覆盖关闭远控的手机接收插件同步与未建链查询。
    此自建功能尚未发布，开发期间旧的无 `r` 签名客户端需同步更新；官方客户端路径无此交换。
  - 加入申请必须带 `publicKey` / `proof`，同意必须带证书；`/relay/info` 的 `features` 声明 `device-signatures-v1`。
- 加入链接 `<cindy|cindycn|cindydev>://relay/join?u=<中转地址>&c=<一次性加入码>&o=<主人公钥>&s=<配对秘密>` 由 `@cindy/device-link` 的
  `buildRelayJoinLink` / `parseRelayJoinLink` 生成与解析，Desktop 与 Mobile 共用 `fetchRelayInfo` /
  `submitRelayPairRequest` / `waitForRelayApproval`。`DeviceLinkClient.authorizationScheme` 也可传函数，每次建连前取值。
- 客户端：Desktop 的地址与凭证经 `device-link/selfHostedRelayRouting.ts`（零依赖）读取，REST 统一走
  `deviceLinkApi.ts`（自建中转时带 `CindyRelay`、跳过账号刷新与会话失效；官方请求刷新后的重试只重读官方区域端点，
  不随中转选择切到自建地址）；Mobile 见 `apps/mobile/src/device-link/selfHostedRelay*.ts`。

兼容：未选择自建中转时，客户端与官方 relay 的行为不变（没有登记中转来源或使用官方中转时一律回到原路径）。
旧客户端没有入口；旧版手机无法加入自建中转。互通验证：`pnpm --filter @cindy/device-link-relay run interop`
（本机起中转、走加入流程，再跑 `scripts/device-link/interop.test.ts`，认证方案由 `CINDY_TEST_AUTH_SCHEME` 指定；
`CINDY_TEST_FRAME_AUTH` 提供测试签名密钥时全程开启设备签名，两端核对每一条对端消息）。

### 自建中转同步维护

服务器部署的 Nginx 自动接入使用中转 bundle `0.3.0`（`nginx` 为 SSH 部署内部 CLI）。公网仍使用
原有 HTTPS/WSS 地址、`CindyRelay` 认证、媒体签名地址及 v1 设备协议；不新增跨端帧、能力位或权限。
已部署 `0.2.0` 的通信行为继续兼容，需要自动配置 Nginx 时由现有升级入口上传新 bundle。
证书请求的网络重试与临时失败状态随 bundle `0.3.1` 提供；已部署 `0.3.0` 的服务器通过现有升级入口更新程序。
新增的证书状态 `transient` 为可选字段，旧客户端忽略；新客户端连接旧中转仍沿用原失败处理，线协议与主人身份不变。
Nginx 后端的 `--trust-proxy` 只对回环连接的单个有效 `X-Forwarded-For` IP 启用配对来源识别，
部署生成的代理配置必须覆盖该头；直连及默认未信任模式继续按 socket 来源限流，协议不变。
Desktop/Mobile 继续共用原客户端，无须更改服务端；验证入口见
[`self-hosted-relay-plan.md §15.3`](../self-hosted-relay-plan.md#153-第-3-步设备签名一键部署到服务器远程管理2026-10-28)。

**硬性要求：凡 Device Link 的改动会影响自建中转，必须在同一次改动中完成必要的同步适配、
兼容处理与验证。缺少这些内容视为未完成，不得只完成官方中转路径后把自建中转留到后续。**

- **触发范围**：共享客户端与协议（`packages/device-link`、`packages/device-link-protocol`）、
  relay 的握手／帧路由／顶层字段／能力协商、鉴权与设备签名、设备／媒体／ICE 接口，以及
  Desktop、Mobile 的连接恢复与中转路由。判断以实际行为影响为准，不以修改文件的位置为准。
- **一起适配**：修改前核对共享客户端、自建中转内核（`packages/device-link-relay`）及两端接入代码。
  需要调整的实现、测试和协议说明必须一起更新；能由已有通用转发或共享客户端直接支持的，
  不要求制造无意义的服务端改动，但必须说明为何无需修改并提供验证结果。
- **一起验证**：影响通信兼容或恢复行为时，必须运行共享客户端测试、自建中转测试，以及
  `pnpm --filter @cindy/device-link-relay run interop`，验证当前生产客户端与真实自建中转的
  加入、签名通信和重连。涉及设备、媒体等未被该互通场景覆盖的接口时，补充对应定向验证。
  官方中转测试或本地 fixture 通过，不能替代自建中转互通结果。
- **照顾已部署版本**：服务器上的自建中转不会随客户端自动更新。新增能力遵循可选字段与能力协商，
  核对新客户端连接旧中转时的行为；需要更新中转程序时同步维护 `RELAY_VERSION`、分发构建与
  升级入口。不兼容变化必须明确支持的版本、升级路径和旧端处理，不能只在两端同时更新时可用。
- **交付说明**：PR／交付中写明自建中转的影响、同步修改位置及实际验证结果。若只是官方服务内部
  扩容、数据库或监控调整，或已有通用转发足够支持本次变化，可以写明无需同步修改的具体依据；
  不得仅写「不涉及」或假定官方与自建中转会自动保持一致。

## 灵动岛完成卡操作

`local-db:sessions:activity` 追加可选的 `completionToken`，由任务所属进程按完成卡代次签发。
桌面控制端经活动镜像将它原样传到原生灵动岛；新完成卡即使文案和毫秒时间相同也会更换标识。
新 invoke `agent-island:completion-action(sessionId, action, completionToken)` 只支持 `mark-read` /
`archive`，复用同账号远控授权和既有任务发送锁；归属端在变更前核对卡片，归档另在现有
worktree 资源等待后复核。控制端先按既有工作区／自动化预检规则确认，再发送归档动作。

旧控制端忽略可选字段；新控制端连接旧归属端时，没有标识的远程卡片保留点击打开入口，
不提供滑动动作。旧归属端不识别新增 invoke 时恢复本机卡片，不回退到无卡片校验的归档／已读
请求，不重放。原生 helper 的完成动作追加同一标识，缺失时不执行。无需服务端、Mobile
原生配置或数据库 migration 更新。回归见 `agentIslandRemoteSessions.test.ts`、
`agent-island/__tests__/service.test.ts` 和 `localDb/ipc/__tests__/sessionsUpdate.test.ts`。

## 灵动岛群消息展示

Desktop Main 向随包分发的原生灵动岛 helper 追加可选 `groupChat` 展示字段（成员头像与本地化 @ 标记），缺省时沿用原卡片。
群卡使用独立 UI 标识，点击仍走现有群消息深链；不签发任务 `completionToken`，不进入任务活动广播或 device-link relay。
服务端已读／关注／静音判据与系统通知共用，未新增服务端接口、数据库、Mobile 原生配置或远程 IPC。
旧 helper 忽略可选字段后仍可显示标题和摘要、点击进入群消息；旧 Main 配合新 helper 保持原样。
回归见 `agent-island/__tests__/{state,service,deviceSessions}.test.ts` 与 `maker-ipc/__tests__/chatServer.test.ts`。

## 限额恢复时间查询

既有 `maker:usage:claude-subscription` 请求可选在 providerId 后追加 `true`，表示等待同一余量
reader 的刷新完成（仍遵守节流/退避），不改变返回结构、授权门或凭证归属。旧控制端省略参数时
仍使用缓存优先读取；旧被控端忽略新增参数，返回其已有快照。自动续跑只使用实际受限窗口的可信
重置时刻，不把请求成功当成已恢复，也不将远程快照替换为本机账号。无需服务端或 Mobile 原生更新。

## 群内独立头像

Chat Server 的 `/me.capabilities` 新增可选 `groupMemberAvatar: 1`；Desktop 的群投影对应
`supportsMemberAvatar`，未声明时不展示换头像入口，也不退回账号头像编辑器。
成员投影沿用 `avatar` 返回当前群的有效头像，并新增可选 `groupAvatar`（可空覆盖值）和
`defaultAvatarUrl`（账号头像）。旧桌面与手机忽略新增字段，沿既有 `avatar` 显示路径读取。
手机经电脑读取群资源时，成员解析须保留有效的 HTTPS `avatarUrl`，交给现有头像组件显示；
缺失或非法地址沿用原头像回退。回归覆盖群头像、恢复账号头像与旧数据解析，不新增手机编辑入口。
Desktop 既有 `chatServer.manage` 增加 `avatar` action；本机校验裁剪字节后复用 OSS 头像上传，
复用 `POST /conversations/:id/nickname`，仅提交当前成员与可选 `avatar` 公开地址，`null` 恢复账号头像。
该接口的 `nickname` 与 `avatar` 均为可选，至少提供一项；未传的字段保持原值，不回传缓存昵称。
昵称请求的旧字段、空串归一化、响应和幂等摘要保持兼容；不新增头像 HTTP 路由。
不新增 IPC channel 或设备互联权限。新服务端先部署，客户端随后发布；旧客户端在新服务端仍可读，
旧服务端拒绝新 action，不能写入全局账号资料。服务端新增可空列，回滚保留列与已保存头像。

## 远程链路流量治理：交互优先名额与 Subagent 变更推送

交互类 invoke（`maker:send`、`maker:abort-session`、`maker:input:enqueue` / `steer` / `stop` /
`resume` / `retry-last-error` / `remove`、`maker:resolve-interaction`、`maker:agent-task:stop`，
集合见 `packages/device-link/src/invokePolicy.ts` 的 `isInteractiveInvoke`）在控制端
`InvokeScheduler` 与被控端 dispatch 准入上各多 2 个（被控端全局多 4 个）消息名额，且在控制端
排队时先于普通前台请求出队；字节上限、超时、重试、授权与 wire 格式都不变。旧控制端没有本地
名额但仍可被新被控端多放行；旧被控端对新控制端照原上限拒绝，控制端沿用既有 BACKPRESSURE
重试。`maker:predict-prompt` 改为控制端后台档（只影响本地排队顺序）。

`local-db:subagent-runs:list` 的响应新增可选 `changePush: true`，表示该被控端会把本机
`local-db:subagent-runs:changed`（payload 顶层 `sessionId`，路由到 `session:<id>` topic）经
link 转发给订阅了该任务的控制端。新桌面控制端收到该标记后改为按推送重读、只保留 60 秒的
兜底轮询；旧被控端不带标记，控制端保持原 5 秒 / 20 秒轮询；旧控制端忽略该字段和未知推送
（Mobile 当前不消费此推送）。不新增 relay 类型、数据库 schema、权限或 Mobile 原生指纹，
云端无需改动。

桌面控制端的持久推送修复读（`messages:created` / 带 persistId 的 `maker:event` 之后 1.5 秒
重读最新页 + 交互快照）只在「窗口内最后一条推送之后已有一次成功应用的最新页读取」时才省掉；
读取失败或晚于该读取的推送仍会触发修复读。本地行为，不进入 wire。

## Agent 预热与远程发送路径

新增 invoke `maker:session:prewarm(sessionId, createOpts)`，Desktop 本机 Renderer 与 device-link
控制端共用，登记在 `REMOTE_INVOKE_ALLOWLIST` 并归入后台调度档；共享任务访客不在其准入表内。
控制端在已有任务的输入框里开始输入（打字、粘贴、开始语音输入）时调用（同一任务 30 秒最多一次；模型、深度、权限、引擎、目录等设置变了立即再请求一次），`createOpts` 与下一次发送
构造的相同；被控端立即回 `{ accepted }`，在同一把会话发送锁里复用发送路径的懒创建启动 Agent，
执行字段（agentKind、model、resume、provider、权限、Agent 所在电脑）照常按数据库校正。只对来源为
user / desktop / plugin / side-chat、状态 active、非协同、Agent 在本机且非 SSH 工作区的任务生效（不要求已发送过：启动加载目录自带的设置与钩子与随后的发送相同，预热只是把时间提前）；
已有运行时、待切换引擎、已有排队输入时不做任何事。预热出来、尚未发送使用的运行时最多 2 个，
10 分钟未发送即关闭；设置变更关掉了它时，下一次请求会重新启动；任何真实发送会接管它。旧被控端返回 CHANNEL_NOT_ALLOWED，控制端静默忽略，
下一次发送照常冷启动；旧控制端不调用，行为不变。

Desktop 新建页的未发送任务：本机普通项目 / 对话草稿开始输入时，任务先建出来（`local-db:sessions:create`
带 `provisional: true`，只接受本机普通任务），出现在本机任务列表、标题随输入变化，并按上面的规则预热；
清空输入经本机专用的 `maker:session:discard-provisional` 真正删除（仍未发送且无消息才删），第一次发送前经
`maker:session:commit-provisional` 转为普通任务（发送路径也会兜底转正）。这两个 channel 不进
`REMOTE_INVOKE_ALLOWLIST`。未发送期间不推给控制端：device-link 读任务列表时过滤掉、`sessions:created` /
`sessions:patched` 不经 tap 转发，IM 项目列表与 hook 最近任务也不列出；项目 git 初始化、插件「已创建」事件与
控制端创建通知延后到转正时补做。登记表在内存里，并写一份到 userData 下的 `provisional-sessions.json`，
没删掉的残留在下次启动、账号库就绪时清理；不加数据库列，旧版本只会把残留看成普通的未发送任务。

`maker:input:enqueue` 与 `maker:input:get-projection` 的 wire 不变。Mobile 已从同一被控端的
projection 见过 `inputDeliveryVersion: 1`、并从 projection / enqueue 回包得知该任务的
`clearBoundaryMs` 时，首次发送跳过发送前的 projection，直接带该边界 enqueue；被控端仍按原规则
校验，若以 `REMOTE_OPTIMISTIC_INPUT_CLEARED` 拒绝，Mobile 撤回本地准备并按原流程查询一次
projection 后重发（被控端拒绝时尚未收下，不产生重复）。旧被控端不回 `inputDeliveryVersion`，
Mobile 始终走原流程。Mobile 学到的这些结论绑定 device-link 连接代次，重连后清空并重新确认。
没有新的 push、数据库迁移或 Mobile 原生指纹变化。

## 伙伴个人聊天全文搜索

既有 `local-db:conversations:search` 的结果 `session` 增加可选
`companion: { id, name, role: 'canonical' | 'history', readOnly }`。
归属由 Host 的 `bot_session_links` 关联确认；群聊与渠道专线不下发。
本机搜索另允许渠道专线，并在 Desktop 本机结果中使用 `companion.role: 'channel'` 与 `readOnly: true`，
沿用现有历史只读页及消息锚点。远程查询仍排除渠道专线，远程回包与 Mobile 消费的角色范围不变；
不增加 IPC channel、请求参数或数据库字段。
`local-db:bots:get` 的远程精简资料增加个人 `sessions: [{ id, role, status }]`，
供控制端复核历史归属，不传提示词、工作目录或渠道配置。
搜索前按远程伙伴可见性筛选，缓存／排队回复投递时再次核查，保持原账号与隐藏边界。
新控制端连接旧 Host 时缺少 `companion` 就沿用普通搜索结果；旧控制端忽略新增字段。
历史定位需要更新查看端，旧端可能按普通任务打开；不更改既有请求参数、
IPC allowlist、relay、数据库 schema 或 Mobile 原生指纹。

## 邮件阅读会话

只读 MailMessage 可选增加 conversation（threadId 和按时间排列的 messages 摘要）。
摘要包含 messageId、url、from、date、subject、snippet，不附带所有正文；当前 messageId 必须在摘要中。
Host 验证摘要唯一性、数量/长度及链接属于同一插件声明域名；展开时复用现有 mailReader，客户端核对返回的账号和邮件 ID。
conversationUnavailable 表示当前邮件可读但周边邮件未能读取，界面提供重试。
桌面右侧阅读器定位当前邮件，长会话折叠中间摘要。旧查看端（含现有手机）忽略新增字段，保留单封阅读；旧插件照常返回单封。
沿用现有 IPC 和 mail-messages 远程资源，无新 channel、数据库迁移、权限或原生变更。

## 插件卡片文本表单

交互卡沿用 v2，在净化后的 div 上可选增加 `data-ghost-form` 字段数组，动作可选增加
`data-ghost-submit="true"`。桌面与手机共用 maker-shared 校验和标准文本控件；
不开放插件脚本、HTML input、文件输入或凭据输入。字段名唯一，最多 16 项，每项值最多 16000 字。
桌面既有 dispatchCardAction IPC 可选追加 formValues；远程 `plugin-card-actions` 投影可选追加
form 和 items[].submit，既有 invoke 的 input 可选追加 formValues。手机声明 `plugin-card-forms`
能力后，Host 才投影表单并省略重复的静态预览；旧手机保留预览、禁用提交按钮。Host 继续校验会话、
设备、页面与 revision，并检查提交字段与当前声明一致；真实点击票和 Agent 续接规则不变。
表单提交活动归原 callId，插件完成后原地更新卡片，不产生新的空操作卡。

新查看端连接旧 Host 时没有 form，维持原卡片行为。旧查看端忽略新字段；旧桌面保留
插件提供的静态预览，新 Host 拒绝缺少字段的表单提交。插件也必须拒绝缺少 formValues
的写入，并说明需更新客户端或通过原工具继续处理。发布时先升级 Host 和查看端，再发布
依赖表单的插件；插件须保留原工具入口，不把卡片不可用误报为业务写入失败。
字段可选 row（同排分组）和 collapsed（默认折叠）。kind:"recipients" 为可选展示提示：
桌面和手机按实测姓名宽度与卡片宽度折叠剩余人数，展开直接替换摘要；完整地址字符串照常编辑与提交。
旧端忽略 kind 并保留原文本编辑框，未知 kind 也退回文本框，不影响已安装插件。div 可选 data-ghost-change 动作 ID，
桌面 IPC 与手机 input 可选 formChange:true，Host 投递无点击票的 card-action 编辑事件；不唤起 Agent。
手机编辑事件校验当前 changeAction、字段和会话归属；同一编辑版本的自动保存回执允许 revision 变化，
发送校验完整 revision，或同一 formKey（即当前 changeAction）与声明动作。插件必须在自动保存期间保持 changeAction，在重新读取/替换草稿时换 ID。
自动保存回执不重建输入框，不覆盖正在输入的文字。插件负责保存、冲突处理及模型读写与卡片提交的一致性。
发送聊天消息前等待该任务已发起的编辑事件送达，避免远程输入被模型工具超越。
card-update 可选 sourceCallId：只接受当前在途、同插件同任务的工具调用，用于更新较早的卡片；
旧调用、跨任务、跨插件和脚本调用不能重开。旧 Host 忽略此字段，可能不更新超出宽限窗的旧卡，业务工具仍返回回执。
没有新 channel、服务端 schema、数据库迁移或 Mobile 原生 fingerprint 变化。

`ghosts:card-updated` 可选携带 Host 注册调用时确定的 `sessionId`，桌面实时卡匹配只使用
当前对话的推送，避免同插件在多个对话同时运行时串卡。旧 Host 缺此字段时不猜测归属，
等待工具结果里的明确卡片 ID；历史与 fork 的明确 ID 引用仍可显示。旧查看端忽略新增字段。
手机沿用按设备、对话和卡片 ID 获取资源的路径；没有新 channel 或插件作者契约。

公共邮件发送沿用 sending 状态，可选 pendingSend（deadline、label、cancelLabel、sendNowLabel）。
Host 仅在此等待阶段接受 mail:cancel / mail:now；动作不提交表单，草稿编辑锁定。
两端只显示倒计时，真正的 10 秒等待和发送由公共邮件 SDK 执行；同草稿重复请求共用一次等待。
撤销、重新读取或修改草稿取消等待，重启不会恢复自动发送。重启后点击旧倒计时的撤销或立即发送，
SDK 重新读取并恢复草稿；再次发送必须重新经过完整倒计时。旧端忽略 pendingSend，仍按 sending
锁定编辑；旧手机可能无法操作新增按钮，完整撤销交互需升级查看端。没有新 channel 或原生配置。

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

## Gateway 媒体请求计费

此契约仅适用于 Cindy AI provider（内部 `providerId='xd'`），按实际供应商身份判断，
与模型名称无关；自定义及第三方 provider 不走此计费头读取和落账链路。
个人版与企业账号的返回结构一致，共用同一解析器，不按账号类型分支。

成功创建媒体请求的 `X-Nova-AIGateway-Billing` 是 Base64URL 编码的 JSON，`cost` 为有限的
非负数，`model` 可选；其它供应商字段忽略。费用直接采用此头，不从 token 或展示价目推算。
头本身没有币种，客户端在提交前捕获同账号 Gateway 的结算币种与数据库归属；币种未知、
头缺失或非法时不猜测金额。旧网关没有头时继续提供媒体结果，不补算历史费用。
仅原始创建响应记账，视频轮询、下载、已保存结果恢复不重复记账；响应正文或下载失败不撤回
已经收到的有效计费。每日总额、模型费用和 Host 可关联的任务费用原子更新。
正文读取与记账并行，读取完成即结束网络超时计时；本地记账等待不占用正文读取时间。
账号数据库关闭前等待已发出媒体请求的记账结束，成功、拒绝、网络失败及提交前退出均释放
对应等待。旧插件代办通过 Host 的同插件在途调用恢复任务上下文；没有此上下文的后台生成
只记日账与模型费用，不借用当前聚焦任务。

目录暂缺币种时复用同账号已确认的结算币种；从未确认或目录币种冲突时仍不猜测。
旧版 v9 缓存未保存冲突标记且账号币种为空时，不能区分缺省与混合币种；在新的目录声明前
不复用历史币种给媒体计费头标注币种。
任务内媒体费在提交前绑定真实用户消息，`agent_meta.mediaCosts` 按币种保存实际费用，
与日账及任务总额同一事务落库。响应下方沿用 `userTurnMoney` 累计，晚到费用刷新原轮，
不修改聊天分段 `turnCost` 或订阅估值。定时运行与累计费用同时读取用户消息媒体账本，
保留纯工具运行的费用，避免与助手消息费用重复累计。

用量模型行的 `agentKind` 追加 `media`，token 数为 0，不虚构聊天引擎或 token 用量。
同账号设备同步沿用 `usage-device-rows-v1`；新版保留此行，旧版可能忽略新类别的模型明细，
每日费用仍通过既有日账同步，无新增 channel、权限或数据库 migration。

## 群聊邀请公开链接

device-link-server 的公开页 `<deviceLinkBase>/chat-invite/join#<token>[?app=cindy|cindycn|cindydev]`
与 Desktop 粘贴解析共用同一规则：口令为 43 位 base64url，只放在 fragment；URL 无 query、无用户信息；
fragment 只允许一个闭集 `app` 提示，不允许额外 `#` / `?` 段；协议为 https，仅本机回环地址允许 http。
公开页按 `app` 提示尝试唤起对应的 `cindy` / `cindycn` / `cindydev` scheme；手机由原生链接入口
交给单一邀请 Host，登录完成后继续同一邀请。浏览器限制唤起或尚未安装时保留复制／下载后重开原链接的后备；
真实微信与安装续接需单独验收。客户端解析见
`packages/device-link/src/chatInvitation.ts`（`parseChatInvitationToken`），继续接受裸口令与
`cindy://chat-invite/<token>`；链接主机只校验形状，从不作为请求地址，也不据此切换 Chat Server
或登录区域，口令只以请求正文发给当前账号的 Chat Server。

本轮生成出口部分切换：已核验公开页的 Global / 中国大陆构建，通过当前 `deviceLinkApiBaseUrl`
生成 HTTPS 邀请，口令仅位于 fragment，app 提示沿构建身份。开发构建及明确的本机回环端点
保留旧 scheme；开发公网公开页尚未核验，不宣称三区部署完成。不做运行期部署探测。
「伙伴 → + → 输入邀请链接…」继续保留；旧客户端点击 HTTPS 经页面转到 scheme 仍可用，
粘贴 HTTPS 需要支持该解析的新客户端。链接不会切换接收者的账号区域或 Chat Server。

Chat Server 既有预览接口兼容追加 `avatar` / `memberCount`，V9（2026-10-28）再可选追加
`memberAvatars?: Array<{avatar:string|null,initial:string}>`，不改请求或接受操作幂等合同。
在原邀请校验通过后统计 `state='joined'` 的人和伙伴；邀请中、离开、移除、封禁不计入。
摘要最多五条，Actor ID 升序，和 joined 总数取自同一 SQL 快照；头像取群内覆盖或 Actor 头像，
沿既有公开值支持 HTTPS、`cindy://avatar/preset/(cindy|dash|lizi)`、emoji、null。首字取群内昵称
或 Actor 名称 trim 后的第一个 Unicode 字素，空白为 `''`；无图片仍保留槽。不提供完整姓名、
Actor ID、owner、role 或 grants，不授予成员详情/历史权限，也不由客户端调用成员接口补齐。
旧字段 `avatar:null` 仍表示无群自身照片。旧端忽略摘要，新端接受旧服务端缺省；缺省/空摘要
显示群缺省标识，坏图原槽显示首字，未知人数不能当 0、不能用摘要长度推算。既有邀请拒绝条件
继续适用，不通过本次展示放宽。两端可独立升级，真实摘要/人数展示需服务端与客户端均支持；
生产部署另核验，不新增 schema、原生配置或安装归因。

## 聊天持久投影的历史修正（2026-10-26）

`BotGroupDetail` 可选追加 `historyRevision?: string` 与 `messageUpdates?: BotGroupMessageView[]`。
前者是不透明的本地投影重建代次，不是服务器房间 revision；新版 UI 发现它变化时丢弃已加载旧页，
再按需补历史。后者返回现有 `sourceMessageIds` 所列已展示消息的当前授权投影，包含删除 tombstone；
不把这些消息追加到最新页，按稳定 id 替换已有旧页。旧客户端忽略附加字段，新客户端连接旧 Host
时沿用原刷新行为。无新 IPC channel、无新的执行权限或服务端必需 capability。

HTTP 继续使用现有 snapshot、messages 与 `/changes`；游标为十进制字符串，计算使用 BigInt。
Desktop 推送帧串行提交本地事务后 ACK；Mobile 活动群先通过 changes 补齐并落盘，再 ACK 通知。
未加载范围不因推进 cursor 被标成已下载。收到 RESET_REQUIRED、成员历史边界变化或明确撤权后，
清除／重建旧覆盖，不能只换最新 100 条而保留未校验旧正文。无 hydrated message 的旧服务端事件
降级为重建投影；新增字段缺省时保留旧端行为。发送与执行上下文仍由现有服务端权限判断。

## 群消息附件的结构化投影

Chat Server 群消息投影（Desktop IPC 与 `bot-group-chat` 远程资源共用 `BotGroupMessageView`）的
`content` 不再包含 `[附件: 文件名]` 占位行，附件只在 `attachments` 里。尚未取到电脑的服务器附件也
保留一项，`url`、`path` 为 null，并带可选 `state: 'loading' | 'unavailable'`；取到后同一 `id` 换成
完整附件、`state` 缺省。新版手机解析该字段，在原位置显示「加载中」/「暂时无法加载」，点开说明状态而不当作
可打开的文件；旧手机忽略该字段，把这一项显示为带文件名的文件条，旧版 Markdown 回退仍为 `📎 文件名`。手机直连同样只从 media 块投影附件，正文不再拼 caption。给伙伴的上下文文本不变。
不改 channel、能力、服务端 schema、数据库或 Mobile 原生指纹。

## 手机直连群的设置管理

### 同账号跨设备伙伴候选

Desktop `chatServer.ownedBots` 返回账号所有可加入的伙伴；`botId` 表示 actor 的稳定 externalId，
不再保证存在本机 Profile。可选 `avatar`、`homeDeviceId` 用于候选展示，旧调用方可忽略。
建群仍提交 externalId，成员邀请仍提交 actorId；手机经电脑的 `create` / `add-member` /
`set-members` 保留原 input，新主机允许缺少本地行但能在 ownedBots 中确认的 externalId，
本机隐藏行继续拒绝。旧主机可能返回 MEMBER_UNAVAILABLE，手机保留错误，不伪报加入成功。
没有新服务端路由、迁移或原生模块改动；加群不改变 homeDevice 或执行授权。

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

Codex 的速度累计独立于计费桶：同一产品轮次中的原生接续保留已配对的输出与时长，
用户新消息同时清零；原生 turn 的测速源计数从零开始。计时未增加但输出增加的区间不进入
速度分子或分母，暂时发 `generationReliable: false`，下一个有效区间恢复；费用仍完整记账。
旧客户端使用的 `outputTokens` / `generationDurationMs` 与速度快照同源，不能用计费桶
补速度分子。若某个原生 turn 丢失过配对区间，其结束用量不附完整输出的生成时长。
`tokenSpeed.peak` 是新增可选字段，保存产品轮次内已测最近速度的峰值；新端跨重连读取，
曲线裁剪不再丢峰值。旧主机没有它时使用客户端已观察到的峰值，旧客户端忽略此字段。

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
渲染端同样以接收标记为准：缺失于历史页、但已证明晚于读取收到的正文不能再因消息时间戳
早于页尾被过滤掉；按时间插入缺失行，保留权威页内部顺序，后续读取仍可接管，删除与
rewind 继续遵守现有作废屏障。若较新的权威读取确认整段历史为空，即使 raw 删除推送
尚未抵达也结束旧接收标记的临时显示；不能把分页窗口中的缺失当成删除。离开页面变为
stale 时不能再用消息时间戳复活已被接收顺序判定为旧的正文。
历史画面已就绪时，两端只构建实际展示的历史序列，不额外解析随后会丢弃的 raw 渲染结果。
详情展开意图沿用串行队列，同一控制器只发送尚未发出的最新替换状态；不取消在途请求，
不跨控制器合并旧主机释放，也不记忆成功结果来跳过重连后的重新订阅。
本地 `history view changed` 调试记录使用设备／任务短引用与缓存、最新页、旧页、详情、降级、
重置来源及行数；手机滚动采样携带相同短引用和可见列表项数，区分数据替换与布局重测，
不记录正文、不扩展遥测上传。

历史页以 20 个可见项为目标；边界跨过子任务时，主机将起点前移到完整子任务入口，
并恢复额外可见项的正文，折叠详情仍按需读取。实际正文恢复后继续执行原有 1 MiB 页预算；
可先返回的完整较短后缀照常返回，只有不可分割范围本身超限时沿用旧的降级行为。
分页游标仍是原始消息 ID，返回结构、权限、缓存与 Mobile 原生配置不变；现有手机和
远程桌面均可读取超过 20 项的完整页，修复只需更新提供历史的主机。

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
DEBUG 统计只记原始／gzip／wire 字节与压缩耗时（按 5 分钟窗口汇总，单次 ≥100ms 单独记），
不记录正文或凭证。
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
  （可打开单窗口实时画面）、`deviceCode`（`{ code, url, origin }`，设备码登录）、`holder`、`remoteInput`、
  `agentPicture`（2026-10-30：码来自 Agent 截图，主人扫完手动交还；同时带 `agentControlled`，旧端照常显示该提醒
  与跳过；加密 offer 的 presentation 不变）等。
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

历史查询的可选 `teammate_id`、`source` 由源端在召回、排名、分页前过滤，仍与原调用方权限
及远程可见范围取交集。`list_sessions` 的 `time_field=activity` 同时控制时间窗、排序和游标，
活动时间取创建、更新、用户发送时间的最大值；省略时保持创建时间语义。新增输出
`lastActivityAt`、`companion`（持久伙伴关联及可证明的渠道），搜索元数据补充 `source`。
跨设备转发不丢筛选字段；旧端若拒绝新参数，保留失败设备组与 `partial`，不能重试成无归属
筛选的查询，也不能把失败当作无聊天。没有这些参数的旧调用保持兼容。

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

## 插件 Agent 模型目录的运行位置（2026-10-27）

插件同源 `GET /agent-models` 新增可选查询参数 `agent_device_id`（Agent 在哪台同账号电脑或分享来的供应商上；省略 = 本机清单）。无参响应在原 `models` 上追加 `locations: [{agentDeviceId, name}]`，与 Lead `list_available_models` 的 `locations` 同源（同账号在线且开了远程控制的电脑 + 生效中的供应商分享，不含本机）；位置列表读失败时仍返回 200，只省略 `locations`。带参时只投影那台允许远程调用的来源，响应回显 `agentDeviceId`，不附 `locations`。旧 Host 仍拒绝任何查询字符串，带参返回 400；新 Host 其它参数、重复参数、空或超过 128 字符的 id 同样 400。格式合法但那台离线、未知或没开远程控制时返回 503 且 `errorCode` 为 `NOT_AVAILABLE`，响应里没有本机条目，旧客户端应退回无参本机清单。不覆盖 SSH 远程主机目录，不改变 `create_worker` / `agent_device_id` 派工校验。实现与回归见 `electronSandboxAdapter.ts`、`ghostAgentModels.ts`、`workerAgentLocations.ts`。

## 定时任务的 Agent 运行位置（2026-10-22）

`maker:schedule:*` 读回的定时任务与写入参数新增可选 `agentDeviceId`（每次新建任务时 Agent 在哪台电脑或
分享来的供应商上运行，相对定时任务所在电脑；省略 = 本机），旧端忽略该字段。新 host 收到的写入改了
`agentKind` / `modelAgentKind` / `model` / `providerId` 却没带 `agentDeviceId` 时，把运行位置归回本机：
旧版手机端与旧版桌面远程编辑选的是任务所在电脑的目录，沿用旧位置会把那份来源派到另一台电脑。
`null` 同样表示回到本机。`cindy_scheduler` 跨电脑修改定时任务时拒绝设置 `agentDeviceId`，因为位置 id
只对定时任务所在电脑有意义。

项目自动化的 `.cindy/automations/schedules.json`（version 1）与既有 upsert 参数也保留可选
`agentDeviceId`：提升用户自动化、表单编辑和文件同步均与模型／供应商一起保存，字段删除时
清除已保存的位置。新 host 校验设备 ID 格式且要求显式模型；实际运行仍按当前账号的既有
远程／分享授权校验，不因配置文件带了设备 ID 而获得授权。旧配置省略时继续使用本机；旧客户端
不支持该字段，提升或编辑时可能丢失运行位置，远端项目自动化需使用支持此字段的客户端维护。

## Agent 跨电脑管理定时任务与发消息

产品规则见 [`../product-rules/agent-user-parity.md`](../product-rules/agent-user-parity.md)。

**定时任务不新增 wire。** `cindy_scheduler` 的 `schedule_list` / `get` / `list_runs` 新增 `device`
（`local` 默认、`all`、设备 ID），`schedule_update` / `pause` / `resume` / `delete` / `run_now` 新增
`device`（`local` 默认或设备 ID）。非本机请求走用户远程控制定时任务时已有的
`maker:schedule:*` channel，参数形状不变，被控端仍由原 IPC 入口校验并执行。`schedule_list` 的
`query` 文本筛选在发起端对返回结果做，不改请求。`device` 缺省时返回形状与原来一致，三个读取工具
都只多出 `scope: "local"`。跨电脑读取按电脑分组，离线、未开启远程控制、撤权、超时、不支持的电脑逐台
列出，`partial` 表示覆盖不全。`schedule_update` 跨电脑时拒绝 `bindToCurrentSession`；除
`intervalMs` 与下文模型选择字段外，其它字段的 `null` 清空仍明确报 `INVALID_PARAMS`，
不写出与意图不符的任务。其它电脑返回的定时任务与运行记录里，`targetSessionId` / `sessionId` 加上 `deviceId::` 前缀（与历史
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

## 桌面出站附件的本机读取拒绝（#6530）

控制端上传附件时，仅将源路径一致的文件系统 `open/stat/fstat/read` 的 `EPERM/EACCES`
标记为 `DEVICE_LINK_MEDIA_ACCESS_DENIED`。已知由该源文件打开的句柄，其 `stat/read` 操作
产生的无路径 `fstat/read` 拒绝在操作边界按已知来源分类；同样覆盖 OSS 的本地整文件读取
与流读取，不覆盖已有其他路径，不对网络或写入操作补齐来源。
源文件拒绝不触发直连冷却、连接关闭或 OSS
回退；消息仍整条不派发。网络、远端和其他路径的错误保留原有传输失败语义。
直传助手及 OSS 源读取边界即生成现有 IPC 格式的稳定错误，不保留原始私人路径或 cause，
非聊天调用方也不会收到原始读取错误。Desktop 的待发消息在该错误下直接恢复草稿，
不因后续远端查询离线而延迟或重试；该错误发生于派发前，不属于投递结果不确定。
Desktop 与 Mobile 的错误展示
提供五语“另存到可访问文件夹、移除旧附件、用附件按钮重选”指引。Desktop 待发失败状态
保留已知错误码至展示边界，避免提前翻译后退回通用错误；附件拒读标题与恢复步骤直接显示，
技术详情保持折叠。
不新增 channel、relay 字段或权限。生成该错误的是桌面控制端，不要求目标设备升级；
旧客户端遇到历史里的未知错误仍走原通用提示。SSH 的远端文件读取流程不变。
受信前台发送与队列编辑（`maker:input:update-content`）在单个源文件拒读后，允许一次原生
单文件确认并重试同一份草稿；后台任务不弹确认。Windows 大小写不同的选择必须由文件系统
文件身份（device/inode）证明为同一来源，不能仅忽略大小写接受。账号切换、代次变化、
窗口销毁或主页面导航会取消直传与 OSS 上传；各异步读取、预签名与 PUT 边界重新核对发起作用域，失效不再派发。
派发前失败对本次新上传对象做 best-effort 删除（OSS 生命周期兜底）；开始派发后，结果可能
不确定，保留对象供已接收消息读取。清理不改变服务端 ownership 校验。
这不授予 macOS 文件权限，也不证明微信拖入的系统授权生命周期已修复。

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

## 远程聊天发送本机文件夹

桌面拖入／粘贴本机文件夹时，控制端通过本地 `maker:chat-folder:upload` 自动打包，
作为普通文件附件放入现有草稿暂存区；发送时复用附件传输（直连优先、OSS 回退），
大小限制和重试行为与普通文件一致。preload 桥只接受原生 `File`，
由隔离世界的 Electron `webUtils.getPathForFile` 取路径；拒绝内存构造的 File，
不接受 Renderer 自选的源路径。`file-browser:remote-op` 的 `caps` 新增可选
`folderAttachment`；缺少能力时明确提示更新，不把控制端路径当作远程目录发送。
归档携带 `application/x-cindy-folder-tar` MIME；接收端通过普通附件物化入口下载到对应
任务，再安全解包到归档旁的 `.contents` 目录，Agent 和消息历史引用解包后的路径。
聊天附件的符号链接必须为相对路径且最终指向解包树内已有条目；绝对路径、越界、
悬空或循环链接导致解包失败并回滚。目录内有效链接链保留，普通目录下载策略不变。
归档与目录共用附件的发送失败回滚、排队移除和任务删除清理，不新增文件夹归属记录、
导入任务或回收定时器。发送前对端只有普通附件传输暂存，复用直传／OSS 原有过期回收。
本机草稿归档复用 `chat-attachment-cache` 的账号隔离与显式丢弃清理；不会因短 TTL
删除仍在使用的草稿。新建任务草稿无需工作目录。打包／解包不完整时整次失败。
发送等待打包完成，失败保留草稿；切换任务／取消后清理迟到暂存结果。
等待发送期间从聊天区外层拖入的后续文件夹也必须完成，任意一项失败均保留原草稿。
当前任务文件栏的目录拖拽携带来源标记，继续直接引用。SSH 入口目前明确提示不支持，
不传本机路径；手机没有本机目录拖拽入口。本次不改 relay、服务端或持久化 schema。
实现与回归见 `file-browser/chat-folder-transfer.ts`、`chatFolderTransfer.test.ts` 和
`chatInputAnnotationAbort.test.tsx`。

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

## 远程桌面闲置锁屏

能力 `idleLock?: boolean` 仅在被控端有原生锁屏能力时声明。新版控制端仅对该能力为真的
整桌面连接发送 `start` / `heartbeat.idleTimeoutMinutes`，枚举为 0、1、5、10、15、30；
0 为永不，缺省字段保持旧端行为。控制端本地默认 5 分钟，按电脑持久化 override。
代输入窗口不协商该能力；旧被控端不显示为已受保护。字段走现有请求解析与鉴权，
官方与自建 relay 均透明转发，不增加新通道或服务端状态。

被控端按单调时间计时，真实输入与手动剪贴板动作续期，心跳、视频与自动同步不续期。
闲置到期返回 `DESKTOP_IDLE_TIMEOUT` 并锁屏断开；控制端将其视为终态，只有显式 start
可恢复。开启闲置保护的连接失联也锁屏，阻止自动 resume。短暂媒体恢复仅撤销控制端
本地状态、保留有界的被控端 lease，由 resume 保留原倒计时；恢复失败仍在现有 12 秒
心跳到期处锁屏。不扩展其他 Device Link 通道的故障范围，不因远程桌面结束而断开整条链路。
普通显式 stop 仍保留旧语义；本机锁屏/睡眠与受保护手机退后台使用已有 stop.lockScreen。

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

直连分享任务的授权失效与进程重启分开处理：M 仍有该 run 但其任务许可已失效时，poll 只返回
既有 `closed/access-revoked` 终态，不读取该 run 缓冲的内容，也不再返回 `missing`。新旧控制端
都按终态关闭；真正不存在的 run 仍用 `missing`。本机两分钟断链宽限同时识别直连 Error.code
的 `ACCESS_REVOKED`（即使显示摘要包装为 `REMOTE_AGENT_UNAVAILABLE`）；只有已在断链窗口内
且仍持有效本机租约的任务才可请 O 为原 M 重新授权，首次撤权、明确终态与租约到期不触发恢复。
不新增 wire 字段、错误码或授权能力；O、M 和服务端仍逐次决定许可。旧控制端保持原行为。


供应商分享 `allocate` 成功响应可选追加 `leaseDurationMs`，由 O 在回复前按服务端已批准期限计算
剩余毫秒，最大 30 分钟，不是给 G 重新批准一次完整许可。G 从请求发出时的单调时钟保守计时，
新建和恢复任务都使用该期限；续权成功才替换期限。到期只结束该任务的本地执行资源，远端 close
无法交付也不等待普通断链的两分钟重试；不关闭共享 WebSocket、不重放请求、不换执行电脑。
旧 G 忽略新增字段；旧 O 缺字段时新 G 沿用原 30 分钟合同，M 仍为最终许可闸门。
字段存在但无效时拒绝把它用作任务授权；此增量不更改 `maker:remote-agent:v1` 或服务端请求格式。

供应商退出期间的恢复（2026-10-29）沿用 v1 与既有字符串 `closed.reason`，不加必填字段、
能力位或 relay 接口。新 host 的空闲 run 使用旧控制端已认识的 `ended + idleReclaimed`，旧端静默
收尾、新端保留本机部分；忙碌 run 用 `provider-restarting`，旧端仍走原有错误恢复，不劣于原来的
`aborted`。新版 host 的主动断开（`user` / `toggle-off`）使用 `controller-disconnected`，
新控制端按用户撤销结束，供应商组也不自动换电脑；旧控制端按未知原因走原可见错误。
`dropAllControllers('shutdown')` 把既有 teardown 值 `app-quit` 传给 host，与 `dispose()`
共用退出处理；两者重叠时等首次收尾写完，后来的 dispose 不得覆盖主动断开的原因。
新控制端保留 `aborted` **仅为兼容旧 host**：旧 host 的退出和主动断开没有可区分的字段／能力位，
因此旧端一键断开也可能自动接回一次；旧端关闭远程控制时重连被拒，最终显示错误。不能把这个
兼容取舍误用于新版 host。重启后 `poll.missing` 仍是兜底；首次打开即消失、本机主动关闭和
superseded 不自动复活。重开仍使用既有 `resumeSessionId` 与权限检查，运行中
中断后的自动续跑拒绝原生会话 ID 不匹配，不自动接受空白新会话。中间层照常透传字符串原因。
自动动作沿用 `autoResumeInfo.agentReconnect`，桌面和手机无需新增显示协议。
回归见 Desktop `connectionPool.test.ts`、`hostLifecycle.test.ts`、`poll.test.ts`。

共享模型分叉追加 `caps.nativeFork: true` 与 `op: fork`，仍使用
`maker:remote-agent:v1`，不改变 relay、版本号或服务端。控制端先协商能力；旧运行端
缺少能力时明确提示更新，不把历史复制成没有原生上下文的本地任务。旧控制端忽略新增能力。
任务和消息仍在任务所属电脑落库，新任务保留历史片段的 `agentDeviceId`、供应商、模型和原工作目录。
曾经换过运行电脑时，按 `agent_switch.fromAgentDeviceId` 向保存该片段的电脑分叉，
子任务也继承这一运行位置（显式 `null` 表示本机）；旧边界缺少该字段时沿用任务的运行位置。
历史片段的原生会话因 `context_rebuild` 失效时，既有交接分叉仍沿用这一设备判据；
重建只决定原生会话能否复用，不把子任务改送到当前设备。
Desktop 与 Mobile 沿用 `maker:fork`；共享任务访客与 SSH 工作区的现有边界不变。

运行端上 Agent 原生分叉失败时回 `REMOTE_AGENT_FORK_FAILED`(原始原因只记运行端日志)，但只回给
`op: fork` 带了可选 `acceptsForkFailed: true` 的控制端；组所在电脑转发时原样带上受邀者的声明，旧控制端
不带、旧运行端忽略，照旧得到 `REMOTE_AGENT_UNAVAILABLE`。经供应商组转来的请求在组内电脑缺 Agent 时回
`REMOTE_AGENT_UNAVAILABLE`(位置类，组所在电脑统一成「暂时不可用」)，直接调用方仍得到 `REMOTE_AGENT_UNSUPPORTED`。
实现见 `apps/desktop/src/main/remote-agent/host/runHost.ts` 与 `controller/fork.ts`，回归见
`groupRelay.test.ts`、`groupRelayClaudeFork.e2e.test.ts`。

运行端按已认证调用方复核供应商权限；受邀者及转分享还必须拥有来源原生会话。
存储目录由运行端派生，不接受调用方传入路径。Claude 返回消息 UUID 映射，
Codex/Pi 在受邀者原有隔离目录分叉；新原生会话登记到既有归属索引，支持继续分叉和恢复。
供应商组按来源会话已有的成员绑定逐层转发，不重新选电脑，也不把成员身份暴露给受邀者；
仅本机执行分叉时检查本机 Agent 是否已安装。Codex 受邀者的一次性分叉进程沿用独立代理作用域，
不修改分享者本机任务共用的代理配置，关闭进程时沿现有回收路径释放。
分叉祖先的影子目录 ID 保存在既有归属索引；启动的 `workspaceProjection` / `started`
追加可选 `previousMirrorRoots`，使历史文件路径仍映射到控制端原项目，权限检查沿用真实路径。
同账号远程任务也保留此映射，连续分叉和运行端重启后仍有效。
执行前后检查账号、分享与转分享权限。分叉是一次写操作，超时或断线不自动重发；
失败不创建 Cindy 子任务，不回退本机，不重建共享连接或影响其它 peer。

回归：`remoteAgent.test.ts`、Desktop `fork.test.ts`、`guestHost.test.ts`、
`groupRelay.test.ts` 与数据库 `client/__tests__/tx.test.ts`；三引擎沿用原生分叉入口。

Codex 原生图片恢复（#6412）在既有 `maker:remote-agent:v1` 上追加可选
`caps.imageRecovery: true` 与 `op: images`，不改变已有事件行格式与协议版本：

- `list(sessionId, offset)` 每页最多 64 条，`read(sessionId, imageId, offset)` 每片最多
  512 KiB，返回总长度和 SHA-256；接收方复核完整字节指纹与真实 MIME。
  `release(sessionId, imageId)` 是持久交付回执，可重复调用。入参不接受任意文件路径；
  Host 从已认证 caller 与任务 ID 派生私有 scope，返回前再次检查撤权。
- 新控制端在 `open` 声明 `acceptsImageDeliveryReceipts: true`，源 Host 才建立持久恢复副本；
  供应商组逐层透传该声明。旧控制端缺少声明时，源 Host 仍验证/读取图片并以 data URL
  交付，但不建立无法确认释放的恢复引用。旧源端忽略可选声明，新控制端仍按其 caps 决定恢复能力。
- 协商回执后源 Host 先入仓再发事件。两种路径均以 data URL 单独携带字节，
  兼容仍优先读取 path 的旧控制端。
  新控制端接受旧事件；旧源 Host 已丢失字节的 path-only 事件只能呈现交付失败，升级源端
  后新产物才具备恢复能力。旧端未声明 capability 时不自动请求 `images`。
- `images` 可选携带 `relay`，与 `open` 相同，scope 始终由已认证 caller、relay、任务 ID
  派生；只有明确声明 `caps.imageRecoveryRelay` 的源端才发中转释放，避免旧端忽略 relay
  后误确认。旧端未升级时保留中转回执，正常图片事件继续交付。
- `open.imageDeliveryEpoch` / 图片 `deliveryEpoch` 是任务 Host 的清空代次（初始 0），
  经供应商组透传，源端不使用自己的时钟换算。旧端忽略可选字段；缺少代次的旧产物在清空时
  保守保留，删除任务仍可全部释放。新代次产物不能被此前离线清理回执删除。无需服务端升级。
- Desktop / Mobile 手动重试走同账号 `maker:images:retry(sessionId, imageId)`，不进入
  共享任务访客清单，不进入自动重放。旧任务 Host 不认识通道时保留失败状态。
- 失败半径是一个产物：恢复不重启 relay、不关闭其它任务、不重新调用生成模型。
  源文件、接收端消息、任务引用和释放回执分别验证，不把传输成功视为最终保存成功。

同账号的 A(任务、项目文件与命令所在)可以让 B(打开了「允许远程控制」)用 B 自己的 Agent 程序、
登录(含 Claude 订阅)、供应商与网络运行 Agent。新增 invoke channel `maker:remote-agent:v1`
(`packages/device-link/src/remoteAgent.ts`)，只进同账号 allowlist，不进共享任务清单；被控端
`dispatch.ts` 对共享任务访客再拒一次。

- **方向**：A 始终是发起方。`open / call / reply / push / close / upload / caps` 是 A → B 的指令，
  `poll` 按游标拉取 B 的 NDJSON 事件流：同一台 B 上的全部任务共用一个 poll(一次带上各任务游标，
  最多 64 个；无新数据时 B 挂起最多 10s)。A 登记新任务时可再发一个覆盖全部任务的 poll(两个长等待都只含
  旧任务时再多一个只为新任务补位的，合计最多 3 个；只是 A 本地调度，B 对并发 poll 本来就逐个处理)，几个 poll
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
  B 的隧道对镜像根内 A 映射不到的虚拟垫层，以及 A 在 `open` 的 `ancestorMarkers` 里明确报了「没有」的上级目录
  标记，只读查询由 B 本机回答。镜像根外的绝对路径照常转发，只有两端路径格式相同且 A 明确报告其缺失的标记
  才可本机回答；隐藏文件和未知外部标记不能凭名字判不存在。本机回答使用
  原生的不存在错误 `-32004`(固定版本 `codex-rs/exec-server/src/remote_file_system.rs` 按 NotFound 处理)，不转给 A；
  B 的 Codex 在执行环境断开时按同一个 id 重新 `environment/add`，先用实验接口 `environment/status` 判断。两者都随
  Codex 版本可能变化，升级时一并核对(见 [`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)
  「托管 Codex 启动的跨机往返与执行环境恢复」)。
  非完全访问档下 `process/start` 与 `fs/*` 带 `sandbox`(固定版本 `codex-rs/file-system/src/lib.rs` 的
  `WireFileSystemSandboxContext`)，其中目录与权限条目都是 B 上看到的 file URI，中继换成 A 的路径：虚拟工作区内的
  映射为本机路径(绝对 glob 里本机目录名按字面转义)；不在其中的是 B 自己的目录(如它的 Codex 记忆目录)，读写
  授权丢弃，只收不放；禁止规则不因转换失效：路径条目在 A 上也是合法绝对路径时原样保留，没映射上的禁止 glob
  一律原样保留；用户目录对不上时换成 A 本机的(Codex 缺了它会把 `~/…` 规则当解析失败、一律拒绝读取)；
  `file:///C:/…` 是否为盘符按 B 的路径约定(虚拟工作区路径)判断；网络配置按原值透传。Windows 沙箱档位通常
  保持原值；唯一例外是在已有虚拟映射、Agent 路径为 POSIX、本机执行端为 Windows、`permissions.type=managed`
  且 `windowsSandboxLevel=disabled` 时，选择本机 `restricted-token`，见[远程适配规则](remote-and-mobile-adaptation.md)。
  显式 Windows 选择、非受限请求与无虚拟映射的 legacy 分支不改；原生实现无法落实限制时仍拒绝，不删规则或转无沙箱。
  原样转发时两端系统不同可能被 A 的 exec-server 拒绝(`invalid sandbox permission path URI`)。
- **Codex 启动清单批量探测（2026-10-29）**：B 在单条 exec-server 连接启动时，把首个插件清单所在
  目录及其祖先的三种清单检查提前发送（最多 64 层／192 条）。全部仍是旧协议支持的普通
  `fs/getMetadata`，使用独立字符串 ID，保留原 params/sandbox，经 A 的原路径映射和原生执行器；
  不添加 wire 字段、方法、IPC、权限或能力协商。只有原生 NotFound 可在本次启动复用，已有文件、
  权限错误、未知目标和不同 sandbox 回落原查询。启动结束或写入／进程启动即停止复用，连接关闭清理；
  迟到内部回复仅在本连接消费，不重放写操作、不重置 peer/relay、不影响其它任务。
  新 B 配旧 A 可直接使用；旧 B 保持串行。供应商组与自建中转只转发既有不透明 ws 数据及有界
  poll/push 批次，不解析内部 JSON-RPC ID，因此无需中转、服务端或 Mobile 同步修改，
  帧大小、鉴权、签名、ACK 和恢复策略不变。回归为 `execServerStartupBatch.test.ts`、
  `startupProbe.e2e.test.ts`、`mirror.test.ts`、`groupRelay.test.ts` 与 `hostLifecycle.test.ts`；
  真实跨系统及线上分享运行端尚未验收，性能数据与复跑命令见远程适配文档。
- **影子目录与配置同步**：`open` 载荷除项目说明文件(含 `.claude/CLAUDE.md`、`.claude/rules`、
  `.codex/skills`)外还带 `ancestorFiles`(项目上级目录里的
  `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` / `AGENTS.override.md`，按层级 `up`，最多 24 级)与
  `personal`(A 的个人配置：Claude Code 的 `~/.claude/CLAUDE.md`、`skills/agents/commands/rules`、`settings.json`
  里的权限规则；Codex 的 `AGENTS(.override).md`；Codex / Pi 的个人 Skill 放在 `.agents/skills`、
  `.codex/skills`；不含 hooks / env)。两者缺省按空处理。Codex 任务另带可选的 `ancestorMarkers`
  (`{ names, levels: [{ up, present }] }`：A 检查过的名字与各级上级目录里存在的那些，`up` 从 1 起到根目录、最多
  24 级)，只报名字在不在、不带内容，Agent 本来就能逐个查到，不多泄露上级目录的其它内容；格式有任何不对 B 整段丢弃。
  旧 A 不带、旧 B 解码时丢弃，都退回逐个转发，只是慢。B 把影子目录按
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
  (null = 任务所在电脑)；不带 = 位置不变(旧控制端与内部调用都走这里，A 不做推断)。pending 意图投影
  只在换电脑时多出 `agentDeviceId`。边界行始终记录 `fromAgentDeviceId`(null = 任务所在电脑)；
  `toAgentDeviceId` 仅在换电脑时出现，作为分隔条与换机判据，`fromAgentDeviceName` /
  `toAgentDeviceName` 也只在换电脑时出现。旧端忽略这些字段即可(旧端的分隔条显示成「从 X 切换到 X」)；
  旧版边界行可能没有 `fromAgentDeviceId`，消费方按无设备证据兼容。
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
  `REMOTE_AGENT_DEVICE_UNREACHABLE` / `REMOTE_AGENT_SHARE_*`；SSH Lead 回
  `INVALID_PARAMS`。与 `executionDeviceId` 同给时，位置相对工作电脑，省略或 null 使用该电脑默认；
  Lead 的 Agent 在其他电脑运行不影响创建。工作电脑 `remote-worker:caps.agentDevice: true` 且 Lead 的
  `execution-devices` 投影 `supportsAgentDevice: true` 才开放独立位置；显式字段发给旧端前返回
  `UNSUPPORTED_CAPABILITY`，不静默建错。新增同账号 `maker:orca:remote-worker:models` 查询 `{agent?, agentDeviceId?}`，
  返回模型列表与 `locations`；共享访客不可调用。open 新增可选 `agentDeviceId`，回包可带准入后的
  `agentDeviceId` / `providerId`；旧请求仍保持原行为。`list_available_models.execution_device_id` 从工作电脑读取目录。Worker 列表(`local-db:orca-workflows:list-workers-by-lead` 的 `session.agentDeviceId`)只在 Agent
  不在任务所在电脑时带值，旧端忽略即可。Lead 的 MCP 工具同步：`list_available_models` 可选 `agent_device_id` 并返回
  `locations`，`create_worker` / `create_workers` 可选 `agent_device_id`(`"local"` = 任务所在电脑)。同账号 allowlist 新增上述 models 查询；共享任务清单不变。回归见 `orcaWorkerCreationService.test.ts`、`CreateWorkerPopover.test.tsx`、Mobile
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
- **分叉**：通过 `nativeFork` 能力协商在原运行端执行，见本节开头的分叉协议；旧运行端提示升级。
- **暂不支持**：审查、复制到其他电脑、导出 `.cshare`(Agent 会话记录在 B)，入口隐藏、
  主进程拒绝。
- **移动项目可用**：B 上的影子目录只按「控制端 + 任务 id」定址(虚拟工作区为必需能力)，与 A 的工作目录
  无关；A 换目录后关闭空闲 handle，下次发送按新目录重建，B 上的会话记录原样续用。
- **提供方闲置收回**(2026-10-22，用户确认由提供方决定；产品规则 `provider-sharing.md` §3)：B 的主人在「远程任务数量」里设
  「闲置收回(分钟)」(`RemoteAgentLimits.idleMinutes`，0～1440，默认 30，0 = 不收回)，对全部控制端统一生效。仍用
  `maker:remote-agent:v1`，不改 relay、服务器、数据库或协议版本；新增的都是可选字段：
  - **B 收回**：巡检(每 5 秒)看到任务不忙且闲置满这个时长，就结束它的 Agent 进程。「忙」= 有等 A 回包的反向请求、
    执行中的调用、Claude Code 待生效的回退(`commitRewindFiles` 成功后到下一个 `done`；Codex / Pi 返回时已完成回退)、还没启动好，或 Agent 状态里有在跑 / 在准备的
    回合、后台任务、待唤醒续跑(中转任务看组内电脑报来的同一组字段)；巡检时忙就把闲置起点移到此刻。活动 = 打开、
    `call` / `reply` / `push`、写进事件流的非 `state` 行；只被 `poll` 不算(闲着的任务 A 也一直在拉)。
  - **收尾**：`closed` 行写 `reason: 'ended'` 并带可选 `idleReclaimed: true`，保留 3 分钟以覆盖 A 的 2 分钟断链重试
    （普通收尾保留 1 分钟）；Agent 进程与名额仍在收回时立即释放。旧 A 不认识这个字段，按 `ended` 静默收起，
    Maker 把事件流结束当成句柄已死、自动关闭任务，下次发送照常重建并带原生会话 id 接回(本机后台命令随句柄结束)；
    新 A 不关句柄，与连接池让出名额同一状态(released)，本机部分保留，下次要 B 干活时连回。中转时组所在电脑把这个字段
    原样转给受邀者(`relayClosed`)，`ended` 本来就在正常收尾的原因里，不触发换电脑。
  - **A 报 hold**：`poll` 的每个任务项和 `push` 请求可选 `hold: true`，表示 A 这边还有 B 看不到的工作(当前只有 Codex 经执行环境在 A 上起的、
    仍在运行的进程，`ExecServerRelay.busy()`)。本机进程的启动回包随 `push` 立即报 hold，不必等下一批 poll；组所在电脑逐跳接着报。
    B 收到后在控制端的 3 分钟存活窗口内按忙处理，后续 poll 未带 hold 就解除，
    再从忙完后计算闲置时长；组所在电脑在同一窗口内接着给组内电脑报 hold。大量任务按批轮询可能超过最短的 1 分钟
    闲置设置，不能只把收到 hold 的那一刻算作活动。poll 的 hold 只在请求抵达时应用，等待结束后仅刷新存活时间，避免旧快照清掉新 hold。
    旧 B 解析 poll / push 时丢弃不认识的字段。
  - **caps**：B 声明 `idleReclaimMinutes`(不合法时当作没声明，不让整个 caps 作废)。A 的连接池按它判定「闲置满」，
    旧 B 不声明 = 0，不让出。
  - **四种组合**：A 新 × B 新 按上面；A 新 × B 旧 不收回、不让出；A 旧 × B 新 被收回后静默重建；A 旧 × B 旧 不变。
    远程管理时，旧版电脑的设置读不到 `idleMinutes`，界面不显示这一项、也不提交(旧版会拒绝不认识的字段)；
    旧控制端管理新电脑时只提交原来的两项。
  - **故障半径**：只结束这一个任务的 Agent 进程，不动 relay、链路或同一台 B 上的其他任务。
  - **已知限制**：B 结束进程与 A 同时发来调用的窄窗口里，那次调用会失败(B 没有执行它)，下一次发送正常连回。
    Pi 任务经供应商组转给旧版组内电脑时，旧版会改写接回用的会话 id，接回时提示上下文没接上。
    回归见 `remote-agent/__tests__/hostLifecycle.test.ts`(收回判据与收尾行)、`connectionPool.test.ts`(新控制端保留本机部分
    并连回)、`poll.test.ts`(hold)与 `packages/device-link/src/__tests__/remoteAgent.test.ts`(字段解析)。
- **控制端连接池：名额紧张时让出闲置任务的 Agent 进程**(2026-10-17；2026-10-22 起闲置时长改由 B 声明)：B 按发起设备限制同时开着的 run(`caps.maxRuns`)，
  A 上开着的任务即使闲着也占名额。A 对每台 B 一个连接池(`controller/connectionPool.ts`，计数口径与 B 的 `limitDeviceOf`
  一致：这台设备)，**只在名额紧张时**让出「不忙且闲置满 N 分钟」的连接；N 是 B 在 `caps.idleReclaimMinutes` 里声明的闲置
  收回时长(A 原来的本机设置已删除；B 没声明或为 0 时从不让出，满了直接报错)。闲置满 N 分钟的任务 B 本来也会自己收回，
  连接池只是名额紧张时不必等它那一轮巡检。主动让出前重新读取 B 的 caps，读取失败不按缓存值关进程，
  主人改为 0 或延长时长不必等 A 再打开连接才生效。三条路径都只让有资格的：
  A 在这台 B 上开着的连接数到了水位线 `ceil(maxRuns×80%)`(只在水位线低于上限、即 maxRuns ≥ 5 时；每次 open 前与每分钟查一次)
  按最久没活动的顺序让，直到降到水位线以下；open 前已满先同步让一个；open 被拒且是名额类 `REMOTE_AGENT_BUSY`
  (`[DEVICE_LIMIT]` / `[TOTAL_LIMIT]`，旧 B 是 `too many tasks are running from this computer`；`too much staged data` 不算)
  让一个再**只重试一次**。没有有资格的就照常 open / 照原样报错，B 才是最终裁判；不排队等名额。
  - **不改 wire**：让出用已有的 `close`(mode `close`、reason `navigation`；不用 `detach`，它不结束 B 上的进程)，连回用已有的
    `open` + `options.resumeSessionId`(远程 Agent 第一版就有)；maxRuns 每次 open 前从 `caps` 读最新值(旧 B 固定回 16，正是它的
    硬上限)。四种版本组合：A 新 × B 新 / B 旧都只用这两个 op；A 旧行为不变(不让出)；B 侧代码未改，没有新的会话状态字段，
    手机端无感知。
  - **本机部分跟句柄走**：执行器(含 `ShellSession` 后台命令，让出后仍可按原 ID 读取)、本机 MCP 身份、Codex exec-server 中继
    都不随让出关闭；中继只关掉为 B 上 Codex 起的 exec-server(B 的 Codex 已退出)，连回来的 Codex 重新连。句柄对 Maker 一直是活的，
    状态镜像(用量、模型、计划模式等)照常读；连回后新进程还没报有内容的用量前保留上一次的读数。
  - **「不忙」**：A 侧没有进行中的方法调用、回包与推帧；状态镜像里没有在跑 / 在准备的回合、没有后台任务(`backgroundTasks`：
    Claude Code 后台子代理与后台任务、Pi 子代理)与待唤醒续跑(`pendingWake`)；Codex 中继里没有仍在运行的 `process/start` 进程
    (后台终端；按 exec-server 的 `process/closed` / `process/exited` 与启动失败判断，固定 Codex 0.159.2 实测)，也没有在等本机确认的消息；
    回到某条消息后、下一轮跑完前也算忙(Claude Code 要到下一次发送才在 B 上截断)。A 本机执行器里的后台命令不算忙。「闲置满 N 分钟」从最后一次活动算起：由忙转闲(后台任务、待唤醒续跑清空，
    Codex 中继里各连接上的工作——在跑的进程、启动中请求、待确认消息——由有变无：进程结束、启动失败、确认处理完，
    或带着工作的 exec-server 连接被整条关掉)本身算一次活动，后台工作再久，结束后也要再闲置满 N 分钟才让。
    会话 id 在旧 B 上可能被改写的仍不让：旧 B 打开时把启动选项里的字符串按 A 的工作目录及各级上级目录、用户目录与附加目录投影到虚拟
    工作区，`resumeSessionId` 也不例外；Pi 的会话 id 是 B 上的会话文件路径，两台同为 Mac(`/Users`)或同为 Windows 时
    常落在这些前缀下，带过去会变成不存在的文件。A 按同一规则预判(`hostRewritesResumeId`)，这样的 Pi 任务不让出。
    修正 #6479 后的 B 仅将 `resumeSessionId` 逐字传给 Agent 启动入口，其它字段与提示仍按原规则投影；
    受邀者的会话归属、Pi 会话目录和供应商授权检查保持不变。这是既有字段在 Host 内的处理修正，未新增能力位或改变解析协议。
    A 尚不能由能力声明区分新旧 B 或确认组内实际执行端，因此继续按 `hostRewritesResumeId` 保守预判，不随此修正放开让出。
  - **连回**：只有要 B 上的 Agent 干活的调用触发(`send` / `steer` / `resumeBackgroundTask` / `compactSession` / 回退，以及要 B 回答的
    `previewModelSwitch` / `getContextUsage` / `getCodexContextWindowInfo`)；`requiresModelSwitchRebuild` 已让出时回 false(下一次连回
    本来就是带新模型的冷启动接回)；只改设置的
    (`setModel` / `setEffort` / `setFastMode` / `setPlanMode` / `setThinkingEnabled` / `setPermissionMode` / 目录 / `setVendorOptions`)
    已让出时只记在 A，`abort` / `requestGracefulStop` / `stopBackgroundTask` 已让出时什么也不做。会话里还没有对话(不是接回的旧会话、
    也没跑完过一轮)时连回直接开新会话，不带 id。连回带当前原生会话 id 与最新的
    模型、来源、推理强度、快速模式、思考开关、权限档、计划模式；回退 / 分叉用的一次性 `resumeSessionAt` /
    `forkSession` 只在第一轮跑完前带(之后再带会再截断一次)；`setVendorOptions` 改过的内容、`libraryRoot`、`useCindyAutoReviewFallback` 连回后再告诉 B 一次；
    补发的任一步失败就当这次连回失败(fail closed)：关掉刚开的 run 还回名额、回到已让出，待补发的内容保留，调用以
    `[REMOTE_AGENT_UNAVAILABLE]` 报错，下次调用重新连回再补发，不会在缺设置的 Agent 上执行消息。
    **目录映射保证**：对话里出现过的每个虚拟路径，连回后仍指向同一个本机目录，绝不会指向另一个目录。B 按 open 里
    附加 / 可写目录的顺序起名(`additional/dir-<序号>`)，所以连回时原样给第一次打开时的列表与顺序；A 已有的映射
    (含运行中新增目录分配的 `additional/runtime-<n>`)只补不换。打开之后的增减(连着时或让出期间)在连回后按运行中
    改目录的 `setExtraDirs` / `setWritableDirs` 补发，与一直连着时一致；已撤掉的目录 A 的执行器不再当作可访问的根。
    消息里的路径在连回完成后才转换。连回期间(含补发设置)其它调用都等这次连回，不会抢在设置恢复前发给 B。受邀者归属校验、
    供应商组 `relayMemberOf` 回到原组内电脑与 App 重启后接回同一条路径。B 接不回原会话时(会话失效回调里正是这次带的 id，或 B
    返回了别的会话 id)沿用 `onInvalidResumeSession` 语义，同时在任务里插一条非终止的 `[REMOTE_AGENT_RESUME_LOST]` 提示，
    不悄悄丢上下文；手机端同步补了 `session.remoteError.REMOTE_AGENT_RESUME_LOST`，旧手机没有这条文案，显示通用的「回复失败」。
  - **并发**：让出进行中来的调用等它让完再连回；同时几个调用只连一次；调用开始后让出放弃；已让出时的关闭、归档、删除、换账号、
    退出 App(`detach`)只收本机部分，不再联系 B。
  - **让出时 close 没送到**(链路抖动等)：B 的进程可能还占着名额。A 的连接池继续把它算作占位，约 2 秒后原样再发一次
    `close`(B 不认识这个 run 时直接回空，等同已关闭)；再发送到、或过了 B 自行回收的最坏时间后不再占位(`REMOTE_AGENT_POOL_CLOSE_HOLD_MS`，3 分 30 秒：
    B 的 `REMOTE_AGENT_HOST_IDLE_MS` 3 分钟，加上每 5 秒一次的回收检查、停止拉取前在途 poll 最长 10 秒的挂起，再留余量，
    不比 B 更早认为名额已空)；占位独立于任务存在，任务在这期间关闭或归档也不会让它消失。占位期间水位线与打开前的判断都算上它，会先让别的有资格的连接，而不是直接打开撞上限。
    close 没送到时本机也不再等 B 的收尾事件(B 不会收尾)。这个任务自己要连回时，打开前与被拒后都先立刻对旧 run 再发
    一次 close，关掉了才不再占位；计数时只排除它正要开的那个位置，旧 run 照样算(B 打开时的名额检查会算上旧 run，
    同一任务的旧实例要到新进程启动时才被替换)。还是关不掉就照常让别的连接或按 B 的上限报错。
  - **已知限制**：B 的整机合计上限(`TOTAL_LIMIT`)A 看不到别的设备的占用，只能靠被拒后处理；A 在自己额度内不让出，可能挡住别的
    设备，第一期接受。A 作为供应商组所在电脑替受邀者中转的 run 不进连接池(由发起方决定让出，发起方让出后按原有逻辑关掉中转)；
    同一台 B 的多个分享入口(`share:<id>`)各算一个池，计数可能偏低，靠被拒后处理兜住。
  - **已知限制：连回被拒时本机后台命令会结束**。触发条件：任务已让出，下一次发送(或其他要 B 干活的调用)连回时被 B 拒绝
    (仍满的名额类 `REMOTE_AGENT_BUSY`，或 B 离线等任何在发出消息之前就失败的情况)。后果：错误照常报给用户，但 Maker 对发送失败
    的通用处理会在约 250ms 后关闭这个会话句柄、等下次重建，本机执行器随之关闭，这个任务里还在跑的本机后台命令(`ShellSession`)
    会结束，按原 ID 也读不到了。对话不丢：下一次从界面发送会重建句柄，并照常带原生会话 id 在 B 上接回原来的对话。第一期只记录不改；
    第二期加上「等名额」的排队后，连回不再因为名额被直接拒绝，这种情况会少很多。
    回归见 `remote-agent/__tests__/connectionPool.test.ts`、`execServerProjection.e2e.test.ts`(中继忙闲)，以及真实 Claude Code / Codex / Pi 的
    `claudeHosted` / `codexHosted` / `piHosted.e2e.test.ts`(共用 `poolHarness.ts`)。

## 伙伴设置动作 `management:settings`（Remote Resource，2026-10-22）

桌面控制另一台电脑上的伙伴时，设置页的读写经现有 `maker:remote-resources:invoke`，不新增 device-link 通道，也不改 allowlist。契约正本是
`apps/desktop/src/shared/botRemoteSettings.ts`，字段只追加：

- **声明**：主机在 `teammates` 集合描述里增加集合动作 `{ id: "management:settings" }`（手机只检查 `open-create`，不显示该动作）。
- **请求**：`collectionId: "teammates"`、`actionId: "management:settings"`、`input: { v: 1, op, args? }`；需要伙伴的操作带
  `resourceRef: { collectionId: "teammates", kind: "bot", id }`，主机级操作（`caps`、`models.default`、`autonomy.*`、`routines.sources`、
  `voice.models`、`voice.voices`、`channels.im.listAdoptable`）不带。`input` 受 64 KiB 上限约束，控制端把超长文本补丁拆成多次请求。
- **响应**：`{ effects: [], result: { ok: true, value } | { ok: false, code, message } }`。失败以数据返回（`PRECONDITION_FAILED`、
  `INVALID_PARAMS`、`NOT_FOUND`、`ALREADY_EXISTS`、`UNSUPPORTED_CAPABILITY`），因为注册表适配层会把其它异常折叠成泛化 `INTERNAL`，
  会让页面看不到 revision 冲突；`message` 去掉 `[CODE] ` 前缀，非白名单异常仍抛 `INTERNAL`，不带原文。
- **能力协商**：`caps` 返回 `{ version, ops[] }`；控制端按操作决定显示哪些页（缺操作的页不出现），主机没有声明动作时整页回退到
  通用表单页。新增操作只追加到 `BOT_SETTINGS_OPS`，旧控制端不识别的操作不会被调用。
- **安全边界**：主机检查「允许同账号设备控制本机」、撤权、共享任务 / 供应商分享对端与伙伴可见性，并在返回前复核账号 owner；
  凭证、本机路径、运行时快照、最近消息预览不出现在任何结果里；`profile.update` 白名单字段且拒绝 `permissions`；消息平台操作只触达该伙伴自己的连接。

## 协同远端 Worker：Worker 在另一台电脑运行

`maker:input:get-projection` 的既有输入投影可选增加 `turnInProgress`，由输入协调器按
当前派发、运行、交互及终态持久化边界生成；它不表示 vendor 的 `isTurnRunning`。
Lead 的自动回报同时识别既有 `autoResumePending`、`usageLimitWait` 和隐藏续跑队列，
读取历史后再次核对投影，恢复期间保留原派活身份，不推进回报去重游标。旧查看端忽略新字段；
新 Lead 连接旧运行端时仍使用既有恢复字段，完整的进行中边界核对需要运行端同时更新。
只调整单个 Worker 的回报收尾，不改变通道、权限、relay、服务端或 Mobile 原生配置。

主动回报可选追加 `maker:orca:remote-worker:bridge`，仅同账号 allowlist；不进入共享任务、
供应商分享清单。运行设备从本机持久来源标记选定 Lead 电脑，传真实任务 ID、Lead ID、
四个既有 Worker 工具名之一与其原参数。Lead 从 server 盖章的来源设备 ID 反查 active team
内的 Worker，核对真实任务和 `worker_id`，再调用与本机 MCP 相同的 handler／schema；
请求不能自报本机 role 或指定任意目标。根 Agent 回报限制在运行设备转发前执行。
桥接请求可选增加 `reportedInputClientIds`（最多 64 个安全 ID），由运行宿主在工具调用入口
同步捕获本轮已消费输入，不接受模型参数指定。Lead 仅结清相交的等待输入；仍在排队的新
输入保持持久等待记录和运行状态。旧端缺少此字段时不清除等待记录，保留自动回报兜底；
新字段不改变四个 MCP 工具 schema，也不改变本机 Worker 的回报路径。
`caps` 可选增加 `workerBridge: true`，协议版本仍为 1，既有 open/release 载荷不变；
桥接沿既有同账号远控授权，Lead 电脑未开放反向远控时也保留自动回报，不扩大授权。
旧端忽略可选字段或返回 `CHANNEL_NOT_ALLOWED`，保留原有完成后自动回报，不降级为通用 handoff，
不自动重试结果不明的写操作。完整主动往返需要 Lead 与运行设备均更新，服务端无需变化。
`get_current_session_id` 和 `list_sessions` 可选投影既有远端来源标记；普通任务不增加空字段。
桌面及手机的控制端继续通过任务所属电脑使用协同，不新增 UI、push 或 Mobile 原生输入。
故障动作只影响当前 Worker 的一次桥接请求，不重启 peer 或共享 relay；另一设备的自动回报
继续由既有运行时处理。权限隔离、旧端、账号切换与真实 handler 往返见
`apps/desktop/src/main/maker-ipc/__tests__/orcaRemoteWorkerBridge.test.ts`。

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
  `maker:orca:remote-worker:caps`(能力探测，回 `{ version, agentDevice? }`)、`…:models`(查询工作电脑的模型与 Agent 位置)、`…:open`(按 A 给定的任务 id 新建 Worker 任务，
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

跨区组员恢复（2026-10-26）：控制端 Main 仅在同账号 `provider-group:remote` 的有效 `view` / `pick`
回包或 `manage-group` 组视图引用分享时，恢复本机缺失的区域标记并通过既有 `/provider-shares/x/session` 核验成员关系。
不新增 wire 字段、channel 或权限，兼容旧组所在电脑；手机仍由任务所在电脑执行。旧控制端保留原行为。
本机已加载的分享直接使用；尚在恢复或请求失败时不按已移除处理。Renderer 收藏和任意分享 ID 不能触发
跨区激活。凭证只留内存、区域标记格式不变，降级后已恢复的分享沿原连接路径继续使用。
回归：`device-link/__tests__/providerShareCrossRegion.test.ts`、`provider-group/__tests__/ipc.test.ts`。

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
  - `rebalance-suggestion { sessionId }` / `rebalance-decision { sessionId, memberKey, remember: boolean }`(2026-10-21，任务进行中
    换号，provider-groups.md §6.2)：同样发给**任务所在的电脑**，见下方「供应商组任务进行中换号」。
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

## 供应商组：订阅配额筛选与用量均衡（2026-10-12，OpenAI 于 2026-10-20 接入）

2026-10-21：同账号 `pick` 的 `{ kind: 'unavailable' }` 回包可选增加
`usageLimit: { resetAtMs: number | null }`，仅表示已验证的订阅额度耗尽；时刻为可分配成员中
最早的已知恢复时间（unix ms）。不发送账号信息、用量快照或成员名单。控制端保留已知／未知
重置语义，以 `REMOTE_AGENT_GROUP_USAGE_LIMIT` 错误接入现有输入投影与限额等待；
手机和桌面沿用 `usageLimitWait` 显示时间、取消等待。新组配旧控制端忽略可选字段，
新控制端配旧组保留原通用错误，不猜测限额或自动等待；旧查看端仍可显示通用错误和既有等待。
完整体验需要组所在电脑与任务所在电脑更新，查看端更新后有对应本地化文案。
不新增 channel、持久状态、权限或服务端改动。

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §5。选电脑仍由组所在电脑完成：先排除额度耗尽的成员，
再按所选策略分配；Claude Code 与 OpenAI 订阅均可参与配额排序，旧策略 `usage` 沿用 `least`。

- **可选策略枚举扩展**：本地组配置与同账号组摘要的 `strategy` 增加 `usage`，原默认 `least` 不变。
  旧版桌面读取未知策略时归一化为 `least`，旧版手机不依赖这个字段；远程 `pick` 仍由组所在电脑执行，因此
  旧控制端连接新组所在电脑也能使用新策略。组所在电脑降级后按 `least` 分配，旧版再次保存组设置会写回 `least`。
  2026-10-15 起配额排序对所有策略生效（2026-10-21 起按「剩下的额度 ÷ 剩下的时间」，最急的先用），设置界面不再提供
  `usage`；枚举值与归一化保持不变，已存的 `usage` 照常读写，挑法与 `least` 相同。这只改组所在电脑本机的选择，
  沿用已有的用量快照字段，不新增字段、不改通道。
- **复用已有同账号通道**：向成员电脑调用 `maker:usage:claude-subscription`，参数 `[member.providerId]`；本机走同一
  订阅 reader。只信与请求一致的 `providerId` 回显；旧端未回显时仅允许默认 `anthropic`，具名账号按未知用量处理，
  避免旧端忽略参数后拿默认账号的额度代替。通道不可用、失败、超时或快照过期时按未知处理，分配照常进行。
  OpenAI 并行复用 `maker:usage:account` 的 `['codex', member.providerId]` 和 `maker:usage:codex-rate-limits`
  的 `[member.providerId]`；两个回包分别校验 `providerId`，无回显的旧端仅允许默认 `openai`。原生限额 RPC 的
  窗口按本次读取时刻记录新鲜度，账号用量回包保留各模型桶与 web 槽自己的时间戳；单路失败仍使用另一路的可信数据。
  不调用兑换重置卡接口，不把重置卡、账号标识或凭证放进内部目录的配额快照。本机和远端读取合并在途，短缓存 15 秒。
- **可选框架信息**：同账号 `view` 请求增加可选 `agentKind: 'codex' | 'pi' | 'claude-code'`，供 OpenAI 发送前检查
  选择原生模型桶或 web 槽；缺省仍按原生模型桶处理，旧组所在电脑忽略该字段。原有仅带模型的查询和回包形状不变。
- **隐私与状态**：完整额度快照只留在组所在电脑的内部目录中，不进供应商目录，不传给受邀者；分享来的成员不调用此通道。
  同账号不带 `model` 的 `view` 用已有 `cooling` / `coolingUntil` 表达总窗口耗尽，带 `model` 的发送前查询只在回显模型一致时
  临时表达该模型的额度状态，不能改变其他模型的可用性。账号切换时丢弃旧读取，不扩大 allowlist 或凭证访问。
- **成员状态可选 `quota`（2026-10-21 用户确认）**：`ProviderGroupView.members[]` 增加可选
  `quota: { usedPercent, resetAtMs: number | null, windowMs }`，只是选电脑排序用的那一个窗口（provider-groups.md §5），
  同账号电脑据此提议任务进行中换号（§6.2）；2026-10-22 起界面不再画进度条（§10），字段保留。不带 5 小时窗口、模型桶名、
  账号标识或重置卡。组所在电脑本机界面与同账号 `view` 回包都带；读不到配额的成员
  省略。`parseProviderGroupRemoteView` 只收有限数值（百分比收敛到 0–100，窗口 0–31 天，重置时刻为正数或 `null`），
  分享来的成员一律丢弃；受邀者的匿名状态是白名单投影，不带此字段。旧组所在电脑不回此字段，查看端按读不到配额处理、
  不提议换到这台；旧查看端忽略它。不新增 channel、请求参数或持久数据。
- 不新增 channel，不改 relay、服务器、数据库或持久冷却格式。实现：`provider-group/usage.ts`、`directory.ts`、`runtime.ts`、
  `router.ts`、`remoteClient.ts`、`remoteHandler.ts`、`service.ts`；额度判定与自动继续复用 `shared/accountUsageLimit.ts`。回归见
  `provider-group/__tests__/usage.test.ts`、`router.usage.test.ts`、`runtime.test.ts` 与 `scheduler.test.ts`。
- **成员状态可选 `fiveHourTight: true`（2026-10-21）**：只在带 `quota` 时出现，表示这台的 5 小时配额已用 85% 以上、离重置还有
  1 小时以上（provider-groups.md §5 第 0 条）。同账号电脑据此不把它当作任务进行中换号的目标。旧组所在电脑不回，查看端按不紧张处理
  （最坏是提议后组所在电脑按自己的排序选不中它，照常留在原处）；旧查看端忽略。`parseProviderGroupRemoteView` 只认 `true`。

## 供应商组任务进行中换号

产品规则见 [`provider-groups.md`](../product-rules/provider-groups.md) §6.2（2026-10-21 用户裁决：上一轮结束、用户发下一条消息
前弹窗问要不要换号，可为这个任务选「以后自动换」，手机与电脑一致）。

- **两个新动作，发给任务所在的电脑**：本机走 `providerGroup.command`（IPC，只限本机 renderer），手机与桌面远程控制走已有的
  同账号 `provider-group:remote`（dispatch 已拒绝受邀者与共享任务访客，allowlist 不变）。
  - `rebalance-suggestion { sessionId }` → `{ kind: 'ask' | 'auto', memberKey, label, quota } | null`：只读，不记占用、不改绑定。
    `auto` = 这个任务选过以后自动换，客户端不弹窗、直接回 `rebalance-decision`。`quota` 是要换去那台排序用的窗口，形状同
    `ProviderGroupView.members[].quota`；`label` 是那台的显示名（同一台电脑上有几个账号时带账号名），不含账号标识。
    组合名称最多 259 个 UTF-16 单元（电脑名 128 + 分隔符 3 + 账号名 128），电脑与手机按相同上限解析。
  - `rebalance-decision { sessionId, memberKey, remember, clientId? }` → `{ ok: boolean }`：只允许这个任务中匹配 `clientId` 的消息
    发送前换到 `memberKey`（2 分钟内有效，定时任务不消费）；复用 `persistUserMessage.clientId`，不增加发送协议字段。
    缺少消息 ID 或 `memberKey` 不在组里回 `ok: false`，不记决定与偏好；`remember: true` 时另记这个任务以后自动换。
  - 解析：`sessionId`、`clientId` 与 `memberKey` 按已有远程 id 规则校验，`remember` 必须是布尔值，坏请求回 `[INVALID_PARAMS]`。客户端读回包用
    `parseProviderGroupRebalanceSuggestion`（手机端 `parseMobileRebalanceSuggestion`，口径相同），格式不对按不提议处理。
- **时机**：客户端在任务空闲时预先问 `rebalance-suggestion`（变空闲、打开任务时，空闲期间每 5 分钟；单次最多等 5 秒），
  结果 10 分钟内有效、只用于一条消息；点发送时只用问好的结果，不为它多等一次往返。只有用户确认换号（或任务选过自动换）时，
  发送前等 `rebalance-decision` 回来再发，确保任务所在电脑先记下决定。
- **新旧兼容**：旧任务所在电脑不认识这两个动作，回 `[INVALID_PARAMS] unknown provider group action`；客户端失败或超时都按
  不提议处理、照常发送，与改动前一致。旧客户端不发这两个动作，任务所在电脑不会自己换号（没有用户确认就不换），行为与改动前
  一致。不新增 channel、relay、服务器或数据库字段。
- **最终选路约束**：`pick` 可选 `quotaRebalance: <当前成员键>`；组所在电脑在选路与占用登记的同一步，按当前负载、配额和换号
  收益门槛重新校验。成功结果回显 `quotaRebalance: true`；新调用端未收到回显就不主动迁移。旧组忽略可选字段时仍可普通
  分配，但不能作为主动换号结果；旧调用端不传该字段，行为不变。
- **分隔条内容可选 `switchReason: 'quota-rebalance'`**：`agent_switch` 边界行（`AgentSwitchBoundaryContent`）只在供应商组为此换了
  电脑时带上，桌面与手机在位置后写「· 这个账号的配额更该先用」。旧端忽略，照常只显示位置。
- **本机持久数据**：「以后自动换」存在按账号隔离的 `provider-group-session-prefs.json`（`{ autoRebalance: { [sessionId]: at } }`，
  最多 4000 条、超出丢最早的；读不出时保留原文件、按都没选过处理）。不同步、不外发；降级旧版忽略这个文件，相当于每次都不提议。
- 实现：`provider-group/service.ts`、`usage.ts`(`providerGroupRebalanceTarget`)、`router.ts`(`rebalanceCandidates`)、`runtime.ts`、
  `ipc.ts`、`remoteHandler.ts`、`remoteRegistration.ts`、`sessionPrefs.ts`、`maker-ipc/sessionAgentSwitchHandler.ts`；客户端
  `renderer/features/provider-group/sessionRebalancePrompt.ts` 与 `apps/mobile/src/session/sessionRebalancePrompt.ts`。回归见
  `shared/__tests__/providerGroup.test.ts`、`provider-group/__tests__/service.test.ts`、两端 `sessionRebalancePrompt.test.ts`。

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
- O 移出最后一个组引用时，在本机组设置里原子记下待清空代次；`reshare` 空名单得到有效回包后才删除该代次，失败与普通同步一起按
  1、1、5、10、20、30 分钟退避(上限 30 分钟)，重复快照和组详情读取不能穿透；成功重置，观察到对端恢复在线只唤醒那台。
  暂停分享或完整可信名单确认分享已删除时不发同步，未确认的清理代次仍保留；`ACCESS_REVOKED` 本身不是永久删除证据。
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

## 供应商分享：按授权查看额度与用量（2026-10-19）

- 新只读通道 `provider-share:insights:v1` 仅接受分享身份，参数严格为 `{ version: 1, includeUsage: boolean }`，供应商由已验证身份决定。
  返回 `{ version, capabilities, status, quota, usage }`，结构和接收端白名单解析在 `shared/providerShareInsights.ts`；
  两项能力默认关闭，未开放无数据，读取失败分别标 unavailable。无版本/能力/状态或未知版本提示更新，不降为管理通道。
  `includeUsage: false` 仍返回独立能力位；获准用量标 `not-requested`、usage 为 null，不读账本、不投影或返回缓存历史。
  仅主动展开时传 true，收起后恢复 false，离开/隐藏详情不再发请求，未请求与未开放/失败/零用量明确区分。
  新通道 v1 首次发布即要求 includeUsage；缺少或非布尔值拒绝，不回退为全量读取。
  已发布旧端不支持此新通道；新端提示更新。接收端同时拒绝折叠请求却附带历史的响应，不降为全量查询。
- 同账号 `manage-share` 追加 `get-visibility`、`set-visibility`（按供应商，仅 quota/usage 布尔补丁）、`quota-account`。
  写入仍只在供应商所在电脑执行；旧端的 Unknown command 映射为 UNSUPPORTED_CAPABILITY，不改存控制端、不重放写入。
  受邀者不能调用这些管理动作，也不能指定另一个 providerId 或借通道读取全量账本。
- 最终发送、重复请求与 outbox 重发核对读取时的账号、成员和可见性代次；开关关闭再开启使旧投影失效。
  新通道不进入通用 completed 结果缓存；受邀端白名单重建响应并丢弃未授权字段，账号/分享变动拒绝在途回包。
  只读请求不调用远程 Agent，不占任务名额。历史和额度分别合并短期在途读取，缓存不跨账号。
- 普通额度为一项，组额度仅返回自有账号匿名数组及 partial 标记，不含设备、上游身份、凭证或第三方分享账号额度。
  用量按天/模型/公开昵称头像投影，合并设备维度，转来用量匿名汇总；历史裁剪口径沿用 usage-history。
  最终投影还按 UTF-8 JSON 总字节限制在 `MAX_FRAME_BYTES - 1024`，预留 invoke 信封空间；预算包括昵称/头像、额度和历史行。
  继续裁剪时优先保留较新的历史并更新 `coverageStart`；人员资料本身超限或连一行历史也无法容纳时，将 usage 标 unavailable，
  不静默删除人员、不伪造零用量，也不让它拖掉可用 quota。quota 本身超限时独立标 unavailable。没有新增 wire 字段。
- 旧受邀端不发新请求，模型使用不变；新受邀端收到 CHANNEL_NOT_ALLOWED 或不完整能力时显示需要更新。
  relay 信封、服务端、数据库与 Mobile 均不变；完整查看需要双方 Desktop 更新。
  实现与回归：`device-link/providerShareInsights.ts`、`dispatch.ts`、同目录 `__tests__/providerShareInsights.test.ts`、`providerShareDispatch.test.ts`。

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
  `manage-share` 只收 `owned` / `own-usage` / `usage-history` / `create-link` / `approve` / `reject` / `set-member` / `set-member-note` / `reshare-decide` / `get-run-limits` / `set-run-limits` / `reset-run-limits`，其余回
  `[PERMISSION_DENIED]`。回包 `{ result, respondedAt }`，`respondedAt` 只用于把链接有效期换算到 C 的时钟。
  - `usage-history`(2026-10-17，供应商组 §7)：只读，`{ action, providerId }`，回这个供应商用量的按天明细
    `{ providerId, todayKey, coverageStart, self, relays, members }`(结构在 `apps/desktop/src/shared/providerShare.ts`)，
    日期是 O 的本地日期，金额在 O 上估算；`members` 只含 O 上这个供应商的分享里现在的成员。最多 5,000 行，按日期从新到旧
    截取，最新一天允许只保留一部分，再按实际 UTF-8 JSON 字节数裁剪，均用 `coverageStart` 标出保留下来的最早日期，
    整包为单帧 2MB 预留 invoke 信封空间。旧 O 不认识该动作，`parseProviderShareCommand` 回
    `[INVALID_PARAMS] Unknown command`，C 的 Main 把 `manage-share` 的这个回包统一成 `[UNSUPPORTED_CAPABILITY]`(与
    `unknown provider group action` 同一处)，管理页退回 `own-usage` 与 `owned`(range=all)的所有时间合计并提示更新 O，不重试。
    旧 C 不发这个动作，照旧读 `own-usage` / `owned`，O 对两者的回包不变。
  - `set-member-note`（2026-10-19）：`{ action, memberId, note }`，只允许已有成员，空字符串清除备注，最多 80 个 UTF-16 单元、保存前规范为单行。
    O 按账号保存私人备注，`owned` 的成员投影新增可选 `note: string | null`，不改服务端成员合同或受邀者目录。
    旧 C 忽略新增字段；旧 O 不认识命令时沿用 `INVALID_PARAMS → UNSUPPORTED_CAPABILITY` 映射，C 保留草稿、提示更新，不重放或改存本机。
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

### 项目显示名的跨设备镜像

`sidebar-settings:get-project-aliases` 是只读的主机别名快照；返回主机平台、账号代次和
`local:` / `remote:` 项目身份对应的别名，不传播主机作为控制端保存的 `device:` 覆盖名。
`local-db:project-aliases:changed` 使用 `{}` 失效通知和账号标记，沿既有 `sessions` topic
转发。控制端首次订阅、重连及既有列表刷新时补拉；在途读取期间收到变更时丢弃旧结果并补拉。
完整空快照表示别名已清除，临时读取失败保留最后有效名称。退出账号、移除或撤销设备时清理镜像，
迟到响应不得恢复已清理的数据。

新主机与旧控制端保持原行为；新控制端连接不支持该读取通道的旧主机时使用目录名。
只新增读取与通知准入，不开放远程别名写入，不改数据库或 relay 格式。
名字按物理来源设备和完整主机项目身份匹配；Windows 本地路径按主机平台比较，SSH 身份和
POSIX 大小写保留。既有分组若包含不同主机项目身份，仍显示原目录名，不能任取一条别名覆盖整组。
桌面控制端已有的本地 `device:` 覆盖名继续优先。分组键、任务标题、工作目录和路由均不随别名改变。

实现与回归见 `packages/maker-shared/src/projectAliasSync.ts`、`projectAliasSync.test.ts` 和
`projectAliasPresentation.test.ts`；移动端首页、设备详情、抽屉与搜索筛选共用同一份镜像。

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
- 默认开关按原生协议与 Harness/出站协议比较：兼容路径默认关闭；已有用户显式偏好优先。逐引擎服务端显式 defaultEnabled 保留策展覆盖能力。Google 原生模型推荐 Pi，Messages 推荐 Claude Code，Responses 推荐 Codex，Chat Completions 推荐 Pi；推荐必须在可用候选内。（2026-10-30 起，目录 `recommendedAgents` 有声明时优先，此协议推断只作兜底，见下文「推荐引擎下发」。）
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

## 群聊话题预览回复者

`BotGroupThreadPreview` 可选增加 `responders`（回复 ID、作者类别、成员 ID、名字），
与最近两条 `replies` 摘要分开。Desktop 从已读取的窗口按服务端作者 ID 去重后取最多三位，
不增加网络读取预算。新查看端遇到旧宿主没有此字段时沿用 replies 去重回退；旧查看端忽略
新字段，继续读取原有两条摘要。Mobile 现有消费路径不渲染该预览字段；无新 channel、
服务端接口、权限、数据库或原生配置变更。

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

### 服务器伙伴群一次一位伙伴（`groupSingleSpeaker`，2026-10-21）

Chat Server `/me` 追加 `capabilities.groupSingleSpeaker: 1`，服务端派发随之改变且对所有客户端生效：
主群里 @ 多位直接建 `kind=talk` 的队列；没有定向接收人的普通消息由现有 `responseMode` 决定：
`all` 排全部可答伙伴，`mentioned` 不产生执行、不创建或替换队列。只有一位可答伙伴时直接回答，不建队列；不再自动续圈。旧客户端照常可用——
它们本就声明 `planVersion: 1` 领取安排步骤、渲染安排卡并能「继续」；仍发送的 `deferExecution` /
`continueDiscussion` 被接受（后者只记录、不续圈），旧的「继续讨论」只叫被 @ 的伙伴或第一位伙伴。

新 Desktop 只在看到该能力时：普通消息不再发 `deferExecution`、不做发送前的辅助判断、不发 `continueDiscussion`；
队列停着等继续时新消息按新请求发送（不作为补充）。队列前 5 位由服务端自动接续，无需客户端参与。
`chat_plan.kind` 是附加字段，旧客户端忽略；新客户端缺字段时按旧分工卡呈现。手机解析电脑的群资源时，
保留经校验的可选 `kind`（talk/work）与 `canAdd`（boolean）；缺失或非法时沿用旧分工呈现，不把字符串当作补充权限。
`mentioned` 的运行中 talk 队列及 work 分工不接受普通无 @ 消息作为自动补充，两端输入框不得承诺交给正在答的伙伴；work 分工仍保留未结束时阻止新建分工的限制。
手机须保留电脑投影的 `singleSpeaker: true`（据此隐藏「发言方式」）；远程电脑传输不等于旧群。

2026-10-23 起客户端在同一能力下恢复「安排分工」，**不改服务端、不新增 wire 字段**，只组合现有接口：
主群消息带 `deferExecution: true` 挂起；请求写好步骤时 `POST /plans`（`kind` 缺省为 `work`）后立即
`action: start`，否则负责人出卡；没有卡时 `POST /messages/:id/continue` 立即回答（该服务端没有 `cancel-planning`，
不处理会在两分钟后被排成讨论队列）。本人等继续的 `talk` 队列先 `action: stop` 再建卡，否则服务端返回 `PLAN_OPEN`。
手机经电脑发起分工走同一路径；手机直连服务器不提供「安排分工」。Chat Server wire 不变；电脑给手机的群投影追加可选
`supportsDivision: true`（仅 `singleSpeaker` 群），手机只在看到它时于该类群显示「安排分工」——更早的电脑会把分工请求
当普通排队消息处理，缺字段即不显示。
停止的范围收窄与主群上下文精简都只在看到该能力时启用，旧服务器保留整轮停止与完整主群历史；收窄只在执行端实现（成员只停自己的请求与伙伴，群主或管理员——含本账号拥有的管理员伙伴——可 `all`），沿用既有 control /
plan action 的服务端权限，IPC `bot-group:stop` 追加可选 `scope`；
手机经电脑的远程动作不变（停止为本人范围）。发布顺序：服务端整集群先上，再发客户端。

2026-10-23 回复模式恢复（客户端 #6888 / cindy-server #1030）：`groupSingleSpeaker` 只表示回答顺序，
不代表每条普通消息必有回答；主群、线程与过期 `deferExecution` 恢复共用 `responseMode` 判断，显式继续不受影响。
仍保留定向回复规则：宿主把引用回复伙伴或伙伴根消息下话题回复的原作者加入 `mentions`，即使没有手打 @，
服务端也按非空 `mentions` 处理；人类根消息下的普通话题回复不隐式点名伙伴。服务端不从正文猜接收人。
不新增字段、能力版本或迁移；先部署服务端整集群以恢复已存模式，再发布客户端入口与补充消息修复。
受影响的旧服务端仍忽略 `mentioned`，旧 Desktop 也可能把闲聊作为队列补充发送；能力位本身不能证明修复已部署，
仅客户端或仅服务端合并均不代表完整生产修复上线，发布后须复验普通消息、定向回复与运行中队列补充。

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

## 同账号远程插件管理

现有 `plugins` 远程资源以可选 action `management:snapshot` 声明 version 1 管理能力。
新增 `management:market-detail/begin/operation/answer/cancel`，沿既有 resource invoke、
同账号设备授权和 owner 边界执行，不新增通用 IPC allowlist 或服务端协议。
`management:snapshot` 的可选 `projects` 字段投影目标 Host 的最近项目 ID、显示名及可选只读
`path`，用于复用本机 Project Scope 的目录展示（含暂时不存在的最近目录，不按任务归档过滤）；
控制端以 Host 生成的项目 ID 请求 `management:project-state`，返回该项目的禁用实例和
由目标 Host 计算的 revision。项目启停沿原 `ghost-workdir-prefs` 例外语义，写入同时绑定
控制设备、物理插件实例、安装批准 token、项目 ID 与 revision。旧 Host 缺少 `projects`
时只保留全局插件管理；空数组表示该 Host 支持项目管理但暂无项目。切电脑先重读项目目录，
不能把控制端本机路径或上一台电脑的项目交给目标 Host。
快照可选追加 `projectBrowse: true`，声明支持 `management:project-select`。控制端复用现有
远程目录选择器并固定目标电脑，Host 重新校验选中的绝对目录，生成项目 ID。浏览选择仅作为
该控制设备、owner 与连接代次内的临时 scope，不创建任务或写入最近项目。读取与启停仍只接收
Host 项目 ID，浏览目录在使用前再次校验；不能以展示路径直接执行项目写入。旧控制端忽略
新增字段，旧 Host 缺少浏览能力时保留原项目列表与启停，不回落本机目录选择器。
旧控制端继续使用原 list/get/enable/disable；新控制端遇到旧 Host 仅展示旧 list/get
和升级提示，不能回退本机写入。

写操作绑定控制设备、物理插件实例、安装批准 token，以及市场 release/manifest。
目标 Host 原安装器处理实际包摘要与权限确认；等待确认不占安装锁。异步操作用
控制端生成的 operationId 查询回执，未知结果只查原操作、不自动重装；回执仅存内存
15 分钟，Host 重启后不能保证恢复。断链使后续写入失效，但同 owner 重连仍可查询已提交
结果；撤权和账号切换作废旧回执。取消请求不能撤销已经提交的安装。

手动 `.cindy` 导入先由控制端 Main 的受信原生选择器授权单个文件，再沿既有 filePeer
传输，目标在自有临时目录检查、确认并安装。控制端路径不作为目标路径。
配置源由 Host 绑定打开页面的控制设备，不传回已存凭证，不以任务卡代替插件设置页。
管理快照可选声明 settingsPage: true：Desktop 通过 settings:open 获取目标插件原
settingsHtml 的包资源声明与页面租约，不要求存量插件补发 mobile 声明。A Main 的
专属非持久 partition 展示原页面，复用同样的 CSP/沙箱/主题/布局；主窗 CSP 不变。
KV、secret、OAuth、connection 与原 BroadcastChannel 请求通过已有 v3 签名握手与
密封 exchange 中的可选 op: settings 传输，只接受绑定该页面的签名会话；普通 OAuth
卡片会话与通用 Remote Resource fetch 不能访问它。controller、owner、物理实例、批准
版本和连接代次在真实执行前复核。新增命令有严格白名单及大小限制；密封 callback 上限
追加到 144KB，以容纳原设置页 64KiB 请求及 JSON 转义，原 OAuth 各内层契约的限制不变。
旧端未声明能力时不发送新 op，不回退到未加密请求。
设置页续签只替换同一控制设备、同一页面与同一插件的旧握手，不等待在途请求，
使轮询和确认回复可经新连接完成。旧连接不再接受新请求；已受理请求仍用原密钥返回，
返回前复核原有效期、owner、控制设备代次和页面租约，不关闭页面或重放写请求。
v3 消息格式和每 Host 16／每 peer 4 个连接、每连接 1024 条消息
的上限不变；旧控制端兼容新版 Host，完整续签交接需要控制端与目标 Host 均更新。

原 /oauth/<key>/connect 先生成绑定页面的一次性 ticket，沿现有 v3 浏览器授权桥执行
目标原端点；原 HTTP 结果送回 settings.js。已有账户只读脱敏原端点投影，令牌保存在 B。
关闭页面取消其待授权 ticket；超时或失败不重放保存/授权。切目标、账号、安装批准或
撤权使旧页面失效；单页故障不重启共享 relay。包资源使用原目录与文件身份检查分块读取，
A 不直接读取目标安装目录。原目录选择请求通过 Main 的固定 IPC 进入既有远程
目录选择器，固定目标 B；选择经密封 answer-directory 返回 B，并由 B 原路径校验
和授权逻辑执行。目录请求不进入作者页面；原普通 Remote Resource fetch 仍拒绝凭证
接口。Mobile 原页面契约保持原行为。

管理快照可选追加 hostPreferences: true，声明 management:preferences/preferences-set。
它只投影本机本就由 Host 管理的模型、任务与侧栏偏好；不包含已有凭证、目标工作目录或
供应商执行路由。写入要求物理实例、安装批准 token 与配置 revision，复用本机校验与
存储，任务 patch 保留目标工作目录。旧控制端忽略新增字段，旧 Host 的缺失能力如实展示。
无需服务端、通用 IPC allowlist、数据库或 Mobile 原生改动。

### 同账号远程技能管理（2026-10-14）

插件与技能页共用电脑选择。目标 Host 通过追加 `skills` Remote Resource collection 和
`management:snapshot` capability 提供技能投影与 opaque 操作；不开放既有本机 SkillHub IPC。
旧 Host 缺少该能力时保留页签和目标电脑，显示升级提示，不回退本机数据。资源 id/revision
由 Host 扫描中的实体、物理目录、授权入口、启停代次与注册记录派生，不接收控制端路径。
响应仅携带名称、描述、范围、引擎、版本、状态、正文及市场身份，不暴露目录、凭证或内部 registry。
Claude 原生 `user` 范围投影为 `global`；控制端读取早期 Host 的 `user` 返回值时也按全局展示，避免丢弃整份快照。

控制端新增受信任原生 IPC `device-link:confirm-skill-mutation`，从目标查询具体操作回执，
原生确认后仅回答这一个 Host requestId。普通 Renderer 的 Remote Resource invoke 禁止直接
发送技能 `management:answer`。确认不占用目标安装锁；批准后重读实体版本，安装器在原锁和
跨进程租约内、下载解包后复核目标及授权目录，继续复用备份和回滚。卸载在租约内再次复核后
复用系统回收站。启停、已提交结果与取消分别表达；离线只查原回执，不重放写操作。
运行中取消通过原 mutation guard 进入安装器的提交前检查；操作结束后记录取消结果，
已经提交的成功结果仍保留，不将取消回执误当作事务回滚。

现有本机接口、路径授权及原生卸载确认保持原行为。仅新增可选 Main 内部 mutation guard；
不改变协议版本、manifest、运行期 fingerprint 或持久数据格式。手机可通过标准 list/get 读取
技能资源，但未新增安装/升级/卸载 UI 或原生确认桥；手动技能目录导入、编辑和发布仍属于本机。

### Cindy AI 企业周期配额

云端组织账号优先通过 Model Access `GET /api/model-access/quota` 查询本人周期配额，
不再假定推理入口暴露 LiteLLM 管理 API。返回 spend/maxBudget/budgetResetAt/currency；
沿用现有 account-usage IPC 和账号作用域缓存，所以设置卡片与任务用量提示使用相同来源。
服务端尚未提供接口（404），或明确返回 501/MODEL_ACCESS_QUOTA_NOT_SUPPORTED（Nova），
才使用原有网关查询。鉴权失败、上游故障或响应无效均显示不可用，不回退或借用其他身份数据。
`dailyLimitEnabled` 只有严格等于 `true` 才表示企业开启日额度；`false`、`null`、缺失或
非法值均视为未开启。企业快照明确带出布尔值，未开启时 `todaySpend` 按 `null` 处理，
隐藏日额度、软限额口径和今日明细不可用警告，月额度不受影响。旧服务端缺少开关字段时
也按未开启处理。开启时，`todaySpend` 为有限且 ≥ 0 的数字表示 UTC 当天消费；缺失、
`null` 或非法值按 `null` 处理，只显示今日明细不可用提示，不影响其余额度字段。
快照新增可选 `dailyLimitEnabled?: boolean`，沿既有 IPC 和 device-link 原样传递；非企业
旧网关路径不设置此字段，保留原有日额度及不可用提示行为。旧控制端忽略新增字段，
需更新控制端才能隐藏未开启时的警告。未设周期上限时不伪造有限配额的原有行为保持不变。
本地手填网关和个人计费路径保持原协议。无新环境变量或数据库变更。

管理员取消周期上限后，主进程明确清空当前 owner 的配额缓存，并通过现有
`usage:claude-account-changed` 广播 null；renderer 同步清除当前 owner 的快照与热缓存。
已有未知载荷消费者会忽略 null，其余有限配额快照字段不变；网络失败仍保留既有缓存策略。

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

## Host-owned mail cards

Manifest v3 adds optional `mail: true`. Cindy serves the versioned `cindyMail` SDK
inside the provider sandbox before its entry point. Providers register mailbox
adapters; they do not need `card` or generate HTML. The local pipe accepts validated
`mail-draft-update` only from enabled mail providers with a live task-owned call.
Cindy renders and persists the existing `ghost_cards` row; no database migration
or relay version change. Old hosts lack the SDK: providers retain read-only tools
and require a Cindy update before draft editing/sending, without a direct-send fallback.

The host-only `data-cindy-mail` marker records account/draft identity, state and
`supersededBy`. Ordinary plugin HTML cannot retain it. Autosave replaces one view;
subsequent tool reads supersede matching provider/account/draft views in that task.
Obsolete or legacy mail actions are rejected on the Host. Historical snapshots remain stored.
The `plugin-card-actions` resource carries optional `mail` / `legacyMail` metadata;
desktop and mobile clients hide superseded mail cards and their plugin labels, leaving
only the latest card per provider/account/draft in that task, including sent/deleted
states. Legacy cards without this metadata retain their read-only fallback.
Old clients keep static fallback text
and receive no obsolete actions. Existing form capability negotiation and task/owner
checks still apply. Sent cards expose only optional task continuation, never send.
Mail receipt continuations use the existing `[UI_ACTION_TRIGGER]` prefix: the
Agent receives the complete receipt, while both clients hide the internal prompt
from chat and session previews. The original mail card remains the visible result.

Optional adapter `deleteDraft` adds a `deleteLabel` and `mail:delete:<key>` action
to active drafts only. It requires no form values because pending edits are
discarded. Deletion shares the per-draft save/send lock and cancels queued saves
and send countdowns. It discards the logical draft even if its content/revision
has changed, verifies the draft identity and refreshes the provider locator;
save/send conflict checks do not apply to explicit discard. Progress is shown
before provider read-back. Failed preparation remains retryable; a deletion
with an unknown provider outcome is never replayed.
Both clients treat `deleting` and terminal `deleted` as
read-only; the Host rejects late edits/sends and cannot restore a deleted card.
Unknown deletes stay locked until the mailbox is checked. Older adapters omit
the button; older clients fall back to inert text for the new states. Existing
remote action ownership/revision checks and the same card row carry this change.

Oversized tool results retain validated top-level `xdt_card_id` and
`xdt_anchor_card_id` in bounded valid JSON during persistence/import and remote
history compaction. The card content remains in the existing card store; no new
wire fields or schema are required. Uncorrelated live cards may only match calls
in the latest visible user turn, so incomplete older history cannot steal them.

Rich mail adapters opt in with `richText: true`; old adapters keep the existing
plain-text contract. Host fields add `mail-html`, `mail-attachments` and `hidden`
kinds, with `bodyHtml` / `quoteHtml` (64k characters) and `attachmentItems` (bounded
JSON metadata). Ordinary text remains 16k. Only Host mail gets the 1 MiB card
budget; arbitrary plugin HTML remains limited to 32 KiB. HTML previews are inert,
sandboxed documents, not markup mounted in Cindy's privileged renderer DOM.
Both clients block remote image sources and CSS fetches in mail previews; CSP
permits only data and managed CID substitutions. Original outgoing HTML remains
unchanged by this preview policy; remote images can be viewed in the mailbox.
HTML supports typing directly into rendered text in both clients and the enlarged
view, without an edit-mode button, formatting toolbar or source editor. Edits patch source text
only, preserving styles, links and CID image references, and synchronize the
plain-text alternative through the existing form autosave path. Sent/history
cards stay read-only. `editor.format: 'text'` retains
the existing compact plain-text input.

The Host mail SDK owns outgoing formatting for all rich adapters. Before preview,
autosave and send it extracts document wrappers into fragments, retains body
attributes on a content container, derives absent text alternatives, supplies
missing filename extensions from known MIME types, and reconnects managed preview
URLs to their attachment CIDs. Missing/duplicate inline references stop sending.
The same URL policy covers `src`, `background`, every `srcset` candidate, inline
CSS and stylesheet `url(...)` in both the body and the quoted content.
Normalized content is saved and read back before the existing countdown; adapter
read-back must retain the normalized structure. Adapters honor supplied filenames,
preserve MIME bytes/reply headers and verify the provider result. No new wire fields
or SDK version are required; plain-text-only adapters retain their existing path.
This is structural protection, not a guarantee of identical CSS rendering across
email clients. Ordinary fragments and explicitly authored plain text are retained.

Desktop attachment actions `mail:attach` / `mail:image` are native Host gestures,
not plugin HTML controls. The dispatcher verifies current view, owner, mail
capability and draft state before and after the native picker, and passes one
transient hash/size-bound file descriptor to the provider event. No arbitrary
path comes from form text. Selected desktop bytes are copied into the existing
session-owned temporary attachment store; only the staged descriptor crosses
the plugin boundary, never the user's original path. Source replacement after
selection cannot change the staged bytes. Failed/stale delivery discards the
copy; accepted files retain normal session/orphan cleanup. Pending or sent mail cannot open the picker. Mobile
resource metadata adds optional `mailUpload`; old hosts omit it and new phones
hide the upload button. Supporting hosts accept `mail:attach:<key>` with optional
`input.mailAttachment: {url,name}` and the complete form. Only existing OSS/peer
upload references with size and SHA-256 are accepted (16 MiB/file), never local
paths. The existing task materializer owns downloads and session cleanup; owner,
interaction lease and current draft state are checked before delivery. No new
relay channel, native dependency, database or runtime fingerprint is introduced.
Ordinary attachment removal retains the existing remote form delivery gate.
Optional `mail.images` contains validated managed preview URLs keyed by CID;
these URLs never replace CID references in the saved/sent message. The existing
media-deposit ledger owns these image bytes; no new file store or database exists.
Mobile resolves CID previews with the existing remote-media queue into data URLs
inside a sanitized mail WebView whose CSP blocks all page scripts. Host-injected
editing listeners send only a document revision, known text-run index and plain
text; the native side validates those before applying source patches. Desktop
uses parent-owned listeners in an iframe without script permission. Autosave
echoes do not reload either editing surface. CID substitutions never enter form
edits; missing images leave the rest of the email readable.
Attachment items optionally carry `mimeType` and `previewUrl` (validated managed
image URLs only). Both clients show file identity and size; image clicks use
their existing viewers. Removing a CID image removes its part and image nodes,
preserving the rest of the authored document. "Insert into message" assigns an
available `image-N@cindy.local` CID to an existing image key and inserts an HTML
image before the closing body tag. Adapters validate the actual bytes and write
that existing part as inline without uploading a duplicate. Compare part keys
and normalized Content-IDs, ignoring preview-only metadata when detecting edits.
After sandbox restart, the next card edit/send (including model send) restores
volatile state using the persisted account/draft/locator. It retains incoming
form edits and the same card key. Optional `baseValues` in the existing host card
retains the last synchronized values (not in plugin KV). The SDK's internal
`mail-draft-read` uses the same plugin/call/session ownership as publication.
It compares base, card edits and provider values: identical/one-sided changes and
independent text ranges merge automatically, ignoring preview-only metadata.
Unmergeable overlapping edits retain both versions and name the conflicting fields.
Legacy clean cards supply their own base; legacy errors without a base converge
only when contents agree. Pending/unknown/sent records never become drafts.
Adapters may return `execution:not_executed` with `stale` read-back; the SDK can
merge and retry once. Unknown writes never retry. Changed content discovered at
send time is shown before a fresh countdown; metadata-only drift needs no prompt.
Old clients ignore optional baseline values; existing remote form actions carry
no new required fields. The host SDK, not mailbox plugins, owns recovery/merging.
Recovery never resumes a previous countdown; a new send gets the full grace period.
Reading an unchanged draft in the same task reuses its existing card without
publishing another snapshot. The host verifies task ownership through
`mail-draft-read`; a different task still receives its own card. Fresh provider
fingerprints/locators are adopted even if visible content is unchanged. Desktop
mail cards require an exact tool ID or settled result to anchor them; the generic
same-plugin in-flight heuristic must not show old mail beneath a schema/read call.
Desktop HTML previews retain head styles, class selectors and body presentation
inside their inert sandbox. External CSS resources, scripts and navigation remain
blocked; preview sanitization never mutates the saved HTML.

### Read-only mail preview

Mail providers may declare `mailReader: { tool, hosts }` alongside `mail: true`.
`mail` accepts only omission or literal `true` in both v2 and v3; both validators
reject a reader without `mail: true` or without its matching tool in `tools`.
Desktop and plugin-protocol validate this known declaration and retain future
extension data; malformed declarations cannot survive as unknown top-level fields.
Install/detail permission projection includes `mail`, the reader tool, individual
reader hosts and optional read-state writes; adding any of them requires the existing
update consent even when the tool was already registered. Reordering/deduplicating
hosts or removing capabilities does not expand permissions.
The tool must be declared and read-only by default. Cindy matches exact HTTPS hosts
and calls it with `{ url }`; the provider resolves the account and message without
marking read or mutating drafts. Providers may opt in with `mailReader.markRead: true`
and accept optional `markRead:true` on that same tool. The declaration permits only
omission or literal `true`; `false`, strings, null and other values are invalid in
both manifest validators. Runtime dispatch also requires literal `true`, including
for declarations retained by older validators. Future unknown metadata remains
preserved by manifest normalization and never grants permission. Only an explicit user opening
passes it; AI reads, probes and neighboring preloads remain read-only.
The dispatcher strips `markRead` from ordinary tool arguments for the declared
reader; only the trusted native-reader request may inject it after literal opt-in.
Other explicitly authorized read-state tools retain their normal Agent path.
Restored inactive tabs and a hidden sidebar must not mark mail read merely by mounting.
Mark only the successfully resolved, visibly opened message, never the whole thread or drafts. A failed
mark must retain the body and return `markReadFailed:true` for a non-blocking notice.
It returns `MailMessage` (maker-shared/mail-message).
Optional `participantPhotos:[{email,url}]` supplies exact normalized-email contact
photos (at most 64, credential-free HTTPS URLs). Invalid photo entries are discarded
without dropping the message. Old providers omit this field; old clients ignore it.
It travels in the existing message response/resource with no new IPC or permission.
Desktop uses it before Gravatar (SHA-256 normalized email), a fixed DuckDuckGo domain
favicon endpoint for non-public mailbox domains, and initials. External avatars use
no referrer and bounded load fallbacks; they do not enable remote images in the body.
Desktop loads avatar sources for at most the first 12 participant positions per
message, shared across from/to/cc/bcc; duplicates also consume a position. Remaining
participants use initials and retain their complete addresses, without photo or hash lookups.
Domain icons are presentation, not authenticated sender identity. Other clients may
continue displaying addresses alone. Provider contact enrichment must remain optional
when new contact scopes are missing; Gmail bounds its lookup budget and account cache.
Desktop activates only HTTP(S) body links through the chat opening policy and keeps
their underline visible despite sender CSS. Unsupported targets, including mailto,
stay inert without an href or explicit link role in the reader, so they are not
keyboard/screen-reader links. Reader paint and authored link attributes are restored
before editing or serializing a draft; the system shell protocol allowlist is unchanged.
Credentials and MIME parsing remain with the provider. Cindy validates the data
and reuses its inert HTML/CID/recipient renderers for delivered mail. Multiple
matching providers/accounts cannot silently select the first. Host setup metadata
selects a sole ready instance without probing mailboxes; several ready instances
return optional `providers:[{id,name,namespace}]` for a user choice. The host-issued
opaque `providerId` returned with a message pins neighboring reads to that instance;
removal/disable never falls back to a different one. Choices are local to the current
owner/device/session/link, with no persisted default or account migration. Unknown providers or
older hosts keep normal browser opening. Attachments use managed image previews;
other file types retain their metadata and the mailbox opening fallback.

Desktop uses a session-scoped sidebar tab. Mobile/same-account remote clients use
the existing `mail-messages/message` remote resource, ID `[sessionId,url,read]`,
primitive `mail-message`.
Explicit opening adds optional `query:"open"` to resource get, or optional fourth
`opened:true` to `ghosts:mail-preview`; resource IDs and default read behavior stay
unchanged. Old hosts ignore the new optional values; old providers still receive
only `{url}`. No new channel, storage or native changes. Plugins adding an OAuth
scope must keep existing granted operations usable; missing new scopes may fail
marking read, not prevent viewing or composing.
Explicit provider selection adds optional fifth `providerId` to `ghosts:mail-preview`,
or JSON `query:{opened,providerId}` (serialized as a string) on the same remote resource;
the three-element resource ID is unchanged. Main revalidates the selected instance
against enabled approved matching readers after session authorization. Old clients
ignore the extra response fields; old hosts do not expose choices, so new clients
retain their normal legacy read request until a current host returns a choice.
Existing 256-character resource ID bounds still apply; overlong remote links fall back to browser opening. Shared-task access does not
grant mailbox access. Scope checks run before and after reads; clients bind display
to account/device/session/URL and ignore stale responses. No mail content is stored
in sidebar state. Delivered-mail links do not publish cards.

For an explicit visible opening the dispatcher also injects Host-only `openDraft:true`;
ordinary tool arguments cannot supply that intent. A draft-aware provider resolves the
stable provider draft ID and reuses its existing compose read/presentation flow, returning
optional `draftId`. Main registers the native call in the existing card service and returns
optional `draftCallId` only after matching a current card's task, plugin, account and draft.
This reference is never accepted from provider result data. Background reads cannot publish
or return editor bindings. Desktop's local sidebar and Mobile use their existing card editors,
autosave and send/undo actions. The Mobile editor reuses `plugin-results/card` subscriptions;
no new transport, persistence, credential transfer or send path is introduced.
The Mobile editor follows `supersededBy` through the same task-scoped resource reads only
while installation, account and draft identity still match; its actions and invalidations
use the resolved card ID. Ordinary chat rows continue hiding superseded cards.
Remote Desktop retains the read-only message and original mailbox link because its
existing card editor dispatches local actions only. Native reader calls are finalized
even after owner/installation invalidation. Owner scope still guards result delivery;
an invalid installation cannot acquire editor bindings or extend the call-bound Host capability window.
Old hosts do not inject `openDraft` and remain read-only; old providers ignore it, and old clients ignore
`draftCallId`. Source package compatibility remains 0.1.112; editable link support requires
both the updated provider and the corresponding Host/client changes.
Desktop link opening and card enlargement both await the existing card-form delivery
barrier before changing tabs; explicit reads also await it before calling the provider.
Failed delivery keeps the current editor intact. Probes and background reads do not
wait for or flush editor changes.
Link probes return `supported:false` when no enabled matching reader is ready, retaining
normal browser opening on Desktop and Mobile. Explicit reads of restored tabs distinguish
no matching reader (`supported:false`) from an unconfigured one (`MAIL_PROVIDER_NOT_READY`)
without calling provider tools. Both show a labelled mailbox-opening action instead of
an ineffective retry; restored tabs never launch an external page automatically.

Desktop native mail cards also open this tab through `open-mail-card` with
`sessionId` and `callId`. The tab stores only the card ID and uses the existing
card editor/actions; session-scoped lookup and supersession select the current
view. This is a local desktop trial, not a new plugin or device-link capability.
Older URL-based reader tabs remain valid. Draft edits, deletion and delayed send
still use the same host-owned mail workflow as the chat card.

## 远程供应商的模型范围

既有供应商管理通道新增 `get-model-access` / `set-model-access` action，返回 `version: 1`、
`models`、`providerModels` 与 `availableModels`；仅提供方主人可管理，`memberId` 必须属于该供应商的分享。
`null` 表示全部／继承，空数组表示不开放。新界面连接不认识此 action 的旧电脑时提示更新，不回退成只改控制端偏好。

同账号 `maker:provider:list` 的 `ProviderView` 可追加 `remoteModelIds`，省略保留原有全部开放语义。
仅远程 Agent 选择入口按此字段过滤；同账号远控和本机列表仍保留完整 `models`。跨账号分享目录直接按成员权限过滤模型。
旧控制端忽略新增字段仍由提供方执行调用权限检查；现有错误码 `REMOTE_AGENT_PROVIDER_NOT_ALLOWED` 也覆盖模型未开放。
权限保存于客户端按账号隔离的配置，不改服务端 schema、数据库或 Mobile 原生指纹。

供应商组中转新增可选 caps / open 字段 `relayModelAccess: true`，只有显式声明此能力的执行电脑才接收需要限制模型的任务。
组所在电脑覆盖调用方自报的该字段；执行电脑通过既有 reverse request 发送 `{type:'model-access', model?}`，
由组所在电脑绑定当前运行、供应商和原成员，回复既有 `callback.value`：省略 model 返回获准目录 ID，指定 model 返回布尔授权。
启动取目录交集，后续每次请求重查原成员权限；不缓存肯定答复。复核最长 10 秒，超时、断连、旧运行、撤权或未知回复均拒绝，
只影响本次调用，不重置共享连接或自动重放。异步答复返回后执行端再次核对本地授权及绑定代次。
新组所在电脑给旧执行电脑只转发不限模型的任务；新增限制时结束尚在旧电脑运行的任务。旧组所在电脑不具备此能力，
需更新后才能提供中转成员模型范围保护。旧控制端无需理解 reverse 请求，它在组所在电脑消费；不新增通道或修改移动端原生配置。
Pi 的原生供应商适配器只暴露获准模型，在打开流前用既有本机任务隧道的 bearer token 请求 `/cindy/model-access`，
模型 ID 来自宿主冻结的授权映射。该路径由执行 Host 消费，复用同一绑定与复核，不转给控制端；凭证与消息内容不进入查询。
同账号 Pi 原生请求也走该本机入口，必须携带实际来源 `providerId`；Host 按该来源把原生模型 ID 解析为目录 ID，
复核当前任务绑定和远程模型范围。访客仍可省略该字段并使用已绑定的唯一来源，提供其他来源时拒绝。
适配器启动与热刷新保留来源标记；本机普通任务不生成标记，不增加远程授权检查。此扩展不改变跨电脑 wire 格式。

## 伙伴导入的消息机器人分类

`companion-import` Remote Resource 的 client primitives 可追加 `companion-import-bots-v1`。只有声明它的控制端
（以及本机界面与 `import_agent`）的预览才会收到 `category: 'bots'` 条目及其可选 `platform` / `owner` 字段，导入时
会先在来源 Agent 里停用这些机器人再由伙伴连接；旧控制端的预览校验不认识新分类，所以照旧把 Telegram / Discord
放在 `connections`、不停来源，也不出现飞书 / 企业微信 / 钉钉条目。分类随预览快照与加密检查点保存，开始导入和恢复
都按当时的分类执行。不改 relay 帧、服务端 schema 或 Mobile 原生指纹。

Cindy AI 设置卡片保留可选读取返回的 `unlimited` 状态，显示“未设置个人限额”；它不代表部门或企业没有限制。`invalidated` 清除该状态，有限额快照覆盖该状态，切换账号不复用上一账号结果。旧 `null` push 无法区分失效与不限额，本地卡片收到后通过既有可选读取核对；同一账号的多个组件共享在途读取，收到读取自身的广播时复用该请求，避免多窗口之间反复触发刷新。主进程跨窗口共享在途读取，已知不限额参与既有节流，重复不限额结果不重复广播。IPC payload 与远程消费者保持兼容。

## Codex 超快速度

客户端内部沿用 `fastMode`：`false` 为标准、`true` 为快速、`"ultrafast"` 为超快。
SQLite 的原有 `fast_mode` 列保留 0/1，新增值 2；Drizzle 与原始 SQL 写入共用映射，
不修改历史 migration。旧客户端读到 2 时回落标准，不破坏已有 0/1 数据。

远程任务／自动化／收藏读模型与设置推送保持旧布尔字段，超快另外携带
`fastModeTier: "ultrafast"`（收藏为 `fastTier`）。新客户端在传输入口恢复内部速度值，
旧客户端继续读取快速开关；消息正文与工具输出不做转换。写操作仍由 Host 按当前账号、
模型及执行引擎校验。新版连接旧 Host 时没有 `supportsUltrafastMode`，不显示超快选项。
新建超快收藏在旧端可读，但旧端无法精确编辑该档位；冲突检查保留 Host 原配置。

新建任务默认值读取与草稿变更推送沿用同一投影；按模型保存的 `fastModeByModel` /
`fastByModel` 保留布尔字典，用 `fastModeByModelTiers` / `fastByModelTiers` 附加档位。
伙伴 `capabilities` 中的 `modelChain`、`modelChainOverride`、`modelOverride` 同样保留
旧布尔字段。仅遍历这些明确的设置结构，不扩展到任意内容对象。

`supportsUltrafastMode` 只来自账号的 Codex `model/list` 或缓存的 `service_tiers`，
不能按模型 ID 或全局 registry 推断资格。完整的超快配置需要执行端与查看端都支持本功能。
没有服务端、原生 Mobile 配置或模型内核版本变更。

## 插件资料设备同步

`device-link:plugin-sync:v1` 只在 Desktop Main 消费，wire 定义在
`packages/device-link/src/pluginSyncProtocol.ts`。同账号、未撤权的在线电脑交换已确认
namespace + id 下同一插件的有界 JSON 请求；`deviceSync: true` 是独立能力，权限区同步展示。
手机继续操作执行电脑上的插件，不建立独立副本；共享任务和供应商分享不准入。
旧客户端忽略新通道，插件探测 API 后保留本地功能；超时不代表未执行，不自动重试非幂等动作。
复用现有设备密钥库，AES-GCM AAD 使用 `plugin-sync:` transfer 标记与源/目标设备绑定。
每请求 64 KiB、每插件 2 个/全机 32 个在途、30 秒超时；应用持久化后才回复。
接收按 peer 顺序排队，全机最多 64 帧；等待不会拦住其他 peer，账号重置后旧队列失效。
投递等待同一插件沙箱入口加载完成，并在实际发送前重查撤权与请求有效期。
排队、密钥准备和沙箱启动共享从帧入站起计算的 30 秒截止时间；超时释放该 peer 队列，迟到的启动不能再投递。
入站等待前捕获各候选插件安装状态；更新后的插件不接收旧帧。撤权翻转 peer 授权代次并清理双向在途请求，重新授权只放行新请求。
显式断开远程控制后此通道可走 unlinked legacy；不重新打开控制链路，仍执行同账号与撤权检查。
同步可用设备查询会向被对端撤权的在线电脑发出有界 `authorize` nonce 探测；对端仅在本机仍允许该设备时通过同账号认证 relay 回复 `authorized`。匹配本连接代、peer 与未过期 nonce 后只恢复同步准入，不清除远控撤权标记，也不打开控制链。撤权和连接重置清除旧探测及同步授权；旧客户端忽略这两类增量帧。
撤权写盘前立即关闭同步准入，成功后由持久黑名单接替，失败后释放临时拒绝但不恢复旧在途请求。插件本地/Forge/市场更新、卸载和启停从停止前到提交或回滚结束全程阻断该实例同步；嵌套变更须全部结束才恢复准入。
账号/owner、安装 revision、插件启停和撤权每次重新核验，旧请求失效只影响其调用，
不重连共享 relay。恢复由插件持久状态对账，不恢复失效请求。
实现与 unit 回归：`cindy-brain/deviceSyncSlot.ts` / `__tests__/deviceSyncSlot.test.ts`。
完整体验需要两台电脑都更新 Host 和插件；本地回归不能代替双机稳定版/Beta 实测。

## 跨电脑任务行动回执

`maker:session:handoff` 增量支持 `task-action-capability` 与 `validate-task-action`。
新发送端先查询 `taskActionVersion: 1`，再发送带 Host 生成 `taskActionReceipt` 的消息；
缺能力时明确拒绝，不回退到旧发送方式。新接收端拒绝缺回执的旧请求，要求发送端更新。
完整任务互发需要两台电脑均升级；同账号鉴权、隐藏任务和共享访客限制不扩大。

回执只存在发送 Host 内存，绑定接收设备、发送任务、目标任务与正文，最长一小时；
接收端一次认领，强制经队列，在消费前回调发送 Host 复核。
确定未发送的本机失败或目标明确未接受时，发送端立即释放回执，避免离线尝试耗尽容量；
在途断连、超时、远端写后回执查询失败和无法识别的结果保留原有效期，不自动重发。
队列派发或丢弃后通过同一 `validate-task-action` 请求的可选 `release` 标志释放回执；
发送端删除回执后返回 `released: true`，重放无法通过验证，接收端才清除认领。
旧端没有该确认或未收到释放回执时保留原过期清理，不把旧端的普通验证成功当作释放成功。断线、撤销、账号切换或重启后
无法复核时不投递，不自动重放；已送达历史保留。未知投递结果仍要求先读取目标核实。
没有新 relay channel、服务端变更、数据库 migration 或 Mobile 原生指纹变化。

### 转达原话的核实标记（2026-10-23）

`maker:session:handoff` 与伙伴跨电脑私信的 `requestSource` 增加可选 `ownerVerified: true`：发送端只在宿主
核实为主人代办的轮次里转达时携带。接收端经 `readForwardedRequestSource` 只认字面量 `true`，并继续用
`matchesForwardedRequest` 校验正文；正文三行格式不变。旧接收端忽略该字段，行为与之前相同；旧发送端
不发送，新接收端按未核实处理。同账号鉴权、行动回执与共享访客限制不变。产品语义见
[伙伴代表谁](../product-rules/teammate-authority.md)。

## 普通个人的社区插件贡献

已安装清单可选追加只读 `publishingSource`，由 Host 既有实例记录、批准回执与安装台账重建。
它仅用于个人提审入口的来源准入，不改变列表的来源展示、安装来源、自动更新或发布权限。
缺失或无法核实来源时不开放提审；本地安装和公开安装都不会因提审或过审自动转换来源，不新增持久化关联记录。

新增独立 `/api/plugin-contributions` 和精确 `plugin-contributions:*` IPC，不改企业发布、
旧公开市场 DTO 或 device-link allowlist。两仓分别维护等价
[HTTP / DTO 契约](../plugin-community-contribution-contract.md)。客户端使用当前个人 Access Token，
以可信 auth discovery 的 issuer 与 token sub 核对所有作者响应主体；`cn/global` 只用于选择 Host 配置，
不能当作 issuer。服务器仍做验签和 public 提交 ACL，包内作者声明不授予提交权。

prepare / PUT / commit 复用同一固定包和持久幂等键；202 仅表示处理。结果不明先查原操作；
不换包、不换键自动新建发布操作。receipt 的 uploadedPackage SHA 与实际 releaseRevision SHA 分开，
`outcome`、修订审核与市场 `available` 分开。处理历史以独立 eventId 分页，旧修订不套用当前修订结果。
Host 持久操作按账号隔离、异步结果按 owner generation 拦截；审核结果通过用户打开、刷新、前台恢复及前台定时读取同步。
本地 `review-updates` / `mark-review-read` IPC 仅供可信桌面 Renderer，不加入 device-link 白名单。
提示点复用现有作者列表和精确修订的审核记录，Main 只额外保存按账号隔离的本机已读标记；
不新增服务端通知/已读 API，不改变审核事实，不因列表查询或 AI 查询而清除提示。
旧服务器未实现接口时如实显示读取/发布失败，不试探企业或 Platform 身份，也不伪造空列表或成功。
存量插件安装、批准记录、启用状态、包格式和市场来源枚举均保持原契约；本能力需要两端更新。

## 社区版本提审 v2（2026-10-16）

manifest 可选字符串 `releaseNotes`；旧包缺字段仍可安装。首次上架可不填写，曾上架插件的后续提审须提供完整非空更新说明。
个人只读 preflight 查询版本、待审与提交权限；SubmissionView 追加真实时间及允许取消动作。
审核状态增加 cancelled；Main/preload 新增精确 cancelReview，AI 对应 ghost_cancel_plugin_review。
旧 journal 字段可选只为读取/原操作恢复，不允许新客户端静默绕过新版预检。
个人投稿复用原审核请求及上架流程，不增加启用开关、审核令牌或历史比较包门槛。取消仅针对本人仍有提交授权的精确待审修订，已通过或驳回时按真实状态返回。

## 伙伴跟进邀请（2026-10-21）

总调度未设置 override 时默认关闭，已有明确选择保留。跨端沿用 `teammates` 远程资源：
`settings:<botId>/follow-up` 返回既有 form/toggle/confirmation、可选邀请标记和不透明动作票。
读资源不启用跟进；点击开启或暂不开启才保存。票据绑定账号、控制端、伙伴及当前设置 revision；
旧票、隐藏伙伴与账号切换沿用既有拒绝规则，不新增 invoke channel 或共享访客权限。
新 Host 对旧查看端仍执行默认关闭；旧端忽略新增入口/字段，已有聊天不变。新查看端连接旧 Host
时不显示邀请，不能声称旧 Host 已执行新默认。Desktop 本机与远程 Desktop 的对话内邀请是一行轻提示，
点「开始跟进」先弹与设置页同一确认框，完整显示范围及用量（远程时取 Host 下发的文字），确认后才保存；
「暂不开启」直接保存。Mobile iOS/Android 复用现有设置表单与按钮并显示范围及用量；
没有原生配置、依赖、指纹或数据库迁移变化。

## 自动化绑定投影的持续会话标记（归档确认）

`maker:schedule:list` 在 `sessionBindings: true` 的投影里新增可选 `persistentSession`（仅为 `true` 时携带，
`false` 或缺省都不下发），继续保留运行模式与旧控制端兼容。当前控制端的归档提醒按 `active` 绑定筛选，
包含持续会话，不再用该字段排除提醒；普通自动任务下次触发会恢复原任务，不因归档换绑。
实际执行生命周期由被控端版本决定：旧被控端仍可能暂停普通自动化或为持续会话换绑，
新被控端按恢复原普通任务的语义执行。混合版本的提示可能与实际执行不同，以被控端版本为准；
不新增协议字段或版本协商。旧控制端可能仍按该字段省略持续会话提醒，或展示旧暂停文案。
`parseScheduleBindings` 对未知字段继续忽略，旧被控端缺省该字段不影响新控制端的提醒筛选。

产品语义与托管任务边界见 [`archive-pauses-automations.md`](../product-rules/archive-pauses-automations.md)。

不新增 channel、能力、服务端 schema、数据库或 Mobile 原生指纹，`maker:schedule:list` 沿用既有白名单。
桌面远程任务归档时，每台设备总是直取一次带 `sessionBindings: true` 的 `maker:schedule:list`（最多等
1.5 秒；失败或超时回退本地镜像里已有的快照，没有则按无绑定处理，离线设备因此每次最多多等 1.5 秒）；
手机归档确认同样只发一次带该投影参数的 `maker:schedule:list`，同样有界。两端都只请求绑定投影，不拉完整列表。

## 原插件设置页的文档来源隔离

`settings:open` 可选返回 `documentIsolation: true`；新手机仅见到明确标记后才在既有
加密 settings 通道发送 `{ kind: "document", epoch }`。epoch 是单租约内递增的正安全整数，
相同值幂等、较旧值拒绝；不增加 channel、权限或持久化字段。Host 每代生成的 UUID
继续使用插件既有 `mobilePageId` 契约，旧来源只保留同租约通知投递资格，不能创建或回答
新确认、目录选择或其它交互。关闭租约清理全部来源。

旧手机连接新 Host 时忽略新增能力、沿用旧语义；新手机连接旧 Host 时不发新命令，
配置读取、保存与包内导航照旧，完整跨文档确认隔离须两端都更新。插件本身无需更新，
不改变已装批准、凭证、KV、版本或原生指纹。实现与时序验证见
[原配置页协议](../remote-plugin-oauth.md#手机原配置页授权的增量能力)。

## 自动化的远程模型选择

`Schedule` / 创建与更新输入增量增加可选 `modelAgentDeviceId`：缺省保持旧版绑定任务的位置继承，
空字符串表示自动化所在电脑，非空使用既有远程／分享 Agent 标识。SQLite 新增可空文本列，
SQL NULL 对应缺省；项目 `version: 1` 配置同样允许该字段，旧文件无需改写。
既有 `agentDeviceId` 仍只提供新建／重建任务的默认位置；绑定任务存在时继续跟随它的当前位置。
显式 `modelAgentDeviceId` 优先于该默认值（包括空字符串本机），仅查看或修改旧记录的非模型字段
不会将默认位置转换为显式覆盖。MCP 的旧 `agentDeviceId: "local"` 仍沿用原协议；从
`schedule_list_models` 选择本机并填写 `modelAgentDeviceId` 时使用空字符串，不使用 `"local"`。
绑定任务或持续模式的 Agent 自动化显式选本机时也须有 `modelAgentKind` 与 `model`；不完整选择在保存前拒绝，
不把“选本机”误作继承绑定任务的位置。更新可沿用已存的完整选择，恢复跟随时清除显式选择。
`maker:get-capabilities` 返回 `supportsScheduleAgentDeviceSelection: true`。
新调用方只有明确看到此能力才向其它电脑提交位置选择；旧端未知字段会被忽略，禁止静默降级。
跨电脑更新非空 `modelAgentKind` 时，即使省略位置以继承原位置，也必须先确认既有
`supportsScheduleModelSelection: true`；旧端不支持时在写入前拒绝。同时设置位置或清空模型
字段时，两项所需能力一起核验，复用一次能力查询及原有账号代次检查，不新增协议字段。
跨电脑 `schedule_update` 清空 `modelAgentDeviceId` / `modelAgentKind` / `model` / `providerId` /
`effort` 时，同样先核验此能力，再保留可序列化的 `null` 发送；接收端 IPC 转成带 key 的
`undefined` 后交给 Scheduler 与存储。省略字段仍是不修改，不在发送前丢掉清空意图。
旧调用方修改新自动化的非模型字段仍保留位置；修改模型路线却未携带已固定的位置时拒绝保存，
避免意外把另一台电脑的供应商当作本机来源。执行与恢复仍使用既有远程授权、目录与切换协议。
直接发送与排队派发在准备完成后，按实际运行位置、模型及供应商重新读取远程目录；来源或模型
已停用、离线或授权不可用时拒绝本次调用，排队项取消发送预留并失败收口，不回退到本机来源。

## 公共插件分享（未发布首版）

`shareBaseUrl` 是端点清单的可选字段；缺失/空值关闭分享素材准备，不猜测域名。旧客户端忽略字段，既有市场和安装协议不变。公开 DTO `PublicPluginPresentation` v1 由两仓的 `packages/plugin-protocol` 同步维护，不含包或安装批准。

`plugin-market:prepare-share` 接受可选 `ShareOptions {includeAttribution:boolean}`，省略时匿名。Main 向构建区域固定 Share Server `POST /api/shares`，请求 `{kind:'plugin',reference,includeAttribution,region,lang,authRealm?}`。CN/Dev 是 cn/zh-CN，Global 是 global/en；Auth 权威区域随当前身份冻结，可以与构建区域不同。只有署名创建携带当前用户 Access Token，固定账号代次；仅遇到明确的 TOKEN_EXPIRED 时复用登录续期并重试一次，续期前后及请求前复核原身份，不降为匿名。匿名请求无凭证。Renderer 不持有 token、不指定用户或上游服务。

Share Server 以独立 PostgreSQL 库唯一保存分享关系；返回既有素材字段及 `shareId`、`includeAttribution`。Main 校验随机分享编号、固定同源且无查询参数的 `/s/:shareId` 与署名方式。区域语言仍由创建请求明确携带并存入记录。转发同一编号保留原署名；开关或重新分享选择另一条绑定，不修改既有记录。链接不含 source、内部身份、版本、包或批准；请求结果在切账号/资源后丢弃。

落地页、二维码和图片使用同一无参 `/s/:shareId`，资源、署名、区域和默认语言以服务器记录为准；页面显式切换语言时，合法 `lang` 仅覆盖当前页面、JSON、SVG 的展示语言，向插件服务透传，不改写原记录或创建新编号。每次检查当前公开上架及可交付资格，显示当前公开版本；作者原文保留。当前昵称头像通过 Auth 实时读取，不可用则隐藏，不把已署名绑定降为匿名。生成时身份验证失败返回错误，可重试或另选匿名分享；资料查询不可用时隐藏署名展示，不改变原署名绑定，不复用错误身份。

Share Server 在创建时保存已验签的分享者 `membershipId` 与身份权威。Auth 只读现有账号资料，不增加分享字段、记录、索引或 migration；公开资料接口使用 shareId，在固定 Share Server 回查有效分享与身份绑定后读取当前资料。分享服务端已独立提供该能力，客户端沿用现有认证与固定分享入口，不引入额外 Auth 写入或凭证存储。公开资料新增可选的内嵌栅格 `icon` 字段，两仓协议同步；缺失或无效时使用默认图标，旧服务与旧客户端均兼容。

方形 SVG 为 1080×1080，Desktop PNG 为 2160×2160，接收界限 1 MiB。素材用于人工复制/保存；网页只展示与承接，不提供发送面板工具。`cindy://plugin/:pluginId` 仍只导航，拒绝 query/fragment/安装参数，沿冷启动、登录恢复、兼容包选择和原安装批准。通用市场详情入口接受服务端解析后的当前区域 ID，再与当前可见目录核对身份及发布；新旧 ID 映射仍归 Plugin Server，分享层不新增转换。已有目录 ID 的请求仍严格绑定原条目，不能借规范化跳到其他插件。不扩 device-link 或 Mobile 能力，没有“我的分享”、移除已发署名、分享统计、转发链、平台 SDK 或资料快照。

本版分享接收限于插件页选择本机且目录正常的情况；不承接远程电脑的分享导航或断线恢复，不自动切换所选电脑。组织目录不可用时继续遵守未下发条目不读取详情的既有限制；历史或跨区域公开编号的解析也可能被该限制拒绝，本版不新增解析入口或放宽访问边界。

## 本地插件按次分享

公共 `kind=plugin`、`cindy://plugin/<pluginId>` 及其链接复用、版本选择和安装规则保留。
本地分享另用 `kind=local-plugin`、随机 `snapshotId` 和
`cindy://plugin-share/<snapshotId>`；只导航，拒绝 query、fragment、包 URL 和自动安装参数，
沿原冷启动与登录续接进入独立分享详情，优先于本机／远程目录分支。安装沿用当前所选电脑；仅在有其他候选电脑或已选远程电脑时显示原设备选择器，不额外要求选择。离线或不支持的目标不可安装，不自动切回本机。不新增 Mobile 入口。

两仓 `packages/plugin-protocol/src/localSharing.ts` 同步维护上传、固定快照与交付校验，
不修改已有 manifest、Release 或来源枚举。每次打开本地分享面板生成新操作；用户明确开始后，
Main 先用原一致性读取入口核对已批准的本地实例，绑定版本、批准回执、内容摘要与原登录身份；
需要上传且取得确认后才压缩固定包。
普通 Access Token 用于创建、查看、图片和下载；关闭署名只隐藏姓名，不转匿名。
同一面板重试和署名切换复用原包，新的分享操作始终独立；ready 包不跟随本地文件或后来版本。

逻辑分享与包存储分开：内容摘要按确定顺序编码，打包沿用原 ZIP 条目与时间戳行为，保留实际文件、权限、
空目录与签名字节，不改变普通导出和投稿的包元数据。新的操作仍创建新的 snapshotId；相同包可指向同一 OSS 对象，服务端命中本人
已验证的相同内容摘要时，check 直接返回 ready，客户端核对本次内容与身份后省略压缩、PUT/commit，
继续创建本轮分享素材。同版本内容改变不能复用；不凭其他用户包的摘要跳过上传验证。
本地分享先核对当前包与服务端复用结果：ready 时直接生成新链接，不再确认上传；需要传包时
返回 `confirmationRequired`，原分享弹窗取得明确确认后才传 `uploadConfirmed: true` 执行 PUT。

检查阶段仅稳定读取文件计算分享内容摘要，调用新增 `POST /api/local-plugin-shares/check`，
不压缩 ZIP、不写上传包。命中本人已验证内容时直接返回本次新快照，免确认和上传；
未命中才确认后打包，打包内容必须仍与确认前摘要一致。服务端从实际归档重新计算
`contentSha256`，精确 ZIP `sha256` 继续负责传输和安装校验，版本号不能替代内容判据。
并发上传的相同内容也可复用不同编码的 ZIP；客户端先绑定服务端已验证的内容，再固定所选
快照的实际 ZIP SHA 和大小，后续分享素材或署名重试不得换包。
原投稿恢复保存的 `contentSha256` 编码不变，分享使用独立版本化摘要，不改其持久状态。
两仓增量协议同步，旧 ZIP 上传请求可省略新增摘要字段；服务端先部署检查能力，
新客户端访问不支持检查的服务端时报告失败，不自动上传或回退成先压缩的检查。
确认前只发送内容摘要，不发送包字节；不新增客户端长期上传记录。

可信 renderer 的新增 IPC 为 `plugin-market:prepare-local-share`、`release-local-share`、
`local-share-detail` 和 `install-local-share`；不加入 device-link allowlist，不接收文件路径、
服务地址或用户身份。下载只取固定服务签发的该快照票据，核对大小、SHA、ghostId 和版本后，
复用本地包的真实权限确认、root/manual 安装／更新锁及 durable receipt。换源必须沿原确认，
不写市场更新订阅，不改写 namespace、签名或 `minCindyVersion` 策略；取消不报告安装完成。
分享包覆盖已安装的同 ID 插件时，即使权限未增加也必须明确点击“替换”；本机与远程目标
共用原确认回执（`purpose=share-replace`）。普通本地来源更新的说明明确告知会继续使用旧账号和数据，
相同 ID 不证明作者相同；已触发原换源判据时仍展示原隔离说明，不改变状态继承规则。
临时包使用独立目录，失败、释放面板、窗口关闭及退出清理；切换账号使在途结果失效。

需先部署支持独立快照与增量表的 Plugin Server，再部署本地模块的 Share Server，最后发布客户端。
旧客户端不认识新深链，不得降为公共安装；新客户端连旧服务只报告能力不可用。
旧服务与新增表可滚动共存，回退入口不改已有本地包或公共记录；已生成的新链接需要支持本地模块的服务。
远程插件 `management:snapshot` 增量返回可选 `localShares: true`，新控制端只在明确声明后提供固定包安装。`management:begin` 新增 `kind=install-share` 与 `expectedSnapshot`，不接受包 URL、token 或目标路径；目标宿主使用自己的登录态换取下载凭据，复核快照／摘要／大小，再进入原手动安装事务。权限确认、取消和结果查询复用原 operationId 回执；断连只查原操作，切账号后丢弃旧结果。旧端缺能力时提示更新；旧控制端忽略新能力字段。无新增远程 channel 或权限扩展。

相关回归：`localSharing.test.ts`、`deepLink.test.ts`、`ghostLocalInstallIdentity.test.ts`、
`LocalPluginShareView.test.tsx` 和 `scripts/fixtures/local-plugin-sharing/`。

## 伙伴关联项目

`teammates` 增加 `settings:<botId>/projects` 与其项目详情资源。使用既有 list/form/toggle 原语，
保存仍绑定账号、控制端、伙伴和资源 revision。远程不传目录绝对路径，项目 ID 为不透明摘要；
旧控制端可忽略新入口，新控制端连接旧 Host 时不显示入口。手机两端与远程桌面共用宿主投影。
本机新增 `local-db:bots:projects:list/set` 仅用于受信 renderer，不进入远程 IPC allowlist。
旧 `workbench.json` 目录及设备归属沿用原格式；关联不进入任务负责范围或扩大文件权限。
不改服务端、数据库 schema、Mobile 原生配置或指纹。

## 订阅 Fast 的账号与组约束

`remote-agent` 的 caps 新增可选 `subscriptionFastPolicy: true`，仅严格的 `true` 表示执行端支持。
新的 `fast-policy` 操作携带组 ID、修订号、`allowFast`，以及可选的任务绑定；只经已有认证通道
发送，不传策略函数，不授予模型或账号权限。执行端持久化并等待原生设置应用后，回传对应
修订与允许状态。旧修订不能解除较新的禁止，同修订冲突只能收紧。

`open` 的 `groupAssigned` / `relay` 是路由防环提示，不是策略豁免。执行端本机实际以 guest
身份运行时，仍绑定本机原生订阅组的限制，与已接收的上游约束取交集；调用方不能自报
已分配来跳过本机限制。绑定先于来源提交时，未能解析的来源按禁止处理，持久化及原生应用
全部成功才确认；旧绑定继续兼容读取，普通 close/idle 不删除禁令记录。

缺省仍允许 Fast，因此旧控制端和未配置禁止的组保持原有行为。新组设置禁止时，未声明能力
或没有正确确认的旧执行端保持待确认，不能用于新的受限分配；自动换电脑沿用已有策略。
旧接收方即使保留 Fast 选项，也由新版实际执行端钳制。首次使用要求组所在电脑与执行电脑
均升级；未更新的执行端不能宣称已受控。

供应商目录新增可选 `subscriptionFastPolicy` 展示字段；受限目录投影为不支持 Fast / Ultrafast。
分享的刷新通知复用已有 `maker:provider:changed` 空载荷，只发给当前被授权的接收方，并核对
对应 host。自定义 API 不进入这套策略与新增刷新规则。详细范围及验证见
[订阅 Fast 控制交接说明](../subscription-fast-policy.md)。

## 群聊远程任务限额原因（#6835）

既有 `cindy-runtime-error:<code>` detail 与可选 `runtimeFailureCode` 新增安全类别
`REMOTE_DEVICE_LIMIT` / `REMOTE_TOTAL_LIMIT`，不传远程错误正文、设备身份或凭证。
旧客户端不认识新类别时沿用通用失败提示；新客户端消费旧服务器的通用 `RUNTIME_ERROR`
或缺失类别时，仅在本执行端保留同一执行 ID / epoch 的已知具体原因，服务器的其他明确类别优先。
普通回复、话题和分工共用分类与终态提交，不改变重试、租约或权限边界。

跨设备与重启后的具体原因需要 Chat Server 的 detail 解析和 `failure_code` 白名单支持这两个类别；
客户端改动不证明服务端已支持或已部署。未支持时其他查看端保持通用失败，执行端缓存不持久化。
本次不改服务端、数据库、device-link channel 或 Mobile 原生配置。

### 聊天通知内容与私聊落点（#7046）

聊天推送增量携带 `conversationKind`，新原生端以此区分私聊/群通讯样式，旧端继续使用原通知。手机 `Accept-Language` 只控制服务端固定提示词，真实原文不翻译；云注册到两个服务都保留显式 preview 选择，旧请求缺省 true。完整任务通知预览关闭需要服务端先支持新列/字段；不添加隐私确认或更改默认预览。

Desktop 在通知点击事件携带可选 `conversationKind: direct`，落入现有时间线的明确私聊模式。`getBotGroup` options、`sendBotGroupMessage` input 与 `manage` 的 read action 的同名可选字段仅用于此模式，主进程读取实际 kind 后确认；普通群入口仍拒绝 direct/channel。私聊不提供群设置、邀请、分工或群话题操作，已读通过既有 read action、发送保留原幂等/引用/附件路径。手机由实际 snapshot.kind 决定私聊标题和单人头像；内部 groups 路径保持旧通知链接兼容，不改变服务器成员权限。此入口补齐通知的阅读/回应，不改伙伴主任务/接管编排。

## 伙伴名册的跟进任务链接

`teammates` 伙伴行的 `links` 在原 `conversation` 链接之后追加 rel `following`，`target` 为
`{ kind: 'session', sessionId }`，表示该伙伴在跟进的本机任务（伙伴发起的委派子任务与明确接手，
扣除解除记录；来源与桌面侧栏「在跟进」相同）。只列在用伙伴、未归档、本机、普通来源且非 Orca
worker 的任务，按最近更新取前 200 条；伙伴行 `revision` 追加这组 ID 的摘要，变化时照常失效重读。
责任记录、委派创建／状态变化都会广播伙伴远程资源变化。

旧控制端按未知 rel 忽略，`conversation` 仍是第一条链接，打开聊天不变；新控制端连接旧 Host
时没有该链接，任务行不显示标记。Mobile 读取的链接上限由 64 放宽到 256 以容纳这组链接。
不增加 IPC channel、请求参数、数据库字段、push 类型或 Mobile 原生配置。

## 桌面伙伴来源筛选

桌面在读取 `teammates` 名册后，用每个伙伴的 `conversation` 任务 ID 调用既有的
`maker:bot-delegations:list`。只将 `requestingBotId` 匹配、`childSessionId` 非空的记录
作为创建来源；不把接手关系当创建，也不要求远端支持新增的 `created` link。
包含活跃和归档任务，实际展示仍由任务列表状态筛选决定；旧版远端也能直接使用。
已有 `following` 链接继续提供跟进标记，任务创建关系同时用于远程创建者头像。

按电脑 ID + 伙伴 ID 区分筛选，按电脑 ID + 任务 ID 匹配任务；远程头像使用原电脑媒体地址。
同一 Host 串行读取伙伴任务记录，关系缓存保留 ID、不保存任务卡正文。委派变更推送与
名册变更沿原刷新合并窗口更新；读取失败保留已有归属，成功空结果清空。
切账号、撤权、断线后的旧响应仍受原请求代次隔离。只读关系请求失败不重启 relay、
不影响其它设备、不重放任何任务操作。不增加 IPC、权限、服务端字段或数据库迁移。

Task creator filtering resolves built-in Cindy identity through the existing local `listCindyCopies` read,
which now returns even a single remaining cloud Cindy. The merge settings entry still requires two copies.
This allows old remote hosts without template metadata to participate in the unified filter without
changing their wire protocol or triggering any companion merge. Identity is cached with the owner-scoped roster.

### 伙伴独立任务的列表归属（2026-10-27）

`sessions:list/get/get-many` 可选投影 `companion: { id, role, channel? }`，从现有
`bot_session_links` 读取，不新增数据库列或改运行身份。普通列表仅纳入 `routine/channel`，
仍过滤隐藏任务与删除中的伙伴；`canonical/thread/group` 保留伙伴入口。
旧远端的普通列表未包含这些任务时，桌面经原有同账号 `history:query/list_sessions`
分页读取 `source=bot` 的归属，再用原有批量／单条读取补齐 Session。无权限或接口失败不能
清空普通任务；撤权沿原处理路径上报。设备／状态代次失效时丢弃迟到回复，保留其它设备的
镜像，不重启链路或重新授权。离线镜像仅保存归属的 id/role/channel，恢复时仍可筛选和显示头像。

Mobile follows the same read-only compatibility path for teammate task attribution and independent
routine/channel Sessions. `taskTeammate` is a client-local display projection (ID/name/avatar), not a
new wire field or permission. Its slim home cache keeps it with `companion`; optional read failure
retains that host's previous attribution and successful absence clears it. Account/query invalidation
and list mutation epochs fence all late results. Home and device list refreshes share this reader.
Cloud Cindy identities come from the existing owner-scoped `/preferences` profile snapshots, using
the same exact preset identity helper as Desktop. Only their IDs enter the cloud-home display cache;
profile bodies are not persisted. This adds no endpoint, database migration or native configuration.

## macOS 原生触控板输入

本机聚焦的浏览器／插件页可在顶层 HTML 声明
`<meta name="cindy-native-trackpad" content="touch">`，并用 `data-cindy-trackpad`
标记接收触摸的平面元素。宿主将 AppKit 的两指位置映射为该元素的浏览器触摸事件；
鼠标位置是落指中心，两轴按触控板物理比例等比映射，按原始抬指／取消结束。
映射使用画面长边作为统一距离基准，避免竖屏窄边压缩平移；落指间距与后续位移
使用同一比例，未裁切时保持缩放比例、旋转角度和静止手指的位置，不单独加速双指中心。
触点在元素边缘停止，越界位移不累计；反向移动立即响应，不要求先退回越界距离。
不新增 preload、renderer IPC 或远程请求；插件沙箱仍为零桥，归属与聚焦检查沿用宿主。
后台窗口、第三指、页面导航、失焦会取消触摸；原生模块不可用或已有调试会话时保留原输入。
旧宿主忽略 meta／属性，继续 wheel 兼容路径；手机、Windows、Linux 不接收本机 AppKit 数据。
AppKit 鼠标位置固定使用窗口内容坐标；嵌入侧栏须先扣除宿主内对应 webview 的位置，
并分别处理宿主与 guest 缩放，再在 guest 内命中检测。独立窗口没有这个偏移，
不能单独替代开发版实际侧栏的输入验收。

`data-cindy-trackpad="contacts"` 可选整帧输入：元素收到 `cindy-trackpad` DOM
事件，`detail={phase,touches:[{id,x,y}]}`；坐标相对该元素所属 frame 的 viewport，
phase 为 begin/change/end/cancel，touches 是仍按下的全部触点。整帧原子投递，避免
Chromium 把双指拆成单指前奏及等待触摸 ACK。空属性仍投递标准 Touch/Pointer 事件；
旧宿主按旧路径工作，插件仍保留标准触摸处理。只有宿主向页面投递数据，没有反向特权桥。

contacts 在每次 begin 投递前核对原元素仍连接、仍声明 contacts，且仍是落指锚点
命中的元素（在元素所属 Document／ShadowRoot 内检测）。目标被替换、移除或遮挡时，
向旧元素发送 cancel（断开的旧元素也可接收清理），停止旧采集并重新命中；下一原生采样
可在新目标开始，不依赖再次移动鼠标。旧目标迟到的失败回复不能撤销后来的目标。
取消、释放 CDP object 完成后才 detach，沿用现有采集代次，无新队列或持久状态。

标准 Touch 路径完整结束与取消使用空 `touchPoints`。当前打包 Chromium 默认 WebTouch
路径的部分抬指使用 released IDs；仅发送剩余触点的 touchMove 不会释放缺失手指。
这与 contacts DOM 事件始终表示「全部仍按下触点」的约定不同；以真实 Electron 的
部分抬指、完整结束和取消回归核对，不能只靠 CDP mock 推断浏览器行为。

## 主人请求跨任务连续性（2026-10-28）

沿用可选 `requestSource.ownerVerified` 和持久 `autoReviewUserText` 回执，不新增字段或 migration。
伙伴私信开始携带当前已接受的主人请求；原话与正文包装仍按旧接收端的逐字验证。无原话时不传空回执。
当前接受的核实回执可继续转交，`agent-request` 与 `delegated-continuation` 的审核投影保持同一原话。
旧接收端仍可能丢弃核实状态或把接收回复标成私密；完整修复需要执行交接的宿主升级。
账号、群与 IM 发言人校验、权限档、Plan、输入代次和撤销校验保持不变。
不改变连接恢复或重放策略；单次派发失败只影响该请求，不重启连接或扩大设备访问。

## Kimi Code 配额查询

同账号 invoke 白名单新增 `maker:usage:kimi-coding`，请求只接受 `providerId`、可选 `agent`
及 `forceRefresh`，不接受端点或凭证。执行端通过现有凭证链查询固定官方 Coding 接口，
返回规范化的窗口比例、重置时间及查询状态；控制端再次校验字段。远程供应商目录新增可选
`kimiCodingUsageAgents` 展示能力数组，由宿主根据真实路由计算，执行地址仍被剥离；该字段
不参与宿主授权，实际查询仍按真实目录严格检查官方端点。不开放供应商分享、
共享任务或未连接设备权限，不改变推理请求及限额自动继续规则。
新控制端连接旧执行端时，该 channel 不受支持，界面显示查询不可用且不回退到本机账号。
旧控制端不发送此请求，新执行端的既有通道保持不变；无需 server、协议版本或数据库迁移。
查询失败只影响该连接的配额显示，不重启共享链路、不重放任务写操作；回滚即恢复不显示
Kimi 配额，用户已有登录及配置保留。

自建中转沿用 `packages/device-link-relay/src/hub.ts` 的通用 envelope 转发：
`invoke` 的 channel、args 与响应 payload 不由中转解析，因此此只读通道无需修改中转、
升级 `RELAY_VERSION` 或新增能力协商；旧中转也可转发，是否支持查询仍由执行端决定。
验证包括共享客户端与自建中转单测、`pnpm --filter @cindy/device-link-relay run interop`
的真实客户端加入／签名通信／重连，以及 Desktop 的 Kimi dispatch 回归；这些验证不替代
真实 Kimi 账号与两台实机的端到端验收。

## Telegram 群历史按消息号取图（2026-10-29）

`GroupMessagePayload.imageRefs` 为可选字段，最多 4 个 `{fileId, name, mimeType,
downloadToken?}`；无此字段的旧包继续接受，旧客户端忽略新增字段。客户端与服务端
`@cindy/slack-hook-protocol` 同步边界校验（ID 1024、名称 256、证明 8192 字符；图片类型白名单）。
官方 relay 对每个接收设备绑定签发 HMAC 图片证明，绑定群、话题、消息与文件身份。
新增只读 `POST /telegram/group-image` 使用正常桌面登录 JWT 验签，不接受调用者提供设备 ID；
下载前后核对当前绑定。证明不能单独访问接口，不新增 env、WS envelope 或 capability。

先部署 telegram-hook-server，再更新客户端（用户确认更新，不能强更）。旧端保持文字
历史，旧服务不发送证明时新端明确不可取回。客户端新增 nullable `image_refs` 数据库列，
通过追加 Drizzle migration 升级；服务端不持久化群图片或消息正文，无服务端数据库迁移。
验收入口为 groupHistoryMcpServer / groupHistorySearch / groupHistoryImages、个人 TelegramIM、
两端 protocol-group-relay 和服务端 telegramController / groupImageHttp 测试；正式 Telegram
跨进程收发需部署后另验。

同一取图工具覆盖飞书/Lark、企业微信、钉钉、Discord 私聊与个人微信。前三方无历史
接口的路径仅保存已收到的托管媒体引用，不接受模型提供的路径/URL，不补抓全量群图。
飞书/Lark 通过该 bot 的消息接口校验精确 chat/topic 后下载；企业微信/钉钉仍只看到
渠道实际投递的消息，Discord/微信当前只支持私聊。微信排队 payload 追加 optional
`platformMessageId`，旧队列无此字段时正常执行，但不把内部 task ID 冒充平台消息号。

Slack 复用既有 user-token 工具网关，在 `listTools` 增加 `cindy_get_message_images`；
参数为 channel_id/message_ts/可选 thread_ts，返回标准 MCP image blocks。客户端网关
透传图片，不再将 base64 当成文字 JSON 泄洪；旧端仍按原方式交付 JSON，需升级客户端
才能直接看图。Slack 权限继续由原绑定用户的 Slack 授权决定，无新增 scope/env。

X 属于公开帖子接入，本轮不新增付费历史抓取；其已有推文上下文自动带图路径不变。

## 伙伴群聊过程关联（2026-10-29）

完成答复在既有 `ChatContentBlock` 列表末尾附可选 `cindy.work-record` v1 card，包含可选执行电脑 `deviceId`（与伙伴当前主力电脑无关；缺失时兼容旧记录），
必需字段仅 `groupId / executionId / sessionId / clientId`；`fallback` 为空，正文与附件次序不变。
旧客户端忽略未知 card 或读取空 fallback，仍能阅读原答复；新版遇到旧消息缺少关联时不补猜任务。
新版 Desktop / Mobile 只在伙伴答复上投影 `process`，群和话题共用组件，并核对群 ID 与伙伴归属。
关联不授予权限：阶段文字通过既有同账号设备授权的 `local-db:messages:around-client-id` 精确读取，
遇到下一个用户输入或本轮终态停止，原始思考和工具结果不进入群消息。
不增加 device-link RPC、relay 帧、权限或数据库 migration；自建中转仍透传既有调用，无服务端代码变更。
没有真实 Chat Server 或自建中转互通验收时，客户端测试不可表述为服务端已验收。

过程关联可附带非负 `durationMs`，在执行终态固定；上传和回执重试不增加该值。旧记录缺少此值时，展开后由原始时间戳计算；未知时间不编造。

## 插件伙伴委派协议与回执（未发布）

agent.delegation 为可选独立能力，依赖 tasks + targets，只有 Host 确认的
delegationCapabilityApproved 才授予；历史未知字段、旧 tasks/targets 批准不推断新授权。
缺省不改变旧权限项、批准、配置或回执摘要；已安装的历史字段保留，不因新校验停用。
新包严格校验声明，旧 receipt 缺少新可选字段照常读取。无需 schema migration。

targets.capabilities 新增只读协议发现；delegation.version=1 与 execution 就绪状态分开。
执行端接入现有 Auto 审核后才报告 execution=true；未就绪时显式 delegation 请求在预留/投递前返回
UNSUPPORTED_CAPABILITY；不得降级为普通消息或另建任务。旧 Host 无入口时不发送。
委派只允许 bot + queue，scope 最多 8000 字符并参与请求摘要，持久回执保存版本、
执行范围及原目标/批准事实。取消、撤权、换批准版本和恢复排队沿原接口复核。
执行保持真实来源并使用既有 Auto 审核；不提升伙伴权限，不包含业务插件。
作者契约见 cindy-plugin-creator/references/plugin-agent-tasks.md §4.11.7。

Node 私有上传只接受 POST + uploadDir，短期 Bearer 不进入页面管道。旧 Host 无入口则不上传；不保存新凭据，不新增设置页授权协议。
targets.get 按本插件 requestKey 查询原收据；settled 自然终态由原 inputClientId 的运行事件持久记录，取消另须确认原队列/执行结束。不开放伙伴历史。

## 伙伴列表的可选活动摘要

RemoteResourceDisplay 与 BotGroupSummary 可选携带 `teammateActivity: { phase }`。宿主从现有运行、待确认、完成、错误状态投影，Desktop/iOS/Android 共用状态优先级。生成文案、确认权限、已读回执均保持原有路径。旧控制端忽略字段；新控制端连接旧宿主时回退已有 generation、确认快照及普通未读，不把缺失状态推断成完成。

字段位于现有 Remote Resource 的业务 payload 内，不改握手、签名、顶层帧、relay 路由或重连逻辑；官方与自建中转都沿用通用加密转发，无需中转升级。群直连复用现有 executions/plans 只读接口，不修改服务端；旧服务器缺少接口时保留普通列表。

## 推荐引擎下发（`registryRecommendedAgents`，2026-10-30）

- Registry V6 新增可选 `recommendedAgents`：`{ providerId, modelIdPrefix?, agent }` 规则表，正本在 Server
  `source/registry/recommended-agents.json`。已发布的 V6 解析器拒绝未知字段，所以它走独立能力位：
  新客户端请求带 `registryRecommendedAgents=1`；Server 对未带该参数的请求（含旧 V6 客户端）去掉字段，
  ETag 按实际响应隔离。V1–V5 投影一律不含此字段。
- 客户端只把它当建议：解析后投影成 `CatalogModel.recommendedAgent`，用于默认选中引擎；不改变模型成员、
  可见性与用户已换过的引擎。推荐的引擎在该来源只能走本地兼容转换时不采用，回退到协议推断。
- 离线回退：升级后首次请求失败时，仍可读取升级前按旧 URL（不带新能力位，或 V5）缓存的 last-known-good
  快照；此时没有推荐表，按协议推断兜底，不报错。
- 字段位于目录 HTTP 响应内，不涉及 device-link、relay 或远控 wire；手机端经现有活动目录投影拿到结果。

### 群广播对象（2026-10-30）

Chat Server `/me` 新增可选能力 `groupMentionAudiences: 1`，群快照新增 `allow_mention_all_bots`（默认 false）。
仅群主可 PATCH `allowMentionAllBots`；旧客户端忽略新字段，管理员原有资料编辑权限不变。
消息可选 `mentionAudience: humans|bots|everyone` 表示真人、伙伴或两者广播，与明确的 `mentions` 合并；
伙伴广播须开关开启。消息读回保留同名字段，服务端持久化后延迟派发仍保留目标。
客户端无能力时不发送新字段，真人广播只展开真人；空目标以本人 actor 保持定向，不触发旧服务端的无点名兜底。
`BotGroupMention.all` 只指真人，新增可选 `allBots` 独立表示伙伴，手机远程资源保留二者；
只有已声明支持的新电脑/服务端才提供伙伴入口。原样重试已提交待发消息，不重算目标或更换操作标识。
先部署数据库增量迁移和服务端，再发布客户端。旧客户端此前已展开的 actor 列表无法可靠区分广播与逐个点名，
因此修复旧客户端行为须升级客户端。批量开关不授权工具，不改变个人代答配置。

## Desktop 话题回复附件

本机 `ChatServerApi.reply` 增量接受可选 `attachments`，沿用群聊的附件输入、校验、上传与引用结算；
旧调用不带此字段仍按文字回复处理。此 IPC 未加入 device-link 白名单，手机和远程调用合同不变。
Chat Server 请求复用既有消息 `content` 的 media 块及 `threadRootId`，不新增服务端字段或消息类型。
无数据库迁移、权限扩大或服务端改动；回退客户端只收起电脑话题的附件输入，已有媒体消息仍可读取。
回归入口：`ChatServerControls.test.tsx`、`chatServer.test.ts`。
