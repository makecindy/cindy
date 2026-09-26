import { afterEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  shell: { openExternal },
  app: {
    getPath: () => '/tmp/cindy-grok-device-test',
    getAppPath: () => '/tmp/cindy-grok-device-test',
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../outbound-fetch.js', () => ({
  outboundFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
vi.mock('../nativeProviderAuthBinding.js', () => ({
  bindNativeProviderAuth: vi.fn(),
  isNativeProviderAuthBound: () => true,
  unbindNativeProviderAuth: vi.fn(),
}));

import {
  cancelGrokOAuthLogin,
  runGrokOAuthLogin,
  type GrokDeviceCode,
  type GrokTokenBlob,
} from '../grok-oauth-login.js';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  cancelGrokOAuthLogin();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  openExternal.mockClear();
});

describe('Grok device authorization', () => {
  it('shows only the public short code, waits through authorization_pending, and stores tokens locally', async () => {
    vi.useFakeTimers();
    const requests: Array<{ url: string; body: URLSearchParams }> = [];
    let polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!init?.method) return response(200, {});
        const body = new URLSearchParams(String(init.body));
        requests.push({ url, body });
        if (url.endsWith('/device/code'))
          return response(200, {
            device_code: 'private-device-code',
            user_code: 'ABCD-1234',
            verification_uri: 'https://auth.x.ai/device',
            expires_in: 120,
            interval: 5,
          });
        polls += 1;
        return polls === 1
          ? response(400, { error: 'authorization_pending' })
          : response(200, {
              access_token: 'private-access',
              refresh_token: 'private-refresh',
              expires_in: 3600,
            });
      }),
    );
    let showCode!: (code: GrokDeviceCode) => void;
    const codeReady = new Promise<GrokDeviceCode>((resolve) => {
      showCode = resolve;
    });
    let persisted: GrokTokenBlob | undefined;
    const login = runGrokOAuthLogin({
      method: 'device',
      onDeviceCode: showCode,
      persist: (blob) => {
        persisted = blob;
      },
    });
    const code = await codeReady;
    expect(code).toMatchObject({
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.x.ai/device',
    });
    expect(JSON.stringify(code)).not.toContain('private-device-code');
    expect(openExternal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await login).toEqual({ ok: true });
    expect(persisted).toMatchObject({
      access_token: 'private-access',
      refresh_token: 'private-refresh',
    });
    expect(persisted?.videoSessionId).toMatch(/^[0-9a-f]{48}$/);
    expect(requests[0]?.body.get('client_id')).toBeTruthy();
    expect(requests[1]?.body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(requests[1]?.body.get('device_code')).toBe('private-device-code');
  });

  it('cancels pending device login without saving a credential', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!init?.method) return response(200, {});
        if (String(input).endsWith('/device/code'))
          return response(200, {
            device_code: 'private-device-code',
            user_code: 'ABCD-1234',
            verification_uri: 'https://auth.x.ai/device',
            expires_in: 120,
          });
        return response(400, { error: 'authorization_pending' });
      }),
    );
    let showCode!: () => void;
    const codeReady = new Promise<void>((resolve) => {
      showCode = resolve;
    });
    const persist = vi.fn();
    const cancellation = new AbortController();
    const login = runGrokOAuthLogin({
      method: 'device',
      cancellationSignal: cancellation.signal,
      onDeviceCode: showCode,
      persist,
    });
    await codeReady;
    cancellation.abort();
    expect(await login).toMatchObject({ ok: false, reason: 'login_cancelled' });
    expect(persist).not.toHaveBeenCalled();
  });
});
