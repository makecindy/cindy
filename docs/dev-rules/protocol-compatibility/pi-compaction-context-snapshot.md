# Pi 压缩后的实时上下文快照（2026-11-12）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)。

既有 Pi `status` 事件的 data 可选增加 `contextSnapshotAuthoritative: true`，只在当前轮
成功压缩且 `estimatedTokensAfter` 为有限非负数时随运行状态发送。它允许 Desktop 将
有效的零值应用到圆环；缺少标记的普通启动／生成状态仍保留最后已知用量，避免把尚未
取得请求用量的零值误当清空。终态快照和正数状态保持原有处理。

旧查看端忽略该字段，非零压缩结果仍通过原有状态更新，零值沿用旧端行为；新查看端连接
旧执行端时不推断此标记。`compact_boundary` 与实际运行窗口保持原合同，复用既有持久化
与广播路径；旧代次／实例和后台状态不能覆盖当前任务。边界本身不触发写入，避免其重放
覆盖新值；宿主只在带标记的当前前台运行状态中读取随事件携带的快照并写入，不能依赖
远程代理缓存已收到下一条 state。

不新增 RPC、channel、能力协商、帧种类、数据库字段或 migration。`sessionEventDelivery`
转发完整事件，`device-link/dispatch` 的逐帧／微批路径保持载荷，`mobileToolProjection`
仅处理工具事件。官方与自建中转透传原有加密 push，不解释 status data，因此无需中转
适配或协调发布。没有重连、重试或连接恢复行为变化，故障范围限于本任务的用量显示。

回归入口：Pi translator、Desktop 的 sessionEventPipeline、sessionSpendBroadcaster 与
makerChatStoreTextDeltaBatching 测试。后者通过真实 translator 和事件订阅验证有效零值、
连续未知零值与继续工具执行；既有 dispatchMakerEventBatch 测试核对旧端逐帧和新版批量
转发的载荷完整性。Mobile 未增加消费者或原生配置，无冷更要求。
