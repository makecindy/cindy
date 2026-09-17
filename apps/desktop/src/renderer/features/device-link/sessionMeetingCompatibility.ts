import { extractIpcError } from '@/utils/ipcError';

/** Only explicit capability failures imply an upgrade; offline is retryable. */
export function sessionMeetingErrorKey(error: unknown): 'sessionMeeting.upgrade' | 'sessionMeeting.retry' {
  const code = extractIpcError(error)?.code;
  return code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'DEVICE_LINK_VERSION_MISMATCH'
    || code === 'UNSUPPORTED_CAPABILITY' ? 'sessionMeeting.upgrade' : 'sessionMeeting.retry';
}
