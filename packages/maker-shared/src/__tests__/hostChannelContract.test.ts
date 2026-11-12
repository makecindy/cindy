import { describe, it, expect } from 'vitest';
import { HOST_CONTRACT_CHANNELS, createHostChannelHandlers } from '../hostChannelContract';

describe('HOST_CONTRACT_CHANNELS', () => {
  it('has unique desktop channels and web paths', () => {
    const desktopChannels = HOST_CONTRACT_CHANNELS.map(c => c.desktopChannel);
    const webPaths = HOST_CONTRACT_CHANNELS.map(c => c.webPath);
    expect(new Set(desktopChannels).size).toBe(desktopChannels.length);
    expect(new Set(webPaths).size).toBe(webPaths.length);
  });

  it('every entry points to a valid api endpoint', () => {
    for (const entry of HOST_CONTRACT_CHANNELS) {
      expect(entry.hostPath.startsWith('/api/')).toBe(true);
      expect(entry.desktopChannel.length).toBeGreaterThan(0);
      expect(entry.webPath.length).toBeGreaterThan(0);
    }
  });

  it('correctly maps estimatedSessionValue instead of the dead estimated-value', () => {
    const entry = HOST_CONTRACT_CHANNELS.find(c => c.hostPath === '/api/messages/estimated-value');
    expect(entry?.desktopChannel).toBe('local-db:messages:estimatedSessionValue');
  });
});

// The preload passes two arguments. Shifting them made every approval return 404.
it('preserves the preload interaction answer and acceptance result', () => {
  const entry = HOST_CONTRACT_CHANNELS.find(c => c.desktopChannel === 'maker:resolve-interaction')!;
  const decision = { behavior: 'allow' };
  expect(entry.body?.(['request-1', decision])).toEqual({ requestId: 'request-1', decision });
  expect(entry.map?.({ accepted: true })).toEqual({ accepted: true });
  expect(entry.map?.({ accepted: false, ok: true })).toEqual({ accepted: false });
});

it('asks for runtime sessions and preserves versioned snapshot options', () => {
  const entry = HOST_CONTRACT_CHANNELS.find(c => c.desktopChannel === 'maker:list-active')!;
  expect(entry.hostPath).toBe('/api/runtime/sessions');
  expect(entry.body?.([{ summary: true, snapshotVersion: 2 }])).toEqual({ options: { summary: true, snapshotVersion: 2 } });
});

// Regression: an explicit Host client must log out the credential owner, not
// mutate the desktop client's unrelated local credential record.
it('routes explicit Host logout to the same writer as refresh', () => {
  const entry = HOST_CONTRACT_CHANNELS.find(c => c.desktopChannel === 'auth:logout')!;
  expect(entry.hostPath).toBe('/api/auth/logout');
  expect(entry.body?.([])).toEqual({});
});

// The shared coordinator returns the authoritative queue state after steer;
// older Hosts returned only a boolean. Both remain readable during upgrades.
it('preserves the steer projection while accepting legacy Host replies', () => {
  const entry = HOST_CONTRACT_CHANNELS.find(c => c.desktopChannel === 'maker:input:steer')!;
  const projection = { sessionId: 's', turnInProgress: true, pendingQueue: [] };
  expect(entry.map?.({ ok: true, projection })).toEqual(projection);
  expect(entry.map?.({ ok: true })).toBe(true);
  expect(entry.map?.({ ok: false })).toBe(false);
});

// Trusted Desktop settings must not silently become privileged Web shim calls.
// Exercise dispatch, not only channel declarations; no network or timers.
it('keeps privileged browser settings out of the web adapter', async () => {
  const requests: string[] = [];
  const handlers = createHostChannelHandlers(async path => { requests.push(path); return { ok: true }; });
  expect(handlers['browserBackend.setKind']).toBeUndefined();
  expect(handlers['browserBackend.openExtensionStore']).toBeUndefined();
  await handlers['auth.logout']();
  expect(requests).toEqual(['/api/auth/logout']);
});
