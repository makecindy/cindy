/**
 * xdt-helper/report_turn.ts —— Lead 每轮收口交的回合声明。
 *
 * 宿主用它对自己的派发凭据对账：声明里说派了、凭据里没有，或凭据里有、声明没写，
 * 都算不一致。所以「说了但没派」在结构层就能被抓到，不靠读散文猜措辞。
 *
 * 口径：
 * - assignments 是「本轮我让谁做什么」，包括还没派出去的；
 * - dispatched 只写宿主已经接受的派发（直接/插话/进队列都算）；
 * - 派不出去的写进 pending，并说明在等什么，否则会被当成光说不做。
 *
 * 声明是必须交的：零派发也要交空数组，这样宿主才能区分「没派」和「没交」。
 */

import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface ReportTurnDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  reportLeadTurn: (params: {
    callerLeadSessionId: string;
    assignments: Array<{ workerId: string; taskSummary: string }>;
    dispatched: Array<{ workerId: string; messageId?: string }>;
    pending: Array<{ workerId: string; waitingFor: string }>;
  }) => Promise<ControlResult<{ workers: number }, 'NOT_FOUND'>>;
}

const assignmentSchema = z.object({
  worker_id: z.string().min(1).describe('Required. Target worker_id from list_workers or get_workspace_info.'),
  task_summary: z
    .string()
    .min(1)
    .describe('Required. One line describing the work you assigned, in the user words when possible.'),
});

const dispatchedSchema = z.object({
  worker_id: z.string().min(1).describe('Required. The worker this dispatch went to.'),
  message_id: z
    .string()
    .min(1)
    .optional()
    .describe('Optional. The queued_message_id returned by a queued send; omit for direct or steered delivery.'),
});

const pendingSchema = z.object({
  worker_id: z.string().min(1).describe('Required. The worker you assigned work to but did not dispatch to.'),
  waiting_for: z
    .string()
    .min(1)
    .describe('Required. What you are waiting for, e.g. a project path, a user confirmation, a missing target.'),
});

export function registerReportTurnTool(
  registry: XdtHelperToolRegistry,
  deps: ReportTurnDeps,
): void {
  registry.register({
    name: 'report_turn',
    category: 'control',
    description:
      'Required once before you end a turn in which you assigned work. Declare every assignment and every dispatch of this turn; the host reconciles it against its own dispatch records and asks you once to correct it if they disagree. Declaring an assignment you never dispatch (outside pending) is treated as claiming work you did not deliver.',
    inputShape: {
      assignments: z
        .array(assignmentSchema)
        .describe('Required. Every worker you assigned work to this turn. Empty array when you assigned nothing.'),
      dispatched: z
        .array(dispatchedSchema)
        .describe('Required. Every dispatch the host accepted this turn. Empty array when you dispatched nothing.'),
      pending: z
        .array(pendingSchema)
        .optional()
        .describe('Assignments you declared but did not dispatch, with what you are waiting for.'),
    },
    handler: async (args) => {
      const callerLeadSessionId = deps.getSessionContext?.().sessionId;
      if (!callerLeadSessionId) {
        return errorPayload('NOT_FOUND', 'No active Orca session for this call.');
      }

      const result = await deps.reportLeadTurn({
        callerLeadSessionId,
        assignments: args.assignments.map((entry) => ({ workerId: entry.worker_id, taskSummary: entry.task_summary })),
        dispatched: args.dispatched.map((entry) => ({ workerId: entry.worker_id, messageId: entry.message_id })),
        pending: (args.pending ?? []).map((entry) => ({ workerId: entry.worker_id, waitingFor: entry.waiting_for })),
      });

      if (!result.ok) {
        return errorPayload(result.errorCode, 'Only a Lead session that owns workers can report a turn.');
      }

      return okPayload({
        recorded: true,
        workers: result.workers,
        message:
          'Declaration recorded. The host reconciles it against its own dispatch records before this turn settles.',
      });
    },
  });
}
