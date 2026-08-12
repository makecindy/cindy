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
 *  - upsert 不暴露 IPC —— 由 main 内部在 session 创建和本地项目软删除路径上调用,
 *    避免 renderer 私自污染该表。生命周期与 session 解耦:归档 / 删除不会移除目录；
 *    软删除会刷新最后活动时间，确保清空会话后的项目仍服从同一活动筛选语义。
 *  - upsert 失败仅日志,不抛 —— 这是"用户体验增强"数据,不该挡住 session 创建主流程。
 */

import { stat } from 'node:fs/promises';

import { BrowserWindow, ipcMain } from 'electron';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { DbClient } from '../client/DbClient.js';
import { getDbClient } from '../client/current';
import { recentWorkdirs, sessions } from '../schema';
import { createLogger } from '../../logger';
import { requireString } from '../../utils/ipcValidate.js';
import { getManagedWorktreeBasePath } from '../../../shared/managedWorktreePaths';
import { normalizeWorkingDirForGrouping } from '../../../shared/workingDir';

const log = createLogger('recentWorkdirs');

/**
 * 归一化 recent_workdirs 存储形态。Windows drive / UNC 的大小写仅用于比较身份，
 * 不改写展示 casing；运行时命名事务负责合并同一比较身份的遗留变体。
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
  localPlatform: NodeJS.Platform = process.platform,
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

function isCaseInsensitiveWindowsPath(path: string, localPlatform: NodeJS.Platform): boolean {
  return localPlatform === 'win32' && (/^[A-Za-z]:\//.test(path) || path.startsWith('//'));
}

/**
 * upsert: 把一个工作目录的 lastUsedAt 刷成 now (或指定 ms)。已存在则取较新时间戳;
 * 不存在则插入。fire-and-forget: 失败仅日志,不影响调用方。
 *
 * path 写入前会被 normalizeRecentWorkdirPath 处理；Windows 大小写身份由命名事务去重。
 */
export async function upsertRecentWorkdir(
  path: string | null | undefined,
  atMs: number = Date.now(),
  localPlatform: NodeJS.Platform = process.platform,
  client?: DbClient,
): Promise<boolean> {
  const normalized = normalizeRecentWorkdirPath(path, localPlatform);
  if (!normalized) return false;
  try {
    const targetClient = client ?? getDbClient();
    if (isCaseInsensitiveWindowsPath(normalized, localPlatform)) {
      // Windows drive / UNC 的合并与遗留变体清理必须同成同败；命名 tx 在 worker
      // 与 in-proc 共用一条事务实现，MAX 也避免旧调用回退较新的 lastUsedAt。
      await targetClient.tx('recentWorkdirs.mergeWindowsIdentity', {
        path: normalized,
        lastUsedAt: atMs,
      });
      return true;
    }

    const db = targetClient.drizzle;
    await db
      .insert(recentWorkdirs)
      .values({ path: normalized, lastUsedAt: atMs })
      .onConflictDoUpdate({
        target: recentWorkdirs.path,
        set: { lastUsedAt: sql`MAX(${recentWorkdirs.lastUsedAt}, ${atMs})` },
      });
    return true;
  } catch (err) {
    log.warn('[localDb] upsertRecentWorkdir failed', {
      path: normalized,
      error: err instanceof Error ? err.message : String(err),
      // drizzle 把底层错误包一层后 message 只剩 "Failed to run the query '<sql>'",
      // 根因全在 cause 里。不带上就只能对着一条无因果的 SQL 反向猜。
      cause: err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined,
    });
    return false;
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

function recentWorkdirProjectIdentity(
  path: string,
  localPlatform: NodeJS.Platform,
): string | null {
  const grouped = normalizeWorkingDirForGrouping(path);
  if (!grouped) return null;
  return isCaseInsensitiveWindowsPath(grouped, localPlatform) ? grouped.toLowerCase() : grouped;
}

export function registerRecentWorkdirsIpc(): void {
  ipcMain.handle('local-db:recent-workdirs:list', async () => {
    const db = getDbClient().drizzle;
    const rows = await db.select().from(recentWorkdirs).orderBy(desc(recentWorkdirs.lastUsedAt));
    const sessionRows = await db
      .selectDistinct({
        workingDir: sessions.workingDir,
        agentKind: sessions.agentKind,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceKind, 'project'),
          isNull(sessions.remoteHostId),
          isNotNull(sessions.workingDir),
        ),
      );
    const knownKindsByPath = new Map<string, Set<string>>();
    for (const session of sessionRows) {
      if (!session.workingDir) continue;
      const identity = recentWorkdirProjectIdentity(session.workingDir, process.platform);
      if (!identity) continue;
      const kinds = knownKindsByPath.get(identity) ?? new Set<string>();
      kinds.add(session.agentKind ?? 'cc');
      knownKindsByPath.set(identity, kinds);
    }
    // 存在性探测与条目数解耦；项目只有显式移除才会退出这份持久目录。
    const exists = await Promise.all(rows.map((r) => dirExists(r.path)));
    // 返回 ISO 字符串避免序列化数字时区岐义 —— 跟 sessions IPC 输出风格一致。
    return rows.map((r, i) => {
      const identity = recentWorkdirProjectIdentity(r.path, process.platform);
      return {
        path: r.path,
        lastUsedAt: new Date(r.lastUsedAt).toISOString(),
        exists: exists[i],
        knownAgentKinds: Array.from(
          (identity && knownKindsByPath.get(identity)) ?? [],
        ).sort(),
      };
    });
  });

  ipcMain.handle('local-db:recent-workdirs:remove', async (_evt, input: unknown) => {
    const body = (input ?? {}) as { path?: unknown };
    const raw = requireString(body.path, 'path');
    // 归一化后再删,保证与写入侧同一主键形态;归一失败(纯空白等)当 no-op,
    // 删除本身幂等,不值得为它抛错。
    const { deleted, normalizedPath: normalized } = await removeRecentWorkdir(raw);
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

/** 可注入平台的删除核心，供跨平台 CI 明确覆盖 Windows drive / UNC identity。 */
export async function removeRecentWorkdir(
  rawPath: string,
  localPlatform: NodeJS.Platform = process.platform,
): Promise<{ deleted: boolean; normalizedPath: string }> {
  const normalized = normalizeRecentWorkdirPath(rawPath, localPlatform);
  if (!normalized) return { deleted: false, normalizedPath: rawPath };
  const db = getDbClient().drizzle;
  // 必须显式 .run():worker 代理的 DbClient 对隐式 await 的 DML 走 executeAll,
  // 会丢弃 RunResult(见 drizzleProxy.test.ts),导致真删了也报 deleted:false。
  const result = (await db
    .delete(recentWorkdirs)
    .where(
      isCaseInsensitiveWindowsPath(normalized, localPlatform)
        ? sql`lower(${recentWorkdirs.path}) = lower(${normalized})`
        : eq(recentWorkdirs.path, normalized),
    )
    .run()) as { changes?: number } | undefined;
  return { deleted: (result?.changes ?? 0) > 0, normalizedPath: normalized };
}
