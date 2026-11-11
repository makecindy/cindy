# 远程 Agent：Agent 在另一台电脑运行

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Cindy 托管 Skill（2026-11-03）：内置 Skill 与插件带的 Skill 以任务所在电脑为准，用远程供应商与本机体验一致。
`open.personal` 追加可选数组 `managedSkills: [{ command, dir }]`：任务所在电脑按本机任务同一来源列出托管 Skill，
用本机停用偏好与伙伴授权过滤（`resolveAllowedManagedSkills`），本机停用的个人 Skill 也不再同步。文件随
`personal.files` 放在 Agent 找项目 Skill 的位置（Claude Code 为 `.claude/skills/<插件>-<Skill>`，Codex / Pi 为
`.agents/skills/...`）。目录名为 `<插件>-<Skill>`；两段里有 `-` 时追加整条命令的 8 位哈希，避免 `a-b:c` 与 `a:b-c`
拍平成同一个目录；该目录已被项目或个人的同名 Skill（本机里是不同命令）占用时同样换成带哈希的目录共存，不丢托管的。
`managedSkills` 条目最多 512 个（超过时接收方拒绝整个打开），收集时截断。文件清单与指纹共用 `managedSkillDigest.ts` 的 `listManagedSkillFiles`：清单超出上限、有单个超过
512 KB 的文件、受邀者任务里的凭证类文件、读不到的文件，该 Skill 整个不带，不留只有 `SKILL.md` 的半个。
对旧运行端与个人配置共用 512 个文件、4 MB 的额度且个人配置优先；放不下的 Skill 整个不带。
沿用 `maker:remote-agent:v1`，只加可选的 `caps.managedSkills`，不加错误码或 relay 接口。

- 新运行端看到字段（含空数组）即以它为准，**不加载自己的托管 Skill**，受邀者也一样：Claude Code 把这些目录挪进
  影子目录内的 `.cindy/managed-skills/<插件>/skills/<Skill>` 并以本地插件挂载，命名保持 `cindy:pr`；Codex 对共用
  CODEX_HOME 里本机那份逐线程停用，Pi 不挂本机的。控制端为原位置与插件位置都登记路径映射，Skill 里的脚本路径
  经 `cindy_exec` 回到任务所在电脑的真实文件；连回时托管 Skill 的映射以这次同步的为准（插件更新后目录也变了），
  其余映射仍保持原目标（上次有、这次已停用或卸载的托管 Skill 的映射也撤掉）。受邀者带来的 `managedFiles` 与 `files` 走同一道 Markdown 检查（带 hooks 的丢弃、命令预执行
  语法断开）；复用提供者自己那份时同样过这道检查和落地改写。不变量：同一份内容，复用与传输落到受邀者任务里的文件
  逐字节相同（`guestHost.test.ts` 直接比较两条路径）。
- 旧运行端解码时丢弃该字段，把文件当项目 Skill 加载：能用，但 Claude Code 里叫 `pr` 而不是 `cindy:pr`；同账号
  旧运行端自己也有同名托管 Skill 时会出现两份。新运行端遇到旧控制端（字段缺省）沿用原规则：同账号用自己的，
  受邀者不加载。
- 不重复传、单独额度：新运行端在 `caps` 追加可选 `managedSkills: { digests }`（自己启用中的托管 Skill：命令名 →
  内容指纹，规则见 `managedSkillDigest.ts`；受邀者只看到 `cindy:` 内置的，不透露装了哪些插件）。控制端看到声明后，
  指纹相同的条目只带 `{ digest, reuse: true }` 不带文件，运行端复制自己那份（复制前再核对指纹，不一致就不带这个 Skill）；
  受邀者只能复用 `cindy:` 内置的，点名提供者装的插件 Skill 一律不复制（运行端直接收和组所在电脑中转补文件都一样）；
  其余文件放进 `personal.managedFiles`，单独 2048 个文件、16 MB 额度，不占个人配置的 512。旧运行端不声明，控制端
  仍用上面的共用额度方式。`caps` 本来每次打开前都问，不多一次往返；两台版本与插件相同时打开、连回都不再传托管 Skill。
- 供应商组中转：受邀者看到的是组所在电脑的 `caps`。组所在电脑转发前按组内电脑的 `caps` 重排：那台也有同指纹的继续
  只报名字，没有的用组所在电脑自己那份补成文件（指纹与受邀者一致才补，且按正常收集的大小限制：单个文件 512 KB、
  新版 16 MB、旧版与个人配置共用 4 MB，放不下整个不带）；组内电脑是旧版时文件放回 `files`，放不下 512 的
  Skill 整个不带。
- 控制端列不出托管 Skill 时不带该字段，对方沿用原规则。实现见 `controller/projectFiles.ts`、`host/runHost.ts`，
  回归见 `mirror.test.ts`、`roundtrip.test.ts`、`guestHost.test.ts`、`groupRelay.test.ts` 与三 harness 的
  `device-hosted-guest` 测试。

插件花名册（2026-11-01）：`open` 的 `options` 追加可选字符串 `ghostRosterSnapshot`，由任务所在电脑按真实
工作目录生成（与本机任务同一 formatter 与过滤），空串表示“那台没有可召回的插件”，同样要带。沿用
`maker:remote-agent:v1`，不加能力位、错误码或 relay 接口；供应商组中转随 `options` 原样透传。旧运行端
解码时丢弃该字段，行为不变；新运行端遇到旧控制端（字段缺省）时，受邀者照旧不注入花名册，同账号照旧用
运行端自己的花名册，均不劣于升级前。运行端只在隧道确实提供 `cindy` MCP 时注入，绝不读自己的已装插件
代替。规则正文见 [插件渐进式发现 §3.4](../../ghost-progressive-discovery.md)，回归见 `roundtrip.test.ts` 与
三 harness 的 `device-hosted-guest` 测试。

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

M 的委托核权只调整本地发送调度，继续使用原 `POST /provider-shares/delegations/check` 与鉴权。
首次／续权安装委托和后台复核共用账号作用域、端点隔离的串行查询门；只合并同一分享、成员、
G、M 与授权代次的在途查询，完成后不缓存授权结果。物理请求之间随机间隔 750–1250ms；
后台按 peer 合并任务，首次复核分散在 30–60 秒，后续约每 60 秒到期、串行发送，积压可能推迟。
队列最多 128 项，从入队起最多等待／核验 15 秒；同一取消信号覆盖 HTTP、登录刷新等待及重试。
到期取消请求并释放查询占用，不能在刷新完成后补发失效查询；共享登录刷新本身不被取消。

HTTP 429 的 `Retry-After`（秒数或 HTTP-date）仅作为 Main 内存中的重试期限保留；
旧服务端没有该头时按连续 429 退避 60/120/240/300 秒，成功重置。当前排队核权立即失败，
冷却期不继续发送其他 peer 的查询，不自动重放首次授权。账号／端点变化或 host 停止时
取消旧队列与请求，丢弃迟到结果；同账号、同端点重建 host 仍保留查询尾部、间隔及限流退避，
不能借重建穿透预算。不重启 relay、不重放任务、不改变管理 API 或普通远控的发送。
核权失败不作为新的授权，也不延长原许可；明确 `active=false` 仍按对应任务 nonce 撤销。
这不提供多执行机的全局协调，也不拆分旧服务端的查询／管理限流桶，无法保证消除所有 429。
实现与回归见 `providerShareDelegationChecks.ts`、`providerShareDelegationChecks.test.ts` 和
`serverApiClient.test.ts`；服务端、自建 relay 与旧客户端无需同步升级。

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
  Codex 版本可能变化，升级时一并核对(见 [`remote-and-mobile-adaptation.md`](../remote-and-mobile-adaptation.md)
  「托管 Codex 启动的跨机往返与执行环境恢复」)。
  非完全访问档下 `process/start` 与 `fs/*` 带 `sandbox`(固定版本 `codex-rs/file-system/src/lib.rs` 的
  `WireFileSystemSandboxContext`)，其中目录与权限条目都是 B 上看到的 file URI，中继换成 A 的路径：虚拟工作区内的
  映射为本机路径(绝对 glob 里本机目录名按字面转义)；不在其中的是 B 自己的目录(如它的 Codex 记忆目录)，读写
  授权丢弃，只收不放；禁止规则不因转换失效：路径条目在 A 上也是合法绝对路径时原样保留，没映射上的禁止 glob
  一律原样保留；用户目录对不上时换成 A 本机的(Codex 缺了它会把 `~/…` 规则当解析失败、一律拒绝读取)；
  `file:///C:/…` 是否为盘符按 B 的路径约定(虚拟工作区路径)判断；网络配置按原值透传。Windows 沙箱档位通常
  保持原值；唯一例外是在已有虚拟映射、Agent 路径为 POSIX、本机执行端为 Windows、`permissions.type=managed`
  且 `windowsSandboxLevel=disabled` 时，选择本机 `restricted-token`，见[远程适配规则](../remote-and-mobile-adaptation.md)。
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
  控制端经任务所在的 A 读取第三台电脑的 `maker:provider:list`，A 自己的目录照远程控制列全部供应商，换位置同样
  带 `agentDeviceId`(null = A)，换后档位记在控制端为那台电脑单独记的一份(改回 A 时写 A 的镜像)。
  同账号收到的可用分享全部列为候选(2026-10-14)，不要求任务已在分享上运行；已暂停或已移除的分享仅保留当前 /
  待切换位置，沿用既有不可用提示。分享按账号授予，候选与读取均以任务所在电脑的有效授权为准；
  各电脑自行向官方分享服务查询本账号的跨区分享，不新增成员授权。查询失败时仅保留当前位置，不改读控制端的授权。
  #8010 新增同账号只读 `maker:model-catalog:read`：`op: locations` 列任务所在电脑可用的来源；
  `op: read` 只代读固定的 `maker:provider:list`、`maker:get-capabilities`、`maker:list-available-agents`、
  `maker:agent:status`。来源必须在主机当前名单中，回包前复核名单与账号代次；不接受任意 IPC 或写操作。
  控制端自身和仅被控电脑加载的分享也参与候选。创建、换位置与发送沿用真实 `agentDeviceId`；
  Renderer 的 `(任务电脑, 来源电脑)` 目录缓存键仅用于读取，不作为运行设备传送或落盘。
  旧主机明确不支持新通道时保留原直接读取与两端分享交集行为；连接失败不触发此降级。
  `locations` 返回 `degraded` 时，沿用同一账号、任务电脑上最后完整结果中的电脑名称；
  分享仍以本次返回为准，完整结果确认移除后不再保留。此显示快照不授予读取或运行权限，
  宿主代读仍前后核对当前名单。控制端自身的 Agent 变化同时使经任务电脑读取的运行时列表失效，
  旧请求不得回填；不刷新其它任务电脑或本机直读缓存。
  分享目录/名单变化以空载荷 `maker:model-catalog:changed` 推送到 `sessions` topic，控制端重新读取。
  `locations` 对有效分享可附带最小 `favoriteSource`（分享、成员、供应商 ID 与归属区域），只用于解析
  任务电脑保存的收藏，收藏仍通过原 `model-favorites` 通道读写任务电脑。不含凭证、不授予运行权限；
  旧控制端忽略此字段，新控制端遇到未提供此字段的主机不以自己电脑的成员身份替代。
  来源电脑向已接受且具备 `background-link-v1` 的同账号后台连接发送空的 provider/agents 变化通知；
  任务电脑将收到的原始变化转为上述 catalog 失效通知，不转发目录内容、不再次转发 catalog 通知。
  只使用已有连接，不增加控制订阅，来源电脑不因此进入受控状态；撤销、离线和分享/访客 peer 不走此路径。
  新旧端复用现有 push 帧和 channel，旧来源端保持原有刷新时机；自建中转不需同步修改服务端协议。
  新通道不加入跨账号分享/共享任务访客白名单；普通 invoke/push 复用既有中转帧，自建中转无需新增路由。
  故障半径：仅驱逐对应任务电脑的目录缓存；只重读目录，不重建链路或重放创建/发送；其他任务电脑的缓存不失效。
  实现见 `apps/desktop/src/renderer/hooks/useControlledModelLocations.ts`，回归见
  `controlledTaskRemoteAgentPanel.test.tsx` 与 `remoteAgentRelocationWiring.test.ts`。
  桌面远程控制下新建任务(建到 A 上，2026-10-09)同样开放：判据与手机新建相同(A 的 `maker:provider:list` 带
  `remoteInvocationEnabled` 布尔标记，共享任务访客与 SSH 不开放)，模型面板先列 A 的全部供应商、再列其他同账号电脑
  已开放的供应商；选中后草稿的模型目录改按那台，`maker:create-session` 带 `agentDeviceId`，权限档沿用 A 的草稿值，
  不把那台的模型写进 A 的新建草稿记忆；默认来源解析、提交的来源与协同 Worker 收窄都只用那台已开放的供应商。
  落点范围与已建任务相同（新版主机包含控制端自己及被控端可用分享）；协同草稿与它不互斥(与桌面本机新建一致)。回归见
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
- **被控电脑上的协同任务换 Agent 位置**(2026-11-04)：A 从 v0.1.112 起接受给它上面的协同 Lead / 本机 Worker
  发带 `agentDeviceId` 的 `maker:switch-session-agent`(运行设备 Worker 仍回 `UNSUPPORTED_CAPABILITY`)；v0.1.104–v0.1.110
  的 A 在登记意图前就回 `UNSUPPORTED_CAPABILITY`。A 在 `maker:get-capabilities` 声明 `supportsOrcaAgentRelocation: true`
  后，桌面与 Mobile 控制端才对这类任务列其他电脑与分享、走与普通任务相同的换电脑事务；缺省 false 时维持原样，不出现能点却必失败的
  选项。协议位是整台 A 的，控制端读到任一已注册 Agent 的快照带这一位即可。通道与参数不变，只新增可选能力位；中转只按通道名
  放行(`packages/device-link/src/allowlist.ts`)、不解析能力字段，自建中转无需同步修改。Mobile 经 `normalizeMobileAgentCapabilities` 读
  这一位(makecindy/cindy#8841)。回归见 `sessionAgentSwitchRemoteRouting.test.ts`、`remoteAgentRelocationWiring.test.ts`、
  `sessionRuntimeControlWiring.test.ts`，Mobile `orcaModelSelection.test.ts`、`sessionAgentSwitchWiring.test.ts`。
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
  见[「供应商组：转分享需原主人逐人同意」](provider-group-reshare-owner-consent.md))。新错误码 `REMOTE_AGENT_SHARE_PAUSED` / `REMOTE_AGENT_SHARE_REMOVED` / `REMOTE_AGENT_SHARE_UNAVAILABLE`
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
