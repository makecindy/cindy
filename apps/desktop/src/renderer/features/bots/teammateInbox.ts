import type { TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { projectTeammateSnoozeWithOfflineInboxIntent } from '@cindy/maker-shared/offline-inbox-intent';

import * as sessionService from '@/lib/sessionService';
import type { Session } from '@/lib/ccAgent.types';
import {
  getOfflineInboxIntent,
  queueOfflineInboxSnooze,
} from '@/features/device-link/offlineInboxIntentsStore';
import type { AgentIslandSessionActivity } from '../../../shared/agentIsland';
import { botRosterLabel } from '../../../shared/botCreation';
import { markBotRead } from './botReadState';
import { botDeviceLabel, botRosterActivityAt, partitionBotRoster } from './botRosterDisplay';
import { canonicalBotSessionId, refreshBotProfiles, type BotProfile } from './botStore';
import { isRemoteBotUnread, remoteBotKey, type RemoteBot, type TeammateInboxSnooze } from './remoteBotRoster';
import { localTeammateStatus, remoteTeammateStatus } from './teammateRosterStatus';
import { markRemoteBotRead } from './useRemoteBots';

/**
 * One teammate's main conversation as an inbox row (docs/product-rules/task-inbox.md
 * 「伙伴主对话」). Group chats and a teammate's own tasks are not rows of this kind.
 */
export interface TeammateInboxEntry {
  /** Stable across refreshes; never collides with a task row key. */
  key: string;
  bot: BotProfile | RemoteBot;
  name: string;
  /** The computer of a teammate that runs elsewhere. */
  deviceLabel?: string;
  status: TeammateStatus;
  /** Null: the conversation cannot be snoozed (none yet, or a computer that predates it). */
  snooze: TeammateInboxSnooze | null;
  sessionId: string | null;
  activityAt: number;
  route: string;
}

export function teammateInboxRoute(bot: BotProfile | RemoteBot): string {
  return 'deviceId' in bot
    ? `/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}`
    : `/bots/${encodeURIComponent(bot.id)}`;
}

/**
 * The inbox asks whose turn it is, so an unreachable computer is not an error here
 * (`quietOffline`): its teammate is listed only for what it left unread.
 */
export function teammateInboxEntries(input: {
  bots: readonly BotProfile[];
  remoteBots: readonly RemoteBot[];
  activities: ReadonlyMap<string, AgentIslandSessionActivity>;
  unreadByBotId: Readonly<Record<string, number>>;
  devices: readonly { deviceId: string; name: string }[];
}): TeammateInboxEntry[] {
  const local = partitionBotRoster(input.bots.filter((bot) => bot.status !== 'archived'), { query: '', showHidden: false }).visible;
  return [
    ...local.map((bot): TeammateInboxEntry => {
      const sessionId = canonicalBotSessionId(bot) ?? null;
      return {
        key: `teammate:local:${bot.id}`,
        bot,
        name: botRosterLabel(bot, input.bots),
        status: localTeammateStatus(bot, input.activities, (input.unreadByBotId[bot.id] ?? 0) > 0),
        snooze: sessionId ? bot.inboxSnooze ?? null : null,
        sessionId,
        activityAt: botRosterActivityAt(bot),
        route: teammateInboxRoute(bot),
      };
    }),
    ...input.remoteBots.map((bot): TeammateInboxEntry => ({
      key: `teammate:${remoteBotKey(bot)}`,
      bot,
      name: bot.name,
      deviceLabel: botDeviceLabel({ deviceId: bot.deviceId, name: bot.deviceName }, input.devices),
      status: remoteTeammateStatus(bot, isRemoteBotUnread(bot), true),
      snooze: bot.sessionId
        ? projectTeammateSnoozeWithOfflineInboxIntent(
            bot.inboxSnooze ?? null,
            getOfflineInboxIntent(bot.deviceId, bot.sessionId),
          )
        : null,
      sessionId: bot.sessionId,
      activityAt: bot.activityAt,
      route: teammateInboxRoute(bot),
    })),
  ].sort((left, right) => right.activityAt - left.activityAt || left.key.localeCompare(right.key));
}

/**
 * Snooze lives on the conversation's Session, on the computer that owns it. A computer that
 * does not answer with the saved time did not snooze it (older version): report that as failure.
 */
export async function snoozeTeammateConversation(entry: TeammateInboxEntry, until: string | null): Promise<void> {
  if (!entry.sessionId || !entry.snooze) throw new Error('UNSUPPORTED_CAPABILITY');
  const bot = entry.bot;
  if ('deviceId' in bot && !bot.online) {
    await queueOfflineInboxSnooze(
      bot.deviceId,
      entry.sessionId,
      {
        snoozedUntil: bot.inboxSnooze?.snoozedUntil ?? null,
        snoozedAt: bot.inboxSnooze?.snoozedAt ?? null,
        userSendAt: bot.inboxSnooze?.userSendAt ?? null,
        title: entry.name,
        deviceLinkDeviceName: entry.deviceLabel ?? bot.deviceName,
      },
      until,
    );
    return;
  }
  const updated = 'deviceId' in bot
    ? await window.electronAPI.deviceLink.invoke(bot.deviceId, 'local-db:sessions:patch-meta', [
      entry.sessionId, { snoozedUntil: until },
    ]) as Session
    : await sessionService.update(entry.sessionId, { snoozedUntil: until });
  if ((updated?.snoozedUntil ?? null) !== until) throw new Error('UNSUPPORTED_CAPABILITY');
  // The owning computer also announces the change; this window need not wait for it.
  if (!('deviceId' in bot)) refreshBotProfiles();
}

/** Done on a teammate row: its replies are read. Nothing is archived, and a pending request stays. */
export function completeTeammateConversation(entry: TeammateInboxEntry): void {
  const bot = entry.bot;
  if ('deviceId' in bot) markRemoteBotRead(bot.deviceId, bot.id, bot.lastReplyAt ?? 0);
  else markBotRead(bot.id, Math.max(Date.now(), bot.lastMessageAt ?? 0));
}
