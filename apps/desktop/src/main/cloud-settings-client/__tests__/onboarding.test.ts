import { describe, expect, it, vi } from 'vitest';
import { createCloudInstanceOnboarding } from '../onboarding';
import { cloudSettingsClientHandlers } from '../ipc';
import { createCloudSettingsService } from '../service';
import { CloudClientError, type CloudClientHttp, type CloudClientIdentity } from '../transport';

const listPath = '/instance-login/api/manage/instances';
// CIS attempt ids are 18 random bytes as 24 base64url characters.
const attemptId = 'aaaaaaaa_bbbbbbbb-cccccc';
const secret = 'invalid-test-only-'.repeat(3);
function fixture() {
  let identity: CloudClientIdentity | null = {
    key: 'owner-a',
    generation: 1,
    accessToken: 'invalid-test-token',
    baseUrl: 'https://cis.example.test',
  };
  const target = {
    instanceId: 'instance-a',
    deviceId: 'cloud-device-aaaaaaaaaaaaaaaaaaaaaaaa',
    customLabel: null,
    nameSequence: 1,
    status: {
      instanceId: 'instance-a',
      deviceId: 'cloud-device-aaaaaaaaaaaaaaaaaaaaaaaa',
      desiredState: 'running',
      runtimeState: 'missing',
      image: 'registry.example.test/cloud:0.1.108',
      readiness: { ready: false },
      updateAvailable: false,
      latestReleaseTag: '0.1.108',
      upgrade: { state: 'idle' },
      loginRequired: true,
      loginWakeSupported: false,
      ownership: {
        orgSlug: 'example' as string | null,
        membershipId: 'owner-a',
        passportId: 'private',
      },
    },
  };
  let list: (typeof target)[] = [];
  let now = 1;
  const request = vi.fn<CloudClientHttp['request']>(
    async (_identity, path, method, _body, _signal, check) => {
      check();
      if (path === listPath && method === 'GET') return { instances: list };
      if (path === `${listPath}/wake`) {
        list = [target];
        throw new CloudClientError('CLOUD_SETTINGS_UNAVAILABLE');
      }
      if (path === '/instance-login/api/attempts')
        return { continueUrl: `/instance-login/#attemptId=${attemptId}&attemptSecret=${secret}` };
      if (path === `/instance-login/api/attempts/${attemptId}/status`) return { status: 'pending' };
      throw Error('unexpected route');
    },
  );
  const caller = { id: 1, assertCurrent: vi.fn() },
    openExternal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue();
  const cancelLogin = vi.fn<NonNullable<CloudClientHttp['cancelLogin']>>().mockResolvedValue();
  const deps = {
    identity: () => identity,
    http: { request, cancelLogin },
    openExternal,
    now: () => now,
  };
  return {
    api: createCloudInstanceOnboarding(deps),
    caller,
    request,
    cancelLogin,
    deps,
    openExternal,
    target,
    setList: (value: (typeof target)[]) => {
      list = value;
    },
    revoke: () => {
      identity = null;
    },
    advance: () => {
      now += 600_001;
    },
  };
}
describe('native cloud instance onboarding', () => {
  it('empty discovery is read-only and never initializes or creates', async () => {
    const f = fixture();
    expect(await f.api.list(f.caller)).toEqual([]);
    expect(f.request.mock.calls.map((v) => [v[1], v[2]])).toEqual([[listPath, 'GET']]);
    expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('projects owned instances without ownership, image registry or credentials', async () => {
    const f = fixture();
    f.setList([f.target]);
    const result = await f.api.list(f.caller);
    expect(result[0]).toMatchObject({ loginRequired: true, version: '0.1.108', maintenance: null });
    expect(JSON.stringify(result)).not.toMatch(/private|registry|owner-a|ownership|token/u);
  });
  it('recovers the allocated record after LOGIN_REQUIRED or a lost create response', async () => {
    const f = fixture();
    expect(await f.api.claim(f.caller)).toMatchObject([
      { instanceId: 'instance-a', loginRequired: true },
    ]);
    expect(f.request.mock.calls.map((v) => [v[1], v[2]])).toEqual([
      [listPath, 'GET'],
      [`${listPath}/wake`, 'POST'],
      [listPath, 'GET'],
    ]);
    expect(f.request.mock.calls[1][3]).toEqual({});
  });
  it('an existing asleep instance is returned without waking or creating it', async () => {
    const f = fixture();
    f.target.status.desiredState = 'stopped';
    f.setList([f.target]);
    expect(await f.api.claim(f.caller)).toMatchObject([{ desiredState: 'stopped' }]);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('does not turn a list failure into a first claim', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new CloudClientError('CLOUD_SETTINGS_UNAVAILABLE'));
    await expect(f.api.claim(f.caller)).rejects.toThrow('UNAVAILABLE');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('unknown creation is reported without automatic resubmission', async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({ instances: [] })
      .mockRejectedValueOnce(Error('lost'))
      .mockResolvedValueOnce({ instances: [] });
    await expect(f.api.claim(f.caller)).rejects.toThrow('SAVE_UNCONFIRMED');
    expect(f.request.mock.calls.filter((v) => v[2] === 'POST')).toHaveLength(1);
  });
  it.each([
    'CLOUD_SETTINGS_ADMISSION_NOT_LISTED',
    'CLOUD_SETTINGS_QUOTA_EXCEEDED',
    'CLOUD_SETTINGS_MEMBER_SUSPENDED',
  ] as const)('reports the refusal %s at once, without reading back or resubmitting', async (code) => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({ instances: [] })
      .mockRejectedValueOnce(new CloudClientError(code));
    await expect(f.api.claim(f.caller)).rejects.toThrow(code);
    expect(f.request.mock.calls.map((v) => [v[1], v[2]])).toEqual([
      [listPath, 'GET'],
      [`${listPath}/wake`, 'POST'],
    ]);
  });
  it('offers another instance only below the limit CIS reports, and reads a new one back', async () => {
    const f = fixture();
    const second = { ...f.target, instanceId: 'instance-b', deviceId: 'cloud-device-bbbbbbbbbbbbbbbbbbbbbbbb',
      nameSequence: 2, status: { ...f.target.status, instanceId: 'instance-b', deviceId: 'cloud-device-bbbbbbbbbbbbbbbbbbbbbbbb' } };
    let list = [f.target];
    let quota: { limit: number; used: number } | undefined = { limit: 3, used: 1 };
    f.request.mockImplementation(async (_identity, path, method, _body, _signal, check) => {
      check();
      if (path === listPath && method === 'GET') return { instances: list, ...(quota ? { quota } : {}) };
      if (path === listPath && method === 'POST') {
        list = [f.target, second];
        // As CIS answers when the new instance waits for its sign-in.
        throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
      }
      throw Error('unexpected route');
    });
    expect(await f.api.capacity(f.caller)).toEqual({ limit: 3, used: 1 });
    const next = await f.api.claim(f.caller, true);
    expect(next.map((v) => v.deviceId)).toEqual([f.target.deviceId, second.deviceId]);
    expect(f.request.mock.calls.filter((v) => v[2] === 'POST')).toHaveLength(1);
    expect(f.request.mock.calls.find((v) => v[2] === 'POST')![3]).toEqual({});
    // At the limit nothing is sent; an older CIS without a limit is not offered another either.
    quota = { limit: 2, used: 2 };
    await expect(f.api.claim(f.caller, true)).rejects.toThrow('CLOUD_SETTINGS_QUOTA_EXCEEDED');
    quota = undefined;
    expect(await f.api.capacity(f.caller)).toBeNull();
    await expect(f.api.claim(f.caller, true)).rejects.toThrow('CLOUD_SETTINGS_UNSUPPORTED');
    expect(f.request.mock.calls.filter((v) => v[2] === 'POST')).toHaveLength(1);
  });
  it('reports a refused or unconfirmed additional instance without resubmitting', async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({ instances: [f.target], quota: { limit: 3, used: 1 } })
      .mockRejectedValueOnce(new CloudClientError('CLOUD_SETTINGS_ADMISSION_CLOSED'));
    await expect(f.api.claim(f.caller, true)).rejects.toThrow('CLOUD_SETTINGS_ADMISSION_CLOSED');
    f.request.mockReset();
    f.request
      .mockResolvedValueOnce({ instances: [f.target], quota: { limit: 3, used: 1 } })
      .mockRejectedValueOnce(Error('lost'))
      .mockResolvedValueOnce({ instances: [f.target], quota: { limit: 3, used: 1 } });
    await expect(f.api.claim(f.caller, true)).rejects.toThrow('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
    expect(f.request.mock.calls.filter((v) => v[2] === 'POST')).toHaveLength(1);
  });
  it('serializes creation across windows for the same membership', async () => {
    const f = fixture();
    const first = f.api.claim(f.caller);
    await expect(f.api.claim({ ...f.caller, id: 2 })).rejects.toThrow('BUSY');
    await first;
    expect(f.request.mock.calls.filter((v) => v[2] === 'POST')).toHaveLength(1);
  });
  it.each(['owner', 'window'])('discards a late claim when the %s changes', async (kind) => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => {
      if (kind === 'owner') f.revoke();
      else f.api.invalidate(1);
      return { instances: [] };
    });
    await expect(f.api.claim(f.caller)).rejects.toThrow('SCOPE_CHANGED');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('initializes only the owned device using the server-owned organization and reopens the same attempt', async () => {
    const f = fixture();
    f.setList([f.target]);
    expect(await f.api.initialize(f.caller, f.target.deviceId)).toBeUndefined();
    await f.api.initialize(f.caller, f.target.deviceId);
    expect(
      f.request.mock.calls
        .filter((v) => v[1] === '/instance-login/api/attempts')
        .map((v) => [v[1], v[3]]),
    ).toEqual([['/instance-login/api/attempts', { instanceId: 'instance-a', org: 'example' }]]);
    expect(f.openExternal).toHaveBeenCalledTimes(2);
    expect(new URL(f.openExternal.mock.calls[0][0]).origin).toBe('https://cis.example.test');
  });
  it('a browser opening failure retains the attempt for explicit retry', async () => {
    const f = fixture();
    f.setList([f.target]);
    f.openExternal.mockRejectedValueOnce(Error('private url'));
    await expect(f.api.initialize(f.caller, f.target.deviceId)).rejects.toThrow('UNAVAILABLE');
    await f.api.initialize(f.caller, f.target.deviceId);
    expect(
      f.request.mock.calls.filter((v) => v[1] === '/instance-login/api/attempts'),
    ).toHaveLength(1);
  });
  it('does not initialize an unknown device or an already initialized one', async () => {
    const f = fixture();
    f.setList([f.target]);
    await expect(f.api.initialize(f.caller, 'cloud-other')).rejects.toThrow('SCOPE_CHANGED');
    f.target.status.loginRequired = false;
    await f.api.initialize(f.caller, f.target.deviceId);
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every((v) => v[2] === 'GET')).toBe(true);
  });
  it.each([
    'https://evil.example/instance-login/#attemptId=x',
    '/instance-login/#attemptId=invalid&attemptSecret=invalid',
    `/instance-login/#attemptId=${attemptId}&attemptSecret=${secret}&redirect=https://evil.example`,
    `/instance-login/#attemptId=${attemptId}&attemptId=${attemptId}`,
  ])('rejects an invalid continuation without opening a browser', async (continueUrl) => {
    const f = fixture();
    f.setList([f.target]);
    f.request
      .mockResolvedValueOnce({ instances: [f.target] })
      .mockResolvedValueOnce({ continueUrl });
    await expect(f.api.initialize(f.caller, f.target.deviceId)).rejects.toThrow('INVALID_RESPONSE');
    expect(f.openExternal).not.toHaveBeenCalled();
  });
  it('never opens an authorization after account invalidation', async () => {
    const f = fixture();
    f.setList([f.target]);
    f.request.mockResolvedValueOnce({ instances: [f.target] }).mockImplementationOnce(async () => {
      f.revoke();
      return { continueUrl: `/instance-login/#attemptId=${attemptId}&attemptSecret=${secret}` };
    });
    await expect(f.api.initialize(f.caller, f.target.deviceId)).rejects.toThrow('SCOPE_CHANGED');
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.cancelLogin).toHaveBeenCalledWith('https://cis.example.test', attemptId, secret);
  });
  it('expires cached attempts and does not reuse them after invalidation', async () => {
    const f = fixture();
    f.setList([f.target]);
    await f.api.initialize(f.caller, f.target.deviceId);
    f.advance();
    await f.api.initialize(f.caller, f.target.deviceId);
    f.api.invalidate(1);
    await f.api.initialize(f.caller, f.target.deviceId);
    expect(f.request.mock.calls.filter((v) => v[2] === 'POST')).toHaveLength(3);
  });
  it.each(['duplicate', 'mismatch'])(
    'rejects a %s membership snapshot before a write',
    async (kind) => {
      const f = fixture();
      f.setList(kind === 'duplicate' ? [f.target, f.target] : [f.target]);
      if (kind === 'mismatch') f.target.status.instanceId = 'other';
      await expect(f.api.claim(f.caller)).rejects.toThrow('INVALID_RESPONSE');
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it('IPC rejects renderer-supplied identity, image or login URL', async () => {
    const f = fixture(),
      handlers = cloudSettingsClientHandlers(createCloudSettingsService(f.deps));
    for (const value of [{ instanceId: 'other' }, { image: 'other' }, { membershipId: 'other' }])
      await expect(handlers.instanceClaim(f.caller, value)).rejects.toThrow('INVALID_PARAMS');
    await expect(
      handlers.instanceInitialize(f.caller, {
        deviceId: f.target.deviceId,
        org: 'other',
        url: 'https://evil.example',
      }),
    ).rejects.toThrow('INVALID_PARAMS');
    expect(f.request).not.toHaveBeenCalled();
  });
});

// Lightweight admission is not an instance-list shortcut; exercise Main's wire
// validation and identity boundary independently of Renderer visibility.
it('reads the explicit permission endpoint without creating a session or listing instances', async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({ schemaVersion: 1, allowed: false });
  expect(await f.api.access(f.caller)).toEqual({ schemaVersion: 1, allowed: false });
  expect(f.request.mock.calls.map((v) => [v[1], v[2]])).toEqual([['/client/access', 'GET']]);
  expect(f.openExternal).not.toHaveBeenCalled();
});
it.each([
  {},
  { allowed: true },
  { schemaVersion: 2, allowed: true },
  { schemaVersion: 1, allowed: 'yes' },
])('rejects malformed permission replies %j', async (reply) => {
  const f = fixture();
  f.request.mockResolvedValueOnce(reply);
  await expect(f.api.access(f.caller)).rejects.toThrow('INVALID_RESPONSE');
});
it('does not publish an admission result after the account changes', async () => {
  const f = fixture();
  f.request.mockImplementationOnce(async () => {
    f.revoke();
    return { schemaVersion: 1, allowed: true };
  });
  await expect(f.api.access(f.caller)).rejects.toThrow('SCOPE_CHANGED');
});

it('rejects caller-supplied permission and membership fields at the IPC boundary', async () => {
  const f = fixture();
  const handlers = cloudSettingsClientHandlers(createCloudSettingsService(f.deps));
  for (const payload of [{ allowed: true }, { membershipId: 'other' }, { orgSlug: 'other' }]) {
    await expect(handlers.instanceAccess(f.caller, payload)).rejects.toThrow();
  }
  expect(f.request).not.toHaveBeenCalled();
});

it('initializes an admitted personal instance without an enterprise selector or local credentials', async () => {
  const f = fixture();
  f.target.status.ownership.orgSlug = null;
  f.setList([f.target]);
  await f.api.initialize(f.caller, f.target.deviceId);
  const create = f.request.mock.calls.find((c) => c[1] === '/instance-login/api/attempts')!;
  expect(create[3]).toEqual({ instanceId: 'instance-a' });
  expect(f.openExternal).toHaveBeenCalledOnce();
});
it('opens a fresh login only after the cached capability is confirmed cancelled', async () => {
  const f = fixture();
  f.setList([f.target]);
  await f.api.initialize(f.caller, f.target.deviceId);
  f.request
    .mockResolvedValueOnce({ instances: [f.target] })
    .mockResolvedValueOnce({ status: 'failed' });
  await f.api.initialize(f.caller, f.target.deviceId);
  expect(f.request.mock.calls.filter((c) => c[1] === '/instance-login/api/attempts')).toHaveLength(
    2,
  );
});
it('does not replay login creation on a transient cached-status error', async () => {
  const f = fixture();
  f.setList([f.target]);
  await f.api.initialize(f.caller, f.target.deviceId);
  f.request
    .mockResolvedValueOnce({ instances: [f.target] })
    .mockRejectedValueOnce(new CloudClientError('CLOUD_SETTINGS_UNAVAILABLE'));
  await expect(f.api.initialize(f.caller, f.target.deviceId)).rejects.toThrow('UNAVAILABLE');
  expect(f.request.mock.calls.filter((c) => c[1] === '/instance-login/api/attempts')).toHaveLength(
    1,
  );
});
it('invalidating a caller cancels its capability without forwarding any account token', async () => {
  const f = fixture();
  f.setList([f.target]);
  await f.api.initialize(f.caller, f.target.deviceId);
  f.api.invalidate(2);
  expect(f.cancelLogin).not.toHaveBeenCalled();
  f.api.invalidate(1);
  expect(f.cancelLogin).toHaveBeenCalledExactlyOnceWith(
    'https://cis.example.test',
    attemptId,
    secret,
  );
});

it('browser continuation requests explicit wake only for a supported sleeping runtime', async () => {
  const f = fixture();
  f.target.status.desiredState = 'stopped';
  f.target.status.loginWakeSupported = true;
  f.setList([f.target]);
  await f.api.initialize(f.caller, f.target.deviceId);
  expect(
    f.request.mock.calls.find((call) => call[1] === '/instance-login/api/attempts')?.[3],
  ).toMatchObject({ instanceId: f.target.instanceId, wake: true });
});
