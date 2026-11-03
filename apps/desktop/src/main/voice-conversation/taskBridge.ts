import type { AgentRequestReceipt } from '../../shared/forwardedRequest.js';

type Dispatch = (input: {
  targetSessionId: string;
  clientId: string;
  message: string;
  persistedContent: string;
  autoReviewUserText: AgentRequestReceipt;
  resumeWithStoredPermissionMode: true;
  authorizationGuard: { validate(): Promise<void>; assertCurrent(): void };
}) => Promise<{ ok: boolean }>;

let dispatch: Dispatch | undefined;
let readMemory: ((botId: string) => Promise<string>) | undefined;
/** Reverse dependency: use the canonical task queue, never create another executor. */
export function setVoiceTaskDispatch(value: Dispatch): void {
  dispatch = value;
}
export function setVoiceCallMemoryReader(value: (botId: string) => Promise<string>): void {
  readMemory = value;
}
export async function readVoiceCallMemory(botId: string): Promise<string> {
  return (await readMemory?.(botId)) ?? '';
}
export async function dispatchVoiceTask(input: Parameters<Dispatch>[0]): Promise<boolean> {
  if (!dispatch) return false;
  return (await dispatch(input)).ok;
}
