# 空响应续跑暂停的诊断原因

`maker-ipc/silentStopTurnEnd.ts` 在预算、频控、任务保护及派发失败时，向
`silentStopFailure.ts` 传递实际停止原因。持久错误消息和现有 error 事件共用同一份内容：

- `reason: "silent-stop-exhausted"`、`isTerminal: true` 保持不变。
- 可选增量字段 `silentStopFailureCause` 为 `budget`、`rate-limit`、`session-breaker`、
  `dispatch-not-accepted` 或 `dispatch-error`，只表示宿主停止自动续跑的原因。
- `message` 保留中性说明及有界原因，供错误详情和诊断使用；不携带新的用户内容、供应商
  原始响应或异常堆栈，不据此推断上游为什么返回空响应。

Desktop / Mobile 按稳定 reason 显示本地化中性主提示，详情仍保留原始 message。
个人 IM 与官方 hook 共用 `terminalErrorText`，只外发中性主提示。

旧宿主没有 cause 时，新客户端仍能用 reason 显示中性提示；不会补猜具体原因。旧客户端
忽略新增字段，既有继续操作和终态处理不变，但旧客户端内置的提示需升级客户端才能修正。
这是已有事件 data 与消息 content 的可选增量，不新增 channel、relay kind、能力位或
数据库 migration；自建中转继续透传既有封包，无需服务端或中转升级。

回归入口：`silentStopAutoResume.test.ts`、`silentStopTurnEnd.test.ts`、Desktop
`ErrorLocalization.test.tsx`、Mobile `AgentErrorLocalization.test.tsx` 及 IM
`turnRetryNotice.test.ts`。共享 mock 的 `ui-mock-silent-stop` 覆盖历史与尾部详情。
