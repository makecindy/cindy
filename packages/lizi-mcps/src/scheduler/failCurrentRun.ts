/** Report a business assertion failure for the caller's current scheduler run. */
import { z } from 'zod';

import { withScheduler } from './_shared.js';
import type { LiziMcpSessionContext, SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerScheduleFailCurrentRunTool(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
  getSessionContext?: () => LiziMcpSessionContext,
): void {
  registry.register({
    name: 'schedule_fail_current_run',
    category: 'scheduler',
    description: 'Report a business failure for this session’s current in-flight schedule run. The caller cannot choose a run id. The run finishes as failed, even if the agent turn otherwise succeeds.',
    inputShape: {
      code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).describe('Stable machine-readable failure code, 2–64 uppercase characters.'),
      message: z.string().trim().min(1).max(500).describe('Short human-readable reason. Do not include secrets.'),
    },
    handler: async ({ code, message }) =>
      withScheduler(deps, async (scheduler) => {
        const sessionId = getSessionContext?.().sessionId;
        if (!sessionId) throw new Error('current scheduler session not found');
        if (!scheduler.reportFailureForSession(sessionId, { code, message })) {
          throw new Error('in-flight run not found for current session');
        }
        return { reported: true };
      }),
  });
}
