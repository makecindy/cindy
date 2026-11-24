import type { AgentEvent, Session } from '@cindy/maker-core';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { rebroadcastTodaySpend, recordModelTurnUsage } from './turnUsagePorts.js';

const lastRecordedGeneration = new WeakMap<Session, number>();

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function recordSessionAcpTurnUsage(session: Session, event: AgentEvent, model: string): void {
  if (session.agentKind !== 'acp' || session.agentDeviceId || session.remoteHostId ||
      event.type !== 'done' || event.turnScope === 'background' || event.runtimeRecovery) return;
  const data = event.data as { type?: string; usage?: Record<string, unknown> } | undefined;
  if (data?.type !== 'acp/prompt_end' || !data.usage) return;
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = data.usage;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens) ||
      !isTokenCount(cacheReadTokens) || !isTokenCount(cacheCreationTokens)) return;

  const generation = event.sessionTurnGeneration ?? session.getTurnGeneration();
  if (generation <= (lastRecordedGeneration.get(session) ?? -1)) return;
  lastRecordedGeneration.set(session, generation);

  const scope = captureDataOwnerBroadcastScope();
  // ACP has already separated cache tokens from input in the prompt response.
  void recordModelTurnUsage({
    agentKind: 'acp',
    model: model.trim() || 'unknown',
    sessionId: session.id,
    inputTokensDelta: inputTokens,
    outputTokensDelta: outputTokens,
    cacheReadTokensDelta: cacheReadTokens,
    cacheCreateTokensDelta: cacheCreationTokens,
  }).then(() => rebroadcastTodaySpend(scope));
}
