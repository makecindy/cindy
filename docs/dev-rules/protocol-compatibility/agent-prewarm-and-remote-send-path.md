# Agent 预热与远程发送路径

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新增 invoke `maker:session:prewarm(sessionId, createOpts)`，Desktop 本机 Renderer 与 device-link
控制端共用，登记在 `REMOTE_INVOKE_ALLOWLIST` 并归入后台调度档；共享任务访客不在其准入表内。
控制端在已有任务的输入框里开始输入（打字、粘贴、开始语音输入）时调用（同一任务 30 秒最多一次；模型、深度、权限、引擎、目录等设置变了立即再请求一次），`createOpts` 与下一次发送
构造的相同；被控端立即回 `{ accepted }`，在同一把会话发送锁里复用发送路径的懒创建启动 Agent，
执行字段（agentKind、model、resume、provider、权限、Agent 所在电脑）照常按数据库校正。只对来源为
user / desktop / plugin / side-chat、状态 active、非协同、Agent 在本机且非 SSH 工作区的任务生效（不要求已发送过：启动加载目录自带的设置与钩子与随后的发送相同，预热只是把时间提前）；
已有运行时、待切换引擎、已有排队输入时不做任何事。预热出来、尚未发送使用的运行时最多 2 个，
10 分钟未发送即关闭；设置变更关掉了它时，下一次请求会重新启动；任何真实发送会接管它。旧被控端返回 CHANNEL_NOT_ALLOWED，控制端静默忽略，
下一次发送照常冷启动；旧控制端不调用，行为不变。

同一通道带 purpose: 'pi-skill-dispatch' 时表示用户已发送项目 Skill。Desktop 和 Node Host 在任务发送锁内核验实际引擎和目录，等 Pi 可用后才返回 accepted 和 piRuntimePrepared: true。旧 Desktop 可能只返回 accepted；新版控制端不能据此发送未展开的命令，会保留草稿。Node Host 从任务记录恢复配置，不接受控制端覆盖授权，也不因普通打字请求启动进程。未实现该入口的旧 Node Host 仍可能返回 NOT_FOUND；控制端保留草稿并显示错误。此变化不需要更新中转。

显式发送 Skill 时，`pendingPiRoute` 只能应用与任务上已登记的模型和位置相符的意图。对同账号远控登记的路线，
两端沿用发送时的窗口核实与重建，拒绝控制端提供的 `confirmedContextWindow`。窗口核实失败时保留旧路线和原生记录。
`pendingPiRoute.nextInputChars` 可带别名展开前的输入长度，按非负安全整数解析，只用于为待发内容留空间；
它不能提高重放预算或证明模型窗口。字段缺失时沿用默认重放留白。
`pendingRouteApplied: true` 只在意图已应用且 Pi 准备成功后返回。

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

## 手机普通对话先建记录、首条输入再启动 Agent

Mobile 在普通、本机执行、非协同的 dialogue 创建请求中增量携带
`deferRuntimeStart: true`。Desktop 在既有创建锁、创建取消和账号边界内，复用
`createUserSession` 的模型准入与持久化，只保存新任务，不等待原生 Agent 启动。
首次入队仍由既有持久输入协调器接收，随后发送事务按数据库配置懒启动 Agent；
凭证、工作区、权限及运行期路由校验继续由该事务执行，启动失败沿用发送错误与恢复路径。
任务记录创建成功不代表消息已发送，手机仍须等入队回执。

成功结果附带可选 `session`（与 `local-db:sessions:get` 相同的任务投影），手机核对
id 与分配目录后直接采用，免一次详情往返。旧电脑忽略新提示、照常启动 Agent，
结果没有 `session` 时手机保留详情查询；旧手机不发提示，Desktop 保持原创建语义。
已有同 id 的任务、项目、协同、SSH、另一电脑执行、插件引擎和原生恢复继续走原创建路径。
不更改 `local-db:sessions:create` 的本机准入边界。

新 Desktop 的上述持久创建结果还可携带 `inputDelivery: { inputDeliveryVersion: 1,
clearBoundaryMs: number | null }`。边界来自这次创建后读回的权威任务行；该字段只表示
宿主支持持久投递，不表示首条消息已经接收。Mobile 校验版本、非负有限时间戳以及同一
任务 id / 目录后，将它和任务投影一同交接给现有首发快照：只供原发件箱记录、同一连接代次、
5 秒内且没有附件的普通对话首次投递使用。缺字段、字段无效、记录替换、重连或冷恢复均保留
原输入状态查询；不得从“新任务”自行推断空边界或新协议支持。
交接时同时把已确认边界保存到首条消息现有的 `clearBoundaryMs` 字段（已有发送边界不覆盖），
因此快照过期、回包丢失或重启后的恢复仍不能跨过电脑随后发生的清空。

符合条件时，持久发件箱复用既有 `knownProjection` 路径，省掉创建后单独的
`maker:input:get-projection` 往返；实际 enqueue 仍携带 `expectedClearBoundaryMs`，由电脑
复核任务与清空边界、去重，并等待队列持久化后才确认接收。边界过期按既有回查／拒绝规则处理，
不把已清空的旧消息自动当成新消息发送。创建回包的字段不灌入后续消息共用的能力缓存。

订阅意图仍在创建前登记，但首条提交不再等待任务列表订阅的 ACK。正常新对话管线的
必要远程步骤是建链、fresh 模型校验、持久创建、消息入队；新电脑符合上述条件的持久
首发不再单独查询任务详情及输入状态。测试的四次 200ms 往返预算只验证直接创建管线，
另有真实创建管线、发件箱存储、访问策略与投递执行器的组合回归验证查询次数及持久回执前后的
消息归属，覆盖旧端、重连、快照过期、记录替换和账号变化；均不代表全链路真机耗时。

订阅生命周期不变量：创建管线只在同步入口登记 `session:<id>`，其中已包含 `sessions`；
不得在异步建链或退避后登记属于新建页的 `new-session:<deviceId>`。订阅意图的唯一真相
仍是 `DeviceLinkTopicRegistry`，页面持有和释放自己的 owner。新建页的有界重试与会话页的
`createTransientTopicSubscriptionCoordinator` 沿用各自已有的取消／过期判据，不由创建管线复制。

| 事件 | 订阅行为 |
| --- | --- |
| 创建入口 | 同步登记任务 owner，首条入队不等 ACK |
| 新建页退出，建链／退避尚未结束 | 页面释放其 owner，创建管线不再注册或恢复它 |
| 挂载页面收到瞬态拒绝 | 由页面现有的可取消恢复流程重试 |
| 任务页退出 | 按既有清理释放任务 owner，创建管线不延迟重加 |
| 另一页面或设备仍有持有者 | registry 保留其订阅，不受当前页面退出影响 |

沿用既有 invoke、结果与 relay 帧，不新增 channel、权限、重试、缓存或后台连接。
自建中转只透明转发业务参数，无需升级；新旧客户端可任意顺序更新。无数据库 migration、
system prompt 或 Mobile 原生指纹改动。回归入口：`sessionCreateHandler.test.ts`、
`sessionsUpdate.test.ts`、`newSessionCreation.test.ts`；真实网络表现仍需设备验收。
