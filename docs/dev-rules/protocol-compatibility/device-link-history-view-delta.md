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
（基页不符、缺条目、后缀形态不一致）时，同一次调用内改为不带 `base` 重读一次整页，不向调用方
报错（重读仍不合规才按普通读取失败处理）；结果因超限被压缩改写时被控端去掉 `token`，控制端不把它当作以后的基页。带 `base` 时控制端
不再带 `messageBodies` 选项（其中的已知正文列表最多 256 个摘要；未变条目本来就不下发），无 `base` 的读取仍照旧携带。
被控端按控制端与任务只保留最近 4 个页面的条目指纹（不同读取选项共用，最多 128 组），不保存页面本身；
控制端缓存也不按 `workLines` 区分，预读（被控端尚未加工作行）可作打开视图的基页；
控制端缓存最多 16 页、约 8 MB，只在内存，随客户端停止清空，任务清空、删除或归档时作废。

后缀只出现在被控端读取器加后缀的那些摘要上（叶子工作项的摘要与预览、消息项的延后范围，含父项
`children` 内的同类），父项摘要与消息行不改写。

旧被控端忽略该选项并返回普通页面；旧控制端从不携带，被控端不会返回 `same`。共享任务访客与
供应商分享两端都不启用。relay 不解析隧道 payload，自建中转无需改动（互通验证见
`pnpm --filter @cindy/device-link-relay run interop`）；无数据库 migration、权限或 Mobile 原生指纹变化。
实现见 `packages/device-link/src/historyViewDelta.ts`、`apps/desktop/src/main/device-link/historyViewDelta.ts`，
回归见 `client.test.ts`「历史页增量」与 Desktop `historyWorkPatch.test.ts`「history view delta」。
