// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOfflineMirrorWipeQueue } from '@/device-link/offlineMirrorWipeQueue';
import { schedulePresenceWipeTimer, type PresenceWipeTimerEntry } from '@/device-link/presenceRecovery';
import { remoteScheduleEventStore, useRemoteScheduleMirrorInvalidations } from '@/scheduler/remoteScheduleEvents';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => { vi.useFakeTimers(); remoteScheduleEventStore.clearAll(); });
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });

it.each([1, 60, 100])('settles mounted mirror consumers after %i separately delivered presence timers', async (count) => {
  const render = vi.fn();
  function Consumer() {
    const invalidations = useRemoteScheduleMirrorInvalidations();
    const [offline, setOffline] = useState<ReadonlyMap<string, number>>(new Map());
    useEffect(() => { setOffline(invalidations); }, [invalidations]);
    render();
    return createElement('span', null, offline.size);
  }
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(createElement(Consumer)));
  render.mockClear();
  const notify = vi.fn();
  const off = remoteScheduleEventStore.subscribe(notify);
  const queue = createOfflineMirrorWipeQueue(ids => remoteScheduleEventStore.invalidateDeviceMirrors(ids));
  const timers = new Map<string, PresenceWipeTimerEntry>();
  const availability = new Map<string, boolean>();
  try {
    for (let i = 0; i < count; i++) {
      const id = `device-${i}`;
      availability.set(id, false);
      schedulePresenceWipeTimer(timers, availability, id, 5_000 + i % 10, {
        now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout, wipe: queue.enqueue,
        deferWipe: queue.enqueue,
      });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_016); });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe(String(count));
    expect(render.mock.calls.length).toBeLessThanOrEqual(3);
    const settledRenders = render.mock.calls.length;
    await act(async () => {
      for (let i = 0; i < 100; i++) {
        remoteScheduleEventStore.invalidateDeviceMirrors([...availability.keys()]);
        await Promise.resolve();
      }
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(settledRenders);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(render).toHaveBeenCalledTimes(settledRenders);
    expect(timers.size).toBe(0);
  } finally { off(); queue.clear(); }
});
