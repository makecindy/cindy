/** Transport codes and anchored serialized host IPC codes, never arbitrary text. */
export function sessionMeetingErrorKey(error: unknown): 'sessionMeeting.upgrade' | 'sessionMeeting.retry' {
  let code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === undefined || code === 'IPC_ERROR') {
    const message = error instanceof Error ? error.message : '';
    code = /^(?:Error invoking remote method '[^']+': Error: )?\[([A-Z0-9_]+)\]/.exec(message)?.[1];
  }
  return code === 'CHANNEL_NOT_ALLOWED' || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
    || code === 'VERSION_MISMATCH' || code === 'DEVICE_LINK_VERSION_MISMATCH'
    || code === 'UNSUPPORTED_CAPABILITY' ? 'sessionMeeting.upgrade' : 'sessionMeeting.retry';
}
