# 远程任务的后台任务状态与停止

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Desktop 控制端在远程任务的输入框状态栏显示后台任务提示：进入任务、前台 turn 结束、设备重连或
窗口重新可见时，读取已登记的只读 `maker:session-background-activity` 与
`maker:session-background-tasks:list`（两者登记为后台 invoke，让位于用户操作），之后在「在线 + 可见 +
无前台 turn」期间每 15 秒复查；
不依赖镜像事件，断连或停读时清空提示。读取失败（含旧被控端）按无后台任务处理。

同账号 invoke allowlist 新增写通道 `maker:agent-task:stop`（单个后台任务）与
`maker:session-background-tasks:stop`（全部停止，关闭被控端会话进程），入参与本机 IPC 相同。
Workflow 行级单停使用独立的 `maker:workflow-agent:stop`，入参为
`(sessionId, workflowTaskId, agentId)`：运行层先核对 Agent 属于该 Workflow 且仍在运行，再调用
Claude Code 原生 `stopTask(agentId)`；主模型经原生 task-notification 看到 `was stopped by user`，
宿主不额外启动模型轮次。停止成功后 Cindy 将该行投影为 `stopped`，并按 `agentId + attempt`
防止迟到 error/progress 帧覆盖；新 attempt 不继承旧停止状态。

单停的本机 IPC 校验 Cindy 自有顶层窗口，远程调用沿用 device-link 已鉴权的入口。
该通道与原单任务停止使用相同的交互优先级，不加入共享任务访客白名单，不进入自动重试。
任务卡、后台任务面板与状态栏
的停止按归属粘滞路由到被控端，不回退本机。旧被控端回 `CHANNEL_NOT_ALLOWED` 时提示升级远程电脑；
旧控制端行为不变。单停通道不得回退到 `maker:agent-task:stop`，否则旧 handler 会忽略 agentId 并
误停整个 Workflow。Mobile 未接入，服务端与自建中转只透传既有 invoke，无需改动。实现见
`makerTransport.ts`、`stopWorkflowAgentHandler.ts`、`TaskStopButton.tsx` 与
`useRemoteSessionBackgroundTasks.ts`。

若 Claude Code 由另一台电脑托管，控制端通过 `maker:remote-agent:v1` 已协商的
`stopWorkflowAgent(workflowTaskId, agentId)` 方法转发，继续使用交互优先级。
旧执行端未声明该方法时返回不支持，保留整组停止能力。该方法扩展可独立部署，
由现有中转透明传输。
