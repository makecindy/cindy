import { expect, it, vi } from 'vitest';
import { readSessionQuota, type SessionQuotaPorts } from '../sessionQuota.js';

const route = { providerId: 'anthropic', deviceId: null, nativeSessionId: 'sdk', remoteHostId: null };
const account = {
  providerId: 'anthropic', state: 'bound', routeProviderId: 'anthropic',
  account: { isDefault: false, number: 2, status: 'ready', identity: 'private@example.invalid',
    usage: { claude: { source: 'oauth-endpoint', updatedAt: Date.now(),
      fiveHour: { utilization: 25, resetsAt: null } } } },
};

function ports(overrides: Partial<SessionQuotaPorts> = {}): SessionQuotaPorts {
  return {
    readRoute: vi.fn(async () => route),
    readLocal: vi.fn(async () => account),
    readRemote: vi.fn(async () => account),
    readShare: vi.fn(),
    shareAccessEpoch: () => 0,
    ...overrides,
  };
}

// #11274: the same provider can run on two computers. Only the actual executor
// receives the lookup; account identifiers from its native response stay private.
it.each(['local', 'device'] as const)('projects the bound account on %s', async source => {
  const deviceId = source === 'device' ? 'other-computer' : null;
  const deps = ports({ readRoute: async () => ({ ...route, deviceId }) });
  const result = await readSessionQuota('task', deps, () => undefined);
  expect(result).toMatchObject({ source, status: 'available', windows: [{ usedPercent: 25 }] });
  expect(JSON.stringify(result)).not.toMatch(/private@example|other-computer|anthropic|sdk/);
  expect(deps[source === 'local' ? 'readRemote' : 'readLocal']).not.toHaveBeenCalled();
});

it('collapses missing tasks and withholds a result when the execution route changes in flight', async () => {
  const missing = ports({ readRoute: async () => null });
  expect(await readSessionQuota('missing', missing, () => undefined)).toEqual({ status: 'unavailable' });
  expect(missing.readLocal).not.toHaveBeenCalled();
  expect(missing.readRemote).not.toHaveBeenCalled();
  const readRoute = vi.fn().mockResolvedValueOnce(route).mockResolvedValueOnce({ ...route, deviceId: 'other' });
  expect(await readSessionQuota('task', ports({ readRoute }), () => undefined)).toEqual({ status: 'unavailable' });
});

it('reads only authorized, unambiguous shared quota', async () => {
  const readRoute = async () => ({ ...route, deviceId: 'share:grant' });
  const resetsAt = Date.now() + 60_000;
  const quota = { group: false, partial: false, accounts: [{
    state: 'ready' as const, updatedAt: Date.now(), balance: null,
    windows: [{ kind: 'week' as const, label: null, remainingPercent: 70, resetsAt, windowMinutes: 10080 }],
  }] };
  const readShare = vi.fn()
    .mockResolvedValueOnce({ capabilities: { quota: true }, status: { quota: 'ready' }, quota })
    .mockResolvedValueOnce({ capabilities: { quota: false }, status: { quota: 'disabled' }, quota })
    .mockResolvedValueOnce({ capabilities: { quota: true }, status: { quota: 'ready' }, quota: { ...quota, group: true } })
    .mockResolvedValueOnce({ capabilities: { quota: true }, status: { quota: 'ready' }, quota });
  const shareAccessEpoch = vi.fn().mockReturnValue(0);
  const deps = ports({ readRoute, readShare, shareAccessEpoch });
  expect(await readSessionQuota('task', deps, () => undefined))
    .toMatchObject({ source: 'shared', status: 'available', windows: [{ usedPercent: 30, resetsAt }] });
  expect(await readSessionQuota('task', deps, () => undefined)).toEqual({ status: 'unavailable' });
  expect(await readSessionQuota('task', deps, () => undefined)).toEqual({ status: 'unavailable' });
  shareAccessEpoch.mockReturnValueOnce(0).mockReturnValueOnce(1);
  expect(await readSessionQuota('task', deps, () => undefined)).toEqual({ status: 'unavailable' });
  expect(readShare).toHaveBeenCalledWith('grant');
  expect(deps.readLocal).not.toHaveBeenCalled();
  expect(deps.readRemote).not.toHaveBeenCalled();
});
