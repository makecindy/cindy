# 延迟凭据切换结果（L342）

`maker:session-credential-switch-failed` 的推送继续包含 `sessionId` 和
`reason: 'apply-failed' | 'rollback-failed'`。可选布尔字段
`previousSettingsRetained` 只在宿主确认本次 Claude/Codex 延期切换失败，并逐项读回登记时的已提交模型、来源、深度、Fast 和生效来源、深度、Fast 后仍相同，才带 `true`。
Pi、回滚失败和无法确认的持久化结果不带该字段。成功推送与任务现有的待选及生效投影沿用原格式。

新版桌面和手机只在 `apply-failed` 且字面值为 `true` 时显示「本次切换未完成，任务会继续使用原来的设置。」。
缺失、`false`、其他类型和 `rollback-failed` 均沿用原失败提示。旧客户端按 `sessionId` 与 `reason` 分发，
忽略附加字段。Electron 本地事件与 Device Link 复用各自的已有任务和账号边界。

确认未提交的失败会清该任务的延期登记与待选意图，按当时已提交设置唤醒队列，再发提示。任一轴已独立提交时，后续结算保留该轴的新值。登记、快照及按轴写入标记都在宿主内存，重启后随登记清除。从已提交设置重新载入任务；临时待选不会重放。写回执不明沿原结算规则。

官方和自建中转仍透传原推送信封。无新的调用、推送通道、权限、订阅、握手或重试。
回归走桌面输入框的 Electron 和 Device Link 订阅、Host SQLite 结算和手机版的 Device Link 帧到任务提醒。
