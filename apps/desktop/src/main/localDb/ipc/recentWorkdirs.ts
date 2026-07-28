/**
 * 最近工作目录 IPC + 内部 upsert helper。
 *
 * 设计:
 *  - 列表读取走 IPC `local-db:recent-workdirs:list`,renderer 给 NewMakerDraft
 *    的"项目"下拉用。返回 path + lastUsedAt(ms) + exists(目录是否仍在磁盘上,
 *    项目迁移/删除后 UI 据此置灰引导用户手动移除),displayName 由 renderer 端
 *    用 projectGrouping.extractDisplayName 实时算(相对当前全集做同名消歧)。
 *  - 删除走 IPC `local-db:recent-workdirs:remove` —— 唯一的 renderer 写入口,
 *    语义是"从最近列表移除"(列表卫生),不动 sessions/磁盘。目录下再次创建
 *    session 会经 upsertRecentWorkdir 重新入列,已迁移的死路径则一去不返。
 *    recent 只影响项目列表展示,不再充当 device-link remote-workdir-guard
 *    的放行依据；远程入口始终实时探测目录当前是否可访问。
 *  - upsert 不暴露 IPC —— 由 main 内部在 session 创建路径上调用 upsertRecentWorkdir,
 *    避免 renderer 私自污染该表。生命周期与 session 解耦:归档 / 删除 session
 *    都不影响这张表。
 *  - upsert 失败仅日志,不抛 —— 这是"用户体验增强"数据,不该挡住 session 创建主流程。
 */

import { stat } from 'node:fs/promises';

import { BrowserWindow, ipcMain } from 'electron';
import { desc, eq, inArray } from 'drizzle-orm';

import { getDbClient } from '../client/current';
import { recentWorkdirs } from '../schema';
import { createLogger } from '../../logger';
import { requireString } from '../../utils/ipcValidate.js';
import { getManagedWorktreeBasePath } from '../../../shared/managedWorktreePaths';

const log = createLogger('recentWorkdirs');

/**
 * 最大保留条目数。超过即按 lastUsedAt 升序淘汰最旧条目(LRU)。
 * 取 10 是因为下拉 UI 4 条以上就要滚,10 已经远超日常活跃项目数;
 * 同时给"重启后再打开第 11 个旧项目"留了缓冲。
 */
const MAX_RECENT_WORKDIRS = 10;

/**
 * 归一化 recent_workdirs 主键形态,避免同一目录因分隔符差异成多条记录。
 *
 * 规则(与 projectGrouping.normalizeWorkingDir 同步但**不**做 worktree-strip
 *  —— 这里要保留用户实际选过的目录原样, worktree 折叠是 sidebar 显示语义):
 *  - trim
 *  - 反斜杠 → 正斜杠 (Windows 的 E:\foo\bar 与 E:/foo/bar 当同一条)
 *  - 去除末尾 `/`,但保留单一根(`/` 或 `D:/`)
 *  - 拒绝 scheduler ephemeral worktree（当前 `/.cindy-worktrees/` 与历史
 *    `/.xdt-worktrees/` 段）—— 这些是
 *    runner 自己临时建的目录,不是用户选过的项目目录,不该出现在"最近"下拉里。
 *    防御性兜底:scheduler 走 DesktopSessionStorage.create() 直接 drizzle,
 *    不经过 sessions:create IPC,本来就不会触发 upsertRecentWorkdir;这里加
 *    一层是防止未来某个新链路误传 worktree 路径进来(也保护 0035 清理过后
 *    再次被脏数据反复污染)。
 *
 * 空 / 非字符串 / worktree 路径 → 返回 null,调用方应据此跳过 upsert。
 */
export function normalizeRecentWorkdirPath(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let s = trimmed.replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) {
    if (/^[A-Za-z]:\/$/.test(s)) break; // 盘符根 `D:/`
    s = s.slice(0, -1);
  }
  if (getManagedWorktreeBasePath(s) != null) return null;
  return s;
}

/**
 * upsert: 把一个工作目录的 lastUsedAt 刷成 now (或指定 ms)。已存在则覆盖时间戳;
 * 不存在则插入。fire-and-forget: 失败仅日志,不影响调用方。
 *
 * path 写入前会被 normalizeRecentWorkdirPath 处理 —— 保证主键唯一形态。
 */
export async function upsertRecentWorkdir(
  path: string | null | undefined,
  atMs: number = Date.now(),
): Promise<void> {
  const normalized = normalizeRecentWorkdirPath(path);
  if (!normalized) return;
  try {
    // 只取一次 drizzle handle,upsert 与驱逐全程复用它 —— 两端必须 pin 在同一个
    // backend 上。getDbClient() 读的是模块级可变 current(账号切换 / client 重新初始化
    // 会 set 或 clear 它);而 in-proc fallback client(worker 起不来时装的那个)的
    // drizzle 是 getter、exec 则在调用时才解析模块全局 getRawDb()。混用「已捕获的
    // drizzle」和「晚绑定的 exec」时,只要 insert 之后这个 fire-and-forget helper 被挂起
    // 期间发生账号切换,驱逐就会打到新账号的库上:旧库该裁的没裁,新库反而被裁一行。
    const db = getDbClient().drizzle;
    await db
      .insert(recentWorkdirs)
      .values({ path: normalized, lastUsedAt: atMs })
      .onConflictDoUpdate({
        target: recentWorkdirs.path,
        set: { lastUsedAt: atMs },
      });
    // LRU 驱逐:超过 MAX_RECENT_WORKDIRS 的行按 lastUsedAt 从旧到新淘汰。
    //
    // 必须是**一条** DELETE,待删集合由子查询在同一条语句里求值 —— 不能先 SELECT 出
    // 快照再按快照 DELETE。session 创建路径以 void 调用本 helper(fire-and-forget),两个
    // upsert 会交错:若分两步,A 选中最旧的 X 之后 B 刷新了 X,A 仍按旧快照删掉 X ——
    // 用户刚用过的目录反而从「最近」里消失,交错还会让列表少于上限。单语句在 SQLite 里
    // 原子求值,最坏只是驱逐重复执行(幂等,结果一致)。
    //
    // 用 query builder 而不是 client.exec 拼 raw SQL,两个原因:
    //  1. pin(见上):builder 走的是已捕获的 db handle,不会二次解析 DbClient。
    //  2. main 侧的 drizzle 是 createDrizzleProxy 的代理,只把 **query builder** 的终结方法
    //     转发给 worker RPC(完整清单见 drizzleProxy.ts 的 terminalMethods:all / get / run /
    //     values / execute,以及 then / catch / finally 触发的隐式执行)。在 db 对象上跑 raw SQL
    //     (db.run(sql`...`))不经过 builder,会落进代理内部那个只会抛错的
    //     fakeSqliteClient.prepare(),被 fire-and-forget 的 catch 吞成一条 warn —— 驱逐
    //     100% 静默失败(本 PR 修的就是这个)。子查询的 limit / offset 是 builder 内部的
    //     SQL 构造,不是 db 级 raw SQL,照样走代理。
    //
    // SQLite 的 OFFSET 必须跟着 LIMIT,而这里要的是"从第 n+1 行起全部":
    //  - 不能传 -1(SQLite 表示无上限的写法):drizzle 会把数字 -1 丢掉只留 offset,生成
    //    `... offset ?`,SQLite 直接报 `near "offset": syntax error`;
    //  - 也不能传 sql`-1` 绕过:limit() 的类型只收 number | Placeholder,typecheck 不过。
    // 所以用 MAX_SAFE_INTEGER 表达"无上限"(表上限十几行,永远取不满)。
    //
    // 一次删掉所有超出上限的行,不是每次删 1 行:稳态下单条 INSERT 最多新增 1 条,自然
    // 也只删 1 条;而驱逐曾长期静默失败留下的脏数据(本机库涨到 18 行)在下一次 upsert
    // 就一次清到上限,不用等多轮。
    const doomed = db
      .select({ path: recentWorkdirs.path })
      .from(recentWorkdirs)
      .orderBy(desc(recentWorkdirs.lastUsedAt))
      .limit(Number.MAX_SAFE_INTEGER)
      .offset(MAX_RECENT_WORKDIRS);
    await db.delete(recentWorkdirs).where(inArray(recentWorkdirs.path, doomed));
  } catch (err) {
    log.warn('[localDb] upsertRecentWorkdir failed', {
      path: normalized,
      error: err instanceof Error ? err.message : String(err),
      // drizzle 把底层错误包一层后 message 只剩 "Failed to run the query '<sql>'",
      // 根因全在 cause 里。不带上就只能对着一条无因果的 SQL 反向猜。
      cause: err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined,
    });
  }
}

/**
 * 目录存在性探测。表内 path 已是 posix 归一形态,Node fs 在 Windows 上同样
 * 接受正斜杠;必须确认是目录 —— 路径被普通文件顶替时 access 也会成功,会让
 * 选择器把不可用条目当正常项目。stat 跟随符号链接(指向目录的 symlink 算存在);
 * 任何 fs 错误(不存在 / 无权限 / 网络盘断连)都按"不存在"处理 —— 这个字段
 * 只驱动 UI 置灰提示,fail-closed 到 false 无害。
 */
async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function registerRecentWorkdirsIpc(): void {
  ipcMain.handle('local-db:recent-workdirs:list', async () => {
    const db = getDbClient().drizzle;
    // LIMIT 是兜底 —— upsert 已经按 MAX_RECENT_WORKDIRS 驱逐过,
    // 这里加 limit 防御任何"绕过 upsert"的写入路径(比如未来的 migration)
    // 漏挂驱逐导致 UI 突然出现一长串。
    const rows = await db
      .select()
      .from(recentWorkdirs)
      .orderBy(desc(recentWorkdirs.lastUsedAt))
      .limit(MAX_RECENT_WORKDIRS);
    // 存在性探测:最多 10 条本地路径的并发 access,开销可忽略。
    const exists = await Promise.all(rows.map((r) => dirExists(r.path)));
    // 返回 ISO 字符串避免序列化数字时区岐义 —— 跟 sessions IPC 输出风格一致。
    return rows.map((r, i) => ({
      path: r.path,
      lastUsedAt: new Date(r.lastUsedAt).toISOString(),
      exists: exists[i],
    }));
  });

  ipcMain.handle('local-db:recent-workdirs:remove', async (_evt, input: unknown) => {
    const body = (input ?? {}) as { path?: unknown };
    const raw = requireString(body.path, 'path');
    // 归一化后再删,保证与写入侧同一主键形态;归一失败(纯空白等)当 no-op,
    // 删除本身幂等,不值得为它抛错。
    const normalized = normalizeRecentWorkdirPath(raw);
    if (!normalized) return { deleted: false };
    const db = getDbClient().drizzle;
    // 必须显式 .run():worker 代理的 DbClient 对隐式 await 的 DML 走 executeAll,
    // 会丢弃 RunResult(见 drizzleProxy.test.ts),导致真删了也报 deleted:false。
    const result = (await db
      .delete(recentWorkdirs)
      .where(eq(recentWorkdirs.path, normalized))
      .run()) as { changes?: number } | undefined;
    const deleted = (result?.changes ?? 0) > 0;
    log.info('[localDb] recent workdir removed by user', { path: normalized, deleted });
    // 广播到本机所有窗口:发起删除的 renderer 已乐观 patch 自己的 store,
    // 其它窗口(以及 device-link 远程调用落地时的被控端窗口)靠这个刷新,
    // 否则模块级缓存只在 sessions:created 时重拉,删掉的项目会在别的窗口
    // 里残留可选。真删了才广播;no-op 不打扰。
    if (deleted) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('local-db:recent-workdirs:changed', { path: normalized });
        }
      }
    }
    return { deleted };
  });
}
