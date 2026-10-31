/**
 * 侧栏「进行中」段的成员与顺序。
 * ---------------------------------------------------------------------------
 * 成员 = 优先级排序的前三档(等你处理 / 完成未读 / 运行中),与「按优先级」排序、
 * 灵动岛共用同一把尺子(sessionPriorityRank)。正在看的任务由 heldPriorityRanks
 * 钉住打开时的档位,所以看完离开后才回到原项目,行不会在眼前消失。
 *
 * 段内按创建时间倒序:任务在三档之间切换(运行中 → 等你处理)时位置不动,
 * 避免状态一变就重排导致误点。已置顶的任务留在置顶段;查看归档时不提取归档任务。
 */

import type { Session } from '@/lib/ccAgent.types';
import { LIVE_TASK_PRIORITY } from '../../../../shared/liveTaskPriority';
import { sessionCreatedMs } from './dateSessionGrouping';
import { sessionPriorityRank, type MainListPriorityContext } from './mainListModel';

export function selectInProgressSessions(
  sessions: Iterable<Session>,
  ctx: MainListPriorityContext,
): Session[] {
  const selected: Session[] = [];
  for (const session of sessions) {
    if (session.pinnedAt != null || session.status !== 'active') continue;
    if (sessionPriorityRank(session, ctx) === LIVE_TASK_PRIORITY.rest) continue;
    selected.push(session);
  }
  return selected.sort((a, b) => sessionCreatedMs(b) - sessionCreatedMs(a));
}
