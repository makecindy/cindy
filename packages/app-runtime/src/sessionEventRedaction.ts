import type { AgentEvent } from '@cindy/maker-core';
import { redactToolInputForUntrustedBoundary } from '@cindy/remote-agent/host/toolInputRedaction';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
export function redactEventForRenderer(event: AgentEvent): AgentEvent {
  // These are main/maker-core lifecycle fields, not renderer data. Keep them on the main-side
  // event used for bookkeeping but never expose them through the raw renderer channel.
  const rendererEvent = { ...event };
  delete rendererEvent.turnAttemptToken;
  delete rendererEvent.backgroundTurnStartedAt;
  delete rendererEvent.sessionTurnGeneration;
  delete rendererEvent.sessionInstanceId;
  delete rendererEvent.runtimeRecovery;
  if (!event.data || typeof event.data !== 'object') return rendererEvent;

  const data = event.data as Record<string, unknown>;
  const safeData = { ...data };
  let changed = false;
  if ('processMedia' in safeData) {
    delete safeData.processMedia;
    changed = true;
  }
  if (
    typeof safeData.toolName === 'string' &&
    Object.prototype.hasOwnProperty.call(safeData, 'input')
  ) {
    const redactedInput = redactToolInputForUntrustedBoundary(safeData.toolName, safeData.input);
    if (redactedInput !== safeData.input) {
      safeData.input = redactedInput;
      changed = true;
    }
  }
  // Main consumes this Cindy-owned durable projection marker before the event
  // crosses renderer/device-link boundaries. Live task-card payloads therefore
  // keep their existing wire shape and older mobile clients need no upgrade.
  if (event.type === 'agent_task_update') {
    for (const key of [
      'subagentObservation',
      'subagentParentContext',
      'returnedResult',
      'returnedResultEmpty',
      'returnedResultTruncated',
    ]) {
      if (!(key in safeData)) continue;
      delete safeData[key];
      changed = true;
    }
  }
  for (const key of ['message', 'sdkError'] as const) {
    if (typeof safeData[key] === 'string') {
      const redacted = redactSensitiveText(safeData[key]);
      if (redacted !== safeData[key]) {
        safeData[key] = redacted;
        changed = true;
      }
    }
  }

  if (event.type === 'done' && safeData.raw && typeof safeData.raw === 'object') {
    const raw = { ...(safeData.raw as Record<string, unknown>) };
    if (raw.error && typeof raw.error === 'object') {
      const error = { ...(raw.error as Record<string, unknown>) };
      for (const key of ['message', 'detail', 'sdkError', 'additionalDetails'] as const) {
        if (typeof error[key] === 'string') {
          const redacted = redactSensitiveText(error[key]);
          if (redacted !== error[key]) {
            error[key] = redacted;
            changed = true;
          }
        }
      }
      raw.error = error;
    }
    safeData.raw = raw;
  }

  return changed ? ({ ...rendererEvent, data: safeData } as AgentEvent) : rendererEvent;
}
