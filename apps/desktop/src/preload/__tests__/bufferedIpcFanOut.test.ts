import { describe, expect, it, vi } from 'vitest';

import { createBufferedIpcFanOut, type BufferedIpcBridge } from '../bufferedIpcFanOut';

function makeHarness(options: { maxBufferedEvents?: number; ttlMs?: number } = {}) {
  let bridge: BufferedIpcBridge | null = null;
  let now = 1_000;
  const unbind = vi.fn();
  const fanOut = createBufferedIpcFanOut(
    (listener) => {
      bridge = listener;
      return unbind;
    },
    {
      maxBufferedEvents: options.maxBufferedEvents ?? 3,
      ttlMs: options.ttlMs ?? 100,
      now: () => now,
    },
  );

  return {
    fanOut,
    emit(data: unknown, ownerStamp?: unknown) {
      if (!bridge) throw new Error('IPC bridge is not bound');
      bridge({}, data, ownerStamp);
    },
    advance(ms: number) {
      now += ms;
    },
    unbind,
  };
}

describe('createBufferedIpcFanOut', () => {
  it('buffers before the first subscriber and flushes each event exactly once', () => {
    const { fanOut, emit } = makeHarness();
    const first = vi.fn();
    const second = vi.fn();

    emit({ url: 'https://accounts.example.com/one' }, 'owner-a');
    emit({ url: 'https://accounts.example.com/two' }, 'owner-b');

    fanOut(first);
    expect(first.mock.calls).toEqual([
      [{ url: 'https://accounts.example.com/one' }, 'owner-a'],
      [{ url: 'https://accounts.example.com/two' }, 'owner-b'],
    ]);

    fanOut(second);
    expect(second).not.toHaveBeenCalled();
  });

  it('delivers live events to every active subscriber without buffering duplicates', () => {
    const { fanOut, emit } = makeHarness();
    const first = vi.fn();
    const second = vi.fn();
    fanOut(first);
    fanOut(second);

    emit({ url: 'https://accounts.example.com/live' }, 'owner-live');

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith({ url: 'https://accounts.example.com/live' }, 'owner-live');
  });

  it('keeps only the newest bounded backlog while no subscriber exists', () => {
    const { fanOut, emit } = makeHarness({ maxBufferedEvents: 2 });
    const listener = vi.fn();
    emit('oldest');
    emit('middle');
    emit('newest');

    fanOut(listener);

    expect(listener.mock.calls).toEqual([
      ['middle', undefined],
      ['newest', undefined],
    ]);
  });

  it('drops backlog entries after their TTL instead of replaying stale OAuth URLs', () => {
    const { fanOut, emit, advance } = makeHarness({ ttlMs: 100 });
    const listener = vi.fn();
    emit('expired');
    advance(101);
    emit('fresh');

    fanOut(listener);

    expect(listener.mock.calls).toEqual([['fresh', undefined]]);
  });

  it('keeps the eager IPC binding after the last renderer subscriber leaves', () => {
    const { fanOut, emit, unbind } = makeHarness();
    const first = vi.fn();
    const off = fanOut(first);
    off();
    expect(unbind).not.toHaveBeenCalled();

    emit('during-route-switch');
    const afterRouteSwitch = vi.fn();
    fanOut(afterRouteSwitch);

    expect(afterRouteSwitch).toHaveBeenCalledWith('during-route-switch', undefined);
  });
});
