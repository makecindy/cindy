import { extractIpcError } from '@/utils/ipcError';

/** Only explicit capability failures imply an upgrade; offline is retryable. */
export function sharedTaskErrorKey(error: unknown, context: 'join' | 'operation' = 'operation') {
  const code = extractIpcError(error)?.code;
  if (code === 'NOT_FOUND') return context === 'join' ? 'sharedTask.invitationUnavailable' : 'sharedTask.unavailable';
  if (code === 'PERMISSION_DENIED') return context === 'join' ? 'sharedTask.invitationRenew' : 'sharedTask.permissionDenied';
  if (code === 'DEVICE_LINK_ACCESS_REVOKED') return 'sharedTask.unavailable';
  if (code === 'DEVICE_LINK_NOT_CONNECTED') return 'sharedTask.connectionFailed';
  if (code === 'DEVICE_LINK_TIMEOUT') return 'sharedTask.requestTimedOut';
  if (code === 'SHARED_TASK_HOST_LIMIT') return 'sharedTask.hostLimit';
  if (code === 'SHARED_TASK_JOIN_LIMIT') return 'sharedTask.joinLimit';
  if (code === 'SHARED_TASK_GUEST_LIMIT') return 'sharedTask.guestLimit';
  return code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'DEVICE_LINK_VERSION_MISMATCH'
    || code === 'UNSUPPORTED_CAPABILITY' ? 'sharedTask.upgrade' : 'sharedTask.retry';
}
