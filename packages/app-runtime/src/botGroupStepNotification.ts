import type { BotGroupChatServiceDeps, BotGroupStepSettledEvent } from './botGroupChatService.js';
import type { OwnerBroadcastTap } from './ownerBroadcast.js';
import type { DbLogger } from '@cindy/runtime-db/logging';

export interface BotGroupStepNotificationDelivery {
  getMobileNotifyGeneration(): number;
  getBotGroupStepNotificationBody(event: BotGroupStepSettledEvent): string;
  sendMobileBotGroupNotify(payload: { groupId: string; title: string; body: string; eventId: string; generation?: number }): boolean;
}

/** The same owner and remote-visibility boundary as the phone's group list. */
export function createBotGroupStepNotification(host: BotGroupStepNotificationDelivery & {
  isDataOwnerBroadcastScopeCurrent: OwnerBroadcastTap['isDataOwnerBroadcastScopeCurrent'];
  botGroupMembersVisibleRemotely(ids: readonly string[]): Promise<boolean>;
  log: DbLogger;
}): NonNullable<BotGroupChatServiceDeps['onStepSettled']> {
  return (event, scope) => {
    if (scope && !host.isDataOwnerBroadcastScopeCurrent(scope)) return;
    const generation = host.getMobileNotifyGeneration();
    void host.botGroupMembersVisibleRemotely(event.memberBotIds).then(visible => {
      if (!visible || (scope && !host.isDataOwnerBroadcastScopeCurrent(scope))) return;
      host.sendMobileBotGroupNotify({
        groupId: event.groupId, title: event.groupName,
        body: host.getBotGroupStepNotificationBody(event),
        eventId: `${event.planId}:${event.position}:${event.outcome}:${Date.now()}`, generation,
      });
    }).catch((error: unknown) => {
      host.log.warn('bot group step push skipped', { error: error instanceof Error ? error.message : String(error) });
    });
  };
}
