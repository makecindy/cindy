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

const PLAN_DECISION_TIMEOUT_MS = 20_000;
const PLAN_DECISION_MAX_TOKENS = 800;

export function createBotGroupPlanDecider(
  requestText: (prompt: string, opts: UtilityTextRequestOptions) => Promise<UtilityTextResult>,
) {
  return async (input: PlanDecisionInput, signal: AbortSignal): Promise<PlanDecision | null> => {
    const memberIds = new Set(input.members.map((member) => member.botId));
    const result = await requestText(buildPlanDecisionPrompt(input), {
      systemPrompt: PLAN_DECISION_SYSTEM_PROMPT,
      maxTokens: PLAN_DECISION_MAX_TOKENS,
      timeoutMs: PLAN_DECISION_TIMEOUT_MS,
      disableReasoning: true,
      signal,
      validateResponse: (text) => parsePlanDecision(text, input.mode, memberIds) !== null,
      beforeDispatch: async () => !signal.aborted,
    });
    return result.ok ? parsePlanDecision(result.text, input.mode, memberIds) : null;
  };
}
