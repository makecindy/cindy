import { isTerminalAgentErrorEvent, type AgentEvent, type Session } from '@cindy/maker-core';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { rebroadcastTodaySpend, recordModelTurnUsage } from '../usageBroadcaster.js';
import { mayRecordTurnUsage } from '../usage/turnUsageAdmission.js';

const lastRecordedGeneration = new WeakMap<Session, number>();

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function recordSessionAcpTurnUsage(session: Session, event: AgentEvent): void {
  // The controller owns the task ledger even when another device hosts its engine.
  if (session.agentKind !== 'acp' || session.remoteHostId ||
      (event.type !== 'done' && !isTerminalAgentErrorEvent(event)) || event.turnScope === 'background' || event.runtimeRecovery) return;
  const data = event.data as { type?: string; usage?: Record<string, unknown>; usageModel?: unknown } | undefined;
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
  void recordModelTurnUsage({
    agentKind: 'acp',
    model: (typeof data.usageModel === 'string' && data.usageModel.trim()) || 'unknown',
    sessionId: session.id,
    inputTokensDelta: inputTokens,
    outputTokensDelta: outputTokens,
    cacheReadTokensDelta: cacheReadTokens,
    cacheCreateTokensDelta: cacheCreationTokens,
  }).then(() => {
    if (mayRecordTurnUsage()) return rebroadcastTodaySpend(scope);
  });
}
