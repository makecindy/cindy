import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeOtaRequestCoordinator, type NativeOtaBridge } from './nativeOtaRequestCoordinator';

function harness() {
  const events: string[] = [];
  const bridge: NativeOtaBridge = {
    cindySelfHostOtaCapabilities: vi.fn(() => ({ version: 1, runtimeVersion: 'native-r1',
      updateUrl: 'https://native.example.invalid/manifest', available: true })),
    cindyBeginSelfHostOtaRequest: vi.fn((channel) => { events.push('begin:' + channel); return 'token'; }),
    cindyFinishSelfHostOtaRequest: vi.fn(() => { events.push('finish'); }),
  };
  const client = {
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: true, manifest: { id: 'u2' } })),
    fetchUpdateAsync: vi.fn(async () => ({ isNew: true, manifest: { id: 'u2' } })),
    reloadAsync: vi.fn(async () => { events.push('reload'); }),
  };
  return { events, bridge, client, coordinator: createNativeOtaRequestCoordinator(bridge, client) };
}
const options = { channel: 'beta' as const, currentUpdateId: 'u1', runtimeVersion: 'native-r1' };
afterEach(() => vi.useRealTimers());

describe('native self-host OTA scheduling', () => {
  it('uses the native contract and closes its request before destroying the JS runtime', async () => {
    const h = harness();
    await h.coordinator.run(options, async (client) => {
      await client.checkForUpdateAsync();
      await client.fetchUpdateAsync();
      await client.reloadAsync();
    });
    expect(h.events).toEqual(['begin:beta', 'finish', 'reload']);
  });

  it.each([
    { version: 2 }, { available: false }, { runtimeVersion: 'other-runtime' }, { updateUrl: '' },
  ])('fails closed for a mismatched native contract: %j', async (override) => {
    const h = harness();
    const capability = h.bridge.cindySelfHostOtaCapabilities();
    vi.mocked(h.bridge.cindySelfHostOtaCapabilities).mockReturnValue({ ...capability, ...override });
    await expect(h.coordinator.run(options, (client) => client.checkForUpdateAsync()))
      .rejects.toThrow('native-ota-contract-unavailable');
    expect(h.bridge.cindyBeginSelfHostOtaRequest).not.toHaveBeenCalled();
    expect(h.client.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it('restores after no update or an operation failure', async () => {
    const h = harness();
    await h.coordinator.run(options, async () => false);
    await expect(h.coordinator.run(options, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    await h.coordinator.run(options, async () => undefined);
    expect(h.events).toEqual(['begin:beta', 'finish', 'begin:beta', 'finish', 'begin:beta', 'finish']);
  });

  it('keeps the queue locked until a timed-out native download really settles', async () => {
    vi.useFakeTimers();
    const h = harness();
    let resolveDownload!: (value: { isNew: boolean; manifest: { id: string } }) => void;
    h.client.fetchUpdateAsync.mockImplementationOnce(() => new Promise((resolve) => { resolveDownload = resolve; }));
    const first = h.coordinator.run({ ...options, fetchTimeoutMs: 5 }, (client) => client.fetchUpdateAsync());
    const rejected = expect(first).rejects.toThrow('ota-request-timeout');
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    const second = h.coordinator.run({ ...options, channel: 'canary' }, async () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual(['begin:beta']);
    resolveDownload({ isNew: true, manifest: { id: 'u2' } });
    expect(await second).toBe(true);
    expect(h.events).toEqual(['begin:beta', 'finish', 'begin:canary', 'finish']);
  });

  it('does not reload the currently running update even when native reports it as new', async () => {
    const h = harness();
    h.client.checkForUpdateAsync.mockResolvedValue({ isAvailable: true, manifest: { id: 'U1' } });
    h.client.fetchUpdateAsync.mockResolvedValue({ isNew: true, manifest: { id: 'U1' } });
    await h.coordinator.run(options, async (client) => {
      expect((await client.checkForUpdateAsync()).isAvailable).toBe(false);
      expect((await client.fetchUpdateAsync()).isNew).toBe(false);
    });
    expect(h.client.reloadAsync).not.toHaveBeenCalled();
  });

  it('does not hide native restoration failures on a normally completed request', async () => {
    const h = harness();
    vi.mocked(h.bridge.cindyFinishSelfHostOtaRequest).mockImplementation(() => { throw new Error('disk-full'); });
    await expect(h.coordinator.run(options, async () => true)).rejects.toThrow('disk-full');
  });
});
