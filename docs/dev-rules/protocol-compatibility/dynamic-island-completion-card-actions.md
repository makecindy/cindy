# 灵动岛完成卡操作

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

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
