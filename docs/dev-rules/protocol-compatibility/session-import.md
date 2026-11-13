# 任务导入 `session-import`（Remote Resource，2026-10-30）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新增隐藏集合 `session-import`（resourceKind `import`），只对声明 client primitive `session-import` 的控制端返回内容，
旧控制端拿到 `UNSUPPORTED_CAPABILITY`，电脑详情页的入口只在新版手机出现。资源 `scan` / `scan:force` 返回可导入的任务：
key、来源、标题、分组名（不含路径，分组键是不透明摘要）、时间、大小与状态位；`job:<requestId>` / `job:latest` 返回导入进度与
逐项结果。动作 `import`（`input.keys`，最多 400 个）开始导入并以 `navigate` 指向对应 job；`cancel`（`input.requestId`）停止。
文件路径、来源内部定位信息不出电脑；原文件夹不存在的任务只能在电脑上选新文件夹。桌面、手机与 Agent 同时发起时，
已在另一次导入里排队或进行中的条目不会重复导入。不改 relay 帧、服务端 schema 或 Mobile 原生配置，自建中转无需适配。
