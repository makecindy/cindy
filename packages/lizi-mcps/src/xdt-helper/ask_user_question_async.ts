import type { Session } from '@cindy/maker-core';
import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export type AskUserQuestionAsyncCallback = (
  context: LiziMcpSessionContext,
  questions: Parameters<Session['askUserQuestionAsync']>[0],
) => string;

// Codex owns async questions through its native protocol. Exposing this second
// path there would give the same card two independent lifecycle owners.
export function supportsAsyncQuestionTool(context: LiziMcpSessionContext): boolean {
  return context.agentKind === 'claude-code' || context.agentKind === 'pi';
}

export function registerAsyncQuestionTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  ask: AskUserQuestionAsyncCallback,
): void {
  registry.register({
    name: 'ask_user_question_async',
    category: 'cindy',
    description: 'Ask optional questions in Cindy cards and immediately continue independent work. '
      + 'This returns a pending receipt, not an answer. User answers arrive as same-turn input. '
      + 'Unanswered questions expire when execution ends; never infer a choice. '
      + 'Use your synchronous question tool when work must wait for the answer. Not for permissions or approvals.',
    inputShape: {
      questions: z.array(z.object({
        question: z.string().trim().min(1).max(2000),
        options: z.array(z.object({
          label: z.string().trim().min(1).max(256),
          description: z.string().max(1000).optional(),
        }).strict()).min(2).max(6).optional(),
      }).strict()).min(1).max(3).refine(
        (questions) => new Set(questions.map((q) => q.question)).size === questions.length,
        'Questions must be distinct',
      ),
    },
    handler: async ({ questions }) => {
      const context = getContext();
      if (!context.sessionId || !context.sessionInstanceId) {
        return errorPayload('NO_SESSION_CONTEXT', 'No current task instance for this question.');
      }
      if (!supportsAsyncQuestionTool(context)) {
        return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Use your native question tool.');
      }
      if (context.mcpCallerKind !== 'root' || context.mcpCallerAttested !== true) {
        return errorPayload('ROOT_REQUIRED', 'Ask the parent agent to relay the question.');
      }
      try {
        const requestId = ask(context, questions);
        return okPayload({ request_id: requestId, status: 'pending' });
      } catch {
        return errorPayload('QUESTION_UNAVAILABLE', 'No active task with question UI and same-turn input support.');
      }
    },
  });
}
