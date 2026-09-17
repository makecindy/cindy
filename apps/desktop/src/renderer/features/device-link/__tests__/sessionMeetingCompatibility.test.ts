import { describe, expect, it } from 'vitest';
import { sessionMeetingErrorKey } from '../sessionMeetingCompatibility';

describe('shared-task compatibility errors', () => {
  it.each(['DEVICE_LINK_CHANNEL_NOT_ALLOWED', 'DEVICE_LINK_VERSION_MISMATCH', 'UNSUPPORTED_CAPABILITY'])(
    'recognizes serialized and structured %s', (code) => {
      expect(sessionMeetingErrorKey(Object.assign(new Error('unsupported'), { code }))).toBe('sessionMeeting.upgrade');
      expect(sessionMeetingErrorKey(new Error(`Error invoking remote method 'device-link:invoke': Error: [${code}] unsupported`))).toBe('sessionMeeting.upgrade');
    });
  it.each(['DEVICE_LINK_NOT_CONNECTED', 'DEVICE_LINK_TIMEOUT', 'DEVICE_LINK_ACCESS_REVOKED', 'NOT_FOUND'])(
    'does not turn %s into an upgrade requirement', (code) => {
      expect(sessionMeetingErrorKey(new Error(`[${code}] DEVICE_LINK_CHANNEL_NOT_ALLOWED`))).toBe('sessionMeeting.retry');
    });
});
