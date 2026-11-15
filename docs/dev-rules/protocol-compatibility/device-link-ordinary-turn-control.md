# Device Link 普通会话按回合停止

控制端在既有 `maker:list-active` 的 v2 摘要请求中显式传
`turnControlVersion: 1`。支持的主机回显版本，并可能为正在运行的会话提供
`turnControlToken`。令牌绑定主机进程内的原运行时、回合代次和已认证的控制设备，
运行时替换、开始下一轮、清空会话、停止获准或主机重启都会使旧令牌失效。

`maker:input:stop-turn(sessionId, turnControlToken)` 只供同账号已授权的控制端
调用。主机在数据库读取完成后重新校验控制端授权、账号、普通本机执行归属及当前
运行时，并在进入原生停止前消费令牌。停止保留队列，有待处理条目时暂停队列。回执包含 sessionId 和 accepted，
accepted 表示主机接纳请求。活动快照仍负责报告实际运行状态。
新停止通道复用原停止通道的交互优先级，包括控制端调度、主机接纳及回执容量。
普通停止入口继续服务旧控制端。新控制端仅在主机确认版本且当前回合提供令牌时启用按回合停止，对旧主机保留原有的状态观察。
同一运行实例、同一代次的原生取消终态可输出 `turnControlOutcome: "interrupted"`。
Claude Code 使用 `done.terminal_reason = "aborted_streaming"`，Codex 使用原生
`done.raw.status = "interrupted"`，Pi 使用 `pi/agent_settled` 的 `status = "cancelled"`。
主机需要先接纳该轮停止，并确认该轮已结束。
结果随当前运行实例保留，重连读取同一实例时仍可获得。主机重启或实例回收后继续通过既有活动与持久化状态判断。
停止结果只扩充原活动摘要字段，沿用原推送、读快照与按 peer 恢复路径。

本改动只增加 invoke 内部 channel、可选参数和可选响应字段。官方与自建中转使用
既有 invoke/response 路由，无需增加顶层帧类型。用 `remoteTurnControl.test.ts` 验证
令牌作用域、终态关联及旧端兼容；用 `pnpm --filter @cindy/device-link-relay run interop`
验证签名请求、重连后读取终态及旧令牌拒绝。

可先升级主机，也可先升级控制端。新控制端仅在主机确认版本后启用精确停止；中转无需升级。
