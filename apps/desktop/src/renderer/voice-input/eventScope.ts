import type { VoiceInputRendererEvent, VoiceInputState } from '@cindy/voice-input-core';

export function isVoiceInputEventScopeActive(state: VoiceInputState): boolean {
  return state === 'listening' || state === 'submitting' || state === 'refining';
}

export function shouldHandleVoiceInputEvent(
  ownedRunId: string | null,
  eventRunId: string,
): boolean {
  return ownedRunId !== null && eventRunId === ownedRunId;
}

/** Bind early IPC events to the start result, never to an unowned listening UI. */
export function dispatchVoiceInputEvent(
  event: VoiceInputRendererEvent,
  getOwnedRunId: () => string | null,
  pendingStart: Promise<{ ok: true; runId: string } | { ok: false }> | undefined,
  handleEvent: (event: VoiceInputRendererEvent) => void,
): void {
  const ownedRunId = getOwnedRunId();
  if (ownedRunId) {
    if (shouldHandleVoiceInputEvent(ownedRunId, event.runId)) handleEvent(event);
    return;
  }
  // Reuse the attempt's existing readiness promise. In particular, cancelling
  // an older run can emit done while the next microphone awaits its own run ID.
  void pendingStart?.then((result) => {
    if (result.ok && result.runId === event.runId &&
        shouldHandleVoiceInputEvent(getOwnedRunId(), event.runId)) {
      handleEvent(event);
    }
  });
}
