import { describe, expect, it, vi } from 'vitest';
import { rehydrateDeviceLinkTopics } from '@/device-link/rehydrate';
import type { DeviceLinkRehydrateDeps } from '@/device-link/rehydrate';

function deps() {
  const calls: string[] = [];
  let nextCohort = 0;
  const harness: DeviceLinkRehydrateDeps = {
    capturePresenceEpoch: vi.fn(() => 0),
    captureResponseEvidenceEpoch: vi.fn(() => 0),
    isPresenceEpochCurrent: vi.fn(() => true),
    isResponseEvidenceEpochCurrent: vi.fn(() => true),
    createDeviceSendCohort: vi.fn(() => ++nextCohort),
    openLink: vi.fn((deviceId: string) => {
      calls.push(`open:${deviceId}`);
      return {
        capturedPresenceEpoch: 0,
        capturedResponseEvidenceEpoch: 0,
        request: Promise.resolve(),
      };
    }),
    subscribe: vi.fn(async (deviceId: string, topics) => {
      calls.push(`subscribe:${deviceId}:${topics.join(',')}`);
    }),
    requestSessionsReseed: vi.fn((deviceId: string) => {
      calls.push(`reseed:${deviceId}`);
    }),
    rebuildSessionSnapshot: vi.fn(async (deviceId: string, sessionId: string) => {
      calls.push(`rebuild:${deviceId}:${sessionId}`);
    }),
  };
  return { calls, harness };
}

describe('rehydrateDeviceLinkTopics', () => {
  it('replays open links, subscriptions, and host-authoritative snapshots in order', async () => {
    const { calls, harness } = deps();

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1', 'sessions'] },
      { deviceId: 'dev-2', openLink: false, topics: ['session:s2'] },
    ], harness);

    expect(calls).toEqual([
      'open:dev-1',
      'subscribe:dev-1:session:s1,sessions',
      'rebuild:dev-1:s1',
      'reseed:dev-1',
      'subscribe:dev-2:session:s2',
      'rebuild:dev-2:s2',
    ]);
  });

  it('stops the remaining sweep when background release cancels it', async () => {
    const { calls, harness } = deps();
    let cancelled = false;
    harness.isCancelled = vi.fn(() => cancelled);
    vi.mocked(harness.openLink).mockImplementationOnce((deviceId: string) => {
      calls.push(`open:${deviceId}`);
      cancelled = true;
      return {
        capturedPresenceEpoch: 0,
        capturedResponseEvidenceEpoch: 0,
        request: Promise.resolve(),
      };
    });

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1'] },
      { deviceId: 'dev-2', openLink: true, topics: ['session:s2'] },
    ], harness);

    expect(calls).toEqual(['open:dev-1']);
    expect(harness.subscribe).not.toHaveBeenCalled();
    expect(harness.rebuildSessionSnapshot).not.toHaveBeenCalled();
    expect(result.transientFailures).toBe(0);
  });

  it('uses independent cohorts for each concurrent snapshot batch', async () => {
    const { harness } = deps();

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1', 'session:s2'] },
      { deviceId: 'dev-2', openLink: true, topics: ['session:s3'] },
    ], harness);

    expect(harness.createDeviceSendCohort).toHaveBeenCalledWith('dev-1');
    expect(harness.createDeviceSendCohort).toHaveBeenCalledWith('dev-2');
    expect(harness.createDeviceSendCohort).toHaveBeenCalledTimes(3);
    expect(vi.mocked(harness.openLink).mock.calls[0]).toEqual(['dev-1']);
    expect(vi.mocked(harness.subscribe).mock.calls[0]).toEqual([
      'dev-1',
      ['session:s1', 'session:s2'],
    ]);
    const dev1First = vi.mocked(harness.rebuildSessionSnapshot).mock.calls[0][2]?.responsivenessCohort;
    const dev1Second = vi.mocked(harness.rebuildSessionSnapshot).mock.calls[1][2]?.responsivenessCohort;
    const dev2 = vi.mocked(harness.rebuildSessionSnapshot).mock.calls[2][2]?.responsivenessCohort;
    expect(dev1First).toBeDefined();
    expect(dev1Second).not.toBe(dev1First);
    expect(dev2).not.toBe(dev1First);
    expect(dev2).not.toBe(dev1Second);
  });

  it('reports a successful remote step as reachable so stale cleanup can be cancelled', async () => {
    const { harness } = deps();
    const onDeviceReachable = vi.fn();
    harness.onDeviceReachable = onDeviceReachable;

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['sessions'] },
    ], harness);

    expect(onDeviceReachable).toHaveBeenCalledWith('dev-1');
  });

  it('ignores stale reachable evidence after a newer offline presence delta', async () => {
    const { harness } = deps();
    const onDeviceReachable = vi.fn();
    harness.onDeviceReachable = onDeviceReachable;
    vi.mocked(harness.isPresenceEpochCurrent).mockReturnValue(false);

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: [] },
    ], harness);

    expect(onDeviceReachable).not.toHaveBeenCalled();
  });

  it('restores unavailable state after an authoritative offline failure', async () => {
    const { harness } = deps();
    const onDeviceUnavailable = vi.fn();
    harness.onDeviceUnavailable = onDeviceUnavailable;
    vi.mocked(harness.openLink).mockReturnValueOnce({
      capturedPresenceEpoch: 0,
      capturedResponseEvidenceEpoch: 0,
      request: Promise.reject(
        Object.assign(new Error('target offline'), { code: 'DEVICE_OFFLINE' }),
      ),
    });

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: [] },
    ], harness);

    expect(harness.subscribe).not.toHaveBeenCalled();
    expect(harness.rebuildSessionSnapshot).not.toHaveBeenCalled();
    expect(onDeviceUnavailable).toHaveBeenCalledOnce();
    expect(onDeviceUnavailable).toHaveBeenCalledWith('dev-1');
    expect(result.transientFailures).toBe(0);
  });

  it('stops the current device plan when a snapshot confirms it is offline', async () => {
    const { harness } = deps();
    const onDeviceUnavailable = vi.fn();
    harness.onDeviceUnavailable = onDeviceUnavailable;
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(
      Object.assign(new Error('target offline'), { code: 'DEVICE_OFFLINE' }),
    );

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: false, topics: ['session:s1', 'session:s2'] },
    ], harness);

    expect(harness.rebuildSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(onDeviceUnavailable).toHaveBeenCalledWith('dev-1');
  });

  it('ignores a stale offline verdict after a newer presence delta', async () => {
    const { harness } = deps();
    const onDeviceUnavailable = vi.fn();
    harness.onDeviceUnavailable = onDeviceUnavailable;
    vi.mocked(harness.isPresenceEpochCurrent).mockReturnValue(false);
    vi.mocked(harness.openLink).mockReturnValueOnce({
      capturedPresenceEpoch: 0,
      capturedResponseEvidenceEpoch: 0,
      request: Promise.reject(
        Object.assign(new Error('target offline'), { code: 'DEVICE_OFFLINE' }),
      ),
    });

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['sessions'] },
    ], harness);

    expect(onDeviceUnavailable).not.toHaveBeenCalled();
    expect(harness.subscribe).toHaveBeenCalledOnce();
    expect(result.transientFailures).toBe(1);
  });

  it('downgrades offline after a concurrent send proves the device reachable', async () => {
    const { harness } = deps();
    const onDeviceUnavailable = vi.fn();
    harness.onDeviceUnavailable = onDeviceUnavailable;
    vi.mocked(harness.isResponseEvidenceEpochCurrent).mockReturnValue(false);
    vi.mocked(harness.openLink).mockReturnValueOnce({
      capturedPresenceEpoch: 0,
      capturedResponseEvidenceEpoch: 0,
      request: Promise.reject(
        Object.assign(new Error('target offline'), { code: 'DEVICE_OFFLINE' }),
      ),
    });

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['sessions'] },
    ], harness);

    expect(onDeviceUnavailable).not.toHaveBeenCalled();
    expect(harness.subscribe).toHaveBeenCalledOnce();
    expect(result.transientFailures).toBe(1);
  });

  it('downgrades remote-disabled after a concurrent send proves reachability', async () => {
    const { harness } = deps();
    const onDeviceRemoteDisabled = vi.fn();
    harness.onDeviceRemoteDisabled = onDeviceRemoteDisabled;
    vi.mocked(harness.isResponseEvidenceEpochCurrent).mockReturnValue(false);
    vi.mocked(harness.openLink).mockReturnValueOnce({
      capturedPresenceEpoch: 0,
      capturedResponseEvidenceEpoch: 0,
      request: Promise.reject(
        Object.assign(new Error('disabled'), { code: 'REMOTE_DISABLED' }),
      ),
    });

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['sessions'] },
    ], harness);

    expect(onDeviceRemoteDisabled).not.toHaveBeenCalled();
    expect(harness.subscribe).toHaveBeenCalledOnce();
    expect(result.transientFailures).toBe(1);
  });

  it('does not treat transport failures as an unavailable presence verdict', async () => {
    const { harness } = deps();
    const onDeviceUnavailable = vi.fn();
    harness.onDeviceUnavailable = onDeviceUnavailable;
    vi.mocked(harness.subscribe).mockRejectedValueOnce(
      Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }),
    );

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: false, topics: ['sessions'] },
    ], harness);

    expect(onDeviceUnavailable).not.toHaveBeenCalled();
  });

  it('continues rebuilding other devices and sessions when one replay step fails', async () => {
    const { calls, harness } = deps();
    vi.mocked(harness.openLink).mockReturnValueOnce({
      capturedPresenceEpoch: 0,
      capturedResponseEvidenceEpoch: 0,
      request: Promise.reject(new Error('open failed')),
    });
    vi.mocked(harness.subscribe).mockRejectedValueOnce(new Error('subscribe failed'));
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(new Error('rebuild failed'));

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1', 'session:s2'] },
      { deviceId: 'dev-2', openLink: true, topics: ['sessions'] },
    ], harness);

    expect(calls).toEqual([
      'rebuild:dev-1:s2',
      'open:dev-2',
      'subscribe:dev-2:sessions',
      'reseed:dev-2',
    ]);
    expect(harness.openLink).toHaveBeenCalledTimes(2);
    expect(harness.subscribe).toHaveBeenCalledTimes(2);
    expect(harness.rebuildSessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it('counts transient failures so the caller can schedule a backoff re-run', async () => {
    const { harness } = deps();
    vi.mocked(harness.subscribe).mockRejectedValueOnce(
      Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }),
    );
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'INVOKE_TIMEOUT' }),
    );

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: false, topics: ['session:s1'] },
      { deviceId: 'dev-2', openLink: false, topics: ['session:s2'] },
    ], harness);

    expect(result.transientFailures).toBe(2);
  });

  it('treats remote-disabled as authoritative and stops the device plan', async () => {
    const { harness } = deps();
    const onDeviceRemoteDisabled = vi.fn();
    harness.onDeviceRemoteDisabled = onDeviceRemoteDisabled;
    vi.mocked(harness.openLink).mockReturnValueOnce({
      capturedPresenceEpoch: 0,
      capturedResponseEvidenceEpoch: 0,
      request: Promise.reject(
        Object.assign(new Error('disabled'), { code: 'REMOTE_DISABLED' }),
      ),
    });

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1'] },
    ], harness);

    expect(onDeviceRemoteDisabled).toHaveBeenCalledWith('dev-1');
    expect(harness.subscribe).not.toHaveBeenCalled();
    expect(harness.rebuildSessionSnapshot).not.toHaveBeenCalled();
    expect(result.transientFailures).toBe(0);
  });

  it('ignores stale remote-disabled after a newer presence delta', async () => {
    const { harness } = deps();
    const onDeviceRemoteDisabled = vi.fn();
    harness.onDeviceRemoteDisabled = onDeviceRemoteDisabled;
    vi.mocked(harness.isPresenceEpochCurrent).mockReturnValue(false);
    vi.mocked(harness.openLink).mockReturnValueOnce({
      capturedPresenceEpoch: 0,
      capturedResponseEvidenceEpoch: 0,
      request: Promise.reject(
        Object.assign(new Error('disabled'), { code: 'REMOTE_DISABLED' }),
      ),
    });

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['sessions'] },
    ], harness);

    expect(onDeviceRemoteDisabled).not.toHaveBeenCalled();
    expect(harness.subscribe).toHaveBeenCalledOnce();
    expect(result.transientFailures).toBe(1);
  });

  it('does not count other permanent failures (retrying them is pointless)', async () => {
    const { harness } = deps();
    vi.mocked(harness.openLink).mockReturnValueOnce({
      capturedPresenceEpoch: 0,
      capturedResponseEvidenceEpoch: 0,
      request: Promise.reject(
        Object.assign(new Error('unsupported'), { code: 'CHANNEL_NOT_ALLOWED' }),
      ),
    });
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(new Error('unexpected'));

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1'] },
    ], harness);

    expect(result.transientFailures).toBe(0);
  });

  it('reports a clean pass with zero transient failures', async () => {
    const { harness } = deps();
    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1'] },
    ], harness);
    expect(result.transientFailures).toBe(0);
  });
});
