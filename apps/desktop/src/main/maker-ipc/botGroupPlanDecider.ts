/**
 * The organizer's forced 要不要分工 decision on Cindy's auxiliary model chain
 * (docs/product-rules/bot-group-chat.md §7.2). A reply that fails validation makes
 * the chain try its next candidate; nothing usable means null.
 */

import type { UtilityTextRequestOptions } from '../utility-model/oneShotCandidates.js';
import type { UtilityTextResult } from '../../shared/utilityTextResult.js';
import {
  buildPlanDecisionPrompt,
  parsePlanDecision,
  PLAN_DECISION_SYSTEM_PROMPT,
  type PlanDecision,
  type PlanDecisionInput,
} from './botGroupDivision.js';

/**
 * The automatic decision gates every unaddressed message: its replies wait until it answers.
 * It is therefore bounded to 8 seconds in total: the first candidate gets at most 5 seconds,
 * whatever remains (about 3 seconds) is left for a fallback, and no candidate is dispatched
 * after the budget. Running out counts as 「不要」 like any other failure, so the message is
 * answered as an ordinary discussion (the rule itself is unchanged).
 */
export const AUTO_PLAN_DECISION_CANDIDATE_TIMEOUT_MS = 5_000;
export const AUTO_PLAN_DECISION_BUDGET_MS = 8_000;
/**
 * An explicit 分工 request (or revising a proposal) must produce steps and the user is waiting for
 * exactly that, so it keeps the longer per-candidate budget.
 */
const EXPLICIT_PLAN_DECISION_TIMEOUT_MS = 20_000;
const PLAN_DECISION_MAX_TOKENS = 800;

export function createBotGroupPlanDecider(
  requestText: (prompt: string, opts: UtilityTextRequestOptions) => Promise<UtilityTextResult>,
) {
  return async (input: PlanDecisionInput, signal: AbortSignal): Promise<PlanDecision | null> => {
    const memberIds = new Set(input.members.map((member) => member.botId));
    const automatic = input.mode === 'auto';
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    const budget = automatic ? setTimeout(abort, AUTO_PLAN_DECISION_BUDGET_MS) : undefined;
    try {
      const result = await requestText(buildPlanDecisionPrompt(input), {
        systemPrompt: PLAN_DECISION_SYSTEM_PROMPT,
        maxTokens: PLAN_DECISION_MAX_TOKENS,
        timeoutMs: automatic ? AUTO_PLAN_DECISION_CANDIDATE_TIMEOUT_MS : EXPLICIT_PLAN_DECISION_TIMEOUT_MS,
        disableReasoning: true,
        signal: controller.signal,
        validateResponse: (text) => parsePlanDecision(text, input.mode, memberIds) !== null,
        beforeDispatch: async () => !controller.signal.aborted,
      });
      return result.ok && !controller.signal.aborted ? parsePlanDecision(result.text, input.mode, memberIds) : null;
    } finally {
      clearTimeout(budget);
      signal.removeEventListener('abort', abort);
    }
  };
}
