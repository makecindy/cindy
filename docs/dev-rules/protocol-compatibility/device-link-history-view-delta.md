# 历史页增量读取（`history-view-delta-v1`，2026-11-11）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

同账号控制端读取最新一页 `local-db:messages:view`（不带 `before`）时，共享 DeviceLinkClient
在 options 加 `historyDelta: { version: 1, base? }`；`base` 是本客户端上次从同一被控端、同一任务、
同一组读取选项解码得到的最新页标记。支持的被控端在授权与投影之后返回普通页面，并附
`historyDelta: { version: 1, token?, base?, revisionSuffix? }`：`token` 由各条目的内容指纹生成；
仍记得 `base` 时，与那一页相比内容未变的非运行条目，按基页顺序连续的一段替换为一个
`{ type: 'same', from, count }`（基页下标）。
大纲读取的工作组修订号带全页统一的数据库写入后缀，`same` 条目沿用基页后缀，由
`revisionSuffix` 换成本页后缀。DeviceLinkClient 在交给调用方之前用自己保存的基页逐条还原，
调用方拿到的仍是完整页面，与整页读取内容一致。

兜底不能省：被控端不认识 `base`（重启、淘汰）时回完整页面；控制端遇到无法证明的还原
（基页不符、缺条目、后缀形态不一致）时，同一次调用内不带 `base` 重读一次整页，这次重读给一次
完整超时，不向调用方报错（重读仍不合规才按普通读取失败处理）。重读前与首次发送一样复核调用方：
调用方已失效、链路被主动断开或对端被标为不可用时直接返回该错误、不重读；对端被误标为不可用时
这次读取失败，下一次读取恢复。它与[列表增量](invoke-result-delta.md)共用 DeviceLinkClient 里同一段
「不带基准重发一次」的逻辑，只是重发预算不同：手机任务页把最新页读取失败当作整轮同步失败（显示同步
错误并暂停待发消息），所以历史页不能只用剩余预算。结果因超限被压缩改写时被控端去掉 `token`，控制端不把它当作以后的基页。带 `base` 时控制端
不再带 `messageBodies` 选项（其中的已知正文列表最多 256 个摘要；未变条目本来就不下发），无 `base` 的读取仍照旧携带。
被控端按控制端与任务只保留最近 4 个页面的条目指纹（不同读取选项共用，最多 128 组），不保存页面本身；
本机主动关掉某个控制端（撤销、踢出、关闭远控、退出、用户停止）时立即释放它的条目指纹，与列表增量的
被控端基准在同一处（`DeviceLinkClient.closeLink` → `onInboundPeerReleased`）；传输超时与普通断线保留，重连的控制端仍可拿增量。
`RoutedDeviceLinkClient` 汇总主连接、兼容中转、跨账号与按资源连接的释放事件，按资源归属过滤，
包括订阅后才注册的连接；取消订阅时一并移除内部监听（回归：`routedClient.test.ts`）。
登出或本实例失去持有权时全部释放，包括此前普通断线、为重连保留的控制端，
与随后 `client.stop()` 清空全部列表增量基准一致；
控制端缓存也不按 `workLines` 区分，预读（被控端尚未加工作行）可作打开视图的基页；
控制端缓存最多 16 页、约 8 MB，只在内存，随客户端停止清空，任务清空、删除或归档时作废。

后缀只出现在被控端读取器加后缀的那些摘要上（叶子工作项的摘要与预览、消息项的延后范围，含父项
`children` 内的同类），父项摘要与消息行不改写。

旧被控端忽略该选项并返回普通页面；旧控制端从不携带，被控端不会返回 `same`。共享任务访客与
供应商分享两端都不启用。relay 不解析隧道 payload，自建中转无需改动（互通验证见
`pnpm --filter @cindy/device-link-relay run interop`）；无数据库 migration、权限或 Mobile 原生指纹变化。
实现见 `packages/device-link/src/historyViewDelta.ts`、`apps/desktop/src/main/device-link/historyViewDelta.ts`，
回归见 `client.test.ts`「历史页增量」与 Desktop `historyWorkPatch.test.ts`「history view delta」。
