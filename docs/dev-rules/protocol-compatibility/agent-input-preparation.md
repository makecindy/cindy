# 输入准备状态的兼容合同

现有 `maker:input:get-projection` 响应及输入队列投影推送增加可选字段
`sendPreparationPending`。只有协调器持有实际输入且尚未完成派发时为真，
包括首次欢迎的权限同步恢复等待；它不表示模型正在生成。

Desktop 和 Mobile 使用该字段显示准备提示并复用现有停止入口。
新界面连接旧宿主时，字段缺失视为 false，保持旧行为；旧界面连接新宿主时
忽略此可选字段。停止、失败、完成及任务关闭后不得残留准备提示。

停止仍走现有 `maker:input:stop`，不新增 channel，不改变权限检查或重试预算。
SSH 与 device-link 继续传递现有投影，无需 relay 修改、额外订阅、轮询或持久化。
Mobile 变更仅涉及 JS/TS，不要求冷更新。

实现：Desktop `agent-input-coordinator.ts`、`makerChatStore.ts`、`useCCAgentChat.ts`；
Mobile `inputProjection.ts`、`remoteSessionStore.ts` 与任务页。
回归：`agent-input-coordinator.test.ts`、`hostChatRecovery.test.ts`、Mobile
`inputProjection.test.ts` 和 `remoteSessionStore.test.ts`。
