# 远程链路流量治理：交互优先名额与 Subagent 变更推送

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

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
