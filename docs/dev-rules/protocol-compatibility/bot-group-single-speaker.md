# 服务器伙伴群一次一位伙伴（`groupSingleSpeaker`，2026-10-21）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

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
手机经电脑默认仍为本人范围；新版显式范围能力见[「手机群内执行与停止范围」](bot-group-mobile-execution-and-stop-scope.md)。发布顺序：服务端整集群先上，再发客户端。

2026-10-23 回复模式恢复（客户端 #6888 / cindy-server #1030）：`groupSingleSpeaker` 只表示回答顺序，
不代表每条普通消息必有回答；主群、线程与过期 `deferExecution` 恢复共用 `responseMode` 判断，显式继续不受影响。
仍保留定向回复规则：宿主把引用回复伙伴或伙伴根消息下话题回复的原作者加入 `mentions`，即使没有手打 @，
服务端也按非空 `mentions` 处理；人类根消息下的普通话题回复不隐式点名伙伴。服务端不从正文猜接收人。
不新增字段、能力版本或迁移；先部署服务端整集群以恢复已存模式，再发布客户端入口与补充消息修复。
受影响的旧服务端仍忽略 `mentioned`，旧 Desktop 也可能把闲聊作为队列补充发送；能力位本身不能证明修复已部署，
仅客户端或仅服务端合并均不代表完整生产修复上线，发布后须复验普通消息、定向回复与运行中队列补充。
