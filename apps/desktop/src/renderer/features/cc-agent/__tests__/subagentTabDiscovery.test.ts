import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubagentRunsListResponse } from '@cindy/maker-shared/subagent-workspace';

import {
  REMOTE_SUBAGENT_DISCOVERY_POLL_MS,
  REMOTE_SUBAGENT_PRESENCE_POLL_MS,
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

  /**
   * The entry used to be decided by the parent's *current* harness. Switching a
   * Pi task to Claude Code or Codex leaves its detached runners going — they
   * hold credentials and write the workspace — while the tab that monitors them
   * and offers the per-child stop vanished. Ownership is what the disk says, so
   * discovery is what answers it, and the answer has to keep being answered:
   * once cleanup removes the records the entry must go away again.
   */
  describe('durable-run presence for the sidebar entry', () => {
    it('reports a task that owns runs, whatever harness it is on now', async () => {
      const h = harness();
      h.listLocal.mockResolvedValue(runs(1));
      const presence: boolean[] = [];

      const dispose = startSubagentTabDiscovery({
        sessionId: 's1',
        deviceId: null,
        listLocal: h.listLocal,
        listRemote: h.listRemote,
        subscribeLocalChanges: h.subscribeLocalChanges,
        registerTab: h.registerTab,
        isRequestOwnerCurrent: () => true,
        onPresenceChange: (present) => presence.push(present),
      });
      await settle();

      expect(presence).toEqual([true]);
      expect(h.registerTab).toHaveBeenCalledOnce();
      dispose();
    });

    it('reports no presence for a task with no Pi runs, and opens nothing', async () => {
      // The gate is widened to every task, so this is what keeps it from
      // becoming an entry on every Claude Code and Codex session.
      const h = harness();
      h.listLocal.mockResolvedValue(EMPTY);
      const presence: boolean[] = [];

      const dispose = startSubagentTabDiscovery({
        sessionId: 's1',
        deviceId: null,
        listLocal: h.listLocal,
        listRemote: h.listRemote,
        subscribeLocalChanges: h.subscribeLocalChanges,
        registerTab: h.registerTab,
        isRequestOwnerCurrent: () => true,
        onPresenceChange: (present) => presence.push(present),
      });
      await settle();

      expect(presence).toEqual([false]);
      expect(h.registerTab).not.toHaveBeenCalled();
      dispose();
    });

    it('falls back once the records are gone', async () => {
      // Cleanup after the parent task was deleted. The tab must stop being
      // declared available rather than lingering as a dead entry.
      const h = harness();
      h.listLocal.mockResolvedValueOnce(runs(1)).mockResolvedValue(EMPTY);
      const presence: boolean[] = [];

      const dispose = startSubagentTabDiscovery({
        sessionId: 's1',
        deviceId: null,
        listLocal: h.listLocal,
        listRemote: h.listRemote,
        subscribeLocalChanges: h.subscribeLocalChanges,
        registerTab: h.registerTab,
        isRequestOwnerCurrent: () => true,
        onPresenceChange: (present) => presence.push(present),
      });
      await settle();
      expect(presence).toEqual([true]);

      // The subscription outlives registration for a presence consumer.
      expect(h.unsubscribe).not.toHaveBeenCalled();
      h.emitLocalChange();
      await settle();

      expect(presence).toEqual([true, false]);
      // Still one-shot where it counts: no second tab registration.
      expect(h.registerTab).toHaveBeenCalledOnce();
      dispose();
    });

    it('keeps terminal runs counted, exactly as a Pi task shows them', async () => {
      // Terminal rows are still rows: a Pi task keeps its tab for reviewing
      // them, and a task that moved off Pi has to behave the same.
      const h = harness();
      h.listLocal.mockResolvedValue(runs(1));
      const presence: boolean[] = [];

      const dispose = startSubagentTabDiscovery({
        sessionId: 's1',
        deviceId: null,
        listLocal: h.listLocal,
        listRemote: h.listRemote,
        subscribeLocalChanges: h.subscribeLocalChanges,
        registerTab: h.registerTab,
        isRequestOwnerCurrent: () => true,
        onPresenceChange: (present) => presence.push(present),
      });
      await settle();
      h.emitLocalChange();
      await settle();

      expect(presence).toEqual([true, true]);
      expect(h.registerTab).toHaveBeenCalledOnce();
      dispose();
    });

    it('keeps a slow remote presence poll after registering, and sees the falling edge', async () => {
      // A remote task has no change push at all, so stopping here left presence
      // pinned true forever: a remote `/clear`, a rewind past the Subagent's
      // start, or its deletion cleanup could never reach the controller, and the
      // entry outlived its records until the session was unloaded.
      const h = harness();
      h.listRemote.mockResolvedValueOnce(runs(1)).mockResolvedValue(EMPTY);
      const presence: boolean[] = [];

      const dispose = startSubagentTabDiscovery({
        sessionId: 's1',
        deviceId: 'device-a',
        listLocal: h.listLocal,
        listRemote: h.listRemote,
        subscribeLocalChanges: h.subscribeLocalChanges,
        registerTab: h.registerTab,
        isRequestOwnerCurrent: () => true,
        onPresenceChange: (present) => presence.push(present),
        presencePollMs: 1_000,
      });
      await settle();
      expect(presence).toEqual([true]);
      expect(h.registerTab).toHaveBeenCalledOnce();

      // Discovery's own cadence no longer applies: the next read is on the
      // slower presence one, and it reports the records going away.
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(presence).toEqual([true, false]);

      // And it keeps answering, so a later re-appearance is seen too.
      h.listRemote.mockResolvedValue(runs(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(presence.at(-1)).toBe(true);
      // Still one-shot where it counts.
      expect(h.registerTab).toHaveBeenCalledOnce();
      dispose();
    });

    it('polls presence more slowly than it polls for discovery', () => {
      // Discovery decides whether a tab appears at all and a user is waiting on
      // it; this only decides when a stale entry disappears, and nobody is.
      expect(REMOTE_SUBAGENT_PRESENCE_POLL_MS).toBeGreaterThan(REMOTE_SUBAGENT_DISCOVERY_POLL_MS);
    });

    it('stops the remote presence poll on dispose', async () => {
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
        onPresenceChange: () => undefined,
        presencePollMs: 1_000,
      });
      await settle();
      expect(h.listRemote).toHaveBeenCalledTimes(1);

      dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(h.listRemote).toHaveBeenCalledTimes(1);
    });

    it('leaves the one-shot contract untouched without a presence consumer', async () => {
      const h = harness();
      h.listLocal.mockResolvedValue(runs(1));

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

      expect(h.unsubscribe).toHaveBeenCalled();
      h.emitLocalChange();
      await settle();
      expect(h.listLocal).toHaveBeenCalledTimes(1);
      dispose();
    });
  });

  /**
   * The module above is where the decision lives; this is the wiring that feeds
   * it. `CCAgentSessionView` is far too heavy to mount here (it pulls in the
   * whole session runtime), so the two invariants that were wrong are checked
   * on its source — the same approach `orcaWorkflowRoute.test.ts` uses for that
   * component's private contracts.
   */
  describe('CCAgentSessionView wiring', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../CCAgentSessionView.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    it('reads on a whole-session invalidation, not just a per-run change', () => {
      // `/clear` and a rewind past the Subagent's start emit one push with
      // `runId: null` — the records are gone. The subscriber dropped exactly
      // that shape, so nothing re-read the list and a task that had switched
      // to Claude Code or Codex kept declaring an entry for runs that no
      // longer existed. `sessionId` is a real id on that payload; only `runId`
      // is nullable, so the scoping is unchanged.
      const subscribe = source.slice(
        source.indexOf('subscribeLocalChanges: (onChanged) =>'),
        source.indexOf('registerTab: () => openSubagentsTab('),
      );
      expect(subscribe).not.toContain('payload.runId === null');
      // Shares the panel's predicate rather than keeping a second copy that can
      // drift from it.
      expect(subscribe).toContain('isCurrentSubagentRunsChange(payload, ownerStamp, sessionId)');
      expect(source).toContain(
        "import { isCurrentSubagentRunsChange } from '@/features/right-sidebar/plugins/subagents/subagentChangeFence';",
      );
    });

    it('lets discovery run for a task on any harness', () => {
      const effect = source.slice(
        source.indexOf('return startSubagentTabDiscovery({') - 900,
        source.indexOf('return startSubagentTabDiscovery({'),
      );
      // The gate that hid a Pi task's live children the moment it switched to
      // Claude Code or Codex. Ownership is decided by the list, not the harness.
      expect(effect).toContain('if (!ownsWindowRoute || !viewVisible || !sessionId) return;');
      expect(effect).not.toContain("session?.agentKind !== 'pi'");
      // And the effect no longer re-runs on a harness switch, because it no
      // longer reads one.
      const deps = source.slice(source.indexOf('return startSubagentTabDiscovery({'));
      const depsLine = deps.slice(0, deps.indexOf('\n\n'));
      expect(depsLine).toContain('}, [ownsWindowRoute, remoteDeviceId, sessionId, viewVisible]);');
      expect(depsLine).toContain('onPresenceChange:');
    });

    it('declares the entry available for a local Pi task or for one that owns runs', () => {
      expect(source).toContain(
        "(session.agentKind === 'pi' && !session.remoteHostId) || durablePiRunsPresent",
      );
      // The harness alone is not enough: `agents/pi` treats a session with a
      // `remoteHostId` as remote and never installs the durable Subagent
      // extension for it, so an SSH-hosted Pi task can never own a run.
      // Declaring the entry from `agentKind` alone opened a tab that stays
      // empty forever and whose controls address the local filesystem rather
      // than the remote host. `durablePiRunsPresent` stays ungated: device-link
      // is supported and discovers remotely, and an SSH task's local list is
      // always empty so it cannot come back through that branch.
      expect(source).not.toContain(
        "session ? session.agentKind === 'pi' || durablePiRunsPresent : undefined",
      );
      // Unresolved session still reads as "not known yet" rather than
      // "unavailable" — the shell distinguishes the two.
      expect(source).not.toContain("subagentsAvailable={session ? session.agentKind === 'pi' : undefined}");
      // Presence is keyed by the session it was observed for, so navigating to
      // another task cannot inherit the previous one's answer.
      expect(source).toContain(
        "const durablePiRunsPresent = Boolean(sessionId) && sessionOwningDurablePiRuns === sessionId;",
      );
    });
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
