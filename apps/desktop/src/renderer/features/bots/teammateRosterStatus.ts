import { resolveTeammateStatus, teammateGroupActivity, type TeammateStatus } from '@cindy/maker-shared/teammate-status';
import type { AgentIslandSessionActivity } from '../../../shared/agentIsland';
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import { canonicalBotSessionId, type BotProfile } from './botStore';
import type { RemoteBot } from './remoteBotRoster';

export function localTeammateStatus(bot: BotProfile, activities: ReadonlyMap<string, AgentIslandSessionActivity>, unread: boolean) {
  const canonical = activities.get(canonicalBotSessionId(bot) ?? '');
  return resolveRosterStatus({ unread, failed: bot.needsAttention,
    activities: [canonical ?? (bot.lastMessageRole === 'assistant' ? { phase: 'completed' } : undefined),
      ...bot.sessions.filter(session => session.role === 'delegation' && session.status !== 'archived' && session.status !== 'deleted')
        .map(session => activities.get(session.id))] });
}

export function remoteTeammateStatus(bot: RemoteBot, unread: boolean, quietOffline = false) {
  return resolveRosterStatus({ unread, quietOffline, online: bot.connectionKnown === false ? null : bot.online,
    working: !!bot.generation, failed: bot.needsAttention, activities: [bot.teammateActivity] });
}

export function groupTeammateStatus(group: BotGroupSummary, bots: readonly BotProfile[],
  activities: ReadonlyMap<string, AgentIslandSessionActivity>, unread: boolean) {
  return resolveRosterStatus({ unread, activities: [teammateGroupActivity(group),
    ...(!group.archived ? bots.flatMap(bot => bot.sessions.filter(session => session.groupId === group.id)
      .map(session => activities.get(session.id))) : [])] });
}

/** Desktop follows the Session attention order without changing the mobile resolver. */
export function aggregateRosterStatus(states: readonly TeammateStatus[]): TeammateStatus {
  const order: readonly TeammateStatus[] = ['error', 'awaiting', 'running', 'done', 'unread', 'idle'];
  return order.find(status => states.includes(status)) ?? 'idle';
}

function resolveRosterStatus(input: Parameters<typeof resolveTeammateStatus>[0]): TeammateStatus {
  if (input.online !== false && (input.failed || input.activities?.some(activity => activity?.phase === 'error'))) return 'error';
  return resolveTeammateStatus(input);
}
