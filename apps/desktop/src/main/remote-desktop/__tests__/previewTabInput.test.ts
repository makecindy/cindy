import type { PreviewInputEvent } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDebuggerLease, releaseDebuggerLease } from '../../rsb-browser-bridge/debuggerLease';
import {
  PREVIEW_INPUT_TIMEOUT_MS,
  TabInputInjector,
  type GuestDebugger,
  type InputGuest,
} from '../previewTabInput';

function setup(options: { attached?: boolean; viewport?: { w: number; h: number } } = {}) {
  const state = { attached: options.attached ?? false };
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const handlers = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>();
  const viewport = options.viewport ?? { w: 800, h: 500 };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const transport: GuestDebugger = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return transport;
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
      return transport;
    }),
    isAttached: () => state.attached,
    attach: vi.fn(() => {
      state.attached = true;
    }),
    detach: vi.fn(() => {
      state.attached = false;
    }),
    sendCommand: vi.fn(async (method: string, params?: object) => {
      commands.push({ method, params: params as Record<string, unknown> | undefined });
      const handler = handlers.get(method);
      if (handler) return handler(params as Record<string, unknown> | undefined);
      if (method === 'Page.getLayoutMetrics')
        return { cssVisualViewport: { clientWidth: viewport.w, clientHeight: viewport.h } };
      return {};
    }),
  };
  const keyEvents: Array<Record<string, unknown>> = [];
  const guest: InputGuest = {
    isDestroyed: () => false,
    debugger: transport,
    sendInputEvent: vi.fn((event) => {
      keyEvents.push(event);
    }),
    insertText: vi.fn(async () => {}),
    setBackgroundThrottling: vi.fn(),
  };
  const emit = (event: string) => listeners.get(event)?.forEach((listener) => listener());
  return {
    injector: new TabInputInjector(guest),
    guest,
    transport,
    commands,
    handlers,
    keyEvents,
    state,
    emit,
    listeners,
  };
}
const touches = (commands: ReturnType<typeof setup>['commands']) =>
  commands.filter((c) => c.method === 'Input.dispatchTouchEvent').map((c) => c.params);
const touch = (
  phase: 'start' | 'move' | 'end' | 'cancel',
  points: Array<[number, number, number]>,
): PreviewInputEvent => ({
  kind: 'touch',
  phase,
  points: points.map(([id, x, y]) => ({ id, x, y })),
});

describe('TabInputInjector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('measures the CSS viewport and maps 0..1 points onto it without touching DPR', async () => {
    const h = setup({ viewport: { w: 800, h: 500 } });
    expect(await h.injector.measure()).toEqual({ width: 800, height: 500 });
    await h.injector.inject([touch('start', [[1, 0.5, 0.25]]), touch('end', [])]);
    expect(touches(h.commands)).toEqual([
      {
        type: 'touchStart',
        touchPoints: [{ id: 1, x: 400, y: 125, radiusX: 3, radiusY: 3, force: 1 }],
      },
      { type: 'touchEnd', touchPoints: [] },
    ]);
    expect(h.injector.pressed).toEqual({ touches: 0, keys: 0 });
  });

  it('sends two-finger sequences with the whole snapshot, and releases one finger via a move', async () => {
    const h = setup();
    await h.injector.inject([
      touch('start', [[1, 0.1, 0.1]]),
      touch('start', [
        [1, 0.1, 0.1],
        [2, 0.9, 0.9],
      ]),
      touch('move', [
        [1, 0.2, 0.1],
        [2, 0.8, 0.9],
      ]),
      touch('end', [[1, 0.2, 0.1]]),
    ]);
    const sent = touches(h.commands);
    expect(sent.map((c) => [c?.type, (c?.touchPoints as unknown[]).length])).toEqual([
      ['touchStart', 1],
      ['touchStart', 2],
      ['touchMove', 2],
      ['touchMove', 1],
    ]);
    expect(h.injector.pressed.touches).toBe(1);
    await h.injector.inject([touch('end', [])]);
    expect(touches(h.commands).at(-1)).toEqual({ type: 'touchEnd', touchPoints: [] });
  });

  it('cancels what is still down on release, once, and not at all when nothing is', async () => {
    const h = setup();
    await h.injector.inject([
      touch('start', [[7, 0.5, 0.5]]),
      { kind: 'key', code: 'ShiftLeft', down: true },
    ]);
    await h.injector.release();
    await h.injector.release();
    expect(touches(h.commands).filter((c) => c?.type === 'touchCancel')).toEqual([
      { type: 'touchCancel', touchPoints: [] },
    ]);
    expect(h.keyEvents.at(-1)).toMatchObject({ type: 'keyUp', keyCode: 'Shift' });
    expect(h.keyEvents.filter((e) => e.type === 'keyUp')).toHaveLength(1);
    expect(h.injector.pressed).toEqual({ touches: 0, keys: 0 });
    // A cancel with nothing started is not sent (the page would refuse it).
    await h.injector.inject([touch('cancel', [])]);
    expect(touches(h.commands).filter((c) => c?.type === 'touchCancel')).toHaveLength(1);
  });

  it('types printable keys, sends shortcuts without a character, and tracks modifiers', async () => {
    const h = setup();
    await h.injector.inject([
      { kind: 'key', code: 'KeyA', down: true },
      { kind: 'key', code: 'KeyA', down: false },
      { kind: 'key', code: 'ShiftLeft', down: true },
      { kind: 'key', code: 'KeyB', down: true },
      { kind: 'key', code: 'KeyB', down: false },
      { kind: 'key', code: 'ShiftLeft', down: false },
      { kind: 'key', code: 'ControlLeft', down: true },
      { kind: 'key', code: 'KeyC', down: true },
      { kind: 'key', code: 'KeyC', down: false },
      { kind: 'key', code: 'ControlLeft', down: false },
      { kind: 'key', code: 'ArrowLeft', down: true },
      { kind: 'key', code: 'ArrowLeft', down: false },
    ]);
    const types = h.keyEvents.map(
      (e) => `${e.type}:${e.keyCode}:${(e.modifiers as string[]).join('+')}`,
    );
    expect(types).toEqual([
      'keyDown:A:',
      'char:a:',
      'keyUp:A:',
      'keyDown:Shift:shift',
      'keyDown:B:shift',
      'char:B:shift',
      'keyUp:B:shift',
      'keyUp:Shift:',
      'keyDown:Control:control',
      'keyDown:C:control',
      'keyUp:C:control',
      'keyUp:Control:',
      'keyDown:Left:',
      'keyUp:Left:',
    ]);
    expect(h.injector.pressed.keys).toBe(0);
  });

  it('commits text through the guest with focus emulation on, not as key events', async () => {
    const h = setup();
    await h.injector.inject([{ kind: 'text', text: '中文ABC' }]);
    expect(h.guest.insertText).toHaveBeenCalledWith('中文ABC');
    expect(h.commands).toContainEqual({
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: true },
    });
    expect(h.keyEvents).toEqual([]);
  });

  it('serializes batches in order', async () => {
    const h = setup();
    const order: string[] = [];
    h.handlers.set('Input.dispatchTouchEvent', async (params) => {
      order.push(String(params?.type));
      return {};
    });
    await h.injector.measure();
    await Promise.all([
      h.injector.inject([touch('start', [[1, 0.1, 0.1]])]),
      h.injector.inject([touch('move', [[1, 0.2, 0.2]])]),
      h.injector.inject([touch('end', [])]),
    ]);
    expect(order).toEqual(['touchStart', 'touchMove', 'touchEnd']);
  });

  it('gives up on a command that never answers, lifts the throttle and drops pressed state', async () => {
    const h = setup();
    await h.injector.measure();
    let hang = true;
    h.handlers.set('Input.dispatchTouchEvent', async (params) => {
      if (hang && params?.type === 'touchStart') return new Promise(() => {});
      return {};
    });
    const pending = h.injector.inject([touch('start', [[1, 0.5, 0.5]])]);
    const assertion = expect(pending).rejects.toThrow('PREVIEW_INPUT_INVALID');
    await vi.advanceTimersByTimeAsync(PREVIEW_INPUT_TIMEOUT_MS);
    await assertion;
    expect(h.guest.setBackgroundThrottling).toHaveBeenCalledWith(false);
    expect(h.injector.pressed.touches).toBe(0);
    hang = false;
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    await h.injector.dispose();
    expect(h.guest.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it('refuses the rest of a batch after a failure and a rejected sequence resets the touches', async () => {
    const h = setup();
    await h.injector.measure();
    h.handlers.set('Input.dispatchTouchEvent', async () => {
      throw new Error('Must send a TouchStart first');
    });
    await expect(
      h.injector.inject([touch('move', [[1, 0.5, 0.5]]), { kind: 'text', text: 'x' }]),
    ).rejects.toThrow('PREVIEW_INPUT_INVALID');
    expect(h.guest.insertText).not.toHaveBeenCalled();
    expect(h.injector.pressed.touches).toBe(0);
  });

  it('owns the debugger only when it attached it, and re-attaches after someone else detaches', async () => {
    const owned = setup();
    await owned.injector.measure();
    expect(owned.transport.attach).toHaveBeenCalledOnce();
    owned.state.attached = false; // taken away by another user of the debugger
    await owned.injector.inject([touch('start', [[1, 0.1, 0.1]])]);
    expect(owned.transport.attach).toHaveBeenCalledTimes(2);
    await owned.injector.dispose();
    expect(owned.transport.detach).toHaveBeenCalledOnce();
    expect(owned.state.attached).toBe(false);
    await expect(owned.injector.inject([touch('end', [])])).rejects.toThrow('PREVIEW_SOURCE_ENDED');

    const shared = setup({ attached: true });
    await shared.injector.inject([{ kind: 'text', text: 'hi' }]);
    await shared.injector.dispose();
    expect(shared.transport.attach).not.toHaveBeenCalled();
    expect(shared.transport.detach).not.toHaveBeenCalled();
    expect(shared.commands.at(-1)).toEqual({
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: false },
    });
  });

  it('refuses an unmeasurable tab', async () => {
    const h = setup();
    h.handlers.set('Page.getLayoutMetrics', async () => ({
      cssVisualViewport: { clientWidth: 0 },
    }));
    await expect(h.injector.measure()).rejects.toThrow('PREVIEW_CAPTURE_UNAVAILABLE');
  });
});

describe('TabInputInjector lease geometry', () => {
  const dispatched = (h: ReturnType<typeof setup>) =>
    touches(h.commands).map((c) => [
      c?.type,
      (c?.touchPoints as Array<{ id: number; x: number; y: number }>).map((p) => [p.id, p.x, p.y]),
    ]);

  it('maps through the contain-fit of the current frame inside the lease rectangle', async () => {
    // The phone laid out 800x500; the tab is now square, so the picture is pillarboxed.
    const h = setup({ viewport: { w: 800, h: 800 } });
    h.injector.bindLease({ width: 800, height: 500 });
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    // The frame spans x 0.1875..0.8125 of the rectangle, all of y.
    await h.injector.inject([touch('start', [[2, 0.1875, 0]]), touch('end', [])]);
    await h.injector.inject([touch('start', [[3, 0.8125, 1]]), touch('end', [])]);
    expect(dispatched(h)).toEqual([
      ['touchStart', [[1, 400, 400]]],
      ['touchEnd', []],
      ['touchStart', [[2, 0, 0]]],
      ['touchEnd', []],
      ['touchStart', [[3, 800, 800]]],
      ['touchEnd', []],
    ]);
    // A wide tab in a tall rectangle is letterboxed instead.
    const wide = setup({ viewport: { w: 800, h: 400 } });
    wide.injector.bindLease({ width: 400, height: 800 });
    await wide.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    expect(dispatched(wide)[0]).toEqual(['touchStart', [[1, 400, 200]]]);
  });

  it('uses the lease size as is when the shape did not change, rounding included', async () => {
    const h = setup({ viewport: { w: 800.4, h: 500.2 } });
    h.injector.bindLease({ width: 800, height: 500 });
    await h.injector.inject([touch('start', [[1, 0.001, 0.999]]), touch('end', [])]);
    const [start] = dispatched(h);
    expect(start[0]).toBe('touchStart');
    const point = (start[1] as number[][])[0];
    expect(point[1]).toBeGreaterThan(0);
    expect(point[1]).toBeLessThan(2);
    expect(point[2]).toBeGreaterThan(498);
  });

  it('drops a gesture that starts on a black bar, finger by finger, and follows the rest', async () => {
    const h = setup({ viewport: { w: 800, h: 800 } });
    h.injector.bindLease({ width: 800, height: 500 });
    // Starts in the left bar: nothing is sent, now or for its move / end.
    await h.injector.inject([
      touch('start', [[1, 0.05, 0.5]]),
      touch('move', [[1, 0.5, 0.5]]),
      touch('end', []),
    ]);
    expect(dispatched(h)).toEqual([]);
    expect(h.injector.pressed.touches).toBe(0);
    // A second finger landing in the bar is ignored; the first carries on.
    await h.injector.inject([
      touch('start', [[1, 0.5, 0.5]]),
      touch('start', [
        [1, 0.5, 0.5],
        [2, 0.95, 0.5],
      ]),
      touch('move', [
        [1, 0.6, 0.5],
        [2, 0.9, 0.5],
      ]),
      touch('end', [[1, 0.6, 0.5]]),
      touch('end', []),
    ]);
    expect(dispatched(h)).toEqual([
      ['touchStart', [[1, 400, 400]]],
      ['touchMove', [[1, 800 * ((0.6 - 0.1875) / 0.625), 400]]],
      ['touchEnd', []],
    ]);
  });

  it('keeps a finger that was already down on the edge when it slides into a bar', async () => {
    const h = setup({ viewport: { w: 800, h: 800 } });
    h.injector.bindLease({ width: 800, height: 500 });
    await h.injector.inject([
      touch('start', [[1, 0.5, 0.5]]),
      touch('move', [[1, 0.02, 0.5]]),
      touch('move', [[1, 0.99, 2 / 3]]),
      touch('end', []),
    ]);
    expect(dispatched(h)).toEqual([
      ['touchStart', [[1, 400, 400]]],
      ['touchMove', [[1, 0, 400]]],
      ['touchMove', [[1, 800, 800 * (2 / 3)]]],
      ['touchEnd', []],
    ]);
  });

  it('re-measures between gestures, so a resized panel maps with its new shape', async () => {
    const h = setup({ viewport: { w: 800, h: 500 } });
    h.injector.bindLease({ width: 800, height: 500 });
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    h.handlers.set('Page.getLayoutMetrics', async () => ({
      cssVisualViewport: { clientWidth: 800, clientHeight: 800 },
    }));
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    expect(dispatched(h).filter(([type]) => type === 'touchStart')).toEqual([
      ['touchStart', [[1, 400, 250]]],
      ['touchStart', [[1, 400, 400]]],
    ]);
  });
});

describe('TabInputInjector keys', () => {
  it('types a newline for Enter, except in a shortcut', async () => {
    const h = setup();
    await h.injector.inject([
      { kind: 'key', code: 'Enter', down: true },
      { kind: 'key', code: 'Enter', down: false },
      { kind: 'key', code: 'ControlLeft', down: true },
      { kind: 'key', code: 'Enter', down: true },
      { kind: 'key', code: 'Enter', down: false },
      { kind: 'key', code: 'ControlLeft', down: false },
    ]);
    const types = h.keyEvents.map((e) => `${e.type}:${JSON.stringify(e.keyCode)}`);
    expect(types).toEqual([
      'keyDown:"Enter"',
      'char:"\\r"',
      'keyUp:"Enter"',
      'keyDown:"Control"',
      'keyDown:"Enter"',
      'keyUp:"Enter"',
      'keyUp:"Control"',
    ]);
  });
});

describe('TabInputInjector debugger lease', () => {
  it('shares the debugger with another user: the last one out detaches', async () => {
    const h = setup();
    await h.injector.measure(); // attaches
    expect(h.state.attached).toBe(true);
    // The browser automation joins and leaves while a preview lease is live.
    const automation = acquireDebuggerLease(h.transport);
    expect(automation.owns).toBe(true);
    if (releaseDebuggerLease(h.transport, automation)) h.transport.detach();
    expect(h.state.attached).toBe(true);
    await h.injector.dispose();
    expect(h.state.attached).toBe(false);
  });

  it('does not tear down an automation session that outlives the preview', async () => {
    const h = setup();
    const automation = acquireDebuggerLease(h.transport); // attaches first
    await h.injector.inject([{ kind: 'text', text: 'x' }]);
    await h.injector.dispose();
    expect(h.state.attached).toBe(true);
    expect(releaseDebuggerLease(h.transport, automation)).toBe(true);
  });

  it('does not own an attachment that was already there (DevTools)', async () => {
    const h = setup({ attached: true });
    await h.injector.inject([{ kind: 'text', text: 'x' }]);
    await h.injector.dispose();
    expect(h.transport.detach).not.toHaveBeenCalled();
    expect(h.state.attached).toBe(true);
  });

  it('enables focus again after the session was replaced, and releases the re-attach it made', async () => {
    const h = setup({ attached: true });
    await h.injector.inject([{ kind: 'text', text: 'one' }]);
    const enables = () =>
      h.commands.filter(
        (c) => c.method === 'Emulation.setFocusEmulationEnabled' && c.params?.enabled === true,
      );
    expect(enables()).toHaveLength(1);
    // Someone detaches and a new session starts underneath: the emulation went with the old one.
    h.state.attached = false;
    h.emit('detach');
    h.state.attached = true;
    await h.injector.inject([{ kind: 'text', text: 'two' }]);
    expect(enables()).toHaveLength(2);
    // The DevTools-style attachment goes away for good; the injector has to re-attach itself ...
    h.state.attached = false;
    h.emit('detach');
    await h.injector.inject([{ kind: 'text', text: 'three' }]);
    expect(h.transport.attach).toHaveBeenCalledOnce();
    expect(enables()).toHaveLength(3);
    // ... and gives that attachment back, and stops listening, when the lease ends.
    await h.injector.dispose();
    expect(h.state.attached).toBe(false);
    expect(h.listeners.get('detach')?.size ?? 0).toBe(0);
  });
});
