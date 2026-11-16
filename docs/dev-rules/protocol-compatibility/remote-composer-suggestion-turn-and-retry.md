# 远程输入推荐的完成轮次与重试

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:predict-prompt` 保留既有请求字段与 45 秒隧道超时，响应新增可选
`retryable?: boolean`：`{ prompt: null, retryable: true }` 表示 B 尚未完成终末交付或落盘，
不是本轮没有推荐。旧控制端忽略额外字段；新控制端收到旧 B 的 `{ prompt: null }` 仍视为终态，
不会猜测原因或重放付费生成。旧端缺少的终末可重试能力需升级 B 才生效。

Desktop 控制端只使用 B 推送的 `lastTurnEndedAt` 作为远程 `completionRevision`，不与 A 本地
记录的 `agentStatus.startedAt` 比较；完成通知可早于运行通知，但只有实际观察到运行后才允许新预测。
轮次资格、暂存结果与用户消费在任务级 store 内管理，输入框的迟到忙碌投影只隐藏推荐。
B 在生成前、复用缓存前和回包前复核本机开始/结束轮次、账号、停止与取消状态；同账号同轮次
的并发与超时重试复用同一 Promise/缓存，切账号或新轮次不会收到旧结果。

仅 `DEVICE_LINK_TIMEOUT`、`DEVICE_LINK_BUSY` 和显式 `retryable: true` 触发恢复，沿原路由携带
原轮次在 1、2、4 秒后最多重试三次。关闭开关、换账号、轮次失效或显式消费后停止重试。
终态空结果、撤权和其它错误不重试。没有新 channel、allowlist、数据库 schema、relay envelope
或服务端改动；自建中转透传新增响应字段，Mobile 沿用既有 `prompt` 字段且不启用这次 Desktop 重试。
自建中转互通回归见 `packages/device-link-relay/src/__tests__/relay.test.ts` 的回包透传用例。
恢复半径与隔离证据见 [`remote-and-mobile-adaptation.md`](../remote-and-mobile-adaptation.md)
「输入推荐的请求级恢复」。
