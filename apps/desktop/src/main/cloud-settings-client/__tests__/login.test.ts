import { describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '@cindy/auth-client';

// Unit: native login must open the selected Auth method, preserve SSO and
// route the final credential only to the owned cloud device. The onboarding
// tests cover the browser continuation, not these native actions/lifetimes.
import { createCloudInstanceLogin } from '../login';
import { CloudClientError, type CloudClientIdentity, type CloudClientHttp } from '../transport';

function fixture(org: string | null = null) {
  let identity: CloudClientIdentity | null = {
    key: 'owner',
    generation: 1,
    accessToken: 'fixture-local-token',
    baseUrl: 'https://cis.example.test',
  };
  const deviceId = 'cloud-device-aaaaaaaaaaaaaaaaaaaaaaaa';
  const target = {
    instanceId: 'instance-a',
    deviceId,
    customLabel: null,
    nameSequence: 1,
    status: {
      instanceId: 'instance-a',
      deviceId,
      desiredState: 'running',
      runtimeState: 'missing',
      image: 'registry.example.test/cloud:0.1.113',
      readiness: { ready: false },
      updateAvailable: false,
      latestReleaseTag: null,
      upgrade: { state: 'idle' },
      loginRequired: true,
      loginWakeSupported: false,
      ownership: { orgSlug: org },
    },
  };
  const cap = { id: 'a'.repeat(24), secret: 's'.repeat(43) };
  let status: unknown = { status: 'pending' };
  const authorize = (path: string) =>
    `https://auth.example.test${path}?device_id=${deviceId}&redirect_uri=${encodeURIComponent('https://auth.example.test/api/auth/desktop/callback')}&code_challenge=fixture`;
  const request = vi.fn<CloudClientHttp['request']>(
    async (_id, path, _method, body, _signal, check) => {
      check();
      if (path.endsWith('/manage/instances')) return { instances: [target] };
      if (path === '/instance-login/api/attempts')
        return { continueUrl: `/instance-login/#attemptId=${cap.id}&attemptSecret=${cap.secret}` };
      expect(body).toMatchObject({ attemptSecret: cap.secret });
      if (path.endsWith('/personal/prepare-code')) return { status: 'prepared' };
      if (path.endsWith('/personal/verify') || path.endsWith('/verification/verify'))
        return { status: 'ready' };
      if (path.endsWith('/personal/request-code') || path.endsWith('/verification/request-code'))
        return { status: 'sent' };
      if (path.endsWith('/personal/social'))
        return {
          status: 'pending',
          authorizeUrl: authorize(
            `/api/auth/social/${(body as { provider: string }).provider}/authorize`,
          ),
        };
      if (path.endsWith('/status')) return status;
      throw Error('unexpected path');
    },
  );
  const client = {
    getProviders: vi.fn(async () => ({
      region: 'cn' as const,
      attribution: 'phone' as const,
      phone: true,
      email: false,
      social: ['wechat', 'apple'] as ('wechat' | 'apple')[],
    })),
    discover: vi.fn(async () => []),
    discoverSsoOrg: vi.fn(async () => ({
      region: 'cn' as const,
      orgName: 'Example',
      connections: [
        { connectionId: 'connection-a', protocol: 'oidc' as const, connectionName: 'Company SSO' },
      ],
    })),
    requestCode: vi.fn(async () => undefined),
  };
  const openExternal = vi.fn<(url: string) => Promise<undefined>>(async () => undefined),
    cancelLogin = vi.fn(async () => undefined);
  const caller = { id: 1, assertCurrent: vi.fn() };
  const service = createCloudInstanceLogin({
    identity: () => identity,
    http: { request, cancelLogin },
    loginAuth: () => ({ client, baseUrl: 'https://auth.example.test' }),
    openExternal,
  });
  return {
    service,
    caller,
    request,
    cancelLogin,
    client,
    target,
    deviceId,
    openExternal,
    authorize,
    cap,
    setStatus: (value: unknown) => {
      status = value;
    },
    revoke: () => {
      identity = null;
    },
    start: () => service.start(caller, deviceId),
  };
}
describe('native cloud login controller', () => {
  it('reads admission before showing methods and keeps attempts and local tokens out of the view', async () => {
    const f = fixture(),
      v = await f.start();
    expect(v.state.step).toBe('identifier');
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(v)).not.toMatch(/fixture-local-token|attemptSecret|continueUrl/);
    expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('sends native CAPTCHA/code through Auth and verifies only through the cloud capability', async () => {
    const f = fixture(),
      v = await f.start();
    const sent = await f.service.dispatch(f.caller, v.handle, {
      type: 'request-code',
      kind: 'phone',
      identifier: '+15555550123',
      captchaToken: 'fixture-captcha',
    });
    expect(sent.state).toEqual({
      step: 'verification-code',
      kind: 'phone',
      identifier: '+15555550123',
    });
    expect(f.client.requestCode).toHaveBeenCalledWith('phone', '+15555550123', {
      captchaToken: 'fixture-captcha',
    });
    expect(
      f.request.mock.calls.some((c) => JSON.stringify(c[3])?.includes('fixture-captcha')),
    ).toBe(false);
    const ready = await f.service.dispatch(f.caller, v.handle, {
      type: 'verify-code',
      kind: 'phone',
      identifier: '+15555550123',
      code: '123456',
    });
    expect(ready.complete).toBe(true);
    expect(f.request.mock.calls.at(-1)?.[3]).toEqual({
      attemptSecret: f.cap.secret,
      code: '123456',
    });
    expect(JSON.stringify(ready)).not.toContain('123456');
  });
  it.each(['wechat', 'apple'])(
    'opens %s directly and polls the same cloud attempt',
    async (provider) => {
      const f = fixture(),
        v = await f.start();
      await f.service.dispatch(f.caller, v.handle, {
        type: 'start-browser',
        kind: 'social',
        providerOrConnectionId: provider,
        label: provider,
      });
      expect(f.openExternal).toHaveBeenCalledExactlyOnceWith(
        f.authorize(`/api/auth/social/${provider}/authorize`),
      );
      f.setStatus({ status: 'ready' });
      expect((await f.service.poll(f.caller, v.handle)).complete).toBe(true);
    },
  );
  it.each([true, false])(
    'requests explicit wake only when stopped CIS advertises support (%s)',
    async (supported) => {
      const f = fixture('example');
      f.target.status.desiredState = 'stopped';
      f.target.status.loginWakeSupported = supported;
      const view = await f.start();
      expect(
        f.request.mock.calls.filter((c) => c[1] === '/instance-login/api/attempts'),
      ).toHaveLength(0);
      await f.service.dispatch(f.caller, view.handle, { type: 'discover-sso-org', org: 'example' });
      expect(
        f.request.mock.calls.find((c) => c[1] === '/instance-login/api/attempts')?.[3],
      ).toEqual({
        instanceId: 'instance-a',
        org: 'example',
        connectionId: 'connection-a',
        ...(supported ? { wake: true } : {}),
      });
      expect(f.target.deviceId).toBe(f.deviceId);
    },
  );
  it('keeps SSO enterprise discovery, direct browser launch and extra verification', async () => {
    const f = fixture('example'),
      v = await f.start();
    f.setStatus({
      status: 'pending',
      authorizeUrl: f.authorize('/api/auth/sso/connection-a/authorize'),
    });
    await f.service.dispatch(f.caller, v.handle, { type: 'discover-sso-org', org: 'example' });
    expect(f.client.discoverSsoOrg).toHaveBeenCalledWith('example');
    expect(f.request.mock.calls.find((c) => c[1] === '/instance-login/api/attempts')?.[3]).toEqual({
      instanceId: 'instance-a',
      org: 'example',
      connectionId: 'connection-a',
    });
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith(
      f.authorize('/api/auth/sso/connection-a/authorize'),
    );
    f.setStatus({ status: 'verification-required', channel: 'sms', targetMasked: '***123' });
    expect((await f.service.poll(f.caller, v.handle)).state.step).toBe('sso-verification');
    await f.service.dispatch(f.caller, v.handle, { type: 'request-sso-verification-code' });
    expect(
      (
        await f.service.dispatch(f.caller, v.handle, {
          type: 'verify-sso-verification',
          code: '123456',
        })
      ).complete,
    ).toBe(true);
  });
  it('keeps multiple SSO connections selectable before creating a cloud attempt', async () => {
    const f = fixture('example'),
      v = await f.start();
    f.client.discoverSsoOrg.mockResolvedValue({
      region: 'cn',
      orgName: 'Example',
      connections: [
        { connectionId: 'connection-a', protocol: 'oidc', connectionName: 'First' },
        { connectionId: 'connection-b', protocol: 'oidc', connectionName: 'Second' },
      ],
    });
    const choices = await f.service.dispatch(f.caller, v.handle, {
      type: 'discover-sso-org',
      org: 'example',
    });
    expect(choices.state.step).toBe('method-choice');
    expect(f.request).toHaveBeenCalledTimes(1);
    f.setStatus({
      status: 'pending',
      authorizeUrl: f.authorize('/api/auth/sso/connection-b/authorize'),
    });
    await f.service.dispatch(f.caller, v.handle, {
      type: 'start-browser',
      kind: 'sso',
      providerOrConnectionId: 'connection-b',
      label: 'Second',
    });
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith(
      f.authorize('/api/auth/sso/connection-b/authorize'),
    );
  });
  it('keeps CAPTCHA failure on the form and permits retry without pretending a code was sent', async () => {
    const f = fixture(),
      v = await f.start();
    expect(v.captchaChallengeUrl).toBe('https://auth.example.test/captcha/turnstile');
    f.client.requestCode.mockRejectedValueOnce(
      new AuthApiError('CAPTCHA_INVALID', 400, 'fixture failure'),
    );
    const action = {
      type: 'request-code' as const,
      kind: 'phone' as const,
      identifier: '+15555550123',
    };
    const failed = await f.service.dispatch(f.caller, v.handle, action);
    expect(failed.errorCode).toBe('CAPTCHA_INVALID');
    expect(failed.state.step).toBe('identifier');
    expect((await f.service.dispatch(f.caller, v.handle, action)).state.step).toBe(
      'verification-code',
    );
    expect(
      f.request.mock.calls.filter((c) => c[1] === '/instance-login/api/attempts'),
    ).toHaveLength(1);
  });
  it('does not turn a personal instance into an enterprise instance or bypass the owner check', async () => {
    const f = fixture(),
      v = await f.start();
    const result = await f.service.dispatch(f.caller, v.handle, {
      type: 'discover-sso-org',
      org: 'different-owner',
    });
    expect(result.errorCode).toBe('LOGIN_OWNERSHIP_MISMATCH');
    expect(f.client.discoverSsoOrg).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('handles binding without exposing its private ticket and cancels on Back', async () => {
    const f = fixture(),
      v = await f.start();
    await f.service.dispatch(f.caller, v.handle, {
      type: 'start-browser',
      kind: 'social',
      providerOrConnectionId: 'apple',
      label: 'Apple',
    });
    f.setStatus({
      status: 'login-options',
      step: 'binding',
      channel: 'phone',
      bindTicket: 'must-not-leak',
    });
    const state = await f.service.poll(f.caller, v.handle);
    expect(state.state).toEqual({ step: 'binding', bindType: 'phone', codeRequested: false });
    expect(JSON.stringify(state)).not.toContain('must-not-leak');
    await f.service.dispatch(f.caller, v.handle, {
      type: 'request-binding-code',
      contact: '+15555550123',
    });
    expect((await f.service.dispatch(f.caller, v.handle, { type: 'back' })).state.step).toBe(
      'identifier',
    );
    expect(f.cancelLogin).toHaveBeenCalledWith('https://cis.example.test', f.cap.id, f.cap.secret);
  });
  it('cancels a late capability after the owning renderer goes away', async () => {
    const f = fixture(),
      v = await f.start();
    const old = f.request.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    f.request.mockImplementation((...args) =>
      args[1] === '/instance-login/api/attempts'
        ? new Promise((r) => {
            resolve = r;
          })
        : old(...args),
    );
    const pending = f.service.dispatch(f.caller, v.handle, {
      type: 'start-browser',
      kind: 'social',
      providerOrConnectionId: 'apple',
      label: 'Apple',
    });
    f.service.invalidate(f.caller.id);
    resolve({
      continueUrl: `/instance-login/#attemptId=${f.cap.id}&attemptSecret=${f.cap.secret}`,
    });
    await expect(pending).rejects.toBeInstanceOf(CloudClientError);
    expect(f.cancelLogin).toHaveBeenCalledTimes(1);
    expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('refuses a foreign renderer and revoked local identity', async () => {
    const f = fixture(),
      v = await f.start();
    await expect(f.service.poll({ ...f.caller, id: 2 }, v.handle)).rejects.toMatchObject({
      code: 'CLOUD_SETTINGS_SCOPE_CHANGED',
    });
    f.revoke();
    await expect(f.service.poll(f.caller, v.handle)).rejects.toMatchObject({
      code: 'CLOUD_SETTINGS_SCOPE_CHANGED',
    });
  });
  it('rejects an authorization URL targeting another cloud device', async () => {
    const f = fixture('example'),
      v = await f.start();
    f.setStatus({
      status: 'pending',
      authorizeUrl: f
        .authorize('/api/auth/sso/connection-a/authorize')
        .replace(f.deviceId, 'another-device'),
    });
    expect(
      (await f.service.dispatch(f.caller, v.handle, { type: 'discover-sso-org', org: 'example' }))
        .errorCode,
    ).toBe('CLOUD_SETTINGS_INVALID_RESPONSE');
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  // Unit / caller-and-device isolation: previous cases only used one target.
  // Two active targets plus A's late status must not cancel, complete or expose B.
  it('isolates two device attempts and drops A’s late completion without disturbing B', async () => {
    const f = fixture();
    const other = structuredClone(f.target);
    other.instanceId = other.status.instanceId = 'instance-b';
    other.deviceId = other.status.deviceId = 'cloud-device-bbbbbbbbbbbbbbbbbbbbbbbb';
    const callerB = { id: 2, assertCurrent: vi.fn() };
    const capB = { id: 'b'.repeat(24), secret: 't'.repeat(43) };
    let resolveA!: (value: unknown) => void;
    f.request.mockImplementation(async (_id, path, _method, body, _signal, check) => {
      check();
      if (path.endsWith('/manage/instances')) return { instances: [f.target, other] };
      if (path === '/instance-login/api/attempts') {
        const instanceId = (body as { instanceId: string }).instanceId;
        expect(['instance-a', 'instance-b']).toContain(instanceId);
        const cap = instanceId === 'instance-a' ? f.cap : capB;
        return { continueUrl: `/instance-login/#attemptId=${cap.id}&attemptSecret=${cap.secret}` };
      }
      const isB = path.includes(`/attempts/${capB.id}/`);
      const cap = isB ? capB : f.cap;
      expect(path).toContain(`/attempts/${cap.id}/`);
      expect(body).toMatchObject({ attemptSecret: cap.secret });
      if (path.endsWith('/personal/social')) {
        const provider = (body as { provider: string }).provider;
        return {
          status: 'pending',
          authorizeUrl: f
            .authorize(`/api/auth/social/${provider}/authorize`)
            .replace(f.deviceId, isB ? other.deviceId : f.deviceId),
        };
      }
      if (path.endsWith('/status')) {
        if (isB) return { status: 'ready' };
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      throw Error('unexpected path');
    });
    const a = await f.start();
    const b = await f.service.start(callerB, other.deviceId);
    expect(a.handle).not.toBe(b.handle);
    const action = {
      type: 'start-browser' as const,
      kind: 'social' as const,
      providerOrConnectionId: 'apple',
      label: 'Apple',
    };
    await f.service.dispatch(f.caller, a.handle, action);
    await f.service.dispatch(callerB, b.handle, action);
    expect(
      f.openExternal.mock.calls.map(([url]) => new URL(url).searchParams.get('device_id')),
    ).toEqual([f.deviceId, other.deviceId]);
    await expect(f.service.poll(f.caller, b.handle)).rejects.toThrow('SCOPE_CHANGED');
    const late = f.service.poll(f.caller, a.handle);
    const rejected = expect(late).rejects.toThrow('SCOPE_CHANGED');
    f.service.invalidate(f.caller.id);
    expect(f.cancelLogin).toHaveBeenCalledExactlyOnceWith(
      'https://cis.example.test',
      f.cap.id,
      f.cap.secret,
    );
    expect((await f.service.poll(callerB, b.handle)).complete).toBe(true);
    resolveA({ status: 'ready' });
    await rejected;
    await f.service.close(f.caller, b.handle); // foreign caller cannot close B
    expect((await f.service.poll(callerB, b.handle)).complete).toBe(true);
    expect(f.cancelLogin).toHaveBeenCalledTimes(1);
    await f.service.close(callerB, b.handle);
  });
});
