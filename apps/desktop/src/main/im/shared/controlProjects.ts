/**
 * main/im/feishu/ctrProjects.ts
 * ---------------------------------------------------------------------------
 * `/ctr` 第一步: 列出 desktop 端 sidebar Projects 段的所有工作区。
 *
 * 数据源: sessions 表里 desktop-visible source AND status='active' AND workingDir
 * 不为空的 row。按 workingDir 分组, 每组取最近一次活跃时间 (userSendAt ?? updatedAt)
 * 用作组间排序; displayName 用 basename + 同名时升到 parent/basename 消歧
 * (与 renderer projectGrouping.ts 算法对齐, 但简化为最多 2 段; 真出现 3 段冲突
 * 的概率极低且飞书按钮 label 30 字符也放不下).
 *
 * 不做的事:
 *  - 不查 messages 表"草稿兜底"(那条逻辑是 renderer 显示用; 这里没 workingDir 的
 *    本来就过滤掉, 不会出现孤儿)
 *  - 不分页; 直接截取最近 N 个 (常量 MAX_PROJECTS) 给飞书卡片用
 *  - 不 include archived; "control" 语义就是接管"在用的"工作区
 */

import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';

import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../../shared/sessionSource.js';
import { normalizeWorkingDirForGrouping } from '../../../shared/workingDir.js';

function attachableSessionPredicate() {
  return or(
    isNull(sessions.orcaRole),
    ne(sessions.orcaRole, 'worker'),
  );
}

/** 飞书卡片单卡上限 — 按钮过多排版会裂; 留 1 个给"退出"。 */
export const MAX_PROJECTS = 19;
/** Session picker 同样的上限; 留 3 个给"新建" + "后退" + "退出"。 */
export const MAX_SESSIONS_PER_WORKSPACE = 17;

export interface ControlProject {
  /** 归一化后的 workingDir (POSIX 斜杠, 无 trailing slash)。 */
  workingDir: string;
  /** 显示名: basename, 必要时 `parent/basename` 消歧。 */
  displayName: string;
  /** 组内最大 sortTime (userSendAt ?? updatedAt), 用于组间排序; unix ms。 */
  latestActivityMs: number;
}

export interface ControlSession {
  id: string;
  title: string;
  /** sortTime = userSendAt ?? updatedAt, unix ms。 */
  sortTimeMs: number;
}

/** 标准 UUID (8-4-4-4-12) 形态。没选项目文件夹的会话, 默认工作目录末段是 sessionId。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 与 renderer projectGrouping.normalizeWorkingDir 行为对齐的精简版。 */
function normalizeWorkingDir(raw: string | null | undefined): string | null {
  return normalizeWorkingDirForGrouping(raw);
}

/**
 * 列出所有 desktop active 工作区, 按最近活跃时间倒序; 上限 MAX_PROJECTS。
 *
 * displayName 算法 (简化):
 *   - basename 全集内唯一 → 1 段
 *   - 否则升到 `parent/basename` (2 段); 仍冲突也接受 (飞书按钮 label 容量有限,
 *     再升 3 段意义不大)
 */
export async function listProjectsForControl(): Promise<ControlProject[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      title: sessions.title,
      workingDir: sessions.workingDir,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(
      and(
        inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
        eq(sessions.status, 'active'),
        isNotNull(sessions.workingDir),
        attachableSessionPredicate(),
      ),
    );

  // 按 normalize 后 dir 聚合最大 sortTime; 同时记录"最新那条会话"的 title,
  // 供下方 UUID 默认目录回退到标题显示。
  const latestByDir = new Map<string, number>();
  const latestTitleByDir = new Map<string, string>();
  for (const r of rows) {
    const dir = normalizeWorkingDir(r.workingDir);
    if (!dir) continue;
    const t = r.userSendAt ?? r.updatedAt;
    if (!latestByDir.has(dir) || t > (latestByDir.get(dir) ?? 0)) {
      latestByDir.set(dir, t);
      latestTitleByDir.set(dir, r.title);
    }
  }

  const allDirs = Array.from(latestByDir.keys());
  if (allDirs.length === 0) return [];

  // basename 频次表 — 用于决定该 dir 是否需要升到 2 段
  const basenameCount = new Map<string, number>();
  for (const dir of allDirs) {
    const segs = dir.split('/').filter(Boolean);
    const basename = segs[segs.length - 1] ?? dir;
    basenameCount.set(basename, (basenameCount.get(basename) ?? 0) + 1);
  }

  const projects: ControlProject[] = allDirs.map((dir) => {
    const segs = dir.split('/').filter(Boolean);
    const basename = segs[segs.length - 1] ?? dir;
    const collides = (basenameCount.get(basename) ?? 0) > 1;
    let displayName = collides
      ? segs.slice(Math.max(0, segs.length - 2)).join('/') || basename
      : basename;
    // 没选项目文件夹的会话, 默认工作目录形如 `.../dialogues/<date>/<sessionId>`,
    // basename 是一串 UUID。此时回退到该会话标题显示, 与桌面 UI 侧边栏保持一致,
    // 避免飞书工作区列表里出现裸 UUID。
    if (UUID_RE.test(basename)) {
      const title = latestTitleByDir.get(dir);
      if (title && title.trim() !== '') displayName = title;
    }
    return {
      workingDir: dir,
      displayName,
      latestActivityMs: latestByDir.get(dir) ?? 0,
    };
  });

  projects.sort((a, b) => b.latestActivityMs - a.latestActivityMs);
  return projects.slice(0, MAX_PROJECTS);
}

/**
 * 拿一次接管目标 session 的 title 给提示文案用。查不到 (session 被删 / 异常)
 * 兜底成 sessionId 末尾 6 位 — 至少让用户能识别是哪个会话。
 */
export async function readSessionTitle(sessionId: string): Promise<string> {
  try {
    const db = getDbClient().drizzle;
    const rows = await db
      .select({ title: sessions.title })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return rows[0]?.title || `…${sessionId.slice(-6)}`;
  } catch {
    return `…${sessionId.slice(-6)}`;
  }
}

/**
 * 列出某 workingDir 下所有 desktop active sessions, 按 sortTime desc。
 *
 * 关键点: 入参 workingDir 是归一化后的 POSIX 路径, 但 DB 里的 working_dir 列存的
 * 是原始路径 (可能是 Windows 反斜杠 + 末尾斜杠)。直接 `eq` 会漏命中, 所以这里
 * 拉取该 source/status 全集后在内存里 normalize 比对 — 数据量受 MAX_PROJECTS
 * 推论上限制约 (一台机器的 active session 总数, 不会大), 不需要走 SQL 索引。
 */
export interface RecentControlSession extends ControlSession {
  /** 会话所在目录显示名(basename;托管 IM 目录显示为空串, 由 UI 兜底)。 */
  workspaceDisplayName: string;
}

/** `/session` 直达列表: 跨工作区取最近活跃会话(官方 bot 最近会话选择器同款)。 */
export async function listRecentSessionsForPicker(
  limit = 20,
): Promise<RecentControlSession[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      workingDir: sessions.workingDir,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(
      and(
        inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
        eq(sessions.status, 'active'),
        isNotNull(sessions.workingDir),
        attachableSessionPredicate(),
      ),
    )
    .orderBy(desc(sessions.userSendAt), desc(sessions.updatedAt))
    .limit(limit * 2); // UUID 目录(未选文件夹的草稿目录)过滤后再截断

  const out: RecentControlSession[] = [];
  for (const r of rows) {
    const dir = normalizeWorkingDir(r.workingDir);
    if (!dir) continue;
    const base = dir.split('/').filter(Boolean).pop() ?? '';
    out.push({
      id: r.id,
      title: r.title,
      sortTimeMs: r.userSendAt ?? r.updatedAt,
      workspaceDisplayName: UUID_RE.test(base) ? '' : base,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function listSessionsForWorkspace(
  workingDir: string,
): Promise<ControlSession[]> {
  const target = normalizeWorkingDir(workingDir);
  if (!target) return [];

  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      workingDir: sessions.workingDir,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(
      and(
        inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
        eq(sessions.status, 'active'),
        isNotNull(sessions.workingDir),
        attachableSessionPredicate(),
      ),
    )
    .orderBy(desc(sessions.userSendAt), desc(sessions.updatedAt));

  const out: ControlSession[] = [];
  for (const r of rows) {
    if (normalizeWorkingDir(r.workingDir) !== target) continue;
    out.push({
      id: r.id,
      title: r.title,
      sortTimeMs: r.userSendAt ?? r.updatedAt,
    });
    if (out.length >= MAX_SESSIONS_PER_WORKSPACE) break;
  }
  return out;
}
