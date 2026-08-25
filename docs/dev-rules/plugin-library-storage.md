# 插件持久 Library 能力

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 library 能力（持久作品库）、binding / 目录选择、迁移、
> 回收站删除、SQLite 语句门、面板 `/library/` 投影，或任何触碰
> `libraries/` / `libraries-binding.json` / `libraries-trash/` 落盘布局的改动之前

`library: true` 给插件一个**用户作品级**的持久存储区，与 `fs: true` 私有储物柜
（256MiB/2000 文件配额、卸载即回收）是两个语义：不受配额约束（只受磁盘保留
水位与软水位约束）、**卸载插件不删数据**、删除必须走设置页独立确认。完整产品
语义与裁决记录见方案文档。安装直接使用系统管理的默认位置，不增加安装确认步骤；
用户可在插件详情页随时安全迁移。

## 事实来源

| 内容 | 权威来源 |
| --- | --- |
| 文件层基座（路径纪律 / 原子写 / 分块流 / 用量账本 / 状态机） | `apps/desktop/src/main/cindy-brain/libraryVault.ts` |
| 自定义位置 binding 与候选目录校验 | `apps/desktop/src/main/cindy-brain/libraryBinding.ts` |
| SQLite 语句门与执行核心（worker 与单测共用） | `apps/desktop/src/main/cindy-brain/libraryDbCore.ts` |
| per-plugin worker 入口 | `apps/desktop/src/main/cindy-brain/libraryDbWorker.ts` |
| 主进程 RPC 服务（发送前语句门 / dispose 收口） | `apps/desktop/src/main/cindy-brain/librarySqlService.ts` |
| 协议分派（资格审 / binding 根解析 / owner scope 复核） | `apps/desktop/src/main/cindy-brain/librarySlot.ts` |
| 随时迁移状态机 | `apps/desktop/src/main/cindy-brain/libraryMigrate.ts` |
| 回收站删除通道 | `apps/desktop/src/main/cindy-brain/libraryTrash.ts` |
| 管子协议类型（`library-request`） | `apps/desktop/src/shared/ghost.ts`（`GhostPipeLibraryRequest/Result`） |
| 面板 `/library/` 投影 | `cindy-brain/runtime/electronSandboxAdapter.ts`（`serveGhostLibraryFile`） |
| 装配 / 生命周期挂点 / 设置面 IPC | `cindy-brain/index.ts`（`getGhostLibrarySlot`、`relocateGhostLibraryTo`、`getGhostLibraryOverview`） |
| 作者手册章节 | `cindy-brain/forge.ts` 的 `FORGE_GUIDE` §4.10.1 |

## 落盘布局（owner-scoped，全部经 `ownerScopedUserDataPath`）

```
owners/<ownerKey>/
├── libraries/<ghostId>/          # 系统管理默认根
├── libraries-binding.json        # 自定义位置持久 binding（原子写）
└── libraries-trash/<ghostId>-<ts>/  # 删除通道的 30 天回收站
```

自定义根 = `<用户所选父目录>/<ghostId>`（binding 记录 realpath 快照 + 文件
identity + generation）。库内宿主命名空间 `.cindy-library/`（meta/usage/tmp/
backups）对插件不可达——路径语法段首不许点，协议层天然隔离。

## 不变量

1. **不可用 ≠ 空**：meta 损坏 → `unavailable(corrupt)`；binding 漂移 →
   `binding-moved` / `disk-missing`。宿主不自动重建、不清空、不回退写默认根、
   不触发 GC、不判素材已删。插件侧同样语义写进了 FORGE_GUIDE。
2. **卸载不删**：uninstall 只标 orphaned + 作废会话；binding 保留（用户亲选
   事实不因重装消失）。删除 = 设置页独立破坏性确认 + `trashGhostLibrary`
   （rename 进回收站，漂移时 NOT_FOUND 不误删）。内置插件退役清理
   （`cleanupRetiredGhostData`）**不得**触及 Library。
3. **owner 隔离**：会话绑定 `activeOwnerScopeKey` 每请求比对；切换在途由
   `interruptGhostCallsForAccountBoundary` 的 `disposeAll` 收口（在途写入随串行
   链归属原 owner）。根解析每次经 binding store 现解。
4. **路径纪律**：相对路径四层校验（`isSafeGhostRelativePath` →
   `validateLibraryRelPath` → `isInsideDir` → realpath 祖先收敛），目标 lstat
   不穿透 symlink。写入 = staging + fsync + rename + dev/ino identity 复验
   （对齐 `dirDeposit.writeNewSaveFile` 范式）。
5. **SQL 白名单**：better-sqlite3 无 set_authorizer，唯一可靠防线是首词允许
   清单（deny-by-default）+ prepare 单语句 + 事务/迁移/备份全宿主管理。
   ATTACH/VACUUM INTO/PRAGMA/事务语句一律 `DB_STATEMENT_REJECTED`。改白名单
   前必须重新论证「该语句类型无法嵌进 SELECT/触发器/视图」。
6. **票据不升级**：`dir`/`save_dir` 十分钟内存票据与 Library binding 不共享
   存储与校验入口。
7. **结果集上限**：2000 行 / 16MiB 序列化（`DB_ROW_LIMIT`）；分块流 Commit 核
   对宿主实算 sha256——`write`/`writeCommit`/`read` 返回的 sha256 是未来网络
   同步的素材完整性地基，不得移除。
8. **迁移安全**：precheck（校验 + 空间 ≥ 用量×1.2 + 目标非空拒）→ copying
   （.sqlite 走在线 backup）→ verifying（清单逐项对账 + quick_check）→
   switching（binding generation+1 原子写）→ grace（旧目录改名保留 14 天）。
   任一步失败 binding 未切换、原位置原样。
9. **面板投影**：`cindy-ghost://<ghostId>/library/<relPath>` 与电子脑 read 同
   源校验，失败折叠 404；内容可变故 `Cache-Control: no-cache`（与内容寻址的
   `/media/` 长缓存刻意不同）。
10. **known limitation（如实告知，不假装覆盖）**：Windows 上 binding 的文件
    identity（st_ino）多为 0，「同路径删后重建」检不出（POSIX 可检出）；映射
    网络盘符检测需要 Win32 API，v1 只拒 UNC 路径。

## Review 清单

1. 路径/SQL 是否仍只经白名单与相对键？有没有新的绝对路径出口？
2. 失败路径是否保持「不可用 ≠ 空」「任一步失败原位原样」？
3. 生命周期挂点（uninstall/setEnabled/owner 边界）是否补了对应的 dispose？
4. i18n 五语与中文标点门禁、FORGE_GUIDE §4.10.1 是否同步？

最小验证入口：

```bash
pnpm --filter desktop exec vitest run src/main/cindy-brain/__tests__/library
pnpm --filter desktop typecheck
```
