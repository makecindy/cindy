/**
 * The task link builder, without Electron: the Node Host builds the same links (session_search
 * results). deepLink.ts re-exports it, so its importers are unchanged.
 */
import { buildTaskDeepLink } from '../shared/deepLinkSchemes';

export function buildSessionDeepLink(
  sessionId: string,
  opts?: { deviceId?: string | null },
): string {
  return buildTaskDeepLink(sessionId, opts?.deviceId);
}
