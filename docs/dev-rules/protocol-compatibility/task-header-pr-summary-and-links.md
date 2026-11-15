# 任务顶栏 PR 汇总与关联管理

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`git-context:pr-status` 的成功结果可选追加 `checks`，包含当前 head 的检查总数、失败、
通过、进行中与跳过／中立数；缺字段或 null 表示不可用，旧客户端忽略。沿用 60 秒缓存、
在途合并和前台 90 秒刷新；客户端请求过期数据时等待本次刷新，不额外增加轮询。
每个 PR 仍只调用一次 REST 与一次 GraphQL。评论只读取原有前 100 条的解决状态，
存在下一页时将未解决数标为不可用，不为数量汇总额外翻页。

新增同账号 `git-context:pr-refs:manage` 接收任务 id 与 list/add/remove/restore/pin/unpin/reorder，
只管理任务关联，不修改 GitHub。`reorder` 的 ids 必须覆盖同一固定组的全部 active 行，
不得重复、跨任务或包含已移除行；重写 priority 与 manuallyAdded，不改 schema。该管理通道
尚未发布，以 reorder 替代 prioritize；两端随本分支一起更新，旧已发布主机仍走不支持分支。新增链接经宿主 GitHub PR API 验证后保存；共享任务访客
不在此通道的授权范围。旧主机拒绝新通道时明确显示不支持，既有 PR 查看与跳转照常工作。
SSH 任务继续在保存任务的 Desktop 管理关联；无需工作目录文件访问或服务端改动。
只读 review 任务可查看关联列表并打开 PR，不提供管理写操作。
Mobile 继续消费既有引用与状态，暂不新增管理界面。
官方与自建中转均沿用通用 invoke 转发，新增通道只在客户端宿主 allowlist 判定，
不改变签名、帧格式或连接恢复，无需更新中转内核。已运行共享客户端测试
`pnpm --filter @cindy/device-link test`、自建中转测试
`pnpm --filter @cindy/device-link-relay test`，以及真实互通验证
`pnpm --filter @cindy/device-link-relay run interop`。

`session_pr_refs` 增量保存固定、优先顺序、手动添加与移除标记；自动提取不会清除用户的
移除决定，恢复需显式操作。已有行按原先最近提及排序，固定最多三条。
手动操作成功后主动使该任务的远程引用缓存失效；其他控制端沿用前台 90 秒刷新，不新增 push topic、连接恢复或请求重放。降级旧客户端会忽略
新增管理字段，因此旧客户端可能重新显示已移除的引用；记录保留，重新升级后恢复选择。
验证入口：`sessionPrManagement.test.ts`、`gitContextPrStatusService.test.ts`、`GitContextBadge.test.tsx`。
