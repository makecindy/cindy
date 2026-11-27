import { isTerminalAgentErrorEvent, type AgentEvent, type Session } from '@cindy/maker-core';
import type { RegionalMoney } from '../../shared/regionalMoney.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { rebroadcastTodaySpend, recordModelTurnUsage } from '../usageBroadcaster.js';
import { mayRecordTurnUsage } from '../usage/turnUsageAdmission.js';

function referenceValue(raw: unknown, tokens: number[]): RegionalMoney | undefined {
  if (!raw || typeof raw !== 'object') return;
  const price = raw as Record<string, unknown>;
  if (price.currency !== 'USD' && price.currency !== 'CNY') return;
  const rates = [price.inputPerMtok, price.outputPerMtok, price.cacheReadPerMtok, price.cacheWritePerMtok];
  let amount = 0;
  for (const [index, count] of tokens.entries()) {
    if (count === 0) continue;
    const rate = rates[index];
    if (!isTokenCount(rate)) return;
    amount += count / 1_000_000 * rate;
  }
  if (!Number.isFinite(amount)) return;
  return { amount, currency: price.currency, approximate: true, kind: 'value-estimate', estimateReasons: ['reference-price'] };
}

const lastRecordedGeneration = new WeakMap<Session, number>();

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function usageDelta(raw: unknown) {
  if (!raw || typeof raw !== 'object') return;
  const data = raw as { usage?: Record<string, unknown>; usageModel?: unknown; usagePrice?: unknown };
  if (!data.usage) return;
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = data.usage;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens) ||
      !isTokenCount(cacheReadTokens) || !isTokenCount(cacheCreationTokens)) return;
  const model = typeof data.usageModel === 'string' ? data.usageModel.trim() : '';
  return {
    model: model || 'unknown',
    money: model ? referenceValue(data.usagePrice, [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens]) : undefined,
    inputTokensDelta: inputTokens,
    outputTokensDelta: outputTokens,
    cacheReadTokensDelta: cacheReadTokens,
    cacheCreateTokensDelta: cacheCreationTokens,
  };
}

export function recordSessionAcpTurnUsage(session: Session, event: AgentEvent): void {
  // The controller owns the task ledger even when another device hosts its engine.
  if (session.agentKind !== 'acp' || session.remoteHostId ||
      (event.type !== 'done' && !isTerminalAgentErrorEvent(event)) || event.turnScope === 'background' || event.runtimeRecovery) return;
  const data = event.data as { type?: string; usageParts?: unknown } | undefined;
  if (data?.type !== 'acp/prompt_end') return;
  const total = usageDelta(data);
  if (!total) return;
  let deltas = [total];
  // A verification continuation can change the model or quote. The two receipts must cover the reported total.
  if (Array.isArray(data.usageParts) && data.usageParts.length === 2) {
    const [first, second] = data.usageParts.map(usageDelta);
    if (first && second && (['inputTokensDelta', 'outputTokensDelta', 'cacheReadTokensDelta', 'cacheCreateTokensDelta'] as const)
      .every(key => first[key] + second[key] === total[key])) deltas = [first, second];
  }

  const generation = event.sessionTurnGeneration ?? session.getTurnGeneration();
  if (generation <= (lastRecordedGeneration.get(session) ?? -1)) return;
  lastRecordedGeneration.set(session, generation);

  const scope = captureDataOwnerBroadcastScope();
  // ACP has already separated cache tokens from input in the prompt response.
  if (!mayRecordTurnUsage()) return;
  void Promise.all(deltas.map(delta => recordModelTurnUsage({
    ...delta, agentKind: 'acp', sessionId: session.id,
  }))).then(() => {
    if (mayRecordTurnUsage()) return rebroadcastTodaySpend(scope);
  });
}
