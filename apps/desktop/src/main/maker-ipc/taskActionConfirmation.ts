import { randomUUID } from 'node:crypto';
import type { InteractionRequest, Session } from '@cindy/maker-core';
import { requestHostInteraction } from './interactionRouter.js';
import type { TaskActionConfirmation } from './taskActionAuthorization.js';

/** Present the same Host-owned task-action request through the Session's
 * existing interaction router on Desktop, web, phone and unattended Host. */
export function createTaskActionConfirmation(deps: {
  getSession(id: string): Session | undefined;
  t(key: string): string;
}) {
  return async (sessionId: string, tool: string, args: unknown, context?: TaskActionConfirmation): Promise<boolean> => {
    const session = deps.getSession(sessionId);
    if (!session) return false;
    const controller = new AbortController();
    const unsubscribe = session.onStatusChange(status => { if (status !== 'active') controller.abort(); });
    const input = structuredClone(args) as Record<string, unknown>;
    const request: Extract<InteractionRequest, { kind: 'permission' }> = {
      kind: 'permission', requestId: randomUUID(), title: deps.t('taskActionConfirmation.title'),
      description: deps.t('taskActionConfirmation.once'),
      toolName: `mcp__${context?.server ?? 'cindy_helper'}__${tool}`, input,
      metadata: { hostOwnedConfirmation: 'task_action' },
    };
    try {
      const result = await session.runHostInteraction(request,
        () => requestHostInteraction(session, request, controller.signal));
      return result.kind === 'permission' && result.behavior === 'allow';
    } finally { unsubscribe(); }
  };
}
