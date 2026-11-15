import type { Session } from '@cindy/maker-core';
import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export type AskUserQuestionAsyncCallback = (
  context: LiziMcpSessionContext,
  questions: Parameters<Session['askUserQuestionAsync']>[0],
) => ReturnType<Session['askUserQuestionAsync']>;

export type ManageUserQuestionsCallback = (
  context: LiziMcpSessionContext,
  input: Parameters<Session['manageAsyncUserQuestions']>[0],
) => ReturnType<Session['manageAsyncUserQuestions']>;

/** Dedicated root-only capability, including Codex questions created through its native tool. */
export function registerManageUserQuestionsTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext | undefined,
  manage: ManageUserQuestionsCallback,
  getSurface: () => Promise<ReadonlySet<string> | null>,
): void {
  registry.register({
    name: 'manage_user_questions', category: 'cindy',
    description: 'List or withdraw your current task’s unanswered asynchronous questions, including native Codex questions. '
      + 'Before finishing, review pending questions: keep those whose answers still help; withdraw only questions made obsolete by completed work, new evidence or changed scope. '
      + 'Execution ending or elapsed time alone does not make a question obsolete. Use the per-question request_ids from the ask receipt, or list to obtain them (including native Codex questions), then withdraw with a short user-facing reason in the user’s language. '
      + 'Withdrawal leaves history, preserves drafts for optional supplemental sending, and never assumes an answer or starts work. Answers already being submitted take priority. Not for permissions, approvals or synchronous questions.',
    inputShape: {
      action: z.enum(['list', 'withdraw']),
      request_ids: z.array(z.string().trim().min(1)).min(1).optional(),
      reason: z.string().trim().min(1).max(200).optional(),
    },
    handler: async ({ action, request_ids, reason }) => {
      const context = getContext();
      if (!context?.sessionId || !context.sessionInstanceId) return errorPayload('NO_SESSION_CONTEXT', 'No current task instance.');
      const surface = await getSurface();
      if (!['codex', 'claude-code', 'pi'].includes(context.agentKind ?? '') || (surface && !surface.has('cindy'))) {
        return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Question management is unavailable in this task.');
      }
      if (context.mcpCallerKind !== 'root' || context.mcpCallerAttested !== true) return errorPayload('ROOT_REQUIRED', 'Ask the parent agent to manage its questions.');
      if (action === 'withdraw' && (!request_ids?.length || !reason)) return errorPayload('INVALID_ARGS', 'Withdrawal requires request_ids and a user-facing reason.');
      if (action === 'list' && (request_ids || reason)) return errorPayload('INVALID_ARGS', 'List takes no request_ids or reason.');
      try {
        return okPayload(manage(context, action === 'list' ? { action } : { action, request_ids: request_ids!, reason: reason! }));
      } catch {
        return errorPayload('QUESTION_UNAVAILABLE', 'The current task instance is no longer active.');
      }
    },
  });
}

// Codex owns async questions through its native protocol. Exposing this second
// path there would give the same card two independent lifecycle owners.
export function supportsAsyncQuestionTool(context: LiziMcpSessionContext): boolean {
  return context.agentKind === 'claude-code' || context.agentKind === 'pi';
}

export function registerAsyncQuestionTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext | undefined,
  ask: AskUserQuestionAsyncCallback,
  getSurface: () => Promise<ReadonlySet<string> | null>,
): void {
  registry.register({
    name: 'ask_user_question_async',
    category: 'cindy',
    description: 'Ask questions in Cindy cards and immediately continue independent work. '
      + 'This returns per-question request_ids and the task’s pending_count, not an answer. Users can answer or skip each question independently; answers arrive as user input. '
      + 'Unanswered questions remain available after execution ends; a later answer can start a new turn. Never infer a choice. '
      + 'Use manage_user_questions to review pending questions and withdraw obsolete ones before finishing. '
      + 'Use your synchronous question tool when work must wait for the answer. Not for permissions or approvals.',
    inputShape: {
      questions: z.array(z.object({
        question: z.string().trim().min(1),
        options: z.array(z.object({
          label: z.string().trim().min(1),
          description: z.string().optional(),
        }).strict()).min(1).optional(),
      }).strict()).min(1),
    },
    handler: async ({ questions }) => {
      const context = getContext();
      if (!context?.sessionId || !context.sessionInstanceId) {
        return errorPayload('NO_SESSION_CONTEXT', 'No current task instance for this question.');
      }
      if (!supportsAsyncQuestionTool(context)) {
        return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Use your native question tool.');
      }
      const surface = await getSurface();
      if (surface && !surface.has('cindy')) {
        return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Async questions are not available in this task.');
      }
      if (context.mcpCallerKind !== 'root' || context.mcpCallerAttested !== true) {
        return errorPayload('ROOT_REQUIRED', 'Ask the parent agent to relay the question.');
      }
      try {
        const receipt = ask(context, questions);
        return okPayload({ ...receipt, status: 'pending' });
      } catch {
        return errorPayload('QUESTION_UNAVAILABLE', 'No active task with question UI and same-turn input support.');
      }
    },
  });
}
