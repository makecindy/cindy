# Desktop 数据库与 Migration 安全

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改 `apps/desktop/src/main/localDb/`、数据库 schema、Drizzle migration、
> migration companion script 或运行期数据库访问之前

本文只治理 Desktop 的 Drizzle／SQLite。本仓不包含服务端数据库；服务端 migration 以
对应服务端仓规则为准。

多账号场景下的 Profile、Machine Registry、Runtime Lease 与表级 ownership 约束见
[`multi-account-database-architecture.md`](multi-account-database-architecture.md)。该文档
是架构基线；在它的所有权边界确认前，不要通过批量增加 `owner_id` 来改造存量业务表。

> **增量适用原则**：本规则约束新数据库改动，不要求为统一形式专项改造存量代码。
> 不得借普通功能修改重写历史 migration 或批量迁移旧数据库访问方式。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 当前 schema | `apps/desktop/src/main/localDb/schema.ts` |
| Drizzle 生成配置 | `apps/desktop/drizzle.config.ts` |
| SQL、snapshot、journal 与 companion | `apps/desktop/drizzle/` |
| 静态完整性与历史冻结 | `apps/desktop/scripts/validate-migrations.mjs` |
| 实际执行顺序与事务语义 | `apps/desktop/src/main/localDb/migrationRunner.ts` |
| 空库与历史库升级验证 | `apps/desktop/src/main/localDb/__tests__/migrationReplay.test.ts` |

文档与实现冲突时先停下核对，不根据旧手册猜测命令或迁移语义。

## Append-only 不变量

- 已进入 `main` 的 `NNNN_*.sql` 及其同名 `drizzle/scripts/NNNN_*.ts` 永久冻结：不得修改、
  删除、改名、换序号或事后补 companion。修复只能追加新 migration。
- 旧仓迁入的 SQL、迁仓首个 commit 已存在的 companion script 由
  `drizzle/migration-baseline.json` 固定 SHA256；新仓已进入 `main` 的 migration
  继续由 Git 基线冻结。两部分都由 `db:validate` 检查。
- `drizzle/meta/_journal.json` 与 `*_snapshot.json` 只能由 Drizzle 生成，不得手工修改。
- migration 序号必须从 `0000` 连续递增，不得重复或跳号。
- 生成 migration 前先基于最新 `origin/main`。多人分支撞号时，保留自己的 schema 意图，
  以最新主干 migration 链重新生成；不得手改文件名、journal 或 snapshot 强行换号。
- **migration 文件本体（`NNNN_*.sql` 与同名 companion）不写注释**。这些文件入 `main`
  即永久冻结，事后连注释都无法修改或删除——写进去的任何内部系统名、内部链接、
  评审编号、人名都会永远留在公开仓里。背景与动机写在 PR 描述或 `docs/`；存量
  migration 里已有的注释按冻结不变量原样保留，不得回头清理。

## 标准变更流程

1. 核对工作区与最新 `origin/main`，确认没有把任务混入他人的 schema／migration 改动。
2. 修改 `apps/desktop/src/main/localDb/schema.ts`。
3. 通过 Drizzle 生成 SQL、snapshot 与 journal 条目：

```bash
pnpm --filter desktop db:generate
```

纯数据迁移或只由 companion 执行的迁移也必须让 Drizzle 建立合法链条，使用 custom
migration，不要手工创建序号、SQL 和元数据：

```bash
pnpm --filter desktop db:generate --custom --name <migration-name>
```

4. Review 生成结果，确认 SQL 与目标 schema 一致。不得手工新建 migration 或伪造元数据。
5. 如历史数据清理、幂等 DDL 或执行顺序无法安全地只靠生成 SQL 表达，可以调整**当前分支
   尚未进入 `main` 的最新 migration**并添加同名 companion；不得修改更早的 migration。
6. 运行静态完整性与冻结校验，再执行真实回放：

```bash
pnpm --filter desktop db:validate
pnpm --filter desktop test:migration-replay
```

`db:validate` 已包含序号连续性、journal／snapshot 对齐、`drizzle-kit check`、孤儿 snapshot、
companion CommonJS 格式和历史 runtime identity 冻结；不能用单独 typecheck 代替。回放测试
验证空库与历史 fixture 能实际升级到 HEAD；高风险历史兼容改动应补对应 fixture。

## Companion script

- 路径和 basename 必须与 SQL 对齐：`drizzle/scripts/NNNN_name.ts` 对应
  `drizzle/NNNN_name.sql`。
- 脚本以 raw TS 随包发布，生产环境通过 CommonJS `require()` 加载。使用
  `function run(db) { ... }` 与 `module.exports = { run }`；只允许顶层 `import type`，
  禁止顶层 `export` 和 value `import`。
- SQL、companion、`schema_version` 与 migration history 在同一事务中提交。脚本应保持
  确定性，并为历史 fixture、部分旧 schema 和重复存在的列／索引设计必要的幂等守卫。
- companion 接收同步 `better-sqlite3` 实例，在受控 migration 事务内使用 `.get()`、
  `.all()`、`.run()` 是契约的一部分；不要把这种同步写法复制到运行期业务代码。

## 未合入 Migration 与本地数据

- 未进入 `main` 的 migration 禁止连接共享 Cindy userData 运行；否则分支换号或回退后会让
  本地 `schema_version` 与真实结构永久分叉。
- **已合入 `main`、但安装包还没带上的 migration 同样不得写进正式 profile。** unpackaged
  writer 在 Cindy / CindyGlobal / CindyDev 上发现 pending 就 fail closed（2026-08-16：
  checkout 带着 0091 把 0.1.50 的共享库升到 91，安装版打不开）。要验证新 schema 必须
  `--isolated[=<名字>]`；等正式版发布后再用共享目录。
- 需要启动验证时，按照 `desktop-development.md` 的参数说明使用显式
  `--isolated[=<名字>]` 沙箱。migration replay 自身使用临时数据库，不污染用户数据。
- 不得为了测试 migration 临时改写、降级或删除用户数据库；需要历史状态时新增最小 fixture。

## 运行期数据库访问

- Main 运行期业务代码使用 `DbClient`／`getDbClient()` 的异步 API，并 `await` Drizzle query
  或使用 `query`、`queryOne`、`exec`、`tx`。
- 不把异步 Drizzle proxy 当成同步 `better-sqlite3` 使用，也不在 Main 业务路径新增直接
  `prepare(...).all()` 之类的同步查询。
- 多步骤写操作需要原子性时使用已有命名事务／worker transaction，不在 Renderer 拼装
  数据库流程。

## Review 清单

1. 这次是否真的需要 schema 变化，还是只需运行时代码调整？
2. migration 是否基于最新主干生成，且只追加未合入的新序号？
3. SQL、snapshot、journal、schema 与可选 companion 是否表达同一最终结构？
   新增 migration 文件本体是否零注释？
4. companion 是否为 CommonJS、确定性且具备必要的历史兼容守卫？
5. 是否只在隔离数据库或 replay fixture 上运行了未合入 migration？
6. `db:validate` 与 migration replay 是否都通过？未执行时是否明确说明原因？
