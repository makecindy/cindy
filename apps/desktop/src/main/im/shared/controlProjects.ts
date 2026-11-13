/**
 * main/im/shared/controlProjects.ts
 * ---------------------------------------------------------------------------
 * 个人 IM 机器人的项目清单: `/ctr` 第一步与 `/project` 切换卡共用。
 *
 * 清单 = 侧栏的本机项目(名字跟随侧栏, 没有任务的项目也在, 侧栏里移除的不在),
 * `/ctr` 另外带上不在任何项目里、但有活跃任务的目录(「对话」任务的托管目录), 这样
 * 仍能接管对话任务。`/project` 是把会话切进某个项目, 只列项目。
 *
 * 侧栏项目由宿主在启动时注入(setControlProjectCatalogSource); 读不到(存储没就绪、
 * 账号正在切换)时退回只按活跃任务的目录分组 —— 那是没有项目列表时的全部信息。
 * 每组取最近一次活跃时间 (userSendAt ?? updatedAt) 排序; 没有任务的项目用它在侧栏的
 * 最近使用时间。
 *
 * 不做的事:
 *  - 不分页; 直接截取最近 N 个 (常量 MAX_PROJECTS) 给卡片用
 *  - 不 include archived 任务; "control" 语义就是接管"在用的"任务
 */

import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';

import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { isProvisionalSession } from '../../localDb/provisionalSessions';
import { DESKTOP_TASK_LIST_SESSION_SOURCES } from '../../../shared/sessionSource.js';
import { normalizeWorkingDirForGrouping } from '../../../shared/workingDir.js';
import { isTeammateProjectPath } from '@cindy/maker-shared/teammate-project';

/** 侧栏本机项目的只读快照(最近使用在前)。 */
export interface ControlProjectCatalog {
  projects: ReadonlyArray<{ path: string; name: string; lastUsedAtMs?: number }>;
  /** 该目录是否是侧栏里已移除的项目。 */
  isRemoved(directory: string): boolean;
}

let catalogSource: (() => Promise<ControlProjectCatalog | null>) | null = null;

/** 宿主注入侧栏项目的读取方式; 传 null 撤销(测试用)。 */
export function setControlProjectCatalogSource(
  source: (() => Promise<ControlProjectCatalog | null>) | null,
): void {
  catalogSource = source;
}

async function readCatalog(): Promise<ControlProjectCatalog | null> {
  if (!catalogSource) return null;
  try {
    return await catalogSource();
  } catch {
    return null;
  }
}

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
 * 列出项目(见文件头), 按最近活跃时间倒序; 上限 MAX_PROJECTS。
 * `projectsOnly`: 只要侧栏项目(`/project` 用), 不带项目之外的任务目录。
 * `all`: 不截断 —— 上限只为卡片排版; 按按钮上的标记找回项目时要查完整清单, 否则发卡之后
 * 别的项目变活跃, 卡上原本可选的项目会被挤出前 N 个而找不到。
 *
 * displayName:
 *   - 侧栏项目用侧栏的名字; 名字就是目录名且与别的目录撞名时升到 `parent/basename`
 *   - 其它目录: basename 唯一 → 1 段, 否则 `parent/basename` (2 段; 仍冲突也接受,
 *     按钮 label 容量有限)
 */
export async function listProjectsForControl(
  options: { projectsOnly?: boolean; all?: boolean } = {},
): Promise<ControlProject[]> {
  const db = getDbClient().drizzle;
  const [catalog, rows] = await Promise.all([
    readCatalog(),
    db
      .select({
        id: sessions.id,
        title: sessions.title,
        workingDir: sessions.workingDir,
        projectDir: sessions.projectDir,
        userSendAt: sessions.userSendAt,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(
        and(
          inArray(sessions.source, DESKTOP_TASK_LIST_SESSION_SOURCES),
          eq(sessions.status, 'active'),
          isNotNull(sessions.workingDir),
          attachableSessionPredicate(),
        ),
      ),
  ]);

  // 按 normalize 后 dir 聚合最大 sortTime; 同时记录"最新那条会话"的 title,
  // 供下方 UUID 默认目录回退到标题显示。
  const latestByDir = new Map<string, number>();
  const latestTitleByDir = new Map<string, string>();
  for (const r of rows) {
    // 新建页里还没发送的任务不出现在渠道的项目 / 任务列表里。
    if (isProvisionalSession(r.id)) continue;
    const dir = normalizeWorkingDir(r.projectDir ?? r.workingDir);
    if (!dir) continue;
    // 侧栏里移除的项目、伙伴自己的项目不进清单(与侧栏一致)。
    if (catalog !== null && (catalog.isRemoved(dir) || isTeammateProjectPath(dir))) continue;
    const t = r.userSendAt ?? r.updatedAt;
    if (!latestByDir.has(dir) || t > (latestByDir.get(dir) ?? 0)) {
      latestByDir.set(dir, t);
      latestTitleByDir.set(dir, r.title);
    }
  }

  /** 侧栏项目: 归一化目录 -> 侧栏名字。 */
  const sidebarNameByDir = new Map<string, string>();
  if (catalog !== null) {
    for (const project of catalog.projects) {
      const dir = normalizeWorkingDir(project.path);
      if (!dir || sidebarNameByDir.has(dir)) continue;
      sidebarNameByDir.set(dir, project.name);
      // 没有活跃任务的项目也在清单里, 用它在侧栏的最近使用时间参与排序。
      if (!latestByDir.has(dir)) latestByDir.set(dir, project.lastUsedAtMs ?? 0);
    }
    if (options.projectsOnly) {
      for (const dir of [...latestByDir.keys()]) {
        if (!sidebarNameByDir.has(dir)) latestByDir.delete(dir);
      }
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
    const sidebarName = sidebarNameByDir.get(dir);
    let displayName =
      sidebarName !== undefined && sidebarName !== basename
        ? sidebarName
        : collides
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

  disambiguateDisplayNames(projects);
  projects.sort((a, b) => b.latestActivityMs - a.latestActivityMs);
  return options.all ? projects : projects.slice(0, MAX_PROJECTS);
}

/** 卡片按钮的 label 上限(cardBuilders 按它截断)。 */
const BUTTON_LABEL_MAX = 30;

/** 从头按 UTF-16 预算截取, 切点落在完整字符上(不把表情这类代理对切成两半)。 */
function fitStart(text: string, budget: number): string {
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out;
}

/** 同上, 保留末尾。 */
function fitEnd(text: string, budget: number): string {
  let out = '';
  for (const ch of Array.from(text).reverse()) {
    if (out.length + ch.length > budget) break;
    out = ch + out;
  }
  return out;
}

/**
 * 卡片上看起来一样的项目补上能区分的后缀: 目录名, 仍相同再加上级目录, 最后用序号。
 * 卡片按钮上只有显示名, 两个一模一样的按钮背后是不同目录, 用户会在不知情的情况下切进错的
 * 项目。
 *
 * 「看起来一样」按最终渲染的按钮文字判: cardBuilders 把显示名截到 BUTTON_LABEL_MAX 个 UTF-16
 * 单元, 所以只在第 30 个单元之后才不同的两个名字也算相同。补完后缀的名字不超过这个长度,
 * 截断不会再把后缀切掉。
 */
function disambiguateDisplayNames(projects: ControlProject[]): void {
  const rendered = (label: string): string => label.slice(0, BUTTON_LABEL_MAX);
  const groups = new Map<string, ControlProject[]>();
  for (const project of projects) {
    const key = rendered(project.displayName);
    const group = groups.get(key) ?? [];
    group.push(project);
    groups.set(key, group);
  }
  const used = new Set<string>();
  for (const [key, group] of groups) if (group.length === 1) used.add(key);
  const withSuffix = (name: string, suffix: string): string =>
    `${fitStart(name, Math.max(2, BUTTON_LABEL_MAX - suffix.length))}${suffix}`;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.forEach((project, index) => {
      const name = project.displayName;
      const segs = project.workingDir.split('/').filter(Boolean);
      const candidates = [
        withSuffix(name, ` · ${fitStart(segs[segs.length - 1] ?? '', 12)}`),
        withSuffix(name, ` · ${fitEnd(segs.slice(-2).join('/'), 16)}`),
      ];
      let label = candidates.find((candidate) => !used.has(candidate));
      for (let n = index + 1; label === undefined; n += 1) {
        const numbered = withSuffix(name, ` #${n}`);
        if (!used.has(numbered)) label = numbered;
      }
      used.add(label);
      project.displayName = label;
    });
  }
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
      projectDir: sessions.projectDir,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(
      and(
        inArray(sessions.source, DESKTOP_TASK_LIST_SESSION_SOURCES),
        eq(sessions.status, 'active'),
        isNotNull(sessions.workingDir),
        attachableSessionPredicate(),
      ),
    )
    .orderBy(desc(sessions.userSendAt), desc(sessions.updatedAt))
    .limit(limit * 2); // UUID 目录(未选文件夹的草稿目录)过滤后再截断

  const out: RecentControlSession[] = [];
  for (const r of rows) {
    // 新建页里还没发送的任务不出现在渠道的项目 / 任务列表里。
    if (isProvisionalSession(r.id)) continue;
    const dir = normalizeWorkingDir(r.projectDir ?? r.workingDir);
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
      projectDir: sessions.projectDir,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(
      and(
        inArray(sessions.source, DESKTOP_TASK_LIST_SESSION_SOURCES),
        eq(sessions.status, 'active'),
        isNotNull(sessions.workingDir),
        attachableSessionPredicate(),
      ),
    )
    .orderBy(desc(sessions.userSendAt), desc(sessions.updatedAt));

  const out: ControlSession[] = [];
  for (const r of rows) {
    // 新建页里还没发送的任务不出现在渠道的项目 / 任务列表里。
    if (isProvisionalSession(r.id)) continue;
    if (normalizeWorkingDir(r.projectDir ?? r.workingDir) !== target) continue;
    out.push({
      id: r.id,
      title: r.title,
      sortTimeMs: r.userSendAt ?? r.updatedAt,
    });
    if (out.length >= MAX_SESSIONS_PER_WORKSPACE) break;
  }
  return out;
}
