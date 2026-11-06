// Live Activity controller (macOS 27.3 ActivityKit via the N-API addon). Rule basis:
// ActivityKit refuses a start from a process without a visible window (`visibility`,
// verified on macOS 27.3) and accepts later background updates, so the controller must
// retry a refused start instead of dropping the feature, clear activities a crashed run
// left behind, and coalesce island updates to the native layer. Unit tier: a fake addon
// stands in for ActivityKit; fake timers, no real waits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentIslandLiveActivityState } from '../liveActivity.js';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nonexistent' } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

const { AgentIslandLiveActivity } = await import('../liveActivity.js');

function state(runningCount: number, status: AgentIslandLiveActivityState['status'] = 'running'): AgentIslandLiveActivityState {
  return { status, runningCount, attentionCount: 0, title: 'Task', detail: 'Running', mascot: 'cindy' };
}

function fakeAddon(replies: Array<Record<string, unknown>> = []) {
  const calls: Array<{ action: string; state?: AgentIslandLiveActivityState }> = [];
  return {
    calls,
    addon: {
      apply(command: string) {
        const parsed = JSON.parse(command) as { action: string; state?: AgentIslandLiveActivityState };
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

  it('never loads the addon before macOS 27.3', () => {
    const load = vi.fn();
    const live = new AgentIslandLiveActivity({ platform: 'darwin', darwinRelease: '27.2.0', load, appName: 'Cindy' });
    live.sync(state(1));

    expect(live.isSupported()).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});
