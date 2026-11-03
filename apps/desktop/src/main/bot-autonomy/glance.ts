/**
 * 工作台「一眼」投影（纯函数）：状态表 → 某个伙伴的「等你 / 在做」两块 + 一行页脚。
 *
 * - 总调度伙伴看全设备全任务（scope: all）；其它伙伴只看自己开的或明确接手的任务（scope: own）。
 * - 等你 = 等权限 / 等回答 / 出错；在做 = 运行中，以及撞上用量上限、宿主正在等重置后自动继续的任务。
 * - 做完的任务只计入「今天做完 N 件」（本地日，内存计数，重启清零）。
 */
import type {
  BotGlance,
  GlanceRow,
  WatchedSession,
} from '../../shared/botAutonomy.js';

/** 每块最多列多少行；更多的工作台不需要一眼看到。 */
export const GLANCE_ROW_LIMIT = 50;

export interface FinishedRecord {
  sessionId: string;
  creatorBotId: string | null;
  at: number;
}

export interface GlanceInput {
  botId: string;
  schedulerBotId: string | null;
  rows: Iterable<WatchedSession>;
  /** 该伙伴明确接手 / 负责的任务 id（task-responsibility 与委派）。 */
  responsibleSessionIds: ReadonlySet<string>;
  finished: readonly FinishedRecord[];
  offlineDevices: readonly string[];
  lastSweepAt: number;
  now: number;
  /**
   * 不可见的伙伴（远程端：隐藏 / 归档的伙伴只在本机恢复）：它开的、它的主任务、它在跟的任务都不投影，
   * 也不计入「今天做完」。本机渲染层不传。
   */
  excludeBotIds?: ReadonlySet<string>;
}

export function isSameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function projectBotGlance(input: GlanceInput): BotGlance {
  const scope: BotGlance['scope'] = input.schedulerBotId === input.botId ? 'all' : 'own';
  const inScope = (sessionId: string, creatorBotId: string | null) =>
    scope === 'all' || creatorBotId === input.botId || input.responsibleSessionIds.has(sessionId);
  const exclude = input.excludeBotIds;
  const hidden = (botId: string | null | undefined) => !!botId && !!exclude?.has(botId);
  const waiting: Array<GlanceRow & { sort: number }> = [];
  const working: Array<GlanceRow & { sort: number }> = [];
  const minutes = (since: number) => Math.max(0, Math.floor((input.now - since) / 60_000));
  for (const row of input.rows) {
    if (!inScope(row.sessionId, row.creatorBotId)) continue;
    // 自己的主任务不进自己的工作台：看到自己在做事只是噪音。
    if ((row.canonicalOfBotId ?? null) === input.botId) continue;
    if (hidden(row.creatorBotId) || hidden(row.canonicalOfBotId) || hidden(row.followerBotId)) continue;
    const base = {
      sessionId: row.sessionId,
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      online: row.online,
      title: row.title,
      phase: row.phase,
      followerBotId: row.followerBotId,
    };
    if (row.phase === 'waiting-answer' || row.phase === 'waiting-permission' || row.phase === 'errored') {
      waiting.push({
        ...base,
        kind: 'waiting',
        minutes: minutes(row.phaseSince),
        question: row.phase === 'errored' ? row.error : row.pendingQuestion,
        waitingFor: row.phase === 'errored' ? 'error' : row.phase === 'waiting-permission' ? 'permission' : 'answer',
        requestId: row.phase === 'waiting-permission' ? row.pendingRequestId ?? null : null,
        sort: row.phaseSince,
      });
    } else if (row.phase === 'running' || row.phase === 'usage-limit') {
      const since = row.startedAt ?? row.phaseSince;
      working.push({
        ...base,
        kind: 'working',
        minutes: minutes(since),
        question: null,
        waitingFor: null,
        sort: -since,
      });
    }
  }
  const finish = (list: Array<GlanceRow & { sort: number }>): GlanceRow[] =>
    list
      .sort((a, b) => a.sort - b.sort || a.sessionId.localeCompare(b.sessionId))
      .slice(0, GLANCE_ROW_LIMIT)
      .map((item) => {
        const row: GlanceRow & { sort?: number } = { ...item };
        delete row.sort;
        return row;
      });
  const doneToday = new Set(
    input.finished
      .filter((item) => isSameLocalDay(item.at, input.now) && inScope(item.sessionId, item.creatorBotId)
        && !hidden(item.creatorBotId))
      .map((item) => item.sessionId),
  ).size;
  return {
    botId: input.botId,
    scope,
    waiting: finish(waiting),
    working: finish(working),
    lastSweepAt: input.lastSweepAt,
    doneToday,
    offlineDevices: scope === 'all' ? [...input.offlineDevices] : [],
  };
}
