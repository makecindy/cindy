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
- **新客户端写 `messages` 的连接必须先注册 `cjk_seg`。** SQLite 自定义函数是连接级的，
  不进 schema。0100 起持久 `messages_fts` insert/update 触发器只写原文，并在
  `cjk_seg` 已注册时跳过；新连接打开后由 `registerCjkSeg` 挂 TEMP 触发器按字写入。
  旧客户端看不到 TEMP、也不会注册该函数，插入仍成功，只是新行不再按字切。生产
  worker、migration runner、漂移修复都经由 `createBetterSqliteDatabase` /
  `createWorkerDatabase` 注册。分词规格冻结在 `cjkSeg.ts`（只收
  `\p{Script=Han}`）；改这个函数必须配新的重建 migration。

## SQLite 语义避坑清单

这些是真实踩过、且失败形态全部是「无报错静默出错」的 SQLite 语义。命中相关场景时
先读本节；修复某条时必须在测试里锁定对应不变量（现有范例：
`cjkTempTriggersSurvival.test.ts`）。

### TEMP 对象 vs `PRAGMA temp_store`（#3841）

**规则：连接上任何 TEMP 对象（TEMP TABLE / TEMP TRIGGER / TEMP VIEW / TEMP INDEX）
的创建，必须排在该连接最后一次 `temp_store` 相关 pragma 执行之后。**

SQLite 官方语义（[PRAGMA 文档](https://www.sqlite.org/pragma.html#pragma_temp_store)）：

> "When the temp_store setting is changed, all existing temporary tables, indices,
> triggers, and views are immediately deleted."

即 **变更 `temp_store` 会立即、无报错地删除连接上全部现有 TEMP 对象**。这不是某个
驱动的 bug，纯 Node、worker_threads、Electron、`:memory:` 与文件库行为一致。

事故形态（#3841，v0.1.72）：`createWorkerDatabase` 先 `registerCjkSeg`（挂 TEMP 触发器）
后 `applyPragmas`（含 `temp_store = MEMORY`），触发器被静默清空；持久触发器又因
`cjk_seg` 函数守卫同时跳过 → 增量消息写入两条路都不进 FTS → 升级用户侧栏搜索按内容
完全打不中新消息。全库 310 行漏索引，无任何 error 日志。

**硬性约定**：

1. 连接初始化顺序必须是「pragma → 注册 UDF → 挂 TEMP 对象」。worker 两条路径
   （`worker/runtime.ts` 的 `createWorkerDatabase`、`client/WorkerThreadTransport.ts`
   的 `createDatabase`）直接按此顺序执行。主进程 `openWithPragmas` 因工厂承担
   native binding 解析与权限收紧，实际是「工厂（注册 UDF + 挂 TEMP）→ pragma →
   `ensureCjkFtsTempTriggersInstalled` 重挂」；pragma 会清掉工厂刚挂的 TEMP 对象，
   由收口函数重挂。新增路径优先按 worker 顺序写，不得在 TEMP 对象创建之后再
   执行 `temp_store` pragma 而不收口。
2. 新增连接级初始化代码时，禁止在 TEMP 对象创建之后再插入任何 `temp_store` pragma；
   需要调整 temp 存储策略时，必须同步审计所有 TEMP 对象的创建时机。
3. 挂载后必须经 `ensureCjkFtsTempTriggersInstalled` 收口：自检不在 → 重挂一次 →
   仍不在则抛错拒绝启动。宁可 init 失败，不可静默漏索引。
4. 复现极轻量：`:memory:` 单测里「`registerCjkSeg` → `temp_store` pragma → 断言
   触发器消失」即可稳定复现（见 `cjkTempTriggersSurvival.test.ts`）。若某个疑似
   SQLite 状态类 bug 在最小单测里复现不了，先怀疑自己的复现序列不对，再怀疑环境。

### 持久 schema 不得引用连接级 UDF

**规则：写入 `drizzle/` 的持久触发器/视图/生成列，函数引用只能是 SQLite 内建函数；
自定义函数（UDF）只允许出现在连接级 TEMP 对象里。**

UDF 是连接级的、不进 schema。持久触发器体内引用 UDF 时，任何未注册该 UDF 的连接
（回退的旧客户端、维护脚本、只读分析工具）在 prepare 阶段就会报
`no such function` —— 注意 **`WHEN` 守卫防不住这一条**：函数解析发生在语句编译期，
`WHEN` 是运行期判断。`messages_fts` 的持久触发器因此只写原文并用 `pragma_function_list`
守卫跳过，按字写入交给 TEMP 触发器；这个双层结构是被迫的，不要"简化"成持久触发器
直调 UDF。

### 通用教训

- 「CREATE/写入了」≠「生效了」。凡是创建后依赖它工作的东西（触发器、函数、虚拟表
  扩展），创建动作本身必须紧跟一条存在性/行为断言，断言失败 fail-loud。
- 失败形态是「无报错 + 功能静默缺失」的 SQLite 交互，review 和测试都拦不住直觉盲区；
  涉及 schema 联动的新设计，先在最小 `:memory:` 单测里验证「创建 → 生效 → 持久存在」
  完整链条，再落实现。

## Review 清单

1. 这次是否真的需要 schema 变化，还是只需运行时代码调整？
2. migration 是否基于最新主干生成，且只追加未合入的新序号？
3. SQL、snapshot、journal、schema 与可选 companion 是否表达同一最终结构？
   新增 migration 文件本体是否零注释？
4. companion 是否为 CommonJS、确定性且具备必要的历史兼容守卫？
5. 是否只在隔离数据库或 replay fixture 上运行了未合入 migration？
6. `db:validate` 与 migration replay 是否都通过？未执行时是否明确说明原因？
7. 是否新增或调整了连接初始化顺序（pragma / UDF 注册 / TEMP 对象）？若是，是否
   经 `ensureCjkFtsTempTriggersInstalled` 收口？worker 路径是否保持「pragma →
   UDF → TEMP」；主进程若必须「工厂 → pragma」，pragma 后是否立即重挂？
