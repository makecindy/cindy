import type { LiziMcpSessionContext } from '@cindy/mcps';

// Scheduler is intentionally excluded: it uses the headless turn marker
// (beginHeadlessGhostSetupTurn) acquired in onAccepted instead of a static
// source-based blocklist, so it can participate in interactive setup when
// triggered from a Desktop session.
const NON_DESKTOP_SETUP_SOURCES = new Set([
  'feishu',
  'discord',
  'slack-hook',
  'telegram',
  'wecom',
]);

const headlessTurnDepthBySession = new Map<string, number>();

/**
 * Marks one concrete agent turn as lacking a Desktop interaction surface.
 * This is intentionally turn-scoped: hook/scheduler may temporarily reuse a
 * normal Desktop session, and build-time session metadata must not permanently
 * change how later user-driven turns behave.
 */
export function beginHeadlessGhostSetupTurn(sessionId: string): () => void {
  headlessTurnDepthBySession.set(
    sessionId,
    (headlessTurnDepthBySession.get(sessionId) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (headlessTurnDepthBySession.get(sessionId) ?? 1) - 1;
    if (next > 0) headlessTurnDepthBySession.set(sessionId, next);
    else headlessTurnDepthBySession.delete(sessionId);
  };
}

export function isHeadlessGhostSetupTurn(sessionId: string): boolean {
  return (headlessTurnDepthBySession.get(sessionId) ?? 0) > 0;
}

/**
 * A business session id does not imply that a Desktop interaction surface is
 * present. IM, scheduler and hook turns must fail closed immediately instead
 * of opening an invisible plugin_setup waiter.
 */
export function ghostSetupInteractionSessionId(
  context: LiziMcpSessionContext | undefined,
): string | null {
  if (context?.sessionId && isHeadlessGhostSetupTurn(context.sessionId)) return null;
  const source = context?.vendorOptions?.source;
  if (typeof source === 'string' && NON_DESKTOP_SETUP_SOURCES.has(source)) return null;
  return context?.sessionId ?? null;
}
