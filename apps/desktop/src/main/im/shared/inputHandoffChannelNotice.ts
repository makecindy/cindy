import type { Session } from '@cindy/maker-core';

/**
 * 代输入 pointer for tasks driven from an IM channel (personal bots and the
 * official Telegram bot). The channel runner binds an independent send for the
 * task's chat; when a 代输入 card opens, the owner gets one fixed line there
 * ("需要你帮忙输入 · 在 Cindy 中打开"). The card itself, the screen and every
 * value stay in Cindy: the channel never shows or receives them.
 */

interface Route {
  session: Session;
  deliver(text: string): Promise<unknown>;
  cleanup(): void;
}

const routes = new Map<string, Route>();

export function bindInputHandoffChannelNotice(
  session: Session,
  deliver: (text: string) => Promise<unknown>,
): void {
  routes.get(session.id)?.cleanup();
  let offStatus: (() => void) | undefined;
  const cleanup = (): void => {
    offStatus?.();
    if (routes.get(session.id)?.cleanup === cleanup) routes.delete(session.id);
  };
  // The deliverer also checks that its runtime is still the task's current one.
  offStatus = session.onStatusChange?.((status) => {
    if (status === 'closed' || status === 'error') cleanup();
  });
  routes.set(session.id, { session, deliver, cleanup });
}

/**
 * Sends the pointer through the task's channel. Returns false when the task is
 * not driven from a channel, so the caller can use its other notice paths.
 */
export function sendInputHandoffChannelNotice(
  sessionId: string,
  text: string,
  log: { warn(message: string): void },
): boolean {
  const route = routes.get(sessionId);
  if (!route) return false;
  try {
    void route.deliver(text).then((result) => {
      if (result === false) log.warn('input handoff channel notice was not delivered');
    }, () => log.warn('input handoff channel notice delivery failed'));
  } catch {
    log.warn('input handoff channel notice delivery failed');
  }
  return true;
}

/** Tests only. */
export function clearInputHandoffChannelNotices(): void {
  for (const route of [...routes.values()]) route.cleanup();
}
