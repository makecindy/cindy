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

## 远程新建 SSH 项目的目录归属（#7117）

`maker:create-session` 的路径守卫先按执行端点识别目录：显式 `remoteHostId` 经既有
SSH 就绪与目录探测后，将主机和规范化路径一同交给创建处理器，不用本机文件系统探测
SSH 路径。旧控制端省略主机时，按当前账号的 session 记录查找唯一 SSH 归属；本地目录
与 SSH 同时命中、或多个 SSH 主机命中时拒绝猜测。记录只能解析归属，不能替代实时探测。
显式 `remoteHostId: null` 选择本地；`agentDeviceId` 指定另一电脑运行 Agent 时，文件仍属
被控电脑，不反查 SSH。探测失败不降级到本机创建，探测期间撤权或切账号也不能继续创建。

`worktree:create` 等其它入口保留本地目录与网络盘超时检查。此修复不改变 wire 字段、
allowlist、重试或 relay 生命周期；手机端完整保留“主机 + 路径”的选择与记忆仍需单独适配。
实现与回归：`device-link/remote-workdir-guard.ts`、`device-link/dispatch.ts`、
`maker-ipc/register.ts` 与 `__tests__/deviceLinkHostDispatch.test.ts`（均相对 Desktop main）。

## 远程任务存档的即时反馈

桌面与手机的远程任务列表在点击存档后立即乐观移走任务行，不能等待远程预检或写入
返回才更新。既有的运行态、接管、worktree 与自动化确认仍在真正写入前执行；取消、
拦截或失败恢复列表，迟到的预检不能覆盖用户后续的恢复操作。展示必要确认框时仍保持
任务行隐藏，不能把“已经打开确认框”当成取消；桌面归档入口等待同一个异步确认结果。
预检期间保留任务内容，
不提前清理消息或草稿；手机只从列表投影隐藏行，保留详情元数据和此前重命名、置顶的
在途写入，确认后才取代这些写入并真正移除行。取消时解除隐藏，不拿旧快照覆盖期间
已经保存的元数据。详情页在确认通过后再退出。手机详情菜单先收起，关闭动画结束后
再查询并弹确认，避免远程等待卡住菜单或原生弹窗被关闭动画吞掉。
手机详情将确认回调交给 `useSessionListActions.patchSession`，与列表共用同一个预览、
写序和失败回滚入口；确认仍有效并开始提交时才退出详情。离页或后续状态操作使旧确认
失效，结算时只解除该次预览，不写回旧状态。

实现与回归：Desktop `useSessionLifecycleActions`、`sharedTaskArchiveGuard.test.ts`；
Mobile `useSessionListActions`、`SessionMenuSheet`、`orphanSessionActions.test.ts` 与
`remoteSessionStore.test.ts`。

## 代输入的多端适配（2026-10-13）

产品规则见 [`../product-rules/input-handoff.md`](../product-rules/input-handoff.md)。三种形态的落点：

- **SSH 远程工作区**：不支持。目标窗口必须在执行代输入的这台电脑上；`request_input_handoff`
  在带 `remoteHostId` 的任务里返回 `CAPABILITY_NOT_AVAILABLE`，由 Agent 改为直接告诉主人需要什么。
- **设备互联远程控制**：卡片快照随既有交互推送（`kind: "input_handoff"`）到所有控制端；交还、取消、
  停留、刷新、接手、看画面等**不带值**的决定走既有 `resolveInteraction`；**带值**的提交与截图只走插件
  授权 v3 加密交换（`plugin-oauth:submit-input` / `plugin-oauth:open-input-picture` /
  `plugin-oauth:answer-input-picture`），不新增明文 invoke。对端不支持 v3 时卡片显示「请更新」，不降级。
- **手机版**：同一张卡（`src/inputHandoff/`），系统保密输入与 AutoFill 类型、截图点按、设备码
  （`expo-clipboard` + `Linking`，无新原生依赖）与单窗口实时画面（远程桌面路由带 `handoff` 参数）。
  推送深链回到所属任务。
- 单窗口实时画面复用远程桌面通道：控制端只在 `start` 里带 `handoff: requestId`，由被控端按请求选窗口；
  被控端以 `handoffWindow` 能力位声明支持，旧被控端不声明时控制端不展示入口。协议细节见
  [`protocol-compatibility.md`](protocol-compatibility.md)「代输入」。

## 恢复动作先回答故障半径（device-link 共享链路）

### 供应商组的跨区分享恢复

2026-10-26：① 故障是任务所在电脑没有加载同账号组已能用的跨区分享；② 仅恢复当前账号在另一
官方区域的分享列表与专用连接，不重启本区 relay、不重放任务、不扩大分享权限。首次请求合并，失败
沿用现有退避，重复的组查询不绕过退避；本区名单的额外核验也限为每 30 秒最多一次，本区已加载的
目标不等待无关的跨区恢复。组视图先返回，成员目录仍受原有 3 秒读取上限约束；③ 回归
通过真实组 `view` / `pick`、设置页 `remote-manage` IPC 与分享路由入口验证恢复，同时核对本区分享仍可用、暂停与撤销仍拒绝、
换账号后的迟到组回包和服务端回包不能激活新账号。手机及桌面远控共用任务所在电脑的这条路径，
SSH 与跨账号组中转不变。实现见 `provider-group/remoteClient.ts`、`device-link/providerShareGuest.ts`
与 `providerShareCrossRegion.ts`。

### 文件通道慢速回退

Desktop 与 Mobile 的整文件 peer 下载共用 `fileTransferPolicy.ts`。数字按职责分开：
网络帧／信用窗口是协议约束；连接空闲与命令／接收超时是资源和等待预算；缓存容量
沿用已有存储预算，不作为文件有效期或“最佳网络速度”的依据。
双方协商支持后，文件连接跟随远程会话生命周期，首次传文件时才建立，不用任意空闲
时长决定关闭；旧端继续按已有空闲预算兼容。手机退后台释放原文件 WebView 和电脑端
连接，回前台不立即重建。手机 relay 离开 online 时同样立即卸载文件 WebView，
不等重新上线后的 connectionEpoch 才清理；取消在途、排队及建连中的请求，
迟到消息不得恢复旧会话。重新在线且新 WebView 就绪后按需建连，不主动重放文件请求。

连续一个命令预算（15 秒）没有写入进展（含等待 EOF）时回退。只要仍有写入进展，
不按预计剩余时间、文件大小或速度放弃传输：接收超时约束的是无进度等待，不是整个
文件的完成时间。没有备用路径的实测速度，就不能以“预计还需超过 60 秒”为由丢弃
已收字节；这会让 806 MB 等大文件在正常传输 15 秒后被中断，再撞上旧媒体上传接口
的 30 秒请求超时。直接、TURN 和未知路径使用同一停滞判断，路径变化不影响它。
每次取件旁路采样实际路径用于诊断，不阻塞握手或文件首字节；进度检查不依赖 Debug 开关。

共享文件 runtime 遇到 ICE `disconnected` 保留连接最多 15 秒，恢复则取消计时；
`failed`、`closed`、显式取消和撤权仍立即清理。重复断连事件不延长窗口，计时只作用于
该连接。Desktop 对已完成且持续至少 15 秒、平均低于 128 KiB/s 的中继下载，在下一次
取件前最多每 60 秒试建一个候选连接；保留旧连接，只有候选确认直连且旧连接没有在途
RPC 时才替换。候选失败或仍走中继继续用旧连接；受现有四连接上限、账号与 peer 代次
约束，不改变 wire 协议或旧端能力协商。升级后停止探路，除非后来再次出现慢中继样本。
诊断记录断连原因和最多八个 ICE 检查结果，不记录地址、候选 ID、SDP 或凭证。

故障仅影响该 peer 的文件通道；复用已有按设备冷却（30 秒起、最多 5 分钟）避免
紧接着的文件重新走同一慢链路，不重连共享 WSS、不影响另一控制端的文件或请求。
取消、退后台、切账号依然是取消，不触发 OSS；不并行竞速或预先上传用户文件。
回归包含两台控制端一台停滞、另一台持续写入并完成，以及旧端缺能力字段的兼容。

### 共享连接静默与请求隔离

2026-10-30：Desktop 在业务超时时先检查共享 relay 最近是否仍有入站活动；整条连接
静默时复用现有有界网络探测，不直接累加某台电脑的熔断失败。任一 peer 的有效回包
都能结束探测；只有共享探测本身超时才恢复整条连接。探测期间后台刷新以未发送的
背压结果退出，前台操作继续按原预算执行。Desktop/Mobile 的 `waitUntilOnline` 保留
原有立即重连入口；已有握手不重复打断，relay 1013 拥塞冷却仍按原规则执行。

相同的列表读取沿用独立请求和发送前取消／账号检查，一个调用方取消不能拖累另一个。
本次恢复不新增请求合并或应用层重试。回归覆盖两台 peer，一台静默时另一台仍能完成
前台请求且共享连接不被拆除。

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

### 直连优先、中继兜底(同账号设备)

产品要求：Device Link 的设备间功能(含手机)在两端已授权、网络实际可达时优先直连，
直连失败、超时或中途断开时自动改走 relay，不能让功能卡住，也不能重复执行命令。
选路与兜底在 `packages/device-link` 统一实现(`directPath.ts` 与 `DeviceLinkClient`)，
`directNegotiation.ts` 在双方可靠链路确认后自动协商，平台提供数据专用 WebRTC runtime，
由统一协商层调用 `attachDirectPath`，不要求用户手工建立通道。

- **分工**：relay 仍是控制面——登录、在线状态、账号归属、link-open/accept/close、
  链路确认 ACK 都只走 relay。直连只承载已建立可靠链路上的 reliable-transport 帧
  (invoke / invoke-result / push)及普通累计 ACK。可靠层按 seq 去重、按序交付，
  同一条消息经两条路径各到一次也只执行一次。
- **授权**：直连帧的来源取自通道绑定的设备，不信任帧内 `src`；被控端照常逐条复验
  被控开关、撤权名单与 allowlist。共享任务、供应商分享等跨账号范围不走直连，逐帧
  授权仍由 relay 执行。relay 报告对端离线(含被移出账号)、链路被关闭或撤权、客户端
  停止时立即撤下直连。ACK 原路返回，单向失效时发送端不会被困在直连上。
- **故障半径三问**：① 故障层级是单个 peer 的直连通道(通道关闭、写入失败、发送缓冲
  在一个可靠重试基准期内没有下降，或已发出的帧过了自适应 ACK 基准期仍未确认)；直连
  判活不乘 relay 的大消息字节退避，单条大结果也能及时回退；缓冲仍有进展时
  继续等待排空，不误判正常背压；② 动作只撤下这一台设备的直连，把它仍未确认的帧
  恢复为未发送、按 relay 既有恢复预算(先探测一批、收到 ACK 再继续)重发，不重连
  relay、不重建链路，直连的失败不消耗 relay 的重试次数；③ 回归见
  `packages/device-link/src/__tests__/client.test.ts`「直连优先、中继兜底」：两个控制端
  共用同一被控端，其中一个的直连静默，断言命令只执行一次、结果经 relay 送达，另一个
  控制端仍走直连、在途请求与 relay 连接不受影响。
- **接入**：Desktop 复用 `DesktopCaptureWindow` 的隔离数据进程(`mode=direct`)，Mobile
  使用 `DirectLinkTransport.tsx` 的隔离 WebView；二者共用 `directRtcRuntime.ts` 与
  `directRuntimeBridge.ts`。只收集 host ICE candidates（不请求 STUN/TURN），局域网不可达
  继续走现有 relay；协商不阻塞正在进行的业务请求。同账号远程供应商的控制、结果和推送
  复用同一条数据路径。手机退后台、WebView 崩溃、账号/区域切换立即释放旧通道。
- **兼容**：双方都声明 `direct-link-v1` 才尝试。信令以既有 relay push 承载，绑定两端
  当前 stream；旧端、平台尚未就绪或协商失败均继续使用 relay。每对设备只有字典序较小的
  deviceId 发起 offer，失败按 5–60 秒退避；最多 16 个 peer，单次协商 15 秒。
  relay 断线仍复位链路，直连暂不独立维持；不新增服务端依赖或 Mobile 原生依赖/配置。
- **验证**：`client.test.ts` 的自动协商矩阵覆盖新旧端、平台不可用、远程 Agent 调用和两个
  控制端隔离回退；`directRuntimeBridge.test.ts` 覆盖桥接背压、迟到事件与流代次；
  `scripts/direct-link-smoke.mjs <Chrome路径>` 运行真实 WebRTC 与手机静态 runtime，验证
  UTF-8 大结果不经中继、断线回退只执行一次、另一控制端继续直连。该浏览器验证不能替代
  iOS/Android 和两台真实电脑的跨设备验收。
  `node scripts/direct-link-electron-smoke.mjs` 另外启动两个临时 Electron 进程，验证生产
  Main/preload/隔离 renderer 的真实 IPC、WebRTC 与中继回退；账号和 userData 均为独立 fixture。

## 远程 Agent 的拉取与恢复(`maker:remote-agent:v1`)

供应商进程重启（2026-10-29）：已打开的 run 收到 `missing`、`provider-restarting` 或旧端的
`aborted` 时只释放这条远程连接，保留本机执行器和 MCP 身份。空闲任务下次发送再接回；进行中的
一轮通过现有供应商组恢复租约、五次有界探测和输入队列自动续跑一次，未归组的供应商也适用。
原生会话 ID 必须接回，设置必须重放完成，才能发送续跑；不重发原消息或结果不明的方法调用。
权限、Plan 和自动动作来源沿用原轮次；Stop、新输入、归档／删除使恢复失效。持续不可达、撤权或
接不回原生会话保留原错误与人工恢复入口。伙伴、目标模式与共享任务沿用既有自动恢复归属检查。

正常退出先经 device-link 同步 quit 回调走 `dropAllControllers('shutdown') → abortAll('app-quit')`；
`host.dispose()` 来自 Maker 重置，不是常规退出必经路径。两条入口共用闲置／忙碌判断，重叠时等待
首次收尾再回收。`dispose()` 返回同一份清理完成 Promise，包含正在启动的任务与巡检已开始的删除；
服务重建后先等待前一 host 的清理，再派发新请求，等待期间再次重建的旧入口不再接单。
这只约束本进程 Maker 重置后的 host 交接，不重连共享链路、不改变线上协议。
新版主动断开（`user` / `toggle-off`）发 `controller-disconnected`，控制端映射为
既有 `user-revoked`，不自动续跑或让供应商组换电脑；中转也不发换电脑凭证。旧版 `aborted` 无法
区分退出和主动断开：兼容旧版退出意味着旧版一键断开可能连回一次，关闭远程控制则被权限门拒绝。

分享在已经发生链路不可达后临时报 `ACCESS_REVOKED` / `REMOTE_AGENT_SHARE_UNAVAILABLE`，
只保留原两分钟窗口，不重置截止时间；首次即撤权仍立即失败。恢复只作用于当前 run 的连接与
当前电脑的拉取器，不重连共享 relay、不绕过授权。两控制端共用一个 host 的回归中，一个 run 消失并
重新打开，另一控制端仍能发送、原生会话不变。实现及回归：`remote-agent/controller/`、
`remote-agent/__tests__/connectionPool.test.ts`、`poll.test.ts` 与 `provider-group/service.ts`。

直连分享任务持久位置仍为 `share:<id>`，该位置代表 O，不等于实际执行电脑 M。重启恢复通过
现有直连句柄向 O 为原 M 申请新许可并探测 M，空闲 run 重开也先完成相同授权，不改选电脑。
断链窗口内的临时拒绝可触发同一授权流程；授权请求不阻塞两分钟截止时间，也不能延长已到期的
本机租约。授权、关停与启动代次复核在异步返回后再次执行，失效请求只释放本次授权代次。
M 仍保存但已撤权的 run 明确收尾为 `access-revoked`，不以 `missing` 触发续跑。
回归见 `roundtrip.test.ts`、`groupRelay.test.ts`、`poll.test.ts` 与供应商组 `service.test.ts`。

离线期间 Stop 仍走 Session 既有的有界中止复核（15 秒）。远程 close 通知失败只记日志，不能把已
清理的本机代理留在运行状态；本机资源清理失败仍须上抛。代理 dispose 同时清空 turnRunning /
preparing，本机 Session 可正常关闭，下一条显式消息按原生会话 ID 重建；不依赖离线电脑确认才能
解除队列占用。回归同时覆盖远程通知失败与本机清理失败，不能把两者混为一谈。

协议见 [`protocol-compatibility.md`](protocol-compatibility.md)「远程 Agent」。恢复策略按故障半径三问：

1. **故障层级**：只处理同一台被控端的事件拉取。`poll` 遇到 peer reset、超时、背压或链路暂断时，
   用同样的游标重拉(0.5s 起指数退避，上限 5s；另一个在途 poll 成功即提前恢复)；连续 2 分钟拉不到
   才结束这台被控端上的任务并提示对方不可达。单个任务的流数据与游标对不上时只结束那一个任务。
   打开或连回 Agent 前的只读 `caps` 查询复用共享瞬态重试策略（最多 6 次），等待启动建连或拥堵冷却
   结束；授权拒绝、旧端不支持等非瞬态错误立即结束。只重读这台电脑的能力，不重建 link、不重启 relay，
   不重放 `open`、上传或发送。回归见 `remote-agent/__tests__/connectionPool.test.ts`。其余 op 不自动重放。
2. **动作层级**：与故障同半径——只影响这台被控端的拉取器，不重建 link、不断开 relay、不影响其它
   被控端和普通远控请求。被控端侧对无人拉取的任务按任务超时(3 分钟)收尾，不波及其它任务。
3. **多 peer**：被控端按 `(控制端, runId)` 隔离任务；默认每台控制设备最多 16 个任务、整机最多 64 个，
   主人可在「远程与分享」调整（最多 1000）。控制端每台被控端一个拉取器，每次 `poll` 最多带 64 个任务，
   按整批轮转，挂起最多 10s，长等待同时在途最多两个；另留一个补位名额给没有被在途 poll 覆盖的任务，直到
   普通 poll 接手(未覆盖任务排在最前并继续轮转)。补位 poll 最多等 1s，让后续新增任务也及时入列；合计不超过 3 个，
   不占满共享的 12 个在途配额。
   补位名额解决的是：两个长等待都只含空闲的旧任务时，新任务的第一个事件及后续事件要等旧长等待超时 10s 才有人拉，
   正好撞上 Codex 执行环境 initialize 握手的 10s 上限(2026-10-22 调查)。
   `poll.test.ts` 用 130 / 1000 个空闲任务验证拉取间隔始终短于 3 分钟的回收期限，并复现上述新任务等待。
   被控端连续立即返回空结果时控制端放慢到 1s 一次，防止空转。2 台控制端共享被控端、
   其中一台静默的回归仍需在双实例实机验证中补测。

账号边界关闭远程 Agent 句柄时，通知对方关闭与释放本机资源独立进行。关闭通知失败只记录日志，
不能作为本机 PI 进程残留阻断换号；本机执行器、MCP 身份与执行环境中继的清理必须等待完成，
失败仍向上传递，并让重复关闭共享同一清理结果。通知失败后，成功关闭本机句柄不代表远端进程已退出：
运行端无人拉取超时使用 `navigation` 收尾父会话与隧道，PI 的此类关闭可能为持久子代理保留代理租约，
不能作为子代理全部停止或模型用量已停止的保证。控制端换号不替换运行端的供应商凭证；运行端自身
换号仍须执行其账号边界保护。本次不新增跨账号重试，也不重建 link 或 relay。
普通关闭和连接池让出仍报告远端关闭失败；
本机与 SSH PI 的账号边界保护不变。实现见 `remote-agent/controller/{proxyHandle,startRemote}.ts`，
不改变 wire、授权检查或跨端版本要求（#6921）。

**控制端连接池的让出与连回**(2026-10-17，协议见 [`protocol-compatibility.md`](protocol-compatibility.md)「控制端连接池」)：

1. **故障层级**：B 的单设备名额(`caps.maxRuns`)快满或已满，或 B 以名额类 `REMOTE_AGENT_BUSY` 拒绝一次 open；只涉及这台 A 在
   这台 B 上的连接。
2. **动作层级**：与故障同半径——只结束这台 B 上一个不忙且闲置满设置时长的 run(`close`)，本机部分与对话记录不动，不碰 link、
   relay、拉取器与其它 B；被拒后只重试一次，没有能让的就按原错误返回，不排队、不循环。连回只在这个任务下一次要 Agent 干活时发生，
   连不回(B 离线、仍满等)保持已让出、按原错误报给用户，下次发送再试，不自动重放；发送路径上 Maker 会按通用发送失败关闭句柄，
   本机后台命令随之结束，对话由下次发送重建时接回(已知限制，见协议文档同节)。
3. **多 peer**：B 按 `(控制端, runId)` 计数，A 的计数只算自己的连接；多实例、别的设备的占用与 B 刚改的上限都可能让 A 的计数不准，
   因此 A 不据此拒绝打开，只据此决定要不要先让，最终以 B 的裁决为准。闲置时长按 B 主人在「远程与分享」设置的
   `caps.idleReclaimMinutes` 判断（默认 30 分钟）；旧版 B 没声明或主人设为 0 时三条路径都不让，与没有连接池时一致。

**托管 Codex 的关键线程 RPC**(#5764)：Agent 所在电脑上的 Codex 经 exec-server 逐个读任务所在电脑的
项目说明与 Skill，`thread/start` 实测约 35 轮串行往返，耗时 ≈ 轮数 × 链路往返，慢链路下合法地超过
`CRITICAL_THREAD_RPC_TIMEOUT_MS`(60s)。`thread/start`、`thread/resume`、`turn/start` 因此在任务隧道
还有往来(Agent 发出的 exec-server 消息、执行环境的回复或 Cindy 工具请求；执行环境主动推的后台命令
输出不算，Agent 卡住时它照样会来)时顺延，隧道连续 30s 没有往来或从发出起满 5 分钟仍按超时收口；
没有往来记录的会话(非托管、旧接线)保持固定 60s。只作用于这一个任务的这一次等待，不重试、不重放、
不动 link 与其它任务。诊断：超时错误末尾带 exec-server 请求/回复数、最早未回复请求与等待时长、
往返均值与峰值、最近一次往来距今多久(Agent 所在电脑的隧道记录，`host/linkActivity.ts`)；任务所在
电脑的中继在首次回推超过 2s 时记一条日志，任务结束时有慢回推或闸门拒绝再记汇总
(`controller/execServerRelay.ts`)。回归见 `codex/app-server/client.test.ts`、
`codex/__tests__/device-hosted-guest.test.ts` 与 `remote-agent/__tests__/linkActivity.test.ts`。

**托管 Codex 启动的跨机往返与执行环境恢复**(2026-10-22 远程供应商调查：启动 277 次串行文件操作、每次跨机
0.5–3s，启动几分钟、撞 5 分钟上限；握手失败后「能聊天但没有 Shell 与文件工具」)：

- **POSIX Agent → Windows 执行端的沙箱实现**（2026-10-28 真机）：固定 Codex 0.159.2
  从 macOS 发出受限权限时携带 `windowsSandboxLevel=disabled`，Windows 原生 exec-server
  因无法落实沙箱意图拒绝所有命令。控制端只把这种跨平台、`permissions.type=managed` 的
  disabled 选择映射为 Windows 原生 `restricted-token`；权限条目、网络设置、Cindy 本机授权
  闸门均保持原值，显式 Windows 选择和非受限请求不改。原生实现不能落实 deny-read 等规则时
  仍拒绝整个请求，不删规则、不转无沙箱、不重放命令，不安装 MXC、创建系统账号或改防火墙。
  这是 Windows 原生受限令牌的边界，不声称其网络隔离等同 macOS：网络约束沿用该原生实现。
  故障只影响这个任务的执行请求，不重启 device-link、不撤下其它 peer。回归见
  `remote-agent/__tests__/execServerProjection.e2e.test.ts` 的真实原生进程及
  `executor/__tests__/virtualWorkspace.test.ts`；临时文件和权限验证均限制在测试目录。
  Windows 的 Store/MSIX PowerShell 无法在受限令牌下启动（真机 `CreateProcessAsUserW`
  错误 `-1073283067`）。同一跨平台适配只在原生声明此类 Shell 时，优先宣告现存的
  非 Store PowerShell 7，否则使用现存的系统 Windows PowerShell；先解析真实路径排除
  指回 Store 的别名。没有替代时保留原声明并明确失败，不改系统 PATH、不下载或安装 Shell，
  不改用户显式命令及其它 Agent 的 Shell。原生回归必须按 initialize 宣告的 Shell 真正执行。

- **不可能存在的路径在 Agent 所在电脑直接回答**(`host/execServerShortcut.ts`)：Codex 沿工作目录逐级向上找
  `.git`、Skill 目录与插件清单。镜像根内的虚拟垫层(真实根目录以上的 `workspace/p/…`)及镜像根本身在任务电脑没有
  对应目录(已映射的工作区及真实上级、`home`、`tmp`、`additional` 除外，见 `controller/startRemote.ts` 的
  `shadowAliases`)。镜像根外的绝对路径会原样转发，可能在任务电脑真实存在；只能按任务电脑明确报告的原始绝对路径
  标记缺失来回答，不能凭点前缀判断不存在，两端路径格式不同时不套用原始路径。可确认不存在的 `fs/getMetadata`、`fs/canonicalize`、`fs/readFile`、
  `fs/readDirectory` 由隧道直接回 exec-server 原生的不存在错误(`-32004`，Codex 按 NotFound 处理，固定 0.159.2
  源码与实测)，不进事件流；其余照常转发。
  工作区的**真实上级目录**在任务所在电脑上存在，Codex 在每一级查 `.git` 与三种插件清单(实测每级 6 次，项目在
  9 层深处时 54 次)。任务所在电脑打开任务时报来各级有没有 `ANCESTOR_MARKER_NAMES` 里的名字(`open` 的可选字段
  `ancestorMarkers`，`controller/projectFiles.ts` 的 `collectAncestorMarkers`，只看名字在不在、查不准按「有」)，
  报了「没有」的同样在本机直接回答；报了「有」、没报的级别、工作区本身照常转发。名单以这次打开时为准，任务连回
  时重新报一次；任务进行中有人在上级目录新建 `.git` 等，要等连回后 Codex 才看得到(上级目录很少在任务中变化)。
  故障半径：只改这一个任务隧道上的只读查询，不动 link 与其它任务；`ancestorMarkers` 是可选字段，旧被控端解码时
  丢弃、旧控制端不带，都退回逐个转发。回归：`mirror.test.ts` 用真实隧道、控制端映射与磁盘核对「本机回答的路径
  在任务所在电脑上确实不存在，存在的照常转发」；`plumbing.test.ts` 核对格式不对整段丢弃。升级 Codex 时核对
  `-32004`、查询方法名与上级目录查找的名字。实测(2026-10-22，Windows 本机真实 Codex 0.159.2，临时项目含
  3 个 Skill，poll 与 push 各加 100/400ms 延迟模拟链路)：启动转发消息 173 → 105(只回答镜像内垫层)→ 41
  (再加已确认缺失的上级标记，含 1 条 initialized 通知)。模拟约 200ms 往返时启动 16.1s → 9.7s → 4.5s，
  约 800ms 时 56.8s → 34.9s → 15.5s；每组单次，计时到启动句柄返回，不含首个模型回复。先前 244 → 82 → 28
  的样本使用了镜像外点前缀推断，审查修复后不再作为最终代码数据。剩余包括工作区、真实 Skill 与未确认的外部查询。
- **执行环境断开后自动重新登记**(`codex/index.ts` 的 `repairHostedEnvironmentIfDisconnected`)：首次握手失败的
  环境，Codex 只记一次结果、之后每轮都跳过，链路恢复也不会自己重连。每轮 `turn/start` 前，隧道上已没有开着的
  WebSocket 连接(`linkActivity` 的 `wsConnectionsOpen` 为 0)时问一次 `environment/status`；`disconnected` 或
  `unknown` 就按同一个 id 再 `environment/add`，这一轮带上的环境选择换成新连接(Codex 的
  `failed_resolution_is_replaced_from_the_environment_manager` 同一路径)。连接开着时不发任何请求，正常发送不多一次
  往返；查询或重新登记失败只记日志，照常发送。回归：`device-hosted-guest.test.ts`。
- **第一次启动期间删除或归档任务就让对方停下**(`controller/startRemote.ts` 的 `cancelPendingRemoteStart`，由
  任务的运行期清理调用)：在第一处异步准备前登记取消状态；MCP 准备期间被取消的，准备完成后释放资源、不发 `open`。
  已开始连接时控制端把连接标成已关闭，已发出的打开立即 `close`；被控端收到后不再换电脑、不再启动，
  迟到完成的 Agent 立刻关闭。此前启动阶段没有取消入口，对方会在几分钟后仍启动并跑完这一轮。回归：`roundtrip.test.ts`。
- **诊断**：任务所在电脑的本机 exec-server 首次输出超过 2s、或进程自己退出时记一条(退出码、信号、stderr 字节数、
  运行时长，不记内容)；供应商组中转的一批帧排队加推送超过 2s 时每个任务记第一次(排队与推送两段耗时)。

## 协同远端 Worker 的轮询与恢复

协议见 [`protocol-compatibility.md`](protocol-compatibility.md)「协同远端 Worker」，实现见
`apps/desktop/src/main/maker-ipc/orcaRemoteWorkerRuntime.ts`。按故障半径三问：

1. **故障层级**：单台运行设备的单个请求。轮询或派活失败只把这台设备标为「暂时无法获取状态」，
   Worker 不判失败、不重派；下一轮成功即恢复，并按消息 id 补报缺失的回报。派活时设备不可达直接失败，
   不排队、不重试；`enqueue` 前保存派活身份，回执丢失时先核对投递回执，不盲重发。
   重启后恢复待回报身份；unknown 回执须核对历史，有限轮次仍找不到时明确报告执行未确认。
   Lead 的 accepted 权限／状态复核在未冻结身份落盘后、远端持久入队前完成；复核后再次核对
   owner 与派发代次。拒绝不发送，并恢复旧等待身份；明确投递失败回滚 accepted 暂存，结果
   未知沿用投递对账，不按未发送回滚。回滚落盘失败记日志并保留原始拒绝原因。
2. **动作层级**：只影响这台设备上的远端 Worker；不重建 link、不断开 relay，不影响其它设备与普通远控。
   结束时先确认停止并落盘，再发 release；重连或 5 分钟补发只继续未完成的阶段。
   清理共用单 Worker 入口并读最新阶段，不能因迟到快照重复停止用户后续的普通任务。
   open 丢回执时用相同 sessionId 核对一次；无法确认的创建身份落盘，恢复后只解除未关联任务的标记。
   同 ID 核对要求来源匹配且任务仍为 active；归档或软删除返回 PRECONDITION_FAILED，不复活或
   关联任务，保留创建收据供只解除标记的孤儿清理。该检查不改变其它设备与普通任务的生命周期。
   普通启动错误也可能发生在任务落库之后，不能据此删除 open 收据；只有通道拒绝或明确 ID 冲突
   且没有先前在途 open 时直接清理。其余错误沿用单任务核对，不停止任务、不拆链路。
   清理与 Worker 关联共用任务锁，锁内复查归属；公开写操作和迟到回调均核对数据库 owner。
   本机代理任务行只在关联时创建，与 Worker、运行设备路由和 open 收据同事务提交。
   未关联即退出时没有本机半成品代理，恢复只按 open 身份解除远端标记，不派活也不复制任务。
   派发、恢复与本机启动检查等待当前 owner 的路由恢复；数据库读取失败不得回退到本机。
   创建回滚归档代理并释放名称与名额，但保留未释放路由；重启后继续 stop/release，确认后清理。
3. **多 peer 与负载**：每台设备每轮只发一次 `maker:list-active`，有待回报时 2s 一轮，否则 15s 一轮；
   按派活输入 clientId 读取对应回复（user / assistant 历史分页）与投递回执，只针对仍在等待回报的 Worker；
   每轮最多扫描 2000 行，预算用尽保留游标下轮续读，不累计“缺少回复”次数。后续插话的回复与 terminal
   状态不归给此前派活。宿主 accepted 生命周期完成后冻结回报身份，保存结果期间的新派活不被旧收尾消费；
   accepted 回调失败则恢复上一代等待状态并继续上抛原错误。同一 Worker 的派发及 accepted 生命周期复用
   现成 session 发送锁串行执行；其它 Worker 不受阻塞。多台控制端共享同一运行设备的回归仍需实机补测。
   已有多设备单测覆盖一台离线时另一台仍能回报；同 owner 的启动恢复幂等，不清空现有派活。

   运行设备的 `INPUT_ENQUEUE` 也承载远端 Orca 自动派活，不能一律当作用户显式输入。
   规范化远控载荷的自动来源意图只用于保留崩溃恢复队列的暂停，不授予来源身份或权限；
   本机、手机和另一台桌面的普通用户输入
   仍可解除恢复暂停，用户 Stop 暂停保持不变。只影响该任务，不重建 link 或 relay；
   内存回归运行实际 IPC handler 与 coordinator，覆盖持久队列、clientId 去重以及另一控制端的其它任务。

   **已知未修复缺口**：远端 queued 派活仍提前执行 accepted/commit，并把旧、新输入合并为同一待回报身份，可能阻塞或覆盖旧轮次回报，也会提前清除手动中断标记。
   修复需要将 active report 与未消费投递分别持久化，并覆盖连续轮次、撤回、未知回执、accepted 回滚与重启恢复；仅延迟两个回调不能补齐这个缺口。

   **收尾未修复缺口**：abort 不清除持久队列，release 后的未消费 Lead 派活仍可能执行。
   当前远控入队剥离 Orca 语义来源，来源设备不足以区分自动派活与同设备用户输入；本轮不清空
   整队列或只删最后一个 clientId。后续须补可持久核对的投递归属及释放边界，取消只作用于该
   Lead 的未消费派活，保留用户消息；覆盖混排、消费竞态、丢回执、重启及其它控制端。

## 共享恢复与请求策略

Desktop 向曾协商可靠传输、当前发送链路未就绪的设备发起新 invoke、订阅或响应性探测时，
先复用该设备既有的单飞建链入口，再发送请求。轻量列表也适用，避免请求尚未写出就反复
耗尽排队预算；从未建链或显式关闭后回退到 legacy 的设备继续使用原路径。等待前后复验
取消与禁用状态，自动探测另查撤权和 owner；建链成功本身不算业务恢复。故障与动作都限于
单 peer，不重启共享 relay、不重放已发出的写操作；回归覆盖另一 peer 与 legacy 请求继续工作。

普通出站 invoke 在共享 `InvokeScheduler` 中按目标设备排队：每台最多 12 个在途，
其中 PR 引用／状态、定时任务侧栏、用量同步和轮后提示预测等后台查询最多 4 个。
发送、插话、停止、回答交互这类用户正在等的写入（`invokePolicy.ts` 的
`isInteractiveInvoke`）另有 2 个专用名额，排队时先于普通前台请求出队，不与历史和列表读取
竞争；被控端 dispatch 的 per-controller 16 / 全局 64 消息准入对它们同样各多 2 / 4 个，
字节准入不放宽。这只是本地准入顺序，不改变授权、超时与重试。
同一真实设备的普通远控与多个共享任务共用并发和等待配额；取消仍按各自 scoped peer
隔离，关闭一个任务不会取消其他任务或普通远控请求，transport 的任务范围保持不变。
任务列表首拉与恢复探测走前台配额（仍受总并发 12 限制）；Desktop 的周期弱刷新与归档
列表通过本地 scheduling 提示走后台配额，提示不进入 wire，也不改变授权。
Mobile 首页自动资源发现同样通过本地 `background` 提示进入既有后台配额，
排队后再次核验本轮发现及账号是否仍有效；失效调用不发送。用户主动打开资源保留原优先级，
不按资源通道统一降级，不改变心跳、订阅、其它设备或共享 relay 的恢复行为。
socket 缓冲或目标 peer 可靠队列超过 128 KiB、或该 peer 积压至少半个接收窗口时，
后台准入收敛到一路；已发送请求正常结算，压力消退后按原上限推进。
前台请求优先于尚未发送的后台请求；不同设备独立推进。PR 的重复聚焦／注册沿用
`PrRefsContext` 的单任务在途合并，不额外重试或保存结果。握手、订阅控制与远控心跳
不占业务队列，避免业务拥堵阻断连接或 lease 维护。
每设备最多等待 128 条，后台最多占前 96 个等待位置；排队预算不超过 30 秒，
排队过期返回 BACKPRESSURE，发送后仍保留原通道执行预算。断连／停止时取消未发送项，
在途项仍由既有 transport 结算，不能把取消或超时当成远端操作未执行。
进入 transport 后，invoke 首次写入 socket 前另有最多 `min(通道超时, 10s)` 的发送等待，
到期返回本地 `BACKPRESSURE`，不累计设备无响应次数、不触发 peer 重开。首次成功写入后才
开始原通道响应预算；分片续发和重传不续期，transport 总等待最多为发送等待加响应预算，
业务准入队列的最多 30 秒等待另计。单调时间或墙钟任一到期，恢复重放前均先淘汰请求，
避免睡眠期间计时器停跑后补发过期写操作。断线时，完全未写入的可靠请求立即结束并以 skip
替换，已经写入（含部分分片）的可靠请求保留原回执等待；`inFlight` 不把排队误报为已发送。
建链确认使用 `max(2 × handshakeTimeoutMs, peer 自适应重传基准 × 重试次数)` 的有界等待，
默认冷启动 30 秒、有 RTT 样本时最多 50 秒；重复确认不延长当前确认对象的期限，成功／撤销
取消原计时器。只调整等待预算，不扩大既有故障恢复半径，不改变 wire 协议。
调用方的 `preSend` 同步检查在出队后、创建请求前再次执行；排队期间失效的写入
必须拒绝发送并释放配额，本地检查失败不作为远端无响应的证据。
Desktop 将 BACKPRESSURE 映射为 DEVICE_LINK_BUSY；桌面和手机标签入口显示繁忙与手动重试。
可靠大回包按体积及该 peer 首次发送后 ACK 的交付速度估算重传等待，超过 512 KiB 再按
次数退避，传输等待封顶 120 秒；小消息保持原 RTT 退避，调用方响应截止时间不延长。
速度估计不从 socket 排空推断，慢 peer 不修改其它 peer 的计时或重置共享连接。

Desktop 远程 HTML 预览仅对只读 stat 的连接类错误做最多四次尝试，间隔 1/2/4 秒，
总预算 60 秒；找不到文件、权限和旧端不支持等错误立即返回。重复点击共享同一次准备，
等待提示可取消；取消按发起窗口和 requestId 隔离，在出队前再次阻止失效 stat，
已发出的 stat 迟到后不得打开页面。窗口关闭、主框架导航或账号代次变化也不得发布旧结果。
下载继续复用已有缓存与取消通路，不整次重跑下载或重试写操作；错误区分拥堵、超时与断线。
故障半径：证据限于目标 peer 的排队/交付及本次预览读取；恢复只调整本机准入和该 peer
重传、重试该预览 stat；第二个健康 peer 不被重置，旧端 wire 格式与权限边界保持不变。
被控端拒收时 Debug 日志记录在途数、待回包数、配额范围和前八个通道计数，
不记录参数／标签／消息内容。原被控端准入上限及 wire 格式不变，可独立升级控制端。

Desktop 和 Mobile 的按设备排队、并发上限、退避、取消代次由
`packages/device-link/src/peerRecoveryScheduler.ts` 统一维护。Desktop 的订阅快照与
在线判断、Mobile 的后台生命周期与页面恢复仍由各端适配器负责。同一设备取消后重新
请求恢复，须等待旧请求结算；旧结果不能取消新请求，也不能恢复已取消的重试。

Mobile 重连时，若熔断设备仍有在途业务请求，先在调度器外恢复该设备的回包链路，
避免旧探测等待回包、新建链又等待旧探测的循环依赖。此例外只发送单飞的 `link-open`，
不占用或结算业务探测席位，不增加业务请求，也不缩短原请求预算；建链成功不能解除熔断。
连接代次、前后台、撤权、显式关闭、设备可用性和在途请求在发送前再次核验。
后台新连接暂不恢复，回前台再复用同一建链入口；其它设备及被控端共享连接不受影响。

Mobile 熔断只把前台期间完整经历的超时算作「电脑端未响应」证据。发出时 App 已不在
前台，或发出后经历过前后台切换的请求，超时按不定论处理：iOS 挂起 JS 会冻结超时
计时器，回前台时它们会在 `active` 事件之前集中到点，不能证明被控端无响应。

可靠 ACK 重试耗尽默认只复位该 peer。重建连接会打断每个已就绪 peer，所以只有本 peer
与**所有**其它已就绪 peer（至少一个）的队头都在首发后没有收到任何对端转发帧（含 ACK），
且其它 peer 已重发多轮时，才视为 relay 连接转发方向卡死并重建连接。任一已就绪 peer
空闲无待确认帧或仍在正常 ACK 时，只复位沉默 peer：多台手机同时休眠不得连带断开健康 peer。
入站方向仍活动的旧版（未协商可靠传输）控制端无从取证，同样按缺少证据处理。
已知边界：本机经 `openLink` 主动控制的旧版目标不留活动标记，不参与该判定；仅在
它与多个可靠对端同时沉默时才可能多一次重连，由既有重连路径恢复，不为此新增状态。

Desktop 清理某设备的熔断状态不等于该设备已恢复。停用、离线和重置时只清理 UI
状态，不触发订阅重放或内容刷新；响应性事件只有携带真实业务回包证据才立即触发恢复。
清理事件本身不启动恢复，但不能永久关闭后续读取：聚焦、手动重试或在线通知再次触发时，
按当前 relay、设备可用性和响应状态重新判断；内部定时重试及旧请求收尾不能自行解除清理。
排队中的订阅与列表刷新同样受设备生命周期代次约束，迟到的失败不得重启已取消的恢复。周期对账复用在途
读取，新增内容等事件仍可合并成一次后续刷新；不得为了限制整轮等待而缩短弱网请求预算。

Mobile 历史读取在 relay 已在线且目标 presence 不是明确不可用时，可以沿既有建链和订阅
流程尝试恢复。新连接会清空 presence，设备列表读取失败后的「未知」不等于离线，不能阻断
历史控制器与页面同步；也不能为了放行读取伪造在线快照。明确离线／停用或 relay 未在线时
仍只展示缓存，授权、撤权和旧代结果拦截继续由原链路处理。

Mobile 项目标题的电脑图标同样使用共享连接状态、当前 presence、无响应与撤权证据，
不从页面局部设备清单的缺失、旧快照或列表读取失败推导断连。首页、任务抽屉与宽屏常驻列表
共用此判据；重建列表与普通同步不会重置连接图标，真实断连与恢复仍随共享状态更新。
实现与回归见 `homeProjectMachineIdentity.ts`、`HomeSurface.tsx` 与 `homeProjectMachineIdentity.test.ts`。

Mobile 返回任务或恢复网络时，历史视图只恢复展示，由页面既有同步协调器发起快照，
不再由视图激活另读一页。已有缓存且订阅尚未确认时，最多等待 2 秒合并本次列表／详情
订阅确认；以当前 ACK 表为准，不复用前一次聚焦／连接已完成的 Promise。等待期间只
每 50 毫秒检查本地 ACK 状态，不发送网络请求；确认、明确失败或预算到期即继续，
首次无缓存立即读取。这个预算只限制等待订阅的时间，
不缩短业务请求超时，也不取消原订阅重试。读取开始之后才确认的订阅仍需补齐空档；
读取期间的内容变化仍由历史控制器合并补读，失败保留画面、不推进同步成功标记。
只影响当前手机页面，不重启共享 relay、不改变其它 peer。Desktop 保持原激活读取行为。
实现与回归见 `remoteSyncTask.ts`、`remoteHistoryViews.ts`、`remoteSyncTask.test.ts`、
`remoteHistoryReentry.test.ts` 与共享 `historyView.test.ts`。

Mobile 明确观察到断网后恢复，或已连接网络类型切换（如蜂窝 → Wi-Fi）时，
替换本机仍显示 online 的旧连接，避免旧路径上的半开连接额外等待探测超时。
相同类型的能力通知、仅 Internet reachability 变化和未知网络仍走原探测预算；
不打断在途握手、不绕过拥塞退避。后台只记录路径变化，回前台再处理；
期间若新连接已完成握手，则不重复替换。此动作只影响该手机的 relay 连接，
不由单 peer 超时触发，也不重启被控端与其它控制端的共享连接。
实现与回归见 Mobile `DeviceLinkContext.tsx`、`historyViewProvider.test.tsx`。

无响应设备的列表、PR 状态和模型目录后台读取应让位给连接层探测。目录失效在暂不可读时
保留待刷新意图，复用已有调度退避，只检查可读性、不发送请求；取消和销毁仍清除待办。
前台、重连和单设备恢复通过同一入口唤醒尚未完成的目录读取，不等待旧退避到期，
也不使已完成缓存再次失效；唤醒与旧轮结算交错时仍由已有调度器合并。
Desktop 周期列表按设备合并在途读取和退避，健康设备不等待其它设备的慢请求；
能力预取仅在列表恢复成功后逐项进行。共享恢复调度沿用已有通知唤醒语义，真实恢复
不能被旧退避计时器挡住。
Mobile 重连先恢复已订阅任务的快照，再请求首页列表；某一步传输失败即退出该设备
本轮恢复，交回按设备退避，不能继续扇出剩余读取或重置其它设备的连接。

Mobile 首页被任务页、设置页等盖住时仍持有可见设备的 `sessions` 订阅，增量补丁照常进镜像；
回到首页不再整份重拉所有电脑，只补拉可能漏过推送的设备：离开期间收到 reseed
（新建任务、未知任务补丁，以及 peer reset／重连／回前台后 device-link 恢复回放发出的重拉）、
拉取失败或离线、离开时已不在同步范围；列表被分页上限截断的设备离开期间收到任何列表推送也重拉（截断窗口的成员变化本地补不全）。离开期间 App 退过后台、relay 重连过、离开超过
10 分钟或尚未完成首轮同步时，仍走整轮设备清单 + 列表重拉，且这次整轮成功提交前一直保持整轮（失败不降级为只补拉）；不可见设备照旧 release 退订。
判据见 Mobile `homeListFreshness.ts`，不新增 wire 字段或持久化状态。
自动化角标（scheduleIndex）同理：自动化事件随 `sessions` 订阅到达，首页被盖住时只记下收到事件的
设备，因失焦被跳过或结果被丢弃的刷新同样留待补刷（成功应用后才清除），回首页只刷新这些设备，整轮返回时才全量刷新。任务页打开普通任务时，若该设备当前索引表明
它未绑定任何自动化，就跳过标记已读的索引读取；运行事件会把新绑定的任务补进记录，自动化定义变化、
重连或离线后记录失效、照常读取（`scheduleIndex.ts` 的 `sessionMayHaveScheduleRuns`）。

远程桌面的输入不是可持久重放的工作：本地未发送输入等待达到两秒时丢弃并退出
控制，复用控制释放路径；重新取得控制时清除旧批次等待，以递增序号隔离迟到 ACK。
Mobile 父层同时退役旧输入批次；旧 native 发送的迟到失败不得回落 relay，旧请求的
错误或收尾不得释放新控制、清除新批次等待或向新控制周期发送 ACK。
已拥塞的数据通道不应被 relay 输入旁路超车。视频发送端
允许 WebRTC 同时调整分辨率与帧率，保留原有帧率／显式码率上限。以上策略不新增
wire 字段，也不自动重试已发送但结果不明的写操作。

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

控制端单独重连可能仍使用原可靠流，被控端因自身 relay 未重连而将建链判为重复 open。
新版确认 ACK 若匹配本次 accept，且明确停在已发送队头的前一序号，可额外补发这个队头；
该队头被累计 ACK 确认后，才能继续补发下一队头，边界固定为本次 accept 时连续已发送的
积压前缀。重复 open 不延长已启动的补发范围，新入队或当时未发出的消息不纳入。
每个序号最多补发一次；新一轮补发仍受原重试基础间隔限制，轮内仅由真实 ACK 前进驱动，
且受原恢复帧预算、socket 背压和聚合公平预算约束。慢速在途消息也可能得到一次副本，
因此不能对每次 open 重放整队。普通 ACK 不能启动补发；旧端无确认能力、已确认数据、
过大的队头及本地背压仍沿用原重试策略，断链和换流取消本轮补发。
此修复只作用于该 peer，不重启共享 relay、不缩短业务超时，也不改变 wire 格式；
多控制端故障隔离用例见 `packages/device-link/src/__tests__/client.test.ts`。

可靠请求已确认接收后，若异步结果在控制端断线期间才完成，回包必须保留在该 peer
原有的有界可靠队列中。链路未就绪时的裸帧直发仍用于避免等待建链的死锁，但直发成功
不等于对端已收到，不能据此删除可靠副本；重连补发同 requestId 的结果，不重新执行
原操作。副本沿用容量、过期、撤权清理与恢复预算，不缩短业务超时或重启共享 relay。
队列被不可丢弃的在途帧占满时，保留失败仍须尝试原有裸帧直发，不扩容或驱逐在途帧。
若结果可可靠分片、但超过裸帧上限，仍返回原 `BACKPRESSURE` 供上层 outbox 重试，
不能误报 `PAYLOAD_TOO_LARGE` 并将原结果压缩或替换成错误。
实现见 `packages/device-link/src/client.ts` 的 `sendInvokeResult`，多控制端回归见同包
`src/__tests__/client.test.ts`。

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
列表已有 conversation link 时，可直接展示聊天框架和同账号缓存，在聊天页内重读资源，
复用该页的 Session 元数据查询校验 ID、类型与设备归属；校验完成前不允许远端投递、控制和已读。
列表返回与后台刷新应保留已有内容，仅首次无数据时显示整页加载，不用固定延迟掩盖切换。

手机伙伴列表的同步新鲜度不决定已缓存伙伴能否打开：连接圆点只消费实际连接与 presence，
列表失败保留之前成功的同连接代次证据，各电脑的成功分片立即更新。暂时读取失败复用既有
错误分类、读取重试与恢复退避；只在前台可见时补读，离开、后台、账号变更与永久错误不续读。
缓存仅供同账号展示，撤权设备仍过滤；无 conversation link 时仍由原资源路由解析，不猜身份。

已有 canonical link 的伙伴在断网时可读本机已缓存历史、编辑持久草稿；未缓存历史明确提示
连接电脑后同步。用户点发送才写入现有 durable outbox，纯草稿不自动发送。新伙伴待发送记录
额外保存资源身份，应用级队列在首次远端 enqueue 前重读资源、准备状态、canonical link 与
Session 类型，不能借页面关闭绕过校验。队列仍按原 clientId 对账和去重：接收不等于送达，
旧主机结果未知时不盲重放，已获宿主持久接收的记录只对账。恢复范围是单 host/read/outbox，
不拆共享 relay，不增加云端执行或 wire 协议；现有历史、草稿和 outbox 的账号清理规则不变。

协议按字段追加演进。未知字段、未知 collection 和未知 action 不得导致整个首页或会话崩溃；
结构化 Session 内容必须携带可读 `fallbackMarkdown`，旧客户端至少能阅读并继续任务。只有新增
移动端此前无法表达的内容或交互原语时，才要求客户端发版。

任务内状态卡使用 collection placement `session:<source>`，资源 id 为任务 id。
Mobile 根据 manifest 发现卡片，不写死具体业务状态；`session-controls` 原语仅声明
输入是否可用与是否忙碌，详情保留可读 fallback，动作 id 为不透明标识。
动作的 disabled 是呈现提示，主机仍须按最新状态、账号与任务身份复核。重连只重读，
不得重放写操作；旧客户端不识别此 placement 时继续原有消息流程。

Desktop 的同账号远程 Cindy Make 任务同样消费该投影：准备与测试交接卡接管输入区，
继续修改后的恢复动作放在输入区顶部，实时状态与动作均来自任务所属电脑。控制端沿用
既有 sessions topic，不新增业务 IPC 或本地构建回退；离线、切账号和切任务后禁用旧卡片
动作，重连与操作超时后只重读状态。旧主机不提供该 placement 时保留只读历史卡片。
实现与回归见 Desktop Renderer 的 `features/device-link/useSessionResourceCards.ts`、
`SessionResourceCards.tsx` 及同目录测试；SSH 工作区不由此获得 Make 执行能力。

## 桌面远程控制的伙伴设置（`management:settings`，2026-10-22）

产品规则见 [`../product-rules/cindy-bots-runtime.md`](../product-rules/cindy-bots-runtime.md)「伙伴设置」。落点：

- **走 Remote Resource，不新增通道**：`teammates` 集合声明集合动作 `management:settings`，`input.op` 选固定操作，结果放在
  `RemoteActionInvokeResponse.result`（`{ ok, value | code, message }`）。`allowlist.ts` 不变；伙伴 `settings-*` 等原始 IPC 仍不放行。
- **主机沿用本机服务**：每个操作调用本机 IPC 同一份服务，凭证、本机路径、运行时快照不进结果；写入口白名单（`BOT_SETTINGS_PATCH_FIELDS`），
  拒绝 `permissions`；消息平台操作只触达该伙伴自己的连接，没有接收凭证的操作。
- **控制端兼容**：用集合动作 + `caps` 探测，主机不支持（旧版）整页回退到通用表单页；手机与旧桌面不变。
- **故障半径三问**：① 故障层级：单个请求（读取 / 写入某个设置）；对方离线只标记页面状态，不判定设置失败。
  ② 动作层级：仅该 peer 上该伙伴的请求，不重建 link、不断 relay、不重放写操作；写入失败沿用自动保存的回滚与重试，读取只在
  推送 / 重连 / 聚焦后 400ms 合并重读，消息平台状态每 5 秒读取一次（仅页面打开且可见）。
  ③ 多 peer：主机按请求内的控制端校验授权与撤权，一个控制端的写入不影响另一个的在途读取；回归见
  `botRemoteSettingsHost.test.ts`（授权、可见性、owner 切换后丢弃结果、冲突形状、凭证 / 路径不出主机）与
  `remoteBotSettingsTarget.test.ts`、`remoteTeammateSettings.test.tsx`。

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

远程列表复用本地查询，返回前额外执行伙伴可见性过滤。过滤按本次授权阶段批量查询，
每条 SQL 最多 200 个 ID；不跨请求缓存授权结论。缓存回复与离线重放仍重新检查，账号
变化时丢弃旧结果。控制端补齐列表外任务时优先使用 `local-db:sessions:get-many`
（最多 32 个 ID，当前每轮补读最多 8 个），保留单条 GET 的元数据、预览和计数语义。
旧被控端不支持或批量回复超帧预算时回退到原有有界 GET；超时、撤权、损坏回复不触发
成倍重试，迟到回复不能覆盖更新的 push。

Mobile 伙伴任务卡的列表外补读由 `companionTaskReads.ts` 按账号、连接代次和电脑聚合，
每批最多 8 个、批次串行；同组共享刷新时钟，旧端单条回退同样串行。焦点或账号切换后
不发送已失效的排队读取，不缓存已完成批次；卡片优先使用普通任务列表中的更新结果。

Debug 日志区分两层耗时：

- `remote invoke slow execution`（至少 300 毫秒）包含 `stagesMs`：调用前授权、业务 handler、
  调用后授权、设置持久化、返回投影。总耗时还包含调度和序列化，不等于 SQL 执行时间。
- `db-rpc` 的 `rpc.slow`（至少 250 毫秒）包含 `queueMs`（主线程待发送队列）、
  `workerWaitMs`（投递到 Worker 开始处理）、`workerExecutionMs`（整个 Worker 操作）、
  `deliveryMs`（结果传输及主线程调度）。事务操作的执行时间覆盖整个事务；结果传输时间
  也不能直接称为主线程阻塞。旧 Worker 未附计时信息时只记录可测部分。

诊断只记录本地 RPC 序号、操作类别、数量与耗时，不记录 SQL、参数、消息内容或结果。
性能复测应同时包含前台发送、另一控制端刷新与补读、本地读取；分别报告请求数量和延迟，
不能把内存数据库基准当成真机网络端到端改善。

自动 Git 保存点的发送前基线和轮末保存各有一份 **8 秒整体预算**，包括元数据、目录探测、
空项目初始化、仓库队列等待、文件过滤、暂存、标签和隐藏 ref 写入。嵌套操作共享同一单调
时钟 deadline；Git 超时或主动取消后另留最多 3 秒进程树清理预算。超时继续发送；Stop
通过发送 reservation / 输入队列 / 目标续跑的取消信号终止准备，不能迟到派发。原生文件系统
请求无法强杀，停止等待后丢弃结果，并在后续写入前检查取消；临时文件由原操作清理。

故障限于当前保存点；不能因此重建设备连接或重试发送。Git 清理无法确认时，本进程暂停该
仓库后续保存点与文件回退写入，其它仓库照常工作。回退不仅看缺口标记，还要求范围内每条
用户消息有完成证据、已记录的 shadow 基线均有对应完成点；未变化的自动轮次也写完成点，
被过滤路径发生变化时不发布完成点。旧历史缺少证据时保守降级为仅回退消息。
同一消息的每次执行在 Git 操作之前写入独立、不可覆盖的派发意图，保存点以可选的
`X-Cindy-Attempt` trailer 绑定该标识。回退逐个核对所选消息的全部意图，基线与缺口标记均
写入失败也能识别，后续成功不能抹掉中间失败。意图落盘也占用上述 8 秒预算；意图无法
写入或超时时拒绝本次派发，迟到写入只能留下保守缺口，不能重新发送。意图写成之后的
Git 故障仍按原约定继续发送。这是安全降级与无法确认派发记录两类失败的区别。

意图仅存 UUID 和消息锚点，位于当前账号的
`owners/<owner-key>/git-snapshot-attempts/<sha256(sessionId)>/<attempt-uuid>.json`，
用独占新建与 flush 写入，不依赖内存、不改用户仓库或数据库 schema。账号和目录在异步
操作前捕获，切账号后不放行发送。记录作为回退安全证据随账号数据保留，不按成功轮次
清除失败意图。读取限 8 秒、每条 4 KiB、每个任务 10000 条；损坏、读取失败或超限一律
降级为仅回退消息，不能当成空历史。旧版本忽略新增 trailer，但不具备这一逐次核对保障。
实现见 `gitSnapshotCoordinator.ts`、`utils/operationBudget.ts`、`worktree/gitExec.ts`；回归见
`gitSnapshotCoordinator.test.ts`、`gitExec.test.ts`、`gitSnapshotShadow.git-integration.test.ts`、
`codexFileRewindPlanner.test.ts` 与 maker-core `session-control.test.ts`。

远程发送的端到端耗时按同一 clientId（只记前 8 位）在三端分别记 debug 日志，各端只用本机时钟：

- 被控端 `remote enqueue timing`：enqueue handler 内 `gate`（准入与清除边界）、`restore`、
  `prepare`（附件物化与引用水合）、`recheck`、`dedupe`、`coordinator`、`snapshot` 各阶段耗时；
  `remote send pushed`：coordinator 收下到用户行 `messages:created` 推出的耗时（含 Agent 冷启动）。
- Desktop 控制端 `remote send accepted`（点击到被控端收下、最后一次派发耗时、尝试次数）与
  `remote send echoed`（点击到回显）。
- Mobile 控制端（调试记录开启时）`send accepted`：`policy` / `projection` / `prepare` / `enqueue`
  各阶段、是否跳过发送前 projection、点击到收下；`send history confirmed`：点击到落库确认。
- Desktop 控制端在 debug 级别每 30 秒输出 `transport bytes`：按 channel 统计 invoke 回包数与字节数
  （只在 debug 开启时为统计再序列化一次回包）。

这些日志不改变 wire、ACK、重试或授权语义。

远程 Agent 创建慢时，开启 `LOG_LEVEL=debug`，在 main 日志里查
`remote agent startup timing`（发起端 scope `remote-agent:startup`，运行端
`remote-agent:host`；独立于 Agent 日志的突发限流）。
Dev 默认已包含 debug，日志在启动 checkout 的 `apps/desktop/logs/`；安装版在本机
userData 的 `logs/`。按 `sessionRef`（任务 ID 前 8 位）与 `runRef`（run ID 前 8 位）
关联两端；同一任务重连会创建新的 run，控制端另标 `reconnect: true`。

- `side=controller`：`mcp-prepare`、`capability-handshake`、`connection-slot`，以及
  `project-files` / `ancestor-files` / `ancestor-markers` / `personal-config` /
  `instruction-imports` / `git-probe` / `image-epoch`，最后是 `remote-open`。
- `side=transport`：`payload-upload`（序列化、压缩与必要的分段上传）、`open-request`
  （打开请求往返）、`session-ready`（请求收下到收到 started 事件）。旧版运行端也能从
  控制端记录这些阶段；打开请求返回不代表 Agent 已经就绪。
- `side=host`：`resume-workspaces`、`guest-registration`、`shadow-workspace`、
  `tunnel-prepare`、`provider-route`、`agent-session`（原生 Agent 启动与会话建立）、
  `session-registration`。仅实际经过的阶段输出。

每阶段先输出 `status=started`，结束输出 `ok` / `failed`、`durationMs` 和 `elapsedMs`；
`stage=total` 汇总本端总耗时与 `stagesMs`。使用各端自己的单调时钟，不相减不同电脑的
墙钟；`remote-open` 包含 transport 与 host 的等待，不能把三侧耗时相加。配置收集仍为
best-effort，因此某项失败而总启动成功是合法结果。只记录固定阶段名、关联标识、结果和
耗时，不记录配置正文、路径、消息、凭证或错误正文，不改变日志上报白名单。
运行端 `stage=total` 另带 `execServer`：`shortcutEnabled`、`ancestorLevels`（收到的祖先快照层数）、
`connections`（识别到的执行环境连接数）、`answered`（本地回答数）、`forwarded`（转发消息数）。
计数仅覆盖创建至 started/失败，不含首轮消息及后续工具调用；只含布尔值和计数，无路径与 RPC 内容。
没有此字段不能推断优化已启用；`shortcutEnabled=false` 需核对虚拟工作区或更早的启动失败，
`ancestorLevels=0` 需核对快照传递，`connections=0` 需核对执行环境接线。已启用且连接存在却
`answered=0`、转发很多时，再核对查询是否属于已确认不存在的路径；不能仅凭零命中扩大短路范围。
Codex 的 `session-ready` 还包括原生会话启动时经执行环境读取项目说明与 Skill 的多轮往返，
不能直接称为模型推理耗时；同一供应商的项目任务与空任务对照可帮助区分项目初始化开销。
若带 Skill 的项目显著更慢，可在同一临时项目里用「无 Skill → 一个最小 Skill → 撤回 Skill」
对照。2026-10-26 实测为 5.3s → 37.4s → 6.0s；一个 Skill 就触发沿 36 层目录逐个检查
三种插件清单的 108 次查询，全部不存在，扫描阶段占 32.3s。原项目同类扫描占 59.4s / 73.6s。
Git 元数据查询可以成批并发，不能仅按总查询数推断耗时；应区分串行目录探测与本机处理时间。
`host/execServerShortcut.ts` 在实际运行 Agent 的电脑上减少已确认不存在的目录查询；供应商组
中转时还需核对最终运行端。控制端更新不能证明该短路已经生效，仍收到虚拟垫层的查询时应先
核对运行端版本和路径。镜像外未知路径必须保留转发，不能为省往返一律回答不存在。

2026-10-26 本机隔离对照（Windows，真实 Codex/exec-server 与生产 Controller/Host，模型回复和
插件业务为 loopback mock，不调用分享供应商）：同一 Skill 项目，只替换短路返回值，分别不加延迟与
在每次 poll/push 返回前增加 100ms。创建到 handle 返回的单次样本为：

| 模拟链路 | 关闭短路 | 开启短路 | 启动阶段本地回答 |
| --- | ---: | ---: | ---: |
| 无附加延迟 | 615ms | 399ms | 128 次 |
| poll/push 各附加 100ms | 14,649ms | 4,150ms | 128 次 |

有延迟组创建耗时下降 71.7%；启动阶段元数据转发 157 → 29，总执行环境转发 164 → 36。
这是模拟链路的样本，不是线上 SLA，也不等同于普通本地供应商的直接启动路径。
四组均验证 Skill 描述进入模型、真实命令读回 Skill 正文，以及通过真实 Cindy MCP 网关完成
`ghost_list` / `ghost_info` / `ghost_call` 并收到 mock 插件业务结果。运行端原生插件按 guest 隔离关闭，
不包含第三方插件安装、原生插件运行时或 UI 验收。`mirror.test.ts` 另验证三种真实存在的插件清单
在映射路径和原始绝对路径下仍转发，不会被判为不存在。

当前源码本机能够命中；尚未证明原分享运行端未命中的具体原因，不应把控制端加日志或本机通过
写成线上已修复。现场查询格式、方法和消息长度符合短路入口，最终运行端版本及接线路径仍待核验。
本次补齐命中统计与可重复对照；测试还修正了 mock 调用方式，并阻止测试引擎后台同步原生插件目录，
避免 Windows 遗留 Git 子进程影响收尾。

2026-10-29 补充：已有短路仍会留下插件清单的串行检查。`host/execServerStartupBatch.ts`
在启动阶段第一次遇到未短路的插件清单 `fs/getMetadata` 时，沿该目录向上最多 64 层，
为三种清单提前发送普通原生查询（最多 192 条，已知不存在的虚拟路径仍由旧短路排除）。
复用既有 poll/push 批次、路径投影和原生 sandbox，不添加协议字段、方法或能力。
只有原生 `-32004` 才能回答同连接、同参数／sandbox 的后续元数据查询；已有文件、权限错误、
未知路径及超出预算的路径继续按原查询处理。不缓存文件内容或成功元数据。
启动结束、出现写操作／启动进程时停止复用并释放等待中的原查询；连接关闭时清理。
内部查询 ID 与原生 ID 隔离，迟到的内部回复不能送给 Codex。每条连接只提前查询一次。
请求的 16 KiB 优化预算不用于回复解析，否则较大错误回复会漏消费内部 ID，并使原查询继续等待。
对端关闭及超限分片主动关连接时显式清理批处理状态，不能依赖不会触发的 `wsClose` 回调。

同日 Windows 隔离基准：真实 Codex 0.159.2、原生 exec-server、生产 Controller/Host，
同一项目 8 个合成 Skill（`.agents` 与 `.claude` 各一份），每次 poll/push 返回增加 400ms。
两侧实际均为 Windows，仅移除原始绝对路径缺失快照，模拟跨系统时不能复用该快照的分支；
不读取真实项目 Skill 或分享者数据，不请求线上模型。仅开关新增批量实现，按关／开／关／开运行：

| 样本 | 批量关闭 | 批量开启 | 回传批次（关闭 → 开启） |
| --- | ---: | ---: | ---: |
| 1 | 24,282ms | 7,469ms | 56 → 15 |
| 2 | 24,214ms | 7,434ms | 56 → 15 |
| 均值 | 24,248ms | 7,451.5ms | 56 → 15 |

启动耗时下降 **69.3%**。真实转发查询仍为 78 条，优化的是串行往返；全部提前查询的实际
处理和回传成本已计入（此前直接复用已知缺失结果的 6.2s 只是因果实验，不是实现后的数字）。
启动本地回答 100 → 142；`forwarded` 包括提前查询，`answered` 包括复用结果，两者相加不再
代表原生 Agent 发起的原始请求总数。完整基准命令：
`pnpm --dir apps/desktop exec vitest run src/main/remote-agent/__tests__/startupProbe.e2e.test.ts -t 'batches eight-Skill' --maxWorkers=1`。
实测测试体 67.02s、含模块加载 107.45s；默认 unit 不运行此手动 e2e。
这证明受控慢链路的因果收益，不承诺现场 95s 变成 7.5s；真实 Windows/macOS 跨设备及原分享供应商仍未验收。
优化需实际运行 Agent 的电脑更新，任务所在电脑和中转可保持旧版。

复跑：`pnpm --dir apps/desktop exec vitest run src/main/remote-agent/__tests__/startupProbe.e2e.test.ts --maxWorkers=1`。
该文件登记在手动 e2e tier，真实进程与延迟不进入默认 unit。单文件两组对照实测 56.11s（含加载）；
最终四组测试体 31.14s，与 roundtrip 合跑共 71.68s。其余相关定向回归 77 通过、1 跳过。

实现：`remote-agent/startupTiming.ts`、`controller/startRemote.ts`、
`controller/runClient.ts` 与 `host/runHost.ts`；回归：`__tests__/roundtrip.test.ts`
以及 `__tests__/startupProbe.e2e.test.ts`、`__tests__/mirror.test.ts`
（上述路径均相对 Desktop main 的 `remote-agent/`，首项相对 Desktop main）。

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

## 桌面远程文件获取的进度

- 直传进度来自接收端每次成功写入的字节数，经 `device-link/fileAccess.ts` 的
  `onProgress` 交给调用方；工作目录内的大文件与目录外的媒体取件都必须接入。
  日志采样不是 UI 进度源，不能等整份文件返回后才上报 100%。
- 聊天打开／定位／复制、下载到本地和侧栏大文件预览，共用
  `file-browser/transfer-progress.ts` 推送到发起窗口。用本机 IPC 的 `requestId`
  关联消费者，不按路径判断归属；它不进入跨设备协议，旧调用可省略。
- 提示、文本预览与侧栏预览共用 `renderer/lib/fileTransferProgress.ts` 的订阅或采样。
  订阅先于请求，完成、失败、卸载时释放；同一路径跨设备、并发获取与下载互不影响。
  阶段切换、回退重置和完成不被限频丢弃；字节回退重置速度，总量未知不显示百分比。
- 文件夹下载仍使用既有打包／发送／下载／解包进度。SSH 使用分片字节或 tar 流字节；
  不将播放中的 Range 缓冲当作整文件下载，也不为媒体协议后台预取弹出下载 Toast。
- 目录外媒体回退旧 `media:fetch` 上传接口时，该接口没有上传字节回调；准备期间不编造
  上传百分比，开始本机下载后再显示真实进度。手机版有独立接收与播放器缓冲链路，
  不消费桌面本机 IPC；相关界面进度由 [PR #5542](https://github.com/makecindy/cindy/pull/5542)
  跟进，桌面修复不代表手机已覆盖。

回归入口：`device-link/__tests__/filePeer.test.ts`（分块、观察者异常、取消与账号失效）、
`device-link/__tests__/fileAccess.test.ts`（两类入口及回退）、
`file-browser/__tests__/chatFile.test.ts`、`file-browser/__tests__/transferProgress.test.ts`，
以及 `renderer/__tests__/remoteFileProgress.test.ts`
（并发隔离、释放、百分比和速度）。源码路径均相对 `apps/desktop/src/main/`，
最后一项相对 `apps/desktop/src/`。

## Review 清单

1. 涉及 workdir／agent／会话数据的功能，在 SSH 远程下是否走远程通道而非本机 `fs`？
2. 新 IPC／推送是否按 allowlist 判据登记 invoke／push 白名单并同步 topic 路由？
3. 手机版入口／UI 是否已适配或明确跟踪？
4. PR Description 是否给出了三选一结论，而不是留空或只写「不涉及」？
5. 触及重试／超时／断链恢复路径的改动：恢复动作是否与故障同半径？扩大半径是否给出
   明确理由？是否有多 peer 拓扑用例证明其它 peer 零感知？
