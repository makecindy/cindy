/**
 * The task link builder, without Electron: the Node Host builds the same links (session_search
 * results). deepLink.ts re-exports it, so its importers are unchanged.
 */
import { DEEP_LINK_URL_PREFIX } from '../shared/deepLinkSchemes';

export function buildSessionDeepLink(
  sessionId: string,
  opts?: { deviceId?: string | null },
): string {
  const device = opts?.deviceId ? `?device=${encodeURIComponent(opts.deviceId)}` : '';
  return `${DEEP_LINK_URL_PREFIX}session/${encodeURIComponent(sessionId)}${device}`;
}
