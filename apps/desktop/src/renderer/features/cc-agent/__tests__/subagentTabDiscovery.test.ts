import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubagentRunsListResponse } from '@cindy/maker-shared/subagent-workspace';

import {
  REMOTE_SUBAGENT_DISCOVERY_POLL_MS,
  startSubagentTabDiscovery,
} from '../subagentTabDiscovery';

function runs(count: number): SubagentRunsListResponse {
  return {
    supported: true,
    runs: Array.from({ length: count }, (_, index) => ({
      id: `run-${index}`,
      provider: 'pi',
    })) as unknown as SubagentRunsListResponse['runs'],
  };
}

/** Historical rows for a task that has since switched to Pi. */
function nonPiRuns(...providers: Array<'claude-code' | 'codex'>): SubagentRunsListResponse {
  return {
    supported: true,
    runs: providers.map((provider, index) => ({
      id: `legacy-${index}`,
      provider,
    })) as unknown as SubagentRunsListResponse['runs'],
  };
}

function mixedRuns(): SubagentRunsListResponse {
  return {
    supported: true,
    runs: [
      { id: 'legacy-0', provider: 'claude-code' },
      { id: 'run-0', provider: 'pi' },
    ] as unknown as SubagentRunsListResponse['runs'],
  };
}

const EMPTY: SubagentRunsListResponse = { supported: true, runs: [] };
const UNSUPPORTED: SubagentRunsListResponse = { supported: false, runs: [] };

interface Harness {
  listLocal: ReturnType<typeof vi.fn>;
  listRemote: ReturnType<typeof vi.fn>;
  registerTab: ReturnType<typeof vi.fn>;
  subscribeLocalChanges: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  emitLocalChange: () => void;
}

function harness(): Harness {
  let onChanged: (() => void) | null = null;
  const unsubscribe = vi.fn(() => {
    onChanged = null;
  });
  return {
    listLocal: vi.fn(async () => EMPTY),
    listRemote: vi.fn(async () => EMPTY),
    registerTab: vi.fn(async () => {}),
    subscribeLocalChanges: vi.fn((cb: () => void) => {
      onChanged = cb;
      return unsubscribe;
    }),
    unsubscribe,
    emitLocalChange: () => onChanged?.(),
  };
}

/** Let the discovery promise chain settle without advancing timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('startSubagentTabDiscovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('discovers a remote task through device-link, never the local DB', async () => {
    const h = harness();
    h.listRemote.mockResolvedValue(runs(1));

    const dispose = startSubagentTabDiscovery({
      sessionId: 's1',
      deviceId: 'device-a',
      listLocal: h.listLocal,
      listRemote: h.listRemote,
      subscribeLocalChanges: h.subscribeLocalChanges,
      registerTab: h.registerTab,
      isRequestOwnerCurrent: () => true,
    });
    await settle();

    expect(h.listRemote).toHaveBeenCalledWith('device-a');
    expect(h.listLocal).not.toHaveBeenCalled();
    // A remote task has no change push for this channel, so it never subscribes.
    expect(h.subscribeLocalChanges).not.toHaveBeenCalled();
    expect(h.registerTab).toHaveBeenCalledOnce();
    dispose();
  });

  it('stops the remote poll once the tab is registered', async () => {
    const h = harness();
    h.listRemote.mockResolvedValueOnce(EMPTY).mockResolvedValue(runs(2));

    const dispose = startSubagentTabDiscovery({
      sessionId: 's1',
      deviceId: 'device-a',
      listLocal: h.listLocal,
      listRemote: h.listRemote,
      subscribeLocalChanges: h.subscribeLocalChanges,
      registerTab: h.registerTab,
      isRequestOwnerCurrent: () => true,
    });
    await settle();
    expect(h.registerTab).not.toHaveBeenCalled();

    // Second read finds runs and registers.
    await vi.advanceTimersByTimeAsync(REMOTE_SUBAGENT_DISCOVERY_POLL_MS);
    await settle();
    expect(h.listRemote).toHaveBeenCalledTimes(2);
    expect(h.registerTab).toHaveBeenCalledOnce();

    // Registration is a one-shot goal: no further reads, no repeat registration.
    await vi.advanceTimersByTimeAsync(REMOTE_SUBAGENT_DISCOVERY_POLL_MS * 4);
    await settle();
    expect(h.listRemote).toHaveBeenCalledTimes(2);
    expect(h.registerTab).toHaveBeenCalledOnce();
    dispose();
  });

  it('does not register the Pi-only tab for non-Pi history alone', async () => {
    // The tab is Pi-only and SubagentsBody drops every non-Pi row, so a task
    // that switched to Pi but still has Claude Code / Codex history would have
    // opened a permanently empty tab. The remote read is already Pi-narrowed on
    // the Main side; this is the local path.
    const h = harness();
    h.listLocal.mockResolvedValue(nonPiRuns('claude-code', 'codex'));

    const dispose = startSubagentTabDiscovery({
      sessionId: 's1',
      deviceId: null,
      listLocal: h.listLocal,
      listRemote: h.listRemote,
      subscribeLocalChanges: h.subscribeLocalChanges,
      registerTab: h.registerTab,
      isRequestOwnerCurrent: () => true,
    });
    await settle();
    expect(h.registerTab).not.toHaveBeenCalled();

    // The first Pi run in the same mixed history does register it.
    h.listLocal.mockResolvedValue(mixedRuns());
    h.emitLocalChange();
    await settle();
    expect(h.registerTab).toHaveBeenCalledOnce();
    dispose();
  });

  it('polls at a 5s-scale cadence, not the panel-level 1s', () => {
    expect(REMOTE_SUBAGENT_DISCOVERY_POLL_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('never registers a tab when the owner reports no runs or no support', async () => {
    const h = harness();
    h.listRemote.mockResolvedValue(EMPTY);

    const dispose = startSubagentTabDiscovery({
      sessionId: 's1',
      deviceId: 'device-a',
      listLocal: h.listLocal,
      listRemote: h.listRemote,
      subscribeLocalChanges: h.subscribeLocalChanges,
      registerTab: h.registerTab,
      isRequestOwnerCurrent: () => true,
    });
    await vi.advanceTimersByTimeAsync(REMOTE_SUBAGENT_DISCOVERY_POLL_MS * 3);
    await settle();
    expect(h.registerTab).not.toHaveBeenCalled();

    h.listRemote.mockResolvedValue(UNSUPPORTED);
    await vi.advanceTimersByTimeAsync(REMOTE_SUBAGENT_DISCOVERY_POLL_MS);
    await settle();
    expect(h.registerTab).not.toHaveBeenCalled();
    dispose();
  });

  it('keeps the local task on its change push with no polling', async () => {
    const h = harness();
    h.listLocal.mockResolvedValueOnce(EMPTY).mockResolvedValue(runs(1));

    const dispose = startSubagentTabDiscovery({
      sessionId: 's1',
      deviceId: null,
      listLocal: h.listLocal,
      listRemote: h.listRemote,
      subscribeLocalChanges: h.subscribeLocalChanges,
      registerTab: h.registerTab,
      isRequestOwnerCurrent: () => true,
    });
    await settle();
    expect(h.listRemote).not.toHaveBeenCalled();
    expect(h.registerTab).not.toHaveBeenCalled();

    // No poll exists for a local task.
    await vi.advanceTimersByTimeAsync(REMOTE_SUBAGENT_DISCOVERY_POLL_MS * 3);
    await settle();
    expect(h.listLocal).toHaveBeenCalledTimes(1);

    h.emitLocalChange();
    await settle();
    expect(h.registerTab).toHaveBeenCalledOnce();
    // One-shot: the change subscription is released after registration.
    expect(h.unsubscribe).toHaveBeenCalled();
    dispose();
  });

  it('drops a response that crossed a data-owner boundary', async () => {
    const h = harness();
    h.listRemote.mockResolvedValue(runs(1));

    const dispose = startSubagentTabDiscovery({
      sessionId: 's1',
      deviceId: 'device-a',
      listLocal: h.listLocal,
      listRemote: h.listRemote,
      subscribeLocalChanges: h.subscribeLocalChanges,
      registerTab: h.registerTab,
      isRequestOwnerCurrent: () => false,
    });
    await settle();
    expect(h.registerTab).not.toHaveBeenCalled();
    dispose();
  });

  /**
   * A device-link invoke defaults to a 30s timeout, so a fixed 5s interval could
   * keep ~6 reads in flight against an unreachable device — all of them queued
   * on the same reliable transport the user's stop/steer controls use.
   */
  it('does not start a second remote read while the first is still in flight', async () => {
    const h = harness();
    let release!: (value: SubagentRunsListResponse) => void;
    h.listRemote.mockImplementation(() => new Promise<SubagentRunsListResponse>((resolve) => {
      release = resolve;
    }));

    const dispose = startSubagentTabDiscovery({
      sessionId: 's1',
      deviceId: 'device-a',
      listLocal: h.listLocal,
      listRemote: h.listRemote,
      subscribeLocalChanges: h.subscribeLocalChanges,
      registerTab: h.registerTab,
      isRequestOwnerCurrent: () => true,
    });
    await settle();
    expect(h.listRemote).toHaveBeenCalledTimes(1);

    // Several cadences pass while the first read is still pending.
    await vi.advanceTimersByTimeAsync(REMOTE_SUBAGENT_DISCOVERY_POLL_MS * 5);
    await settle();
    expect(h.listRemote).toHaveBeenCalledTimes(1);

    // Only after it settles does the next round get armed.
    release?.(EMPTY);
    await settle();
    expect(h.listRemote).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REMOTE_SUBAGENT_DISCOVERY_POLL_MS);
    await settle();
    expect(h.listRemote).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('keeps polling after a failed remote read', async () => {
    // A dropped link is exactly what this poll is waiting to recover from, so a
    // rejection must re-arm the chain rather than end it.
    const h = harness();
    h.listRemote.mockRejectedValueOnce(new Error('link down')).mockResolvedValue(EMPTY);

    const dispose = startSubagentTabDiscovery({
      sessionId: 's1',
      deviceId: 'device-a',
      listLocal: h.listLocal,
      listRemote: h.listRemote,
      subscribeLocalChanges: h.subscribeLocalChanges,
      registerTab: h.registerTab,
      isRequestOwnerCurrent: () => true,
    });
    await settle();
    expect(h.listRemote).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REMOTE_SUBAGENT_DISCOVERY_POLL_MS);
    await settle();
    expect(h.listRemote).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('stops polling and swallows read failures after dispose', async () => {
    const h = harness();
    h.listRemote.mockRejectedValue(new Error('link down'));

    const dispose = startSubagentTabDiscovery({
      sessionId: 's1',
      deviceId: 'device-a',
      listLocal: h.listLocal,
      listRemote: h.listRemote,
      subscribeLocalChanges: h.subscribeLocalChanges,
      registerTab: h.registerTab,
      isRequestOwnerCurrent: () => true,
    });
    await settle();
    dispose();

    const callsAtDispose = h.listRemote.mock.calls.length;
    await vi.advanceTimersByTimeAsync(REMOTE_SUBAGENT_DISCOVERY_POLL_MS * 3);
    await settle();
    expect(h.listRemote).toHaveBeenCalledTimes(callsAtDispose);
  });
});
