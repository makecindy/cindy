/**
 * scheduledSessionGrouping — 自动化任务生成会话的来源识别
 * ---------------------------------------------------------------------------
 * 新数据使用 sessions.source='scheduler' 做稳定来源标记；旧数据只有
 * `[Schedule] <name>` 标题前缀，仍然需要兼容识别和展示时去前缀。
 *
 * 自动化任务本身仍在 Automations 页集中管理；这里处理的是任务 fire 后创建的
 * 普通会话。它们在 sidebar 中按 project/dialogue 普通规则展示、排序、点击和红点。
 */

import type { Session, AgentKind } from '@/lib/ccAgent.types';

import { extractDisplayName, normalizeWorkingDir } from './projectGrouping';

/**
 * legacy automation 会话的标题前缀。**非 i18n 串**:它是旧数据唯一的来源标记
 * (新数据走 `source='scheduler'`),既用于识别也用于展示时剥离。重命名落库前要靠它
 * 把前缀补回去,否则 legacy 会话会从 automation 分组里消失 —— 故对外导出。
 */
export const SCHEDULE_TITLE_PREFIX = '[Schedule] ';
const SCHED_PREFIX = SCHEDULE_TITLE_PREFIX;

export function isScheduledSession(s: Session): boolean {
  if (typeof s.title !== 'string') return false;
  return s.title.startsWith(SCHED_PREFIX);
}

export function isAutomationGeneratedSession(s: Session): boolean {
  return s.source === 'scheduler' || isScheduledSession(s);
}

/** 从 `[Schedule] my-cron-job` 切掉前缀；不匹配时返回原 title 保兜底显示。 */
export function extractScheduleName(s: Session): string {
  if (typeof s.title !== 'string') return s.title;
  if (s.title.startsWith(SCHED_PREFIX)) return s.title.slice(SCHED_PREFIX.length);
  return s.title;
}

export function getAutomationSessionDisplayTitle(s: Session): string {
  return isScheduledSession(s) ? extractScheduleName(s) : s.title;
}

export interface ScheduleSubGroup {
  /** 旧数据为 schedule.name 快照；新数据没有标题前缀时回落到 session.title。 */
  scheduleName: string;
  /**
   * 整个 schedule 用的 agent。一条 schedule 的 agentKind 在创建时固定，所有 fire 出来的
   * session 都同 agent，所以聚合到 schedule 级别就够了，不需要 per-session 重复展示。
   * 取组内任一 session 的 agentKind；老 session 没字段时兜底 'cc'。
   */
  agentKind: AgentKind;
  /** 组内 session 已按 sortTime desc 排序，[0] = 最新一次 run */
  sessions: Session[];
  latestActivityMs: number;
}

export interface ScheduledDirGroup {
  /** 归一化 workingDir；null = 未指定 dir（heartbeat 模式 / 早期 schedule 没传 workingDir） */
  workingDir: string | null;
  /** 显示名：basename（必要时父段消歧）；null workingDir 显示 '未指定目录' */
  displayName: string;
  /** 该 dir 下所有 schedule 子组，按最新 run desc */
  schedules: ScheduleSubGroup[];
  latestActivityMs: number;
}

const toMs = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

// 以 userSendAt（用户最近一次按下发送）为主键；null 时回落到 updatedAt，
// 兼容 touchUserSendInDb 失败的 scheduler fire 与从未发送过的会话（历史存量）。
const sortTimeMs = (s: Session): number =>
  s.userSendAt != null ? toMs(s.userSendAt) : toMs(s.updatedAt);

type TFunc = (key: string) => string;

export function groupScheduledSessions(sessions: readonly Session[], t?: TFunc): ScheduledDirGroup[] {
  if (!sessions || sessions.length === 0) return [];

  // 先按 (workingDir, scheduleName) 双键聚合
  // dirKey: normalize 后的 workingDir，null 用 '__nodir__'
  const NO_DIR = '__nodir__';
  const dirToSchedToSessions = new Map<string, Map<string, Session[]>>();

  for (const s of sessions) {
    if (!isAutomationGeneratedSession(s)) continue;
    const dir = normalizeWorkingDir(s.workingDir ?? null);
    const dirKey = dir ?? NO_DIR;
    const schedKey = getAutomationSessionDisplayTitle(s);

    let schedMap = dirToSchedToSessions.get(dirKey);
    if (!schedMap) {
      schedMap = new Map();
      dirToSchedToSessions.set(dirKey, schedMap);
    }
    const arr = schedMap.get(schedKey);
    if (arr) arr.push(s);
    else schedMap.set(schedKey, [s]);
  }

  // 真实 dir 路径集合（不含 NO_DIR 占位），给 displayName 消歧用
  const realDirs = Array.from(dirToSchedToSessions.keys()).filter((k) => k !== NO_DIR);

  const out: ScheduledDirGroup[] = [];
  for (const [dirKey, schedMap] of dirToSchedToSessions) {
    const subGroups: ScheduleSubGroup[] = [];
    let dirLatest = 0;
    for (const [scheduleName, sess] of schedMap) {
      const sorted = sess.slice().sort((a, b) => sortTimeMs(b) - sortTimeMs(a));
      const latestActivityMs = sorted.length > 0 ? sortTimeMs(sorted[0]) : 0;
      if (latestActivityMs > dirLatest) dirLatest = latestActivityMs;
      // agentKind 取组内任一 session（同 schedule 的 fire 必同 agent）；老数据兜底 'cc'
      const agentKind: AgentKind = sorted[0]?.agentKind ?? 'cc';
      subGroups.push({ scheduleName, agentKind, sessions: sorted, latestActivityMs });
    }
    subGroups.sort((a, b) => b.latestActivityMs - a.latestActivityMs);

    const isNoDir = dirKey === NO_DIR;
    const displayName = isNoDir
      ? (t ? t('ccAgent.schedule.unspecifiedDir') : 'Unspecified directory')
      : extractDisplayName(dirKey, realDirs, 1).name;

    out.push({
      workingDir: isNoDir ? null : dirKey,
      displayName,
      schedules: subGroups,
      latestActivityMs: dirLatest,
    });
  }

  out.sort((a, b) => b.latestActivityMs - a.latestActivityMs);
  return out;
}
