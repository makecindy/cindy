/** Device-local microphone ownership shared with dictation, including its global shortcut. */
let owner: string | null = null;
export function hasVoiceConversationLease(): boolean {
  return owner !== null;
}
export function acquireVoiceConversationLease(callId: string): boolean {
  if (owner !== null) return false;
  owner = callId;
  return true;
}
export function releaseVoiceConversationLease(callId: string): void {
  if (owner === callId) owner = null;
}
