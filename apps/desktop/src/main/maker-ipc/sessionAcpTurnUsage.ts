import type { AgentEvent, Session } from '@cindy/maker-core';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import { rebroadcastTodaySpend, recordModelTurnUsage } from '../usageBroadcaster.js';
import { mayRecordTurnUsage } from '../usage/turnUsageAdmission.js';

const lastRecordedGeneration = new WeakMap<Session, number>();

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function recordSessionAcpTurnUsage(
  session: Session,
  event: AgentEvent,
  turnAssistantPersistId?: string | null,
): void {
  // The controller owns the task ledger even when another device hosts its engine.
  if (session.agentKind !== 'acp' || session.remoteHostId ||
      event.type !== 'done' || event.turnScope === 'background' || event.runtimeRecovery) return;
  const data = event.data as {
    type?: string;
    usage?: Record<string, unknown>;
    usageModel?: unknown;
  } | undefined;
  if (data?.type !== 'acp/prompt_end' || !data.usage) return;

  const generation = event.sessionTurnGeneration ?? session.getTurnGeneration();
  if (generation <= (lastRecordedGeneration.get(session) ?? -1)) return;
  lastRecordedGeneration.set(session, generation);

  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, durationMs, turnDurationMs, generationTrace } = data.usage;
  const hasFullTokens = isTokenCount(inputTokens) && isTokenCount(outputTokens)
    && isTokenCount(cacheReadTokens) && isTokenCount(cacheCreationTokens);
  const model = (typeof data.usageModel === 'string' && data.usageModel.trim()) || undefined;

  if (turnAssistantPersistId) {
    const turnUsageDetails = buildTurnUsageDetails({
      ...(hasFullTokens
        ? { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens: cacheCreationTokens }
        : {}),
      ...(model ? { model } : {}),
      ...(isPositiveMs(durationMs) ? { durationMs } : {}),
      ...(isPositiveMs(turnDurationMs) ? { turnDurationMs } : {}),
      ...(generationTrace && typeof generationTrace === 'object'
        ? { trace: generationTrace as Parameters<typeof buildTurnUsageDetails>[0]['trace'] }
        : {}),
    });
    if (turnUsageDetails) {
      void recordTurnUsageOnMessage({
        sessionId: session.id,
        clientId: turnAssistantPersistId,
        turnUsageDetails,
      });
    }
  }

  if (!hasFullTokens) return;

  const scope = captureDataOwnerBroadcastScope();
  // ACP has already separated cache tokens from input in the prompt response.
  if (!mayRecordTurnUsage()) return;
  void recordModelTurnUsage({
    agentKind: 'acp',
    model: model || 'unknown',
    sessionId: session.id,
    inputTokensDelta: inputTokens,
    outputTokensDelta: outputTokens,
    cacheReadTokensDelta: cacheReadTokens,
    cacheCreateTokensDelta: cacheCreationTokens,
  }).then(() => {
    if (mayRecordTurnUsage()) return rebroadcastTodaySpend(scope);
  });
}
