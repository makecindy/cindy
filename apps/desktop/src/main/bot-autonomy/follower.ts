/**
 * 伙伴自主跟进 · 谁来跟（纯函数）。
 *
 * 规则（docs/product-rules/cindy-bots-runtime.md §6.3「谁来跟」）：
 * - 伙伴开的任务（creator）由它自己跟；它暂停 / 已不在时，只有它允许「也交给总调度跟」才落到总调度，
 *   否则没人跟（只进工作台看）。
 * - 没有 creator 的任务（主人自己开的、远程电脑上的）由总调度跟。
 * - 没有可用总调度时为 null：不叫醒任何伙伴，「等你」由宿主直接发系统提醒。
 */

import type { RoutineRun } from '@cindy/maker-scheduler';
import { HOST_SESSIONS_SOURCE_ID, type WatchedSession } from '../../shared/botAutonomy.js';
import { isPendingForFallback } from './events.js';

export interface FollowerBotState {
  status: string;
  /** 资料能力位 `allowSchedulerFollow`，缺省 false。 */
  allowSchedulerFollow: boolean;
  /** 云端伙伴的主力电脑在别处：本机不运行它的例行任务，视为本机不可用。 */
  shadowed?: boolean;
  /** 资料上登记的主任务 id（bot_profiles.canonical_session_id）。 */
  canonicalSessionId?: string | null;
}

export type FollowerBotDirectory = ReadonlyMap<string, FollowerBotState>;

export function isFollowerAvailable(bot: FollowerBotState | undefined): boolean {
  return !!bot && bot.status === 'active' && !bot.shadowed;
}

/**
 * 「自动跟进所有任务」的有效伙伴：用户 override 指向的伙伴仍存在（非归档 / 删除中）就用它
 * （显式 null = 用户关掉了总调度）；目标已不存在时关闭，不自动转交其他伙伴。
 * 未自定义的新用户和老用户都默认关闭，只有明确选择才开始读取与分析自己的任务。
 */
export function resolveSchedulerBotId(
  override: { customized: boolean; schedulerBotId: string | null },
  bots: FollowerBotDirectory,
): string | null {
  const exists = (id: string) => {
    const bot = bots.get(id);
    return !!bot && bot.status !== 'archived' && bot.status !== 'deleting';
  };
  if (override.customized) {
    if (override.schedulerBotId === null) return null;
    if (exists(override.schedulerBotId)) return override.schedulerBotId;
  }
  return null;
}

export function deriveFollowerBotId(input: {
  creatorBotId: string | null;
  schedulerBotId: string | null;
  bots: FollowerBotDirectory;
}): string | null {
  const scheduler = input.schedulerBotId && isFollowerAvailable(input.bots.get(input.schedulerBotId))
    ? input.schedulerBotId
    : null;
  if (!input.creatorBotId) return scheduler;
  const creator = input.bots.get(input.creatorBotId);
  if (isFollowerAvailable(creator)) return input.creatorBotId;
  return creator?.allowSchedulerFollow ? scheduler : null;
}

/** 资料 capabilities_json 里的 `allowSchedulerFollow`；缺失或读不了都按 false。 */
export function readAllowSchedulerFollow(capabilitiesJson: string | null | undefined): boolean {
  if (!capabilitiesJson) return false;
  try {
    const parsed = JSON.parse(capabilitiesJson) as unknown;
    return !!parsed && typeof parsed === 'object' && (parsed as { allowSchedulerFollow?: unknown }).allowSchedulerFollow === true;
  } catch {
    return false;
  }
}

/** Recheck queued events against current ownership/consent before sending any data to a model. */
export type FollowUpSubject = Pick<WatchedSession, 'sessionId' | 'deviceId' | 'shared' | 'canonicalOfBotId' | 'creatorBotId'>;

export function filterFollowUpEvents(
  botId: string,
  events: RoutineRun['events'],
  rows: readonly WatchedSession[],
  schedulerBotId: string | null,
  bots: FollowerBotDirectory,
  now: number,
  subjects: readonly FollowUpSubject[] = rows,
): RoutineRun['events'] {
  const isAllowed = (row: FollowUpSubject) => row.deviceId === null && !row.shared
    && row.canonicalOfBotId !== botId
    && deriveFollowerBotId({ creatorBotId: row.creatorBotId, schedulerBotId, bots }) === botId;
  const ids = new Set(subjects.filter(isAllowed).map((row) => row.sessionId));
  return events.filter(({ sourceId, event }) => sourceId === HOST_SESSIONS_SOURCE_ID && (
    event.type === 'sweep'
      ? rows.some((row) => isAllowed(row) && isPendingForFallback(row, now))
      : typeof event.subject === 'string' && ids.has(event.subject)
  ));
}
