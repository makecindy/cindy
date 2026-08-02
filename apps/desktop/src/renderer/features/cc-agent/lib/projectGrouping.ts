/**
 * projectGrouping — CC Agent Sidebar 分组算法（纯函数）
 * ---------------------------------------------------------------------------
 * 给定 Session 列表，输出 Sidebar 三段渲染所需结构：
 *   - pinned        ：所有 pinnedAt != null，先按 status (active 优先) 再按 pinnedAt desc
 *   - dialogues     ：workspaceKind === 'dialogue' 的非置顶会话，按 status 再按 sortTime desc
 *   - unclassified  ：草稿（workingDir 缺失，或非 scheduler / 非 Orca lead 且
 *                    userSendAt 与 _count.messages 都空）的会话，先按 status 再按 sortTime desc
 *   - projects      ：按 normalize 后的 workingDir 分组、同名消歧后排序
 *                    组内 sessions 先按 status (active 在 archived 之上) 再按 sortTime desc
 *
 * 时间轴：
 *   - 排序唯一字段是 `sortTime = userSendAt ?? updatedAt`
 *     · userSendAt = "用户最近一次按下发送" 的瞬间，由 sendMessage 入口同步 bump，
 *       不会被 model/effort/title 等字段类改动污染
 *     · 老数据 / 未发过消息的草稿 userSendAt 可能为 null —— 回落到 updatedAt 兜底
 *
 * 草稿识别（归未分类）：
 *   - workingDir 缺失 OR
 *     (userSendAt == null AND _count.messages === 0 AND source !== 'scheduler' AND 非 Orca lead)
 *     · 主判定：userSendAt == null —— 用户从未按下发送
 *     · 兜底：messages 表零 row —— 防止 SDK echo 失败 / 老数据 backfill 漏掉时
 *       把"有消息但 userSendAt 没写上"的孤儿 session 错判成草稿。userSendAt
 *       依赖 sendMessage → SDK echo → main 落库这条链，链中任一环出错（API Key
 *       失效 / 子进程崩 / 网络中断）都会留下 user 行没落但 assistant/tool 行
 *       已落的孤儿，物理上 _count.messages > 0 是更可靠的"非空"证据
 *     · scheduler 会话的归属来自自动化任务配置；刚绑定 session 时 message
 *       count 可能还没写入，不应按用户草稿规则归未分类
 *
 * 设计要点：
 *   - 路径归一化：Windows 反斜杠 → POSIX 斜杠；去尾部斜杠（保留根/盘符根）
 *   - 同名消歧：多个 workingDir basename 相同时，从父目录开始往上拼，最多 3 段
 *   - 排序：
 *       · 组内 session：status === 'active' 排在 'archived' 之上，同状态按时间 desc
 *       · Project 间按"组内任意 session 的最大 sortTime" desc —— 按真实最近活跃时间，
 *         避免 active-first 排序把 latest 字段污染成"最新 active"
 *
 * 全部纯函数；输入为空 / 异常 → 静默返回合理默认。
 */

import type { DeviceLinkConnectionStatus, Session } from '@/lib/ccAgent.types';
import { isOrcaLeadSession, isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import { normalizeWorkingDirForGrouping } from '../../../../shared/workingDir';
import {
  deviceLinkProjectKey,
  normalizeProjectKey,
  projectKeyComparisonKey,
  projectIdentityKey,
  type ProjectScope,
} from '../../../../shared/projectKeys';
import type { RemoteProjectMachineIdentity } from './remoteProjectIdentity';

export {
  deviceLinkProjectKey,
  normalizeProjectKey,
  projectKeyComparisonKey,
  projectIdentityKey,
};

/* ============================== Types ============================== */

export interface ProjectIdentity {
  scope: ProjectScope;
  workingDir: string;
  remoteHostId: string | null;
  /**
   * device-link 跨设备远程控制:被控设备 deviceId。非 null ⟺ 这是一个 device-link
   * 远程项目(scope 仍为 'remote',复用隐藏本机 FS 入口的分支;但与 SSH 的
   * `remoteHostId` 互斥,二者不会同时非 null)。
   */
  deviceLinkDeviceId: string | null;
  deviceLinkDeviceName: string | null;
  deviceLinkConnectionStatus: DeviceLinkConnectionStatus | null;
}

export interface ProjectNode {
  /** Stable project identity key. Legacy bare workingDir keys are local. */
  projectKey: string;
  scope: ProjectScope;
  /** 归一化后的 workingDir（POSIX 斜杠，无 trailing slash） */
  workingDir: string;
  remoteHostId: string | null;
  /** device-link 远程项目:被控设备 deviceId（非 null ⟺ device-link 项目，渲染设备 icon）。 */
  deviceLinkDeviceId: string | null;
  /** device-link 远程项目:被控设备友好名（sidebar tooltip）。 */
  deviceLinkDeviceName: string | null;
  /** device-link 远程项目:当前连接状态。断线时仍显示最近一次快照。 */
  deviceLinkConnectionStatus: DeviceLinkConnectionStatus | null;
  /** 当前 registry 解析出的远程机器身份;undefined 表示调用方尚未执行富化。 */
  remoteMachineIdentity?: RemoteProjectMachineIdentity | null;
  /** 显示名：basename，必要时含父目录段消歧（如 `parent/basename`） */
  displayName: string;
  /** displayName 中包含的路径段数 */
  segments: number;
  /** 该 Project 下所有 session，已按 status 然后 sortTime desc 排序 */
  sessions: Session[];
  /** 组内任意 session 的最大 sortTime（userSendAt ?? updatedAt），用于 Project 间排序 */
  latestActivityAt: string;
}

export interface ProjectGroupsResult {
  pinned: Session[];
  dialogues: Session[];
  unclassified: Session[];
  projects: ProjectNode[];
}

export interface GroupSessionsOptions {
  projectAliases?: ReadonlyMap<string, string> | Record<string, string>;
  /**
   * Build a project catalogue that also contains individually pinned sessions.
   * The normal sidebar keeps this false so a pinned conversation only appears
   * once; project pinning uses true so the project itself does not disappear
   * when every conversation inside it is pinned.
   */
  includePinnedInProjects?: boolean;
}

/* ============================== normalize ============================== */

/**
 * 归一化 workingDir。
 * - null/undefined/空字符串 → null
 * - 反斜杠 → 正斜杠
 * - 去除末尾 `/`，但保留单一根（`/` 或 `D:/`）
 * - **worktree 归一**：`<repo>/.cindy-worktrees/<name>`（兼容历史
 *   `.xdt-worktrees`）/ `<repo>/.worktrees/<name>` /
 *   `<repo>/.claude/worktrees/<name>` → `<repo>`
 *   （schedule / issue-triage / imported Codex session 的实际 cwd 可能是 worktree
 *    子目录，sidebar 分组应当归到 baseRepo，否则每个 worktree 一个独立 group。
 *    本函数仅用于 displayName / 分组键，IO 路径仍读 session.workingDir 原值。）
 */
export const normalizeWorkingDir = normalizeWorkingDirForGrouping;

export function projectIdentityKeyForSession(
  session: Pick<Session, 'workingDir' | 'remoteHostId' | 'deviceLinkDeviceId'>,
): string | null {
  const workingDir = normalizeWorkingDir(session.workingDir);
  if (workingDir == null) return null;
  if (session.deviceLinkDeviceId) return deviceLinkProjectKey(session.deviceLinkDeviceId, workingDir);
  return projectIdentityKey(session.remoteHostId ? 'remote' : 'local', workingDir, session.remoteHostId ?? null);
}

export function getProjectIdentity(session: Session): ProjectIdentity | null {
  const workingDir = normalizeWorkingDir(session.workingDir);
  if (workingDir == null) return null;
  if (session.deviceLinkDeviceId) {
    return {
      scope: 'remote',
      workingDir,
      remoteHostId: null,
      deviceLinkDeviceId: session.deviceLinkDeviceId,
      deviceLinkDeviceName: session.deviceLinkDeviceName ?? null,
      deviceLinkConnectionStatus: session.deviceLinkConnectionStatus ?? 'connected',
    };
  }
  return {
    scope: session.remoteHostId ? 'remote' : 'local',
    workingDir,
    remoteHostId: session.remoteHostId ?? null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    deviceLinkConnectionStatus: null,
  };
}

/* ============================== displayName ============================== */

/**
 * 根据 workingDir 与全集，提取最短可识别的 displayName。
 * 算法（按 prod_spec F-PJ-2 扩展）：
 *   1. 取 basename
 *   2. 若全集内无其他 workingDir 的 basename 与之相同 → 1 段
 *   3. 否则逐步加上父目录段，直到不冲突；若完整路径仍冲突，则接受完整路径
 *
 * minSegments：从该段数起步搜索（默认 1）。groupSessions 在"先创建保留 basename"
 * 规则下，会把后创建的同名 Project 传 minSegments=2，强制至少加上 parent 段。
 */
export function extractDisplayName(
  workingDir: string,
  allWorkingDirs: readonly string[],
  minSegments: number = 1,
): { name: string; segments: number } {
  const segs = splitPathSegments(workingDir);
  const ownSegs = segs;
  const ownBasename = ownSegs[ownSegs.length - 1] ?? workingDir;

  // 收集其它 workingDir 的逐段拆分
  const others: string[][] = [];
  let maxSegments = Math.max(1, ownSegs.length, minSegments);
  for (const w of allWorkingDirs) {
    if (w === workingDir) continue;
    const parts = splitPathSegments(w);
    if (parts.length > 0) {
      others.push(parts);
      maxSegments = Math.max(maxSegments, parts.length);
    }
  }

  for (let n = minSegments; n <= maxSegments; n += 1) {
    const myTail = tailJoin(ownSegs, n);
    const collision = others.some((parts) => tailJoin(parts, n) === myTail);
    if (!collision) {
      return { name: myTail || ownBasename, segments: n };
    }
  }

  const fallback = tailJoin(ownSegs, maxSegments) || ownBasename;
  return { name: fallback, segments: maxSegments };
}

function splitPathSegments(workingDir: string): string[] {
  return workingDir.split('/').filter(Boolean);
}

// 取从尾部往前 N 段（如 segments=2 → `parent/basename`）。
function tailJoin(parts: readonly string[], n: number): string {
  return parts.slice(Math.max(0, parts.length - n)).join('/');
}

interface DisplayNameIndex {
  tailCounts: Map<number, Map<string, number>>;
  workingDirCounts: Map<string, number>;
}

function buildDisplayNameIndex(workingDirs: readonly string[]): DisplayNameIndex {
  const tailCounts = new Map<number, Map<string, number>>();
  const workingDirCounts = new Map<string, number>();
  let maxSegments = 1;

  for (const workingDir of workingDirs) {
    workingDirCounts.set(workingDir, (workingDirCounts.get(workingDir) ?? 0) + 1);
    maxSegments = Math.max(maxSegments, splitPathSegments(workingDir).length);
  }

  for (let n = 1; n <= maxSegments; n += 1) {
    tailCounts.set(n, new Map());
  }

  for (const workingDir of workingDirs) {
    const parts = splitPathSegments(workingDir);
    for (let n = 1; n <= maxSegments; n += 1) {
      const tail = tailJoin(parts, n);
      const counts = getRequiredMapValue(tailCounts, n, 'tail count bucket');
      counts.set(tail, (counts.get(tail) ?? 0) + 1);
    }
  }

  return { tailCounts, workingDirCounts };
}

function extractDisplayNameFromIndex(
  workingDir: string,
  index: DisplayNameIndex,
  minSegments: number = 1,
): { name: string; segments: number } {
  const parts = splitPathSegments(workingDir);
  const ownBasename = parts[parts.length - 1] ?? workingDir;
  const sameWorkingDirCount = index.workingDirCounts.get(workingDir) ?? 0;
  const maxSegments = Math.max(...index.tailCounts.keys(), minSegments, 1);

  for (let n = minSegments; n <= maxSegments; n += 1) {
    const myTail = tailJoin(parts, n);
    const counts = index.tailCounts.get(n);
    const collisionCount = (counts?.get(myTail) ?? 0) - sameWorkingDirCount;
    if (collisionCount <= 0) {
      return { name: myTail || ownBasename, segments: n };
    }
  }

  const fallback = tailJoin(parts, maxSegments) || ownBasename;
  return { name: fallback, segments: maxSegments };
}

function normalizeProjectAliases(
  raw: GroupSessionsOptions['projectAliases'],
): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  const entries = raw instanceof Map ? raw.entries() : Object.entries(raw);
  for (const [key, value] of entries) {
    const projectKey = normalizeProjectKey(key);
    const alias = typeof value === 'string' ? value.trim() : '';
    if (!projectKey || alias.length === 0) continue;
    out.set(projectKey, alias);
  }
  return out;
}

function getRequiredMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`projectGrouping invariant failed: missing ${label} for ${String(key)}`);
  }
  return value;
}

/* ============================== comparators ============================== */

const toMs = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

/**
 * 排序时间轴：以 userSendAt（用户最近一次按下发送）为主键。
 * - userSendAt 存在时只认它 —— agent 回复 / /clear 等只 bump
 *   updatedAt 的路径不再重排列表，会话顺序稳定跟随"用户上次发送"。
 * - userSendAt == null 时回落到 updatedAt：兼容 touchUserSendInDb 失败的 scheduler fire
 *   与从未发送过的草稿会话，避免这类会话因取 0 沉到列表最底。
 */
const sortTimeMs = (s: Session): number =>
  s.userSendAt != null ? toMs(s.userSendAt) : toMs(s.updatedAt);

const sortTimeIso = (s: Session): string => s.userSendAt ?? s.updatedAt;

export const compareSessionsBySortTimeDesc = (a: Session, b: Session): number =>
  sortTimeMs(b) - sortTimeMs(a);

export const comparePinnedByPinnedAtDesc = (a: Session, b: Session): number =>
  toMs(b.pinnedAt) - toMs(a.pinnedAt);

export const compareProjectsByLatestSessionDesc = (a: ProjectNode, b: ProjectNode): number =>
  toMs(b.latestActivityAt) - toMs(a.latestActivityAt);

/**
 * Status 优先级：active < archived < deleted（数字越小越靠前）。
 * 'deleted' 通常已被服务端过滤掉不出现在列表里，给它最低优先级只是兜底。
 */
const statusRank = (s: Session): number => {
  if (s.status === 'active') return 0;
  if (s.status === 'archived') return 1;
  return 2;
};

/** 组内 session 排序：active 在 archived 之上，同状态按 sortTime desc。 */
export const compareSessionsByStatusThenSortTimeDesc = (a: Session, b: Session): number => {
  const r = statusRank(a) - statusRank(b);
  if (r !== 0) return r;
  return sortTimeMs(b) - sortTimeMs(a);
};

/** Pinned 排序：active 在 archived 之上，同状态按 pinnedAt desc。 */
export const comparePinnedByStatusThenPinnedDesc = (a: Session, b: Session): number => {
  const r = statusRank(a) - statusRank(b);
  if (r !== 0) return r;
  return toMs(b.pinnedAt) - toMs(a.pinnedAt);
};

/**
 * 全量置顶 session 的 id,按**置顶段同一排序**(active 优先 → pinnedAt desc)。
 * 供侧边栏拖拽落定时计算持久化顺序的 baseline:必须与用户看到的置顶段顺序一致,否则首次在
 * 过滤态(按机器 / vendor)拖拽、manualPinnedOrder 还空时,被过滤掉的隐藏置顶项会因 baseline
 * 顺序(原始 sessions 是 updatedAt desc)≠ 展示顺序而在切回时跳位。
 * 入参传**未过滤**的会话(本地 + 全部远程)。**含归档置顶**(status=All/Archived 视图下置顶段会
 * 展示归档置顶,排除它们会让在这些视图拖拽时丢掉归档置顶的持久化顺序);comparePinnedByStatusThenPinnedDesc
 * 已把 active 排在 archived 之前,与 groupSessions 的 pinned 段口径一致。仅排除 orca worker。
 */
export function pinnedSessionIdsInDisplayOrder(sessions: readonly Session[]): string[] {
  return sessions
    .filter((s) => s.pinnedAt != null && !isOrcaWorkerSession(s))
    .slice()
    .sort(comparePinnedByStatusThenPinnedDesc)
    .map((s) => s.id);
}

/* ============================== aggregator ============================== */

/**
 * 主聚合函数：把扁平 sessions 切成三段。
 *
 * 排序合约：
 *   - pinned          按 status → pinnedAt desc
 *   - dialogues       按 status → sortTime desc
 *   - unclassified    按 status → sortTime desc (sortTime = userSendAt ?? updatedAt)
 *   - projects        按 latestActivityAt desc；组内 sessions 按 status → sortTime desc
 *
 * 草稿判定：workingDir 缺失 OR
 *   (非 scheduler / 非 plugin / 非 Orca lead 且 userSendAt == null AND _count.messages === 0)
 *   → 归未分类。scheduler session 的归属由自动化任务配置决定，刚绑定时可能
 *   还没落 user prompt/message count，不能按用户手动草稿处理。plugin session
 *   是插件经 workspace 槽为指定目录创建的空会话入口——"零消息落在项目分组"
 *   正是它的产品目的，套草稿规则会让它掉未分类、功能不成立。
 *
 * 异常输入：
 *   - 空数组 / 全 null → 各段返回空数组
 *   - workingDir 异常 → 归到 unclassified
 */
export function groupSessions(
  sessions: readonly Session[],
  options: GroupSessionsOptions = {},
): ProjectGroupsResult {
  const aliases = normalizeProjectAliases(options.projectAliases);
  if (!sessions || sessions.length === 0) {
    return { pinned: [], dialogues: [], unclassified: [], projects: [] };
  }

  // 1. Pinned —— active 在 archived 之上，同状态按 pinnedAt desc
  const pinned = sessions
    .filter((s) => s.pinnedAt != null)
    .slice()
    .sort(comparePinnedByStatusThenPinnedDesc);

  // 2. 剩余 = 未 pin 的
  const remaining = options.includePinnedInProjects
    ? sessions
    : sessions.filter((s) => s.pinnedAt == null);

  // 3. 按 normalize 后 workingDir 分组
  // 草稿判定主线：userSendAt == null（用户从未按下发送）。
  // 兜底：_count.messages === 0 —— userSendAt 依赖 sendMessage → SDK echo →
  // main 落库这条链，链中任一环出错（API Key 失效 / 子进程崩 / 老数据漏 backfill）
  // 都会留下"有消息但 userSendAt 没写上"的孤儿。物理上 messages 表有 row 是更
  // 可靠的"非空"证据，避免把这类孤儿错判成草稿堆到未分类。
  // scheduler 会话不套这条草稿规则：它由自动化任务显式绑定 workingDir，且
  // session-bound 事件可能早于 user prompt/message count 落库。
  // plugin 会话(workspace 槽)同样豁免:它就是插件为目录准备的零消息会话
  // 入口,创建时目录已经过用户授权,落项目分组是功能本身。
  const unclassified: Session[] = [];
  const dialogues: Session[] = [];
  const groups = new Map<string, Session[]>();
  const identityByKey = new Map<string, ProjectIdentity>();
  for (const s of remaining) {
    if (s.workspaceKind === 'dialogue') {
      dialogues.push(s);
      continue;
    }
    const dir = normalizeWorkingDir(s.workingDir);
    const noPhysicalMessages = (s._count?.messages ?? 0) === 0;
    const isOrcaLead = isOrcaLeadSession(s);
    const isAutoPlacedSession = s.source === 'scheduler' || s.source === 'plugin';
    if (
      dir == null ||
      (!isAutoPlacedSession && !isOrcaLead && s.userSendAt == null && noPhysicalMessages)
    ) {
      unclassified.push(s);
    } else {
      const isDeviceLink = !!s.deviceLinkDeviceId;
      // device-link 远程会话也归 'remote' scope(复用隐藏本机 FS 入口的渲染分支),
      // 但用独立 device: key,且不带 remoteHostId(与 SSH 维度互斥)。
      const scope: ProjectScope = isDeviceLink || s.remoteHostId ? 'remote' : 'local';
      const projectKey = isDeviceLink
        ? deviceLinkProjectKey(s.deviceLinkDeviceId as string, dir)
        : projectIdentityKey(scope, dir, s.remoteHostId ?? null);
      const arr = groups.get(projectKey);
      if (arr) arr.push(s);
      else groups.set(projectKey, [s]);
      if (!identityByKey.has(projectKey)) {
        identityByKey.set(projectKey, {
          scope,
          workingDir: dir,
          remoteHostId: isDeviceLink ? null : s.remoteHostId ?? null,
          deviceLinkDeviceId: isDeviceLink ? (s.deviceLinkDeviceId as string) : null,
          deviceLinkDeviceName: isDeviceLink ? s.deviceLinkDeviceName ?? null : null,
          deviceLinkConnectionStatus: isDeviceLink ? s.deviceLinkConnectionStatus ?? 'connected' : null,
        });
      }
    }
  }

  // 4. unclassified 排序 —— active 在 archived 之上，同状态按 sortTime desc
  dialogues.sort(compareSessionsByStatusThenSortTimeDesc);
  unclassified.sort(compareSessionsByStatusThenSortTimeDesc);

  // 5. 同名消歧 — "先创建优先"：在每个 basename 相同的 dir 集合里，按
  //    "该 dir 下最早 createdAt 的 Session 升序"排序，排序第一的获胜者保留纯
  //    basename（minSegments=1），其余强制 minSegments=2 触发 parent 追溯。
  //    createdAt 缺失时回退到 dir 字符串字典序，保证确定性。
  const allProjectKeys = Array.from(groups.keys());
  const allDisplayDirs = allProjectKeys.map((projectKey) => identityByKey.get(projectKey)?.workingDir ?? projectKey);
  const minSegByDir = new Map<string, number>();

  // 5a. 先按 basename 分桶
  const dirsByBasename = new Map<string, string[]>();
  for (const projectKey of allProjectKeys) {
    const identity = identityByKey.get(projectKey);
    const workingDir = identity?.workingDir ?? projectKey;
    const segs = splitPathSegments(workingDir);
    const basename = segs[segs.length - 1] ?? workingDir;
    const arr = dirsByBasename.get(basename);
    if (arr) arr.push(projectKey);
    else dirsByBasename.set(basename, [projectKey]);
  }

  // 5b. 每个 basename 桶内确定获胜者
  for (const [, dirsInBucket] of dirsByBasename) {
    if (dirsInBucket.length === 1) {
      // 唯一 basename，无需消歧；走默认 minSegments=1
      minSegByDir.set(dirsInBucket[0], 1);
      continue;
    }
    // 计算每个 dir 下"最早 createdAt"
    const earliestCreatedByDir = new Map<string, number>();
    for (const dir of dirsInBucket) {
      const sess = getRequiredMapValue(groups, dir, 'session group');
      let earliest = Number.POSITIVE_INFINITY;
      for (const s of sess) {
        const t = toMs(s.createdAt);
        if (t > 0 && t < earliest) earliest = t;
      }
      // createdAt 全缺失 → Infinity，会被排到最后；用 dir 字典序作为 tie-breaker
      earliestCreatedByDir.set(dir, earliest);
    }
    const sortedBucket = dirsInBucket.slice().sort((a, b) => {
      const da = getRequiredMapValue(earliestCreatedByDir, a, 'earliest createdAt');
      const db = getRequiredMapValue(earliestCreatedByDir, b, 'earliest createdAt');
      if (da !== db) return da - db;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    // 第一名获胜：保留 basename
    minSegByDir.set(sortedBucket[0], 1);
    // 其余：强制至少 2 段
    for (let i = 1; i < sortedBucket.length; i += 1) {
      minSegByDir.set(sortedBucket[i], 2);
    }
  }

  // 5c. 构造 ProjectNode
  //  - 获胜者 (minSeg=1)：即使 basename 与其他 dir 冲突也强制保留 1 段（先创建优先）
  //  - 非获胜者 (minSeg=2)：通过 extractDisplayName 走至少 2 段的消歧
  //  - 唯一 basename (minSeg=1)：走默认 1 段（无冲突自然 1 段返回）
  const displayNameIndex = buildDisplayNameIndex(allDisplayDirs);
  const projects: ProjectNode[] = [];
  for (const [projectKey, sess] of groups) {
    const identity = identityByKey.get(projectKey);
    // 组内排序：active 优先 + sortTime desc（filter='all' 下 archived 自然沉到底）
    const sorted = sess.slice().sort(compareSessionsByStatusThenSortTimeDesc);
    // latestActivityAt 取"全员里 sortTime 最大"——project 间排序按真实最近活跃时间，
    // 不被 active-first 的组内排序污染（否则只有 archived 的 project 会被强行按
    // 较旧的 active 时间下沉，与用户预期不符）。
    let latestMs = 0;
    let latestIso = '';
    for (const s of sess) {
      const t = sortTimeMs(s);
      if (t > latestMs) {
        latestMs = t;
        latestIso = sortTimeIso(s);
      }
    }
    const minSeg = minSegByDir.get(projectKey) ?? 1;

    // 同名桶里被标记为获胜者的 dir：直接给 1 段 basename，绕过 extractDisplayName
    // 的"冲突自动升段"行为。判断方式：minSeg=1 且 basename 在桶中数量 >1（同名）
    const workingDir = identity?.workingDir ?? projectKey;
    const segsArr = splitPathSegments(workingDir);
    const ownBasename = segsArr[segsArr.length - 1] ?? workingDir;
    const bucketSize = dirsByBasename.get(ownBasename)?.length ?? 1;
    const isWinner = bucketSize > 1 && minSeg === 1;

    let name: string;
    let segments: number;
    const alias = aliases.get(projectKey);
    if (alias) {
      name = alias;
      segments = 0;
    } else if (isWinner) {
      name = ownBasename;
      segments = 1;
    } else {
      const r = extractDisplayNameFromIndex(workingDir, displayNameIndex, minSeg);
      name = r.name;
      segments = r.segments;
    }

    projects.push({
      projectKey,
      scope: identity?.scope ?? 'local',
      workingDir,
      remoteHostId: identity?.remoteHostId ?? null,
      deviceLinkDeviceId: identity?.deviceLinkDeviceId ?? null,
      deviceLinkDeviceName: identity?.deviceLinkDeviceName ?? null,
      deviceLinkConnectionStatus: identity?.deviceLinkConnectionStatus ?? null,
      displayName: name,
      segments,
      sessions: sorted,
      latestActivityAt: latestIso,
    });
  }

  // 6. Project 间排序
  projects.sort(compareProjectsByLatestSessionDesc);

  return { pinned, dialogues, unclassified, projects };
}
