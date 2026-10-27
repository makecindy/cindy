import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface TaskDeliveryCallbacks {
  report(sessionId: string, finalDelivery: boolean, sessionInstanceId?: string): { ok: true } | { ok: false; errorCode: string; message: string };
}

export function registerTaskDeliveryTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  callbacks: TaskDeliveryCallbacks,
): void {
  registry.register({
    name: 'report_task_delivery',
    category: 'cindy',
    description: 'Before the final answer in each followed task turn, report whether this turn newly delivers the requested result. PR delivered for human review, merged/closed, or task goal achieved: true. Intermediate review fixes, waiting for CI, or repeated status: false. A true report followed by normal completion notifies the following teammate. Current task executor only; this neither ends the turn nor sends a message.',
    inputShape: { final_delivery: z.boolean() },
    handler: async ({ final_delivery }) => {
      const context = getContext();
      if (!context.sessionId) return errorPayload('NO_SESSION_CONTEXT', 'No current task.');
      if (context.mcpCallerKind === 'descendant') return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Only the task executor can report delivery.');
      const result = callbacks.report(context.sessionId, final_delivery, context.sessionInstanceId);
      return result.ok ? okPayload({ recorded: true }) : errorPayload(result.errorCode, result.message);
    },
  });
}
