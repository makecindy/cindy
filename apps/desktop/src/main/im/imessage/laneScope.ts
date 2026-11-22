import type { BlueBubblesIM } from '@cindy/im';
import type { IMessageToolScope } from '../shared/channelToolScope';

export interface IMessageLaneScopeDeps {
  /** Live session instance and its current turn origin; undefined once the session is gone. */
  session(sessionId: string): { instanceId: string; getCurrentTurnOrigin(): { kind: string } | null } | undefined;
  /** Whether the active input is the owner's own input in Cindy, and its turn boundary. */
  input(sessionId: string): { ownerInput: boolean; boundary: unknown };
  /** The active channel lane link of this session, if any. */
  channelLink(sessionId: string): Promise<{ botId: string; routeKey: string | null } | null>;
  /** The connected chat that lane talks in. */
  target(botId: string, routeKey: string): { im: IMessageToolScope['im'] & Pick<BlueBubblesIM, 'isGroup' | 'botContextId'>; chat: string } | null;
  /** Account / database boundary captured before and re-checked after the lookup. */
  boundary(): unknown;
}

/**
 * The iMessage tool scope of a teammate's channel lane for a turn without an inbound message: the
 * owner typing in Cindy, or a scheduled run there. Relayed or provider-initiated work gets none.
 */
export async function resolveIMessageLaneScope(
  context: { sessionId?: string; sessionInstanceId?: string },
  deps: IMessageLaneScopeDeps,
): Promise<IMessageToolScope | null> {
  const sessionId = context.sessionId;
  const live = sessionId ? deps.session(sessionId) : undefined;
  if (!sessionId || !live || live.instanceId !== context.sessionInstanceId) return null;
  const input = deps.input(sessionId);
  const scheduled = live.getCurrentTurnOrigin()?.kind === 'scheduler';
  if (!input.ownerInput && !scheduled) return null;
  const boundary = deps.boundary();
  const link = await deps.channelLink(sessionId);
  if (!link?.routeKey?.startsWith('im:imessage:')) return null;
  if (deps.boundary() !== boundary || deps.session(sessionId)?.instanceId !== context.sessionInstanceId
    || deps.input(sessionId).boundary !== input.boundary) return null;
  const target = deps.target(link.botId, link.routeKey);
  if (!target) return null;
  return {
    channel: 'imessage', im: target.im, botId: target.im.botContextId, laneUserId: target.chat,
    chatId: target.chat, chatKind: target.im.isGroup(target.chat) ? 'group' : 'direct',
    requesterIsOwner: input.ownerInput && !scheduled, companion: true,
  };
}
