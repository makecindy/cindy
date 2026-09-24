import { describe, expect, it } from 'vitest';
import { sharedTaskErrorKey } from '../sharedTaskCompatibility';

describe('shared-task compatibility errors', () => {
  it.each([['SHARED_TASK_HOST_LIMIT', 'sharedTask.hostLimit'], ['SHARED_TASK_JOIN_LIMIT', 'sharedTask.joinLimit'],
    ['SHARED_TASK_GUEST_LIMIT', 'sharedTask.guestLimit']])('explains %s without suggesting retry', (code, key) => {
    expect(sharedTaskErrorKey(Object.assign(new Error('limit'), { code }))).toBe(key);
    expect(sharedTaskErrorKey(new Error('[' + code + '] limit'))).toBe(key);
  });
  it.each(['DEVICE_LINK_CHANNEL_NOT_ALLOWED', 'DEVICE_LINK_VERSION_MISMATCH', 'UNSUPPORTED_CAPABILITY'])(
    'recognizes serialized and structured %s', (code) => {
      expect(sharedTaskErrorKey(Object.assign(new Error('unsupported'), { code }))).toBe('sharedTask.upgrade');
      expect(sharedTaskErrorKey(new Error(`Error invoking remote method 'device-link:invoke': Error: [${code}] unsupported`))).toBe('sharedTask.upgrade');
    });
  it.each([['DEVICE_LINK_NOT_CONNECTED', 'sharedTask.connectionFailed'], ['DEVICE_LINK_TIMEOUT', 'sharedTask.requestTimedOut'],
    ['DEVICE_LINK_ACCESS_REVOKED', 'sharedTask.unavailable'], ['NOT_FOUND', 'sharedTask.unavailable'],
    ['PERMISSION_DENIED', 'sharedTask.permissionDenied']])(
    'explains %s without trusting the error body', (code, key) => {
      expect(sharedTaskErrorKey(new Error(`[${code}] DEVICE_LINK_CHANNEL_NOT_ALLOWED`))).toBe(key);
    });
  it.each([['NOT_FOUND', 'sharedTask.invitationUnavailable'], ['PERMISSION_DENIED', 'sharedTask.invitationRenew']])(
    'gives a new-invitation action for joining with %s', (code, key) => {
      expect(sharedTaskErrorKey(new Error(`Error invoking remote method 'shared-task:account': Error: [${code}] rejected`), 'join')).toBe(key);
    });
  it('does not infer a cause from arbitrary error text', () => {
    expect(sharedTaskErrorKey(new Error('NOT_FOUND NETWORK_ERROR'))).toBe('sharedTask.retry');
  });
});
