import type { MobileGoalStatusPayload } from '@cindy/maker-shared';
import { z } from 'zod';

import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

/** Host callbacks use the calling task's identity, never a model-supplied target. */
export interface SessionGoalCallbacks {
  get(context: LiziMcpSessionContext): Promise<ControlResult<{ goal: MobileGoalStatusPayload | null }, string>>;
  update(context: LiziMcpSessionContext, objective: string): Promise<ControlResult<{ goal: MobileGoalStatusPayload }, string>>;
}

export function registerGoalTools(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  callbacks: SessionGoalCallbacks,
): void {
  const invoke = async (objective?: string) => {
    const context = getContext();
    if (!context.sessionId) return errorPayload('NO_SESSION_CONTEXT', '当前调用没有绑定 Cindy 任务。');
    const result = objective === undefined
      ? await callbacks.get(context)
      : await callbacks.update(context, objective);
    return result.ok
      ? okPayload({ session_id: context.sessionId, goal: result.goal })
      : errorPayload(result.errorCode, result.message);
  };
  registry.register({
    name: 'get_goal',
    category: 'control',
    description: 'Read the current task’s Goal Mode objective, status, counters and limits on the Cindy host. Returns goal=null when no goal exists. Read-only; does not start or resume work. Cannot target another task or computer.',
    inputShape: {},
    handler: () => invoke(),
  });
  registry.register({
    name: 'update_goal',
    category: 'control',
    description: 'Update the existing Goal Mode objective of the current task on the Cindy host during a session. Preserves limits and counters, records the edit and refreshes the existing goal UI. Changing a paused or blocked objective resumes it, matching the goal editor; usage-limit guards still apply. Future goal continuations use the new objective; the current turn is not interrupted or restarted. Does not create a goal or change the system prompt. Cannot target another task or computer. Use get_goal to inspect the result.',
    inputShape: { objective: z.string().trim().min(1).describe('Replacement goal prompt, including all requirements that must remain.') },
    handler: ({ objective }) => invoke(objective),
  });
}
