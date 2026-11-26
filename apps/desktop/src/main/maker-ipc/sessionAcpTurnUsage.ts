import type { RegionalMoney } from '../../shared/regionalMoney.js';
import type { AgentEvent, Session } from '@cindy/maker-core';
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

export function recordSessionAcpTurnUsage(session: Session, event: AgentEvent): void {
  // The controller owns the task ledger even when another device hosts its engine.
  if (session.agentKind !== 'acp' || session.remoteHostId ||
      event.type !== 'done' || event.turnScope === 'background' || event.runtimeRecovery) return;
  const data = event.data as { type?: string; usage?: Record<string, unknown>; usageModel?: unknown; usagePrice?: unknown } | undefined;
  if (data?.type !== 'acp/prompt_end' || !data.usage) return;
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = data.usage;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens) ||
      !isTokenCount(cacheReadTokens) || !isTokenCount(cacheCreationTokens)) return;

  const generation = event.sessionTurnGeneration ?? session.getTurnGeneration();
  if (generation <= (lastRecordedGeneration.get(session) ?? -1)) return;
  lastRecordedGeneration.set(session, generation);

  const scope = captureDataOwnerBroadcastScope();
  // ACP has already separated cache tokens from input in the prompt response.
  if (!mayRecordTurnUsage()) return;
  const model = typeof data.usageModel === 'string' ? data.usageModel.trim() : '';
  void recordModelTurnUsage({
    agentKind: 'acp',
    model: model || 'unknown',
    money: model
      ? referenceValue(data.usagePrice, [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens]) : undefined,
    sessionId: session.id,
    inputTokensDelta: inputTokens,
    outputTokensDelta: outputTokens,
    cacheReadTokensDelta: cacheReadTokens,
    cacheCreateTokensDelta: cacheCreationTokens,
  }).then(() => {
    if (mayRecordTurnUsage()) return rebroadcastTodaySpend(scope);
  });
}
