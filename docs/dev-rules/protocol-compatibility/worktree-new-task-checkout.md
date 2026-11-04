# 新建任务页切换主目录分支

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`worktree:detect-cwd` 增量声明可选 `supportsCheckout: true`。未勾 worktree 的新 Desktop
仅在执行电脑声明能力后调用同账号 `worktree:checkout`；旧端省略时只读展示实际当前分支，
原有 worktree 源分支选择不变。SSH 不接入，Mobile 本次不新增入口。
新通道使用既有可信 Renderer / 同账号 invoke 身份与 `baseRepo` 路径检查，不加入共享任务访客白名单。
`status` 返回检出目录、占用分支与本机任务的只读状态；`switch / undo / restore` 在执行电脑
重新检查状态再操作 Git。每次显式写入带唯一 `operationId`，耗时操作返回 pending，
`result` 只查询同账号、同控制端、同目录的原操作，不重放 checkout 或 stash。
暂存写入具名 `refs/stash`，可经 Git 自行恢复；不依赖数据库迁移，降级也不丢暂存内容。
撤销仅允许当前仍在切换后的分支，不回滚快进获取的提交。
官方及自建中转均沿用通用 invoke 转发，不新增帧、鉴权、重连或 relay 路由，无需升级中转内核。
故障只影响本次目录操作；不重连共享链路，不重发写操作，不影响其他控制端的连接。
