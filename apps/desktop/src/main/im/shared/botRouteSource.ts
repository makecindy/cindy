import type { IMMessageEvent } from '@cindy/im';

import type { BotRouteSource } from '../../../shared/botRoute.js';
import type { ImChannelName } from './types.js';

/** Pure adapter-event to Bot Route identity mapping. */
export function botRouteSourceForMessage(
  channel: ImChannelName,
  event: Pick<IMMessageEvent, 'contextId' | 'chatId' | 'senderId' | 'scopeKey' | 'threadTs'>,
): BotRouteSource {
  const threadKey = event.threadTs?.trim() || event.scopeKey?.trim() || undefined;
  return {
    platform: channel,
    accountKey: event.contextId,
    // chatId identifies the concrete DM/group/channel surface; senderId is the
    // adapter's outbound lane. Keeping them separate is required for route
    // uniqueness and later proactive delivery.
    scopeKey: event.chatId,
    principalKey: event.senderId,
    ...(threadKey ? { parentPrincipalKey: event.senderId } : {}),
    ...(threadKey ? { threadKey } : {}),
  };
}
