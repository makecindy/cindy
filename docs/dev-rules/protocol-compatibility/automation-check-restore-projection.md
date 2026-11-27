# 自动化检查恢复投影

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

运行状态和已读回执保留历史事实。当前警告只保留未被**同一自动化**更新成功运行恢复的失败；
另一自动化成功不能清除它。任务列表红点与任务内警告共用此恢复判定；已恢复的失败即使
历史记录仍未读，也不再贡献任务列表红点或完成未读点。新的失败与真实任务终止错误仍须
正常标红。检查受阻与实际执行失败分别显示；原有运行历史页面及其已读状态保持不变。
轻量侧栏协议新增可选 `failureKind` / `failureRecovered`，旧端忽略，新端缺省按普通失败处理。

任务页另按对话进展决定是否展示自动续跑失败横幅。轻量索引在失败行携带可选的
`finishedAt`（Unix 毫秒）。同一任务的 `userSendAt` 严格晚于该次失败结束时，
桌面和手机收起这条横幅。旧宿主缺少结束时间时继续展示，旧控制端忽略该字段。
列表红点、运行结果和已读回执继续沿用上述调度规则。

前置检查仍遵守 exit 0 放行、exit 2 跳过、其他值阻止执行。脚本可在 stdout 单独输出一行
`CINDY_PRECHECK_OK`，表示检查完整完成（包括正常无事可做的跳过）。只有 exit 0/2 且输出未
截断时记录可选 `checkSucceeded: true`；错误、超时、取消和退避跳过不构成恢复。
该标记只恢复此前的检查故障，不恢复 Agent 执行失败；旧脚本不输出、旧客户端不识别均不影响
原有退出码语义。实现见 `scheduler-host/pre-run-hook.ts` 与 `scheduler-host/storage.ts`。
macOS/Linux 上命令先经 `sh -n` 语法预检：shell 语法错误的退出码同为 2，不预检会被误记为
跳过而让任务悄悄停摆。保存时直接拒绝（INVALID_PARAMS），已保存的旧命令在运行时按失败记录并提醒。

PR 检查受阻时可以在 stdout 单独输出 `CINDY_PR_CHECK_DIAGNOSIS ` 后接一行 JSON。
`kind` 取 `dns`、`timeout`、`auth`、`rate-limit` 或 `unknown`，DNS 诊断附带
`host`。脚本提供连续失败次数 `failures` 和退避结束时间 `retryAt`（Unix 毫秒）。
执行端仅在脚本失败且 stdout 完整时读取，为有效数据补上本机名称，然后将
`prCheckDiagnosis` 随运行记录和轻量索引传递。缺失或无效的诊断沿用原有提示，
退出码、恢复条件与调度频率沿用原有约定。stderr 首行仍供旧版执行端提取摘要。

可自动重试的瞬时前置检查故障（`prCheckDiagnosis.kind` 为 `rate-limit` / `timeout` / `dns`，
或无结构化诊断且无插件缺失时的通用限流 `stderr`）在首次发生后的 24 小时内静默处理：
`preRunHookResult` 记录可选 `transientQuiet: true`，运行仍落 `status: 'failed'` 但生而已读
（`readAt = finishedAt`），不推进绑定任务的活动时间／`updatedAt`、不发外发通知、
不将已归档目标留在活跃列表，并广播带可选 `silenced: true` 的 `failed` 事件。
任务内失败横幅不依赖已读回执，因此打开任务仍可看到未恢复的提示，并在后续 `CINDY_PRECHECK_OK`
或成功运行后自动消失；旧控制端忽略未知字段，凭 `readAt` 同样不亮未读红点、不拉入收件箱「待处理」。
同一自动化若连续超过 24 小时仍未恢复（或距上次升级提醒又满 24 小时），下一次瞬时失败会升级为
正常未读失败并补发兜底提醒；`hasUnrecoveredMatchingFailure` 既排除 `transientQuiet` 记录、
也将瞬时前置检查失败的去重窗口限定在 24 小时内，避免首次静默记录或上一次升级记录吞掉到期后的
兜底外发通知。prompt 与 script 两种执行模式均遵守 `quietFailure` 静默判定。`auth`、
`missingPlugin`、`unknown` 与执行期失败仍立即提醒。
