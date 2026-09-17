import { describe, expect, it } from 'vitest';
import { sessionMeetingErrorKey } from '../device-link/sessionMeetingCompatibility';

describe('shared-task compatibility errors', () => {
  it.each(['CHANNEL_NOT_ALLOWED', 'VERSION_MISMATCH', 'DEVICE_LINK_CHANNEL_NOT_ALLOWED', 'UNSUPPORTED_CAPABILITY'])(
    'recognizes transport and serialized %s', (code) => {
      expect(sessionMeetingErrorKey({ code })).toBe('sessionMeeting.upgrade');
      expect(sessionMeetingErrorKey(Object.assign(new Error(`[${code}] unsupported`), { code: 'IPC_ERROR' }))).toBe('sessionMeeting.upgrade');
    });
  it.each(['NOT_CONNECTED', 'INVOKE_TIMEOUT', 'ACCESS_REVOKED', 'NOT_FOUND'])(
    'does not turn %s into an upgrade requirement', (code) => {
      expect(sessionMeetingErrorKey(Object.assign(new Error('[CHANNEL_NOT_ALLOWED]'), { code }))).toBe('sessionMeeting.retry');
    });
  it('does not match capability names inside unrelated error text', () => {
    expect(sessionMeetingErrorKey(new Error('[INTERNAL] CHANNEL_NOT_ALLOWED'))).toBe('sessionMeeting.retry');
  });
});
