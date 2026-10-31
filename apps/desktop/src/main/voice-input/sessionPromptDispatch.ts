import type { SessionVoicePromptResult } from '../../shared/sessionVoicePrompt.js';

export interface SessionVoicePromptDispatchInput {
  sessionId: string;
  sourceDeviceId: string | null;
  text: string;
  clientId: string;
  assertCurrent(): void;
}

type Dispatcher = (input: SessionVoicePromptDispatchInput) => Promise<SessionVoicePromptResult>;

let dispatcher: Dispatcher | null = null;

export function setSessionVoicePromptDispatcher(next: Dispatcher): void {
  dispatcher = next;
}

export async function dispatchSessionVoicePrompt(
  input: SessionVoicePromptDispatchInput,
): Promise<SessionVoicePromptResult> {
  if (!dispatcher) return { ok: false, errorCode: 'SEND_FAILED' };
  try {
    input.assertCurrent();
    return await dispatcher(input);
  } catch {
    return { ok: false, errorCode: 'SEND_FAILED' };
  }
}
