import { runAssistantReplyHook } from './assistantReplyHook.js';
import type { GhostSubscriptionGateway } from './subscriptionGateway.js';
import type { GhostCardRow } from '@cindy/plugin-runtime/cardService';
import { sanitizeGhostCardHtml } from '@cindy/plugin-runtime/cardSanitizer';
import { GHOST_CARD_HEIGHT_DEFAULT, GHOST_CARD_HEIGHT_MIN, GHOST_CARD_HEIGHT_MAX, type InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
export interface GhostAssistantReplyHost<Stamp> {
 availableGhosts(): InstalledGhost[];
 getGhostOwnerPushStamp(): Stamp;
 isGhostOwnerStampCurrent(stamp: Stamp): boolean;
 isGhostEligibleSession(id: string): Promise<{outcome: 'eligible'|'ineligible'|'retry'}>;
 getGhostSubscriptionGateway(): Pick<GhostSubscriptionGateway,'screenAssistantMessage'>;
 updateMessageContent(sessionId: string, clientId: string, text: string): Promise<unknown>;
 upsertGhostCard(row: GhostCardRow): Promise<void>;
 broadcastGhostWindowPush(channel: string, payload: unknown, stamp?: Stamp): void;
 log: {warn(message:string, meta?:Record<string,unknown>):void};
}
export function createGhostAssistantReply<Stamp>(host: GhostAssistantReplyHost<Stamp>) {
 const {availableGhosts,getGhostOwnerPushStamp,isGhostOwnerStampCurrent,isGhostEligibleSession,getGhostSubscriptionGateway,updateMessageContent,upsertGhostCard,broadcastGhostWindowPush,log}=host;
 type DataOwnerPushStamp = Stamp;
 const GHOST_ASSISTANT_REWRITTEN_CHANNEL='ghosts:assistant-message-rewritten';
 const GHOST_ASSISTANT_PENDING_CHANNEL='ghosts:assistant-message-pending';
 const GHOST_CARD_UPDATED_CHANNEL='ghosts:card-updated';
function hasEnabledGhostAssistantHook(): boolean {
  return availableGhosts().some(
    (g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-assistant-message'),
  );
}

function broadcastGhostAssistantRewritten(
  payload: {
    sessionId: string;
    clientId: string;
    ghostId: string;
    ghostName: string;
    text: string;
  },
  ownerStamp?: DataOwnerPushStamp,
): void {
  broadcastGhostWindowPush(GHOST_ASSISTANT_REWRITTEN_CHANNEL, payload, ownerStamp);
}

function broadcastGhostAssistantPending(
  sessionId: string,
  clientId: string,
  pending: boolean,
  ownerStamp?: DataOwnerPushStamp,
): void {
  broadcastGhostWindowPush(
    GHOST_ASSISTANT_PENDING_CHANNEL,
    { sessionId, clientId, pending },
    ownerStamp,
  );
}

async function applyGhostAssistantRenderCard(
  sessionId: string,
  clientId: string,
  card: { ghostId: string; ghostName: string; html: string; height?: number },
  ownerStamp?: DataOwnerPushStamp,
): Promise<void> {
  if (ownerStamp !== undefined && !isGhostOwnerStampCurrent(ownerStamp)) return;
  const sanitized = sanitizeGhostCardHtml(card.html);
  if (!sanitized.ok) {
    log.warn('ghost assistant render card rejected by sanitizer', {
      sessionId,
      reason: sanitized.reason,
    });
    return;
  }
  const heightRaw =
    typeof card.height === 'number' && Number.isFinite(card.height)
      ? Math.round(card.height)
      : GHOST_CARD_HEIGHT_DEFAULT;
  const height = Math.min(GHOST_CARD_HEIGHT_MAX, Math.max(GHOST_CARD_HEIGHT_MIN, heightRaw));
  const now = Date.now();
  // 落库失败不阻断广播(活卡先见;历史回放缺卡 renderer missing 降级)。
  await upsertGhostCard({
    callId: clientId,
    ghostId: card.ghostId,
    sessionId,
    html: sanitized.html,
    height,
    v: 1,
    updatedAt: now,
  }).catch((err) => {
    log.warn('ghost assistant render card persist failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  if (ownerStamp !== undefined && !isGhostOwnerStampCurrent(ownerStamp)) return;
  broadcastGhostWindowPush(
    GHOST_CARD_UPDATED_CHANNEL,
    {
      callId: clientId,
      ghostId: card.ghostId,
      toolUseId: null,
      html: sanitized.html,
      // 出口钩子自绘卡不含 running 动画版语义(turn 已结束),静态版即最终。
      animatedHtml: null,
      height,
      // turn 级自绘卡标记:renderer 只入卡库(byCallId,AssistantMessage 按消息
      // clientId 直取),**不进 liveCards 锚定池**——否则 toolUseId:null 的条目会
      // 被同意识进行中 ghost_call 的启发式锚定抢走(review P1,2026-07-13)。
      turnCard: true,
    },
    ownerStamp,
  );
}

function runGhostAssistantReplyHook(
  sessionId: string,
  clientId: string,
  text: string,
): void {
  const ownerStamp = getGhostOwnerPushStamp();
  const isCurrent = () => isGhostOwnerStampCurrent(ownerStamp);
  void runAssistantReplyHook(
    {
      isCurrent,
      hasHook: hasEnabledGhostAssistantHook,
      isEligible: async (sid) =>
        isCurrent() && (await isGhostEligibleSession(sid)).outcome === 'eligible',
      screen: async (sid, t) => {
        if (!isCurrent()) return { action: 'allow' as const };
        const result = await getGhostSubscriptionGateway().screenAssistantMessage(
          { sessionId: sid, text: t },
          ownerStamp,
        );
        return isCurrent() ? result : { action: 'allow' as const };
      },
      persistRewrite: async (sid, cid, t) => {
        if (!isCurrent()) return;
        await updateMessageContent(sid, cid, t);
      },
      applyRenderCard: (sid, cid, cardArg) =>
        applyGhostAssistantRenderCard(sid, cid, cardArg, ownerStamp),
      broadcastRewritten: (payload) => broadcastGhostAssistantRewritten(payload, ownerStamp),
      setPending: (sid, cid, pending) =>
        broadcastGhostAssistantPending(sid, cid, pending, ownerStamp),
      log,
    },
    sessionId,
    clientId,
    text,
  );
}
 return {hasEnabledGhostAssistantHook,runGhostAssistantReplyHook};
}
