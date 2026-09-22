import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetchRaw } from '../api/client';
import { sharedTaskErrorKey } from '../device-link/sharedTaskCompatibility';

describe('shared-task compatibility errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('explains native network failures from the shared-task HTTP request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network request failed')));
    const error = await apiFetchRaw('/api/device-link/shared-tasks/join', {
      baseUrl: 'https://relay.example.invalid',
      method: 'POST',
      body: { invitation: 'a'.repeat(43), displayName: 'Guest' },
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'NETWORK_UNAVAILABLE', status: 0 });
    expect(sharedTaskErrorKey(error, 'join')).toBe('sharedTask.connectionFailed');
    expect(sharedTaskErrorKey(error)).toBe('sharedTask.connectionFailed');
  });

  it.each([['SHARED_TASK_HOST_LIMIT', 'sharedTask.hostLimit'], ['SHARED_TASK_JOIN_LIMIT', 'sharedTask.joinLimit'],
    ['SHARED_TASK_GUEST_LIMIT', 'sharedTask.guestLimit']])('explains direct API and remote host %s', (code, key) => {
    expect(sharedTaskErrorKey({ code })).toBe(key);
    expect(sharedTaskErrorKey(Object.assign(new Error('[' + code + '] limit'), { code: 'IPC_ERROR' }))).toBe(key);
  });
  it.each(['CHANNEL_NOT_ALLOWED', 'VERSION_MISMATCH', 'DEVICE_LINK_CHANNEL_NOT_ALLOWED', 'UNSUPPORTED_CAPABILITY'])(
    'recognizes transport and serialized %s', (code) => {
      expect(sharedTaskErrorKey({ code })).toBe('sharedTask.upgrade');
      expect(sharedTaskErrorKey(Object.assign(new Error(`[${code}] unsupported`), { code: 'IPC_ERROR' }))).toBe('sharedTask.upgrade');
    });
  it.each([['NOT_CONNECTED', 'sharedTask.connectionFailed'], ['NETWORK_ERROR', 'sharedTask.connectionFailed'],
    ['INVOKE_TIMEOUT', 'sharedTask.requestTimedOut'], ['REQUEST_TIMEOUT', 'sharedTask.requestTimedOut'],
    ['ACCESS_REVOKED', 'sharedTask.unavailable'], ['NOT_FOUND', 'sharedTask.unavailable'],
    ['PERMISSION_DENIED', 'sharedTask.permissionDenied']])(
    'explains %s without trusting the error body', (code, key) => {
      expect(sharedTaskErrorKey(Object.assign(new Error('[CHANNEL_NOT_ALLOWED]'), { code }))).toBe(key);
    });
  it.each([['NOT_FOUND', 'sharedTask.invitationUnavailable'], ['PERMISSION_DENIED', 'sharedTask.invitationRenew']])(
    'gives a new-invitation action for joining with %s', (code, key) => {
      expect(sharedTaskErrorKey({ code }, 'join')).toBe(key);
      expect(sharedTaskErrorKey(new Error(`[${code}] rejected`), 'join')).toBe(key);
    });
  it('does not match capability names inside unrelated error text', () => {
    expect(sharedTaskErrorKey(new Error('[INTERNAL] CHANNEL_NOT_ALLOWED'))).toBe('sharedTask.retry');
  });
});
