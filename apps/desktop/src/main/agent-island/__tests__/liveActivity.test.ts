// Live Activity controller (macOS 27.3 ActivityKit via the N-API addon). Rule basis:
// ActivityKit refuses a start from a process without a visible window (`visibility`,
// verified on macOS 27.3) and accepts later background updates, so the controller must
// retry a refused start instead of dropping the feature, clear activities a crashed run
// left behind, and coalesce island updates to the native layer. Alerts expand the system
// island, so only a new request for the user or finished work may raise one. Unit tier: a fake addon
// stands in for ActivityKit; fake timers, no real waits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentIslandLiveActivityState } from '../liveActivity.js';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nonexistent' } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

const { AgentIslandLiveActivity, agentIslandLiveActivityStateFromPill } = await import('../liveActivity.js');

function state(
  runningCount: number,
  status: AgentIslandLiveActivityState['status'] = 'running',
  attentionCount = 0,
): AgentIslandLiveActivityState {
  return { status, runningCount, attentionCount, title: 'Task', detail: status, summary: '', mascot: 'cindy' };
}

function fakeAddon(replies: Array<Record<string, unknown>> = []) {
  type Call = { action: string; state?: AgentIslandLiveActivityState; alert?: { title: string; body: string } };
  const calls: Call[] = [];
  return {
    calls,
    addon: {
      apply(command: string) {
        const parsed = JSON.parse(command) as Call;
        calls.push(parsed);
        if (parsed.action === 'sync') return JSON.stringify(replies.shift() ?? { ok: true, result: 'updated' });
        return JSON.stringify({ ok: true, result: 'ended' });
      },
    },
  };
}

function controller(addon: { apply(command: string): string }, darwinRelease = '27.3.0') {
  return new AgentIslandLiveActivity({
    platform: 'darwin',
    darwinRelease,
    load: () => addon,
    now: () => Date.now(),
    appName: 'Cindy',
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentIslandLiveActivity', () => {
  it('clears stale activities once, then sends only the latest of rapid island updates', async () => {
    const fake = fakeAddon([{ ok: true, result: 'started' }]);
    const live = controller(fake.addon);
    live.sync(state(1));
    await vi.advanceTimersByTimeAsync(0);
    live.sync(state(2));
    live.sync(state(3));
    live.sync(state(3));
    await vi.advanceTimersByTimeAsync(1000);

    expect(fake.calls.map((call) => [call.action, call.state?.runningCount])).toEqual([
      ['end', undefined],
      ['sync', 1],
      ['sync', 3],
    ]);
  });

  it('retries a start ActivityKit refused for visibility once a window is visible', async () => {
    const fake = fakeAddon([{ ok: false, error: 'visibility' }, { ok: true, result: 'started' }]);
    const live = controller(fake.addon);
    live.sync(state(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.calls.filter((call) => call.action === 'sync')).toHaveLength(1);

    live.notifyWindowVisible();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((call) => call.action === 'sync')).toHaveLength(2);

    live.sync(state(2));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls.at(-1)).toMatchObject({ action: 'sync', state: { runningCount: 2 } });
  });

  it('ends the activity when nothing needs it or the user turns it off', async () => {
    const fake = fakeAddon([{ ok: true, result: 'started' }, { ok: true, result: 'started' }]);
    const live = controller(fake.addon);
    live.sync(state(1));
    await vi.advanceTimersByTimeAsync(0);
    live.sync(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls.at(-1)?.action).toBe('end');

    live.sync(state(1, 'attention'));
    await vi.advanceTimersByTimeAsync(1000);
    live.setEnabled(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls.map((call) => call.action)).toEqual(['end', 'sync', 'end', 'sync', 'end']);

    live.sync(state(4));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toHaveLength(5);
  });

  it('alerts only when a task newly needs the user or work finishes', async () => {
    const fake = fakeAddon([{ ok: true, result: 'started' }]);
    const live = controller(fake.addon);
    live.sync(state(1, 'attention', 1));
    await vi.advanceTimersByTimeAsync(0);
    for (const next of [state(2, 'attention', 1), state(1, 'attention', 2), state(1), state(0, 'completed')]) {
      live.sync(next);
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(fake.calls.filter((call) => call.action === 'sync').map((call) => call.alert?.body)).toEqual([
      undefined, // a start shows up on its own
      undefined, // more running work
      'attention',
      undefined, // answered
      'completed',
    ]);
  });

  it('shows the surfaced companion only once it needs the user or replied, without oversized artwork', () => {
    const strings = {
      needsInput: 'Needs input', running: 'Running', completed: 'Replied',
      runningCount: (n: number) => `${n} running`,
      alsoRunningCount: (n: number) => `${n} more`,
      waitingCount: (n: number) => `${n} waiting`,
    };
    const pill = (running: number, pending: number) => ({
      priorityId: 's1', priorityStatus: 'running' as const, priorityMicroTitle: 'Lizi', priorityCompactTitle: 'Lizi',
      sessionCount: 1, runningSessionCount: running, pendingInteractionCount: pending,
      unreadCompletedCount: 0, deferredRevealCount: 0, attentionCount: pending,
    });
    const companion = { name: 'Lizi', hue: 'pink' as const, glyph: 'L', glyphIsInitial: true, imageJpeg: 'a'.repeat(2049) };

    expect(agentIslandLiveActivityStateFromPill(pill(1, 0), 'cindy', strings, companion)?.companion).toBeUndefined();
    // A 4 KB content update fails as a whole; the avatar falls back to the glyph instead.
    expect(agentIslandLiveActivityStateFromPill(pill(0, 1), 'cindy', strings, companion)?.companion)
      .toEqual({ hue: 'pink', glyph: 'L', glyphIsInitial: true });
  });

  it('never loads the addon before macOS 27.3', () => {
    const load = vi.fn();
    const live = new AgentIslandLiveActivity({ platform: 'darwin', darwinRelease: '27.2.0', load, appName: 'Cindy' });
    live.sync(state(1));

    expect(live.isSupported()).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});
