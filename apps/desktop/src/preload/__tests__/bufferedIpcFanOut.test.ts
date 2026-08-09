import { describe, expect, it, vi } from 'vitest';

import {
  createBufferedIpcFanOut,
  type BufferedIpcBridge,
  type BufferedIpcDiscardContext,
} from '../bufferedIpcFanOut';

function makeHarness(
  options: {
    maxBufferedEvents?: number;
    ttlMs?: number;
    onDiscard?: (context: BufferedIpcDiscardContext) => void;
  } = {},
) {
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
      onDiscard: options.onDiscard,
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
    const discarded: BufferedIpcDiscardContext[] = [];
    const { fanOut, emit } = makeHarness({ onDiscard: (context) => discarded.push(context) });
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
    expect(discarded).toEqual([]);
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
    const discarded: BufferedIpcDiscardContext[] = [];
    const { fanOut, emit } = makeHarness({
      maxBufferedEvents: 2,
      onDiscard: (context) => discarded.push(context),
    });
    const listener = vi.fn();
    emit('oldest');
    emit('middle');
    emit('newest');

    fanOut(listener);

    expect(listener.mock.calls).toEqual([
      ['middle', undefined],
      ['newest', undefined],
    ]);
    expect(discarded).toEqual([{ data: 'oldest', ownerStamp: undefined, reason: 'overflow' }]);
  });

  it('drops backlog entries after their TTL instead of replaying stale OAuth URLs', () => {
    const discarded: BufferedIpcDiscardContext[] = [];
    const { fanOut, emit, advance } = makeHarness({
      ttlMs: 100,
      onDiscard: (context) => discarded.push(context),
    });
    const listener = vi.fn();
    emit('expired');
    advance(101);
    emit('fresh');

    fanOut(listener);

    expect(listener.mock.calls).toEqual([['fresh', undefined]]);
    expect(discarded).toEqual([{ data: 'expired', ownerStamp: undefined, reason: 'expired' }]);
  });

  it('prunes expired entries on subscribe exactly once', () => {
    const discarded: BufferedIpcDiscardContext[] = [];
    const { fanOut, emit, advance } = makeHarness({
      ttlMs: 100,
      onDiscard: (context) => discarded.push(context),
    });
    const listener = vi.fn();
    emit('expired');
    advance(101);
    fanOut(listener);

    expect(listener).not.toHaveBeenCalled();
    expect(discarded).toEqual([{ data: 'expired', ownerStamp: undefined, reason: 'expired' }]);
  });

  it('disposes a real backlog during reset without affecting live listeners', () => {
    const discarded: BufferedIpcDiscardContext[] = [];
    const { fanOut, emit } = makeHarness({ onDiscard: (context) => discarded.push(context) });
    emit('reset-me');

    fanOut.__reset();

    expect(discarded).toEqual([{ data: 'reset-me', ownerStamp: undefined, reason: 'reset' }]);
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
