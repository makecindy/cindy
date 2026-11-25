import { describe, expect, it, vi } from 'vitest';
import { createCloudInstanceControl } from '../instanceControl';
import { createCloudSettingsService } from '../service';
import { cloudSettingsClientHandlers } from '../ipc';
import { CloudClientError, type CloudClientHttp, type CloudClientIdentity } from '../transport';
import {
  cloudMaintenanceEditSchema,
  type CloudMaintenanceView,
} from '../../../shared/cloudInstanceControl';

function fixture() {
  let identity: CloudClientIdentity | null = {
    key: 'owner-a',
    generation: 1,
    accessToken: 'invalid-test-token',
    baseUrl: 'https://cis.example.test',
  };
  const caller = { id: 7, assertCurrent: vi.fn() };
  const target = {
    instanceId: 'instance-a',
    deviceId: 'cloud-a',
    customLabel: 'Cloud A',
    nameSequence: 1,
    status: {
      instanceId: 'instance-a',
      deviceId: 'cloud-a',
      desiredState: 'stopped',
      runtimeState: 'stopped',
      image: `registry.example.test/cloud:0.1.108@sha256:${'a'.repeat(64)}`,
      readiness: { ready: false },
      updateAvailable: false,
      latestReleaseTag: '0.1.108',
      upgrade: { state: 'idle' },
      observedAtMs: 100,
    },
  };
  const policy: CloudMaintenanceView = {
    instanceId: 'instance-a',
    revision: 'a'.repeat(64),
    defaultsRevision: 1,
    autoUpdate: true,
    raw: {
      policyMode: 'inherit',
      calendar: null,
      scheduledTaskPolicy: 'protect',
      pausedUntilMs: null,
    },
    effective: {
      source: 'inherit',
      calendar: {
        timezone: 'Asia/Shanghai',
        windows: [
          { id: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '03:00', endLocal: '05:00' },
        ],
      },
    },
    executionMode: 'scheduled',
    nextEligibleAtMs: 10000,
    serverTimeMs: 100,
    windows: [],
  };
  const request = vi.fn<CloudClientHttp['request']>(
    async (_identity, path, method, body, _signal, check) => {
      check();
      if (path === '/instance-login/api/manage/instances') return { instances: [target] };
      if (path === '/instances/instance-a/maintenance')
        return method === 'PATCH' ? { ...policy, ...(body as object) } : policy;
      if (path === '/instance-login/api/manage/instances/wake' || path.endsWith('/stop')) return {};
      throw Error('unexpected route');
    },
  );
  const deps = { identity: () => identity, http: { request } };
  const control = createCloudInstanceControl(deps);
  return {
    control,
    caller,
    target,
    policy,
    request,
    deps,
    revoke: () => {
      identity = null;
    },
    edit: () => ({
      revision: policy.revision,
      defaultsRevision: policy.defaultsRevision,
      autoUpdate: false,
      policyMode: 'inherit' as const,
    }),
  };
}
describe('CIS instance controls', () => {
  it('reads a sleeping owned instance without connecting or waking the runtime', async () => {
    const f = fixture(),
      view = await f.control.read(f.caller, 'cloud-a');
    expect(view).toMatchObject({
      desiredState: 'stopped',
      version: '0.1.108',
      imageId: 'a'.repeat(64),
      maintenance: { autoUpdate: true },
    });
    expect(f.request.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['/instance-login/api/manage/instances', 'GET'],
      ['/instances/instance-a/maintenance', 'GET'],
    ]);
    expect(JSON.stringify(view)).not.toContain('registry');
  });
  it('wakes only the resolved explicit instance, never the default creation path', async () => {
    const f = fixture();
    await f.control.power(f.caller, 'cloud-a', 'wake');
    expect(f.request.mock.calls.filter((c) => c[2] === 'POST').map((c) => [c[1], c[3]])).toEqual([
      ['/instance-login/api/manage/instances/wake', { instanceId: 'instance-a' }],
    ]);
  });
  it('stops only the owned instance and leaves schedules untouched', async () => {
    const f = fixture();
    f.target.status.desiredState = 'running';
    await f.control.power(f.caller, 'cloud-a', 'sleep');
    expect(f.request.mock.calls.filter((c) => c[2] !== 'GET').map((c) => [c[1], c[3]])).toEqual([
      ['/instance-login/api/manage/instances/instance-a/stop', {}],
    ]);
  });
  it.each(['other', 'duplicate', 'mismatch', 'deleted'])(
    'rejects %s target before any write',
    async (kind) => {
      const f = fixture();
      if (kind === 'duplicate')
        f.request.mockResolvedValueOnce({ instances: [f.target, f.target] });
      if (kind === 'mismatch') f.target.status.instanceId = 'instance-other';
      if (kind === 'deleted') f.target.status.desiredState = 'deleted';
      await expect(
        f.control.power(f.caller, kind === 'other' ? 'cloud-other' : 'cloud-a', 'wake'),
      ).rejects.toThrow('SCOPE_CHANGED');
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it('does not retry a write with an unknown response', async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({ instances: [f.target] })
      .mockRejectedValueOnce(Error('network'));
    await expect(f.control.power(f.caller, 'cloud-a', 'wake')).rejects.toThrow('SAVE_UNCONFIRMED');
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each(['CLOUD_SETTINGS_INSTANCE_TRANSFERRED', 'CLOUD_SETTINGS_MEMBER_SUSPENDED'] as const)(
    'reports the refusal %s instead of an unconfirmed result',
    async (code) => {
      const f = fixture();
      f.request
        .mockResolvedValueOnce({ instances: [f.target] })
        .mockRejectedValueOnce(new CloudClientError(code));
      await expect(f.control.power(f.caller, 'cloud-a', 'wake')).rejects.toThrow(code);
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it('no-ops an already sleeping instance', async () => {
    const f = fixture();
    await f.control.power(f.caller, 'cloud-a', 'sleep');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(['owner', 'window'])(
    'discards an inflight response when %s is invalidated',
    async (kind) => {
      const f = fixture();
      f.request.mockImplementationOnce(async () => {
        if (kind === 'owner') f.revoke();
        else f.control.invalidate(f.caller.id);
        return { instances: [f.target] };
      });
      await expect(f.control.power(f.caller, 'cloud-a', 'wake')).rejects.toThrow('SCOPE_CHANGED');
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it('blocks concurrent mutations across renderer windows', async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = f.control.power(f.caller, 'cloud-a', 'wake');
    await expect(f.control.policy({ ...f.caller, id: 8 }, 'cloud-a', f.edit())).rejects.toThrow(
      'BUSY',
    );
    resolve({ instances: [f.target] });
    await first;
  });
  it('saves with server CAS and protect policy without changing scheduled tasks', async () => {
    const f = fixture();
    await f.control.policy(f.caller, 'cloud-a', f.edit());
    expect(f.request.mock.calls.filter((c) => c[2] === 'PATCH').map((c) => [c[1], c[3]])).toEqual([
      ['/instances/instance-a/maintenance', { ...f.edit(), scheduledTaskPolicy: 'protect' }],
    ]);
  });
  it.each(['revision', 'defaultsRevision', 'taskPolicy'])(
    'refuses stale or unsupported %s before PATCH',
    async (kind) => {
      const f = fixture(),
        edit = f.edit();
      if (kind === 'revision') f.policy.revision = 'b'.repeat(64);
      if (kind === 'defaultsRevision') f.policy.defaultsRevision++;
      if (kind === 'taskPolicy') f.policy.raw.scheduledTaskPolicy = 'defer';
      await expect(f.control.policy(f.caller, 'cloud-a', edit)).rejects.toThrow(
        kind === 'taskPolicy' ? 'UNSUPPORTED' : 'CONFLICT',
      );
      expect(f.request.mock.calls.every((c) => c[2] === 'GET')).toBe(true);
    },
  );
  it('supports older CIS lifecycle reads while keeping maintenance unavailable', async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({ instances: [f.target] })
      .mockRejectedValueOnce(new CloudClientError('CLOUD_SETTINGS_UNSUPPORTED'));
    expect((await f.control.read(f.caller, 'cloud-a')).maintenance).toBeNull();
  });
  it.each(['instanceId', 'owner', 'baseUrl', 'token'])(
    'rejects renderer supplied %s overrides',
    async (field) => {
      const f = fixture(),
        handlers = cloudSettingsClientHandlers(createCloudSettingsService(f.deps));
      await expect(
        handlers.instancePower(f.caller, { deviceId: 'cloud-a', action: 'wake', [field]: 'other' }),
      ).rejects.toThrow('INVALID_PARAMS');
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it('validates overlap across midnight and supports valid multi-window calendars', () => {
    const f = fixture();
    const calendar = {
      timezone: 'UTC',
      windows: [
        { id: 'a', weekdays: [7], startLocal: '23:00', endLocal: '01:00' },
        { id: 'b', weekdays: [1], startLocal: '00:30', endLocal: '02:30' },
      ],
    };
    const parse = () =>
      cloudMaintenanceEditSchema.safeParse({ ...f.edit(), policyMode: 'custom', calendar }).success;
    expect(parse()).toBe(false);
    calendar.windows[1]!.startLocal = '01:00';
    expect(parse()).toBe(true);
  });
});

describe('owner-requested native upgrades', () => {
  const requestId = '33333333-3333-4333-8333-333333333333';
  const path = '/instances/instance-a/maintenance/upgrade';
  const operation = {
    operationId: 'user-example',
    phase: 'requested',
    active: true,
    updatedAtMs: 123,
  };
  function upgradeFixture() {
    const f = fixture();
    f.target.status.desiredState = 'running';
    f.target.status.runtimeState = 'running';
    f.target.status.readiness.ready = true;
    f.policy.autoUpdate = false;
    const status = {
      instanceId: 'instance-a',
      manualUpgrade: true,
      updateAvailable: true,
      latestReleaseTag: '0.1.108-cloud.10-cn-amd64',
      operation: null as typeof operation | null,
    };
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) =>
      args[1] === path ? (args[2] === 'GET' ? status : { operation }) : original(...args),
    );
    return { ...f, status };
  }
  it('uses the owner maintenance queue without setting a target, policy or runtime command', async () => {
    const f = upgradeFixture();
    const handlers = cloudSettingsClientHandlers(createCloudSettingsService(f.deps));
    expect(await handlers.instanceUpgrade(f.caller, { deviceId: 'cloud-a', requestId })).toEqual(
      operation,
    );
    expect(f.request.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ['/instance-login/api/manage/instances', 'GET', undefined],
      [path, 'GET', undefined],
      [path, 'POST', { requestId }],
    ]);
    expect(f.policy.autoUpdate).toBe(false);
  });
  it('returns an existing active request without another POST', async () => {
    const f = upgradeFixture();
    f.status.operation = operation;
    expect(await f.control.upgrade(f.caller, 'cloud-a', requestId)).toEqual(operation);
    expect(f.request.mock.calls.every((c) => c[2] === 'GET')).toBe(true);
  });
  it.each(['stopped', 'no-release', 'unsupported', 'wrong-instance', 'verifying'])(
    'blocks %s before submission',
    async (kind) => {
      const f = upgradeFixture();
      if (kind === 'stopped') f.target.status.desiredState = 'stopped';
      if (kind === 'no-release') f.status.updateAvailable = false;
      if (kind === 'unsupported') f.status.manualUpgrade = false;
      if (kind === 'wrong-instance') f.status.instanceId = 'other';
      if (kind === 'verifying') f.target.status.upgrade.state = 'verifying';
      await expect(f.control.upgrade(f.caller, 'cloud-a', requestId)).rejects.toThrow(
        'CLOUD_SETTINGS_',
      );
      expect(f.request.mock.calls.every((c) => c[2] === 'GET')).toBe(true);
    },
  );
  it('does not retry a POST whose response was lost', async () => {
    const f = upgradeFixture(),
      original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[2] === 'POST') throw Error('private-network-detail');
      return original(...args);
    });
    await expect(f.control.upgrade(f.caller, 'cloud-a', requestId)).rejects.toThrow(
      'SAVE_UNCONFIRMED',
    );
    expect(f.request.mock.calls.filter((c) => c[2] === 'POST')).toHaveLength(1);
  });
  it.each(['image', 'instanceId', 'owner', 'force', 'backupPassed'])(
    'rejects renderer %s overrides',
    async (field) => {
      const f = upgradeFixture(),
        handlers = cloudSettingsClientHandlers(createCloudSettingsService(f.deps));
      await expect(
        handlers.instanceUpgrade(f.caller, { deviceId: 'cloud-a', requestId, [field]: 'extra' }),
      ).rejects.toThrow('INVALID_PARAMS');
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it('rejects invalid idempotency IDs before network access', async () => {
    const f = upgradeFixture(),
      handlers = cloudSettingsClientHandlers(createCloudSettingsService(f.deps));
    await expect(
      handlers.instanceUpgrade(f.caller, { deviceId: 'cloud-a', requestId: 'invalid' }),
    ).rejects.toThrow('INVALID_PARAMS');
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['owner', 'window'])('drops upgrade responses after %s changes', async (kind) => {
    const f = upgradeFixture(),
      original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (...args) => {
      if (args[1] === path && args[2] === 'GET') {
        if (kind === 'owner') f.revoke();
        else f.control.invalidate(f.caller.id);
      }
      return original(...args);
    });
    await expect(f.control.upgrade(f.caller, 'cloud-a', requestId)).rejects.toThrow(
      'SCOPE_CHANGED',
    );
    expect(f.request.mock.calls.every((c) => c[2] === 'GET')).toBe(true);
  });
});
