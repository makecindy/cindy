/** Transport codes and anchored serialized host IPC codes, never arbitrary text. */
export function sharedTaskErrorKey(error: unknown, context: 'join' | 'operation' = 'operation') {
  let code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === undefined || code === 'IPC_ERROR') {
    const message = error instanceof Error ? error.message : '';
    code = /^(?:Error invoking remote method '[^']+': Error: )?\[([A-Z0-9_]+)\]/.exec(message)?.[1];
  }
  if (code === 'NOT_FOUND') return context === 'join' ? 'sharedTask.invitationUnavailable' : 'sharedTask.unavailable';
  if (code === 'PERMISSION_DENIED') return context === 'join' ? 'sharedTask.invitationRenew' : 'sharedTask.permissionDenied';
  if (code === 'ACCESS_REVOKED' || code === 'DEVICE_LINK_ACCESS_REVOKED') return 'sharedTask.unavailable';
  if (code === 'NETWORK_UNAVAILABLE' || code === 'NETWORK_ERROR' || code === 'NOT_CONNECTED' || code === 'DEVICE_LINK_NOT_CONNECTED') return 'sharedTask.connectionFailed';
  if (code === 'REQUEST_TIMEOUT' || code === 'INVOKE_TIMEOUT' || code === 'DEVICE_LINK_TIMEOUT') return 'sharedTask.requestTimedOut';
  if (code === 'SHARED_TASK_HOST_LIMIT') return 'sharedTask.hostLimit';
  if (code === 'SHARED_TASK_JOIN_LIMIT') return 'sharedTask.joinLimit';
  if (code === 'SHARED_TASK_GUEST_LIMIT') return 'sharedTask.guestLimit';
  return code === 'CHANNEL_NOT_ALLOWED' || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
    || code === 'VERSION_MISMATCH' || code === 'DEVICE_LINK_VERSION_MISMATCH'
    || code === 'UNSUPPORTED_CAPABILITY' ? 'sharedTask.upgrade' : 'sharedTask.retry';
}
