# 从已有任务创建伙伴：单次真实模型验收

## 环境与入口

- 日期：2026-10-29；实现提交：`a5ae461f29`；Windows、Node 24.19.0。
- 用标准启动器运行 `--region=global --isolated=companion-acceptance --passive`。
  启动回执为 `DESKTOP_DEV_VERDICT=ready`；CDP 主进程 PID 与隔离实例登记一致。
- 数据归属为该隔离实例的本地模式；模型使用实例发现的现有 OpenAI 连接，未复制凭证。
  生效任务路由为 **Codex / openai / gpt-6.1-sol / low**，运行快照状态为 `applied`。
- 通过生产 IPC 写入合成普通任务，再调用 `local-db:bots:create` 与
  `local-db:bots:create-canonical-session` 建立伙伴，最后通过 `maker:send` 发起一次真实接续。
  未使用模拟模型回复，也未转换任何真实创作任务。

## 合成背景与实际输入

来源包含 30 条消息：早期候选方案、十二组氛围素材记录、最终决定和停止位置。
早期方案是第三人称、男性灯塔守卫、洪水毁城结局，原始备忘码为 `LANTERN-47`。
最终明确否定该方案，确认第一人称、女性书籍修复师 Lan、海边旧图书馆、温和悬疑。
当前目标是 800 词开篇，正文尚未写；地图提供者和观察者角色是否保留仍待定。

新伙伴名为 **Aster**。2026-10-29 18:36:17（UTC+8）实际发送：

> Answer briefly in Simplified Chinese. Introduce yourself using your companion name, then state our current goal, confirmed decisions, unresolved questions, and whether the opening has been written. Actually look up the earliest rejected proposal in the source history, report its original memo code, and cite the source session ID and message ID. Only review the state; do not draft prose, change files, or start other work.

## 实际结果

发送回执 `accepted: true`、`dispatched: true`。18:36:34 收到 `turnCompleted: true` 的最终回复。

| 验收点 | 观察结果 |
| --- | --- |
| 新身份 | 回复以「我是 Aster」开始 |
| 当前目标 | 正确说明 800 词开篇、本轮只回顾、正文尚未动笔 |
| 最终决定 | 正确保留第一人称、女性修复师 Lan、海边老图书馆和温柔悬疑 |
| 已否定／待定 | 早期第三人称、男性灯塔看守人、洪水结局明确列为已否定；两项待定没有擅自补完 |
| 原文回查 | 实际调用 `list_tools(history)`，随后 `search_chat_history(query="LANTERN", session_ids=[来源任务])`；FTS 返回最早原消息全文，最终回复给出备忘码和匹配的任务／消息 ID |
| 数据与执行边界 | 来源 30 条消息正文和角色逐条核对不变，仍为普通任务、Ask 权限；本轮工具轨迹只有历史发现与检索，没有改文件或启动其他工作 |

来源任务：`616873b1-72a9-49de-b138-0198acee8764`；新主任务：
`f7992279-3af8-4cf9-9c1f-e89b864800ad`；回查命中的原消息：`c5mikvunxpcs2akqg1rlwtmi`。

这是一个明确要求回查的合成用例，通过生产创建、发送、真实模型和历史工具链。
不代表所有模型、自动回忆、手机实机、跨电脑接管或长时间学习均已验收；UI 输入持久化不是本次直接 IPC 发送的验证对象。
验收后已正常退出隔离测试实例，PID 40332 不再存在，未停止正式 Cindy。

## 远程历史失败的基线确认

针对原基线 `5f0b5f42b46969c3ac21b0cd798a07e36b46e8fd`，临时 Vite 加载覆层直接采用
`git show <base>:<path>` 的原始测试与变更模块源码；依赖沿用本 worktree（本功能未改依赖或锁文件）。
加载回执确认了测试、reader、search、schema、historyCompanion 等原始源码。工作区文件未被替换。

仅运行 `remoteHistoryPagination.test.ts` 中的两条断言，分别覆盖 SQL 和原生向量模式：
`paginates the visible list without hidden rows consuming slots or cursors` 与
`projects parent references using current source visibility without changing local history`。
结果 **4 failed、24 skipped**，墙钟 12.22 秒；差异与当前分支完全相同：实际为 `background`
而预期为 `hidden`，以及实际保留 `parentSessionId: hidden-0`。因此这四项确认为基线已存在的失败，未放宽断言。
