# 远程连接与手机版适配

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改涉及 workdir 文件、agent 进程或会话数据的功能，新增／修改 IPC
> channel 或推送事件，修改 device-link 的重试／超时／断链恢复逻辑，或设计功能入口之前

Cindy 的产品形态不止本地桌面单机。同一个功能可能运行在三种场景里，而这三种缺口都
**不报错、typecheck／单测拦不住**，只在对应场景的用户实际使用时才暴露成“功能在远程／
手机上不工作”。多端的产品语义见
[`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)
的「多端连接与任务连续性」；插件在这三种场景的约束见
[`plugin-security-and-authoring.md`](plugin-security-and-authoring.md)。

> **增量适用原则**：约束新增和正在修改的功能；默认期望在同一 PR 内一并适配，适配量大
> 时才拆 issue 跟踪。

## 三种形态

- **SSH 远程工作区**：workdir、agent 进程、文件都在远程主机上，经
  `packages/maker-remote-ssh`、`packages/remote-file-service` 与 cc-manager 驱动。
- **设备互联远程控制**：手机或另一台桌面通过 `packages/device-link` 隧道驱动被控桌面端，
  IPC channel 走白名单准入。
- **手机版**：`apps/mobile` 独立客户端，作为纯控制端复用 device-link。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| SSH 远程工作区 | `packages/maker-remote-ssh`、`packages/remote-file-service`、cc-manager |
| 设备互联／手机准入白名单 | `packages/device-link/src/allowlist.ts` |
| 手机版客户端 | `apps/mobile` |

## 设计阶段先回答三个问题

1. 功能涉及 workdir 文件／agent 进程／会话数据时，在 SSH 远程工作区下能否正常工作？路径
   与执行位置在远端，直接 `fs` 读 workdir 会读到本机——必须走 remote-file-service／
   cc-manager／exec 等现有远程通道。
2. 新增／修改的 IPC channel 与推送事件，手机／远程控制场景需不需要用？需要就按
   `packages/device-link/src/allowlist.ts` 顶部注释的准入判据登记 invoke／push 白名单并
   同步 topic 路由；不登记，手机／远程控制端就永远调不通。
3. 手机版需不需要对应的入口／UI／交互？

## 恢复动作先回答故障半径（device-link 共享链路）

设备互联是 1:N 拓扑：被控端与 relay 之间只有一条连接，同账号的全部控制端共用它。
故障域从小到大分四层——单个请求、单个 peer 的 link、整条 relay 连接、**relay 聚合
背压**（第四层：故障原因不是任何单个请求或 peer，而是本机对 relay 的**聚合出站速率**；
relay 以 close 1013 `inbound backpressure` 主动断连，此时任何「立即重连 + 全量重放」
的恢复动作都会立刻复现故障，形成「重连 → 洪峰 → 再被踢」的自放大循环，2026-08-08
线上：两次 1013 间隔 15s，第二条连接只活了 7s，期间控制端全部超时熔断）。修改
`packages/device-link` 或 Desktop dispatch 层的重试／超时／teardown／重连逻辑前，
先回答三个问题：

1. **触发条件是哪一层的故障？** 单个请求失败、单个 peer 停止 ACK、整条连接断开，
   还是 relay 对聚合速率的背压？对第四层，恢复动作除了同半径（连接级冷却/降速）
   外还要问一句：**重连成功后的重放会不会立刻重造触发条件？**
2. **恢复动作作用在哪一层？** 默认选择与故障同半径的最小动作。动作半径大于故障半径
   （如「单 peer 可靠重试耗尽 → 强拆整条 relay 连接」）就是把一台设备的故障放大成
   所有设备同时掉线；确需扩大半径的，必须在 PR 描述里写明理由，且理由要经得起
   「一台手机退后台休眠时会发生什么」的追问。
3. **多 peer 拓扑下测过吗？** 恢复路径改动必须带「≥2 个控制端共享同一被控端，其中
   一个 peer 静默／停止 ACK，断言其它 peer 的 link 与在途请求零感知」的用例。单
   peer 对连的用例验证不了故障放大——单测全绿只说明实现忠实于设计，设计本身选错
   半径时测试不会报警。

判例：#1187（2026-07-31）引入「可靠重试耗尽 → 强拆整条 relay 连接」，wire 向后兼容、
单测全绿、多轮 review 通过，上线后一台休眠手机反复把同账号所有设备（含桌面↔桌面）
一起打掉线，由 #1405 收窄止损半径修复。协议兼容、allowlist、单测三层防线对这类问题
全部免疫，只有 review 时点名问「半径」才拦得住。

## 共享恢复与请求策略

Desktop 和 Mobile 的按设备排队、并发上限、退避、取消代次由
`packages/device-link/src/peerRecoveryScheduler.ts` 统一维护。Desktop 的订阅快照与
在线判断、Mobile 的后台生命周期与页面恢复仍由各端适配器负责。同一设备取消后重新
请求恢复，须等待旧请求结算；旧结果不能取消新请求，也不能恢复已取消的重试。

`packages/device-link/src/invokePolicy.ts` 集中维护请求策略，三个边界独立判断：

- 通道执行预算：保留 Desktop / Mobile 的超时差异，超时不代表主机操作未执行。
- peer reset 后可重试的读取：显式列举，不按名字推断写操作可以重试。
- 可共享在途结果的 listing：不能从“可重试”推导。`sessions:get` 与要求 `fresh` 的
  `sessions:list` 必须重新读取，避免复用写入之前开始的快照。

主机数据库后台准入是独立的资源分配策略，不能直接复用上述 listing 集合作为分类依据。
这些策略不改变 wire 格式或通道权限；权限仍以 allowlist 为准。

Mobile 的模型目录变化通知由 `deviceCatalogRefresh.ts` 按设备合并，失效立即推进代次，
在途读取结算后再补拉最新快照；页面与后台共享能力读取，通知不得清掉物理在途槽后重复发包。
可靠传输在本地 WebSocket 出现积压时提前暂停数据写入，复用公平预算与短间隔 drain，
为 ACK／握手保留硬上限之前的余量；不等待 relay 的 1013 才降速，也不对已排空的健康
socket 固定限速。最大逻辑消息仍可在排空后原子发送，不改变可靠序号和跨版本协议。

## 模块通过 Remote Resource 接入移动端

面向移动端新增独立产品入口时，默认通过 `@cindy/device-link` 的 Remote Resource
协议接入，不为每个业务模块复制 DTO、store、channel 与 push reason。稳定 wire 入口只有：

- `maker:remote-resources:manifest`：主机声明 collection、placement 与客户端可展示的有限原语；
- `maker:remote-resources:list` / `maker:remote-resources:get`：读取资源投影；
- `maker:remote-resources:invoke`：调用主机已注册、已校验的 opaque action；
- `maker:remote-resources:changed`：只表达 collection/ref 失效，控制端据此重拉。

Desktop 功能模块通过 `RemoteResourceRegistry` 注册 provider；主机保留业务权威和安全边界，
provider 只投影用户可见信息。密钥、Token、渠道凭证、系统路径、内部 prompt 与运行时对象不得
进入资源响应。Mobile shell 只理解有限的展示/交互原语，不按 Bot、Schedule 或 Plugin 的内部
enum 编译分支，也不接受任意 HTML、React 或无限 UI DSL。

资源身份必须包含 `deviceId + collectionId + kind + id`。资源路由打开时应重新调用 `resource:get`
解析 `conversation` 等 link，不能把可能 rollover 的 Session id 当成永久资源身份。已有对话继续
复用 canonical Session 的消息、输入、确认与恢复链路，不复制一套模块专属聊天协议。

协议按字段追加演进。未知字段、未知 collection 和未知 action 不得导致整个首页或会话崩溃；
结构化 Session 内容必须携带可读 `fallbackMarkdown`，旧客户端至少能阅读并继续任务。只有新增
移动端此前无法表达的内容或交互原语时，才要求客户端发版。

任务内状态卡使用 collection placement `session:<source>`，资源 id 为任务 id。
Mobile 根据 manifest 发现卡片，不写死具体业务状态；`session-controls` 原语仅声明
输入是否可用与是否忙碌，详情保留可读 fallback，动作 id 为不透明标识。
动作的 disabled 是呈现提示，主机仍须按最新状态、账号与任务身份复核。重连只重读，
不得重放写操作；旧客户端不识别此 placement 时继续原有消息流程。

## 本机与远程共用查询策略

本机独立使用、远程操作、两端同时使用应共享数据语义与通用查询策略；远程连接状态
不得改变本机的业务规则。数据库优化落在共享数据访问层，远程边界只承担授权、协议
兼容和传输约束，不另建一套查询、缓存或调度策略。

`localDb/sessionQueries.ts` 统一单条、批量、列表的字段选择、消息计数、预览与结果整理；
单条读取委托批量读取，列表保留同一语句内先限量再取详情的查询形状。Renderer 的
`sessionBatchRead.ts` 统一按所属设备路由、去重、分批、结果验证与缺失判定；本机分屏
补读与远程列表补读都复用它。现有列表在途合并和数据库 Worker 调度继续由本机与远程
共用；不增加已完成结果缓存。远程权限结论仍只在授权边界处理。

### 远程边界与延迟诊断

**逐任务精确停止**（后台命令 / durable subagent）走 `maker:agent-task:stop` 隧道：任务进程属于
会话所在端，控制端 main 没有那个 handle，本地调用会「假成功」（控制端表里恰好有同 id 任务时
还会停错对象）而任务照旧在被控端跑。归属按**粘滞**判定（`stickySessionOrigin`）：relay 瞬时
重连清空注册表的窗口里仍留在被控端，不退回本机。老被控端无此 channel → `CHANNEL_NOT_ALLOWED`
→ 保留按钮但失败提示，不做乐观收口（任务确实还在跑）。反向不成立：状态栏的「后台任务运行中 /
全部停止」计数仍只服务本机会话（镜像事件有设计内丢失窗口，计数不可作权威）。

远程列表复用本地查询，返回前额外执行伙伴可见性过滤。过滤按本次授权阶段批量查询，
每条 SQL 最多 200 个 ID；不跨请求缓存授权结论。缓存回复与离线重放仍重新检查，账号
变化时丢弃旧结果。控制端补齐列表外任务时优先使用 `local-db:sessions:get-many`
（最多 32 个 ID，当前每轮补读最多 8 个），保留单条 GET 的元数据、预览和计数语义。
旧被控端不支持或批量回复超帧预算时回退到原有有界 GET；超时、撤权、损坏回复不触发
成倍重试，迟到回复不能覆盖更新的 push。

Debug 日志区分两层耗时：

- `remote invoke slow execution`（至少 1 秒）包含 `stagesMs`：调用前授权、业务 handler、
  调用后授权、设置持久化、返回投影。总耗时还包含调度和序列化，不等于 SQL 执行时间。
- `db-rpc` 的 `rpc.slow`（至少 250 毫秒）包含 `queueMs`（主线程待发送队列）、
  `workerWaitMs`（投递到 Worker 开始处理）、`workerExecutionMs`（整个 Worker 操作）、
  `deliveryMs`（结果传输及主线程调度）。事务操作的执行时间覆盖整个事务；结果传输时间
  也不能直接称为主线程阻塞。旧 Worker 未附计时信息时只记录可测部分。

诊断只记录本地 RPC 序号、操作类别、数量与耗时，不记录 SQL、参数、消息内容或结果。
性能复测应同时包含前台发送、另一控制端刷新与补读、本地读取；分别报告请求数量和延迟，
不能把内存数据库基准当成真机网络端到端改善。

`device-link request slow/failed/timeout` 另记录 `firstWriteWaitMs`（请求建立到首次
WebSocket 写入成功）与 `afterFirstWriteMs`（首次写入到结束）；从未写出时记录
`firstWrite=none`。写入成功不是送达回执，后半段仍包含 socket/relay/网络、对端处理和
接收端调度。可靠层在至少 250ms 的等待或重发时记录发送 `queueMs`（首次写出）／
`ageMs`（重发时消息年龄），以及接收 `assemblyMs`（首分片到重组完成）／
`orderedWaitMs`（重组完成到按序交付）。新增阶段时长使用各端单调时钟，以 requestId 关联，
不相减不同设备的墙钟，也不改变 wire、ACK、重试或授权语义。

本地目录联合刷新和远程目录变化推送共用 `coalescedRefresh.ts`：同轮通知合并，
在途期间只保留最新一次补读；失效立即推进已有代次，旧结果不提交。整组读取结束
（包括失败后的其它成员）才释放刷新位置。账号切换或远程断连后的新代次独立刷新，
不等待旧请求超时；已经取消的补读不重新打开连接。该合并不引入结果缓存或定时重试。

## PR 门禁

功能类 PR 的 Description 必须写明上述每一项的结论，三选一：

1. 本 PR 已一并适配；或
2. 已开跟踪 issue 并贴链接；或
3. 说明为什么不涉及（给出理由，不能只写「不涉及」）。

review 按此检查：功能类 PR 缺这段说明 = P1。

触及 device-link 重试／超时／断链恢复路径的 PR，Description 还必须写明「故障半径
三问」的结论（故障层级、动作层级、多 peer 用例）。缺失同样 = P1。

## Review 清单

1. 涉及 workdir／agent／会话数据的功能，在 SSH 远程下是否走远程通道而非本机 `fs`？
2. 新 IPC／推送是否按 allowlist 判据登记 invoke／push 白名单并同步 topic 路由？
3. 手机版入口／UI 是否已适配或明确跟踪？
4. PR Description 是否给出了三选一结论，而不是留空或只写「不涉及」？
5. 触及重试／超时／断链恢复路径的改动：恢复动作是否与故障同半径？扩大半径是否给出
   明确理由？是否有多 peer 拓扑用例证明其它 peer 零感知？
