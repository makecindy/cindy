# Cindy Bots 数据兼容与回滚契约

> 状态：Cindy Bots Draft 的兼容性正本。涉及 Bot schema、旧 IM 任务迁移、回滚或降级时必须同步更新本文件与对应回放测试。

## 四格兼容矩阵

| 数据 | 代码 | 明确行为 |
|---|---|---|
| 旧 IM 数据 | 旧代码 | 完全沿用原 Telegram、飞书及其它 IM 的任务、消息、引用、附件、群历史和 adapter 配置；没有 Bot 表，也不会看到 Bot 入口。 |
| 旧 IM 数据 | 新代码 | 0092 和 0093 只新增 Bot 表与索引，不改写旧表。用户主动迁移某个通道时，新代码只创建 Bot 投影、把当时仍 active 的旧任务归档并建立 history link；任务 source、消息、工作目录、群历史、附件和 adapter 配置原地保留。迁移失败由事务回滚，schema migration 失败由启动前备份恢复。 |
| 新 Bot 数据 | 新代码 | Bot Profile、通道、Route、主任务、历史、状态变迁消费 ledger、逻辑订阅、收件匣、自动化、委派、worktree lease 与 outbox 按各自表运行；消费 ledger 只保存统一状态模型已发布变迁的去重/审计收据，不产生任务状态。旧 IM 表仍作为 adapter 数据面存在，不被搬入 Bot 表。 |
| 新 Bot 数据 | 旧代码 | 旧代码不理解 schema 92/93。对共享数据库必须按现有 migration compatibility 守卫失败关闭，不能强行打开或降级；换回包含 schema 93 的版本即可继续。迁移前自动备份是需要回退旧安装版时的恢复点。Bot migration 本身不删除旧 IM 数据，因此恢复旧库后原 IM 路径仍可用。 |

## 迁移不变量

- 0092 增加 Bot 主体、生命周期、能力与迁移表；0093 增加统一状态变迁的 Bot 消费 ledger、逻辑订阅和收件匣。两者及后续 Bot migration 保持只增量；不得 `ALTER`、`DROP`、`UPDATE` 或 `DELETE` 旧 IM 表。
- 通道迁移必须先预检并以 `requestId` 幂等执行；同一账号同时只能有一个迁移写者。
- 旧任务只允许修改 `status`，且只在迁移仍拥有该版本时回滚；用户后来修改过的任务不被旧快照覆盖。
- rollback 只解除本次创建的 Bot 投影、恢复仍安全的旧入口与 relay binding；不删除迁移后产生的 Bot 历史，也不删除任何旧消息、群历史或附件。
- Telegram 的本地群历史继续留在 `hook_group_messages` 的 adapter namespace；飞书按每轮 API 上下文降级，不伪装成同一种持久群历史。

## 证据入口

- `botMigrationReplay.test.ts`：从已发布的 0000—0091 lineage 建真实 v91 库，冻结旧任务、消息、接管 binding 与 Telegram 群历史快照，再连续执行 0092/0093 并逐字段比对，同时验证两份 migration 均不含旧表改写。
- `botImMigrationService.test.ts`：覆盖预检、幂等 apply、状态归档、rollback、relay binding 文件恢复与崩溃续跑。
- `pnpm --filter desktop db:validate`：校验 migration 序号、journal、snapshot、SQL 与 companion 冻结身份。

跨仓协议仍需真实组合验收：旧客户端必须继续收到服务端 legacy `turn.progress` / `turn.end`；本客户端保留这些消费路径，但服务端是否持续下发必须由 Chris 在真实环境验证。
