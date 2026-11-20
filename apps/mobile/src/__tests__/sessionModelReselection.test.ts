import { afterEach, describe, expect, it } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { clearAllDeviceProviders, fetchDeviceProviders, fetchDeviceProvidersFresh, retainedProviderModelKey } from '@/device-link/deviceProvidersCache';
import { clearAllProviderShareCatalogs, refreshProviderShareCatalogs } from '@/device-link/providerShareCatalogCache';
import { hiddenSessionModelAtSend } from '@/session/sessionModelAtSend';

const session = { agentKind: 'codex' as const, model: 'old', providerId: 'source' };
const target = { targetAgentKind: 'pi' as const, model: 'next', providerId: 'source' };
const modelKey = 'codex:source:old';
const nextKey = 'pi:source:next';
const read = (device: string, overrides: Record<string, boolean>) =>
  fetchDeviceProviders(device, async () => ({ providers: [], modelVisibilityOverrides: overrides }));

afterEach(() => {
  clearAllDeviceProviders();
  clearAllProviderShareCatalogs();
});

// #11693: exercise the screen's send decision with live device caches. The old guard
// read only the controlled computer even after a retained lookup or a pending move.
describe('existing task hidden-model send guard', () => {
  it('uses the pending cross-agent selection, including its execution computer', async () => {
    await read('host', { [modelKey]: false, [nextKey]: true });
    await read('executor', { [nextKey]: false });
    expect(hiddenSessionModelAtSend(session, 'host')).toEqual({ agent: 'codex', modelId: 'old', providerId: 'source' });
    expect(hiddenSessionModelAtSend({ ...session, agentSwitchIntent: target }, 'host')).toBeUndefined();
    expect(hiddenSessionModelAtSend({ ...session, agentSwitchIntent: { ...target, agentDeviceId: 'executor' } }, 'host'))
      .toEqual({ agent: 'pi', modelId: 'next', providerId: 'source' });
    expect(hiddenSessionModelAtSend({ ...session, agentDeviceId: 'executor', agentSwitchIntent: { ...target, agentDeviceId: null } }, 'host'))
      .toBeUndefined();
  });

  it('uses a retained visibility only for the same device, base snapshot and exact route', async () => {
    const base = await read('executor', {});
    await read('host', {});
    const remote = { ...session, agentDeviceId: 'executor' };
    const retained = { base, key: retainedProviderModelKey({ agent: 'codex', providerId: 'source', modelId: 'old' }),
      payload: { providers: [], modelVisibilityOverrides: { [modelKey]: false } } };
    expect(hiddenSessionModelAtSend(remote, 'host', retained)?.modelId).toBe('old');
    expect(hiddenSessionModelAtSend(session, 'host', retained)).toBeUndefined();
    expect(hiddenSessionModelAtSend({ ...remote, providerId: null }, 'host', retained)).toBeUndefined();
    await fetchDeviceProvidersFresh('executor', async () => ({ providers: [], modelVisibilityOverrides: { [modelKey]: true } }));
    expect(hiddenSessionModelAtSend(remote, 'host', retained)).toBeUndefined();
  });

  it('reads a shared supplier from the controlled computer’s received-share catalog', async () => {
    const shared = { ...session, agentDeviceId: 'share:abc' };
    await read('host', { [modelKey]: false });
    expect(hiddenSessionModelAtSend(shared, 'host')).toBeUndefined();
    await refreshProviderShareCatalogs('host', async () => ({ shares: [{
      agentDeviceId: 'share:abc', shareId: 'abc', providerId: 'source', providerLabel: 'Source',
      deviceName: 'Computer', owner: { displayName: 'Owner' }, status: 'active', hostOnline: true,
      catalog: { providers: [], modelVisibilityOverrides: { [modelKey]: false } },
    }] }));
    expect(hiddenSessionModelAtSend(shared, 'host')?.modelId).toBe('old');
  });

  it('uses the guest-scoped catalog for a shared task that names a separate execution computer', async () => {
    const guestHost = sharedTaskHostPeer('task', 'host');
    await read(guestHost, { [modelKey]: false });
    await read('executor', { [modelKey]: true });
    expect(hiddenSessionModelAtSend({ ...session, agentDeviceId: 'executor' }, guestHost)?.modelId).toBe('old');
  });
});
