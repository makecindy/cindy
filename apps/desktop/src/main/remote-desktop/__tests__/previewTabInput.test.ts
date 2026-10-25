import type { PreviewInputEvent } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const logs = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn() }));
vi.mock('../../logger', () => ({ createLogger: () => logs }));
import { acquireDebuggerLease, releaseDebuggerLease } from '../../rsb-browser-bridge/debuggerLease';
import {
  type GuestOrigin,
  PREVIEW_INPUT_TIMEOUT_MS,
  TabInputInjector,
  type GuestDebugger,
  type InputGuest,
} from '../previewTabInput';

function setup(
  options: {
    attached?: boolean;
    viewport?: { w: number; h: number };
    origin?: () => Promise<GuestOrigin | null>;
    pointFree?: (point: { x: number; y: number }) => Promise<boolean>;
  } = {},
) {
  const state = { attached: options.attached ?? false };
  const commands: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }> = [];
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
    sendCommand: vi.fn(async (method: string, params?: object, sessionId?: string) => {
      commands.push({ method, params: params as Record<string, unknown> | undefined, sessionId });
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
    injector: new TabInputInjector(
      guest,
      options.origin
        ? {
            origin: options.origin,
            ...(options.pointFree ? { pointFree: options.pointFree } : {}),
          }
        : {},
    ),
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

  // Measured on Electron 42: a touch missing from a `touchMove` stays down in the page; only a
  // `touchEnd` carrying it lifts it. So a finger that left the snapshot is ended on its own.
  describe('when one of several fingers lifts first', () => {
    const point = (id: number, x: number, y: number) => ({
      id,
      x,
      y,
      radiusX: 3,
      radiusY: 3,
      force: 1,
    });
    const typesOf = (h: ReturnType<typeof setup>) =>
      touches(h.commands).map((c) => [
        c?.type,
        (c?.touchPoints as Array<{ id: number }>).map((p) => p.id),
      ]);

    it('ends only the lifted finger and goes on moving the other', async () => {
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
        touch('move', [[1, 0.3, 0.2]]),
      ]);
      expect(typesOf(h)).toEqual([
        ['touchStart', [1]],
        ['touchStart', [1, 2]],
        ['touchMove', [1, 2]],
        ['touchEnd', [2]],
        ['touchMove', [1]],
      ]);
      // The ended finger goes out where it last was.
      expect(touches(h.commands)[3]?.touchPoints).toEqual([point(2, 640, 450)]);
      expect(h.injector.pressed.touches).toBe(1);
      await h.injector.inject([touch('end', [])]);
      expect(touches(h.commands).at(-1)).toEqual({ type: 'touchEnd', touchPoints: [] });
      expect(h.injector.pressed.touches).toBe(0);
    });

    it('ends the finger that went down first and goes on moving the one that went down later', async () => {
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
        touch('end', [[2, 0.8, 0.9]]),
        touch('move', [[2, 0.5, 0.9]]),
        touch('move', [[2, 0.2, 0.9]]),
      ]);
      expect(typesOf(h)).toEqual([
        ['touchStart', [1]],
        ['touchStart', [1, 2]],
        ['touchMove', [1, 2]],
        ['touchEnd', [1]],
        ['touchMove', [2]],
        ['touchMove', [2]],
      ]);
      // The ended finger goes out where it last was; the one left follows its own track.
      expect(touches(h.commands)[3]?.touchPoints).toEqual([point(1, 160, 50)]);
      expect(touches(h.commands).at(-1)?.touchPoints).toEqual([point(2, 160, 450)]);
      expect(h.injector.pressed.touches).toBe(1);
    });

    it('moves the rest when it moved with the lift, and ends a finger a move left out', async () => {
      const h = setup();
      await h.injector.inject([
        touch('start', [[1, 0.1, 0.1]]),
        touch('start', [
          [1, 0.1, 0.1],
          [2, 0.9, 0.9],
        ]),
        touch('end', [[1, 0.2, 0.1]]),
        touch('start', [
          [1, 0.2, 0.1],
          [3, 0.5, 0.5],
        ]),
        touch('move', [[3, 0.6, 0.5]]),
      ]);
      expect(typesOf(h)).toEqual([
        ['touchStart', [1]],
        ['touchStart', [1, 2]],
        ['touchEnd', [2]],
        ['touchMove', [1]],
        ['touchStart', [1, 3]],
        ['touchEnd', [1]],
        ['touchMove', [3]],
      ]);
    });

    it('lifts three fingers one after another, and takes a new finger afterwards', async () => {
      const h = setup();
      await h.injector.inject([
        touch('start', [[1, 0.1, 0.1]]),
        touch('start', [
          [1, 0.1, 0.1],
          [2, 0.5, 0.5],
        ]),
        touch('start', [
          [1, 0.1, 0.1],
          [2, 0.5, 0.5],
          [3, 0.9, 0.9],
        ]),
        touch('end', [
          [1, 0.1, 0.1],
          [3, 0.9, 0.9],
        ]),
        touch('end', [[3, 0.9, 0.9]]),
        touch('start', [
          [3, 0.9, 0.9],
          [4, 0.3, 0.3],
        ]),
        touch('move', [
          [3, 0.8, 0.9],
          [4, 0.3, 0.4],
        ]),
        touch('end', [[4, 0.3, 0.4]]),
        touch('end', []),
      ]);
      expect(typesOf(h)).toEqual([
        ['touchStart', [1]],
        ['touchStart', [1, 2]],
        ['touchStart', [1, 2, 3]],
        ['touchEnd', [2]],
        ['touchEnd', [1]],
        ['touchStart', [3, 4]],
        ['touchMove', [3, 4]],
        ['touchEnd', [3]],
        ['touchEnd', []],
      ]);
      expect(h.injector.pressed.touches).toBe(0);
    });
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

describe('TabInputInjector guest origin', () => {
  const sentPoints = (h: ReturnType<typeof setup>) =>
    touches(h.commands).map((c) =>
      (c?.touchPoints as Array<{ id: number; x: number; y: number }>).map((p) => [p.x, p.y]),
    );
  const box = (x: number, y: number, width: number, height: number): GuestOrigin => ({
    x,
    y,
    width,
    height,
  });

  it('adds the webview box origin: CDP touches are in the host window coordinate space', async () => {
    // The <webview> sits at (770, 86) in the host window; the page is 800x500 CSS px.
    const h = setup({ origin: async () => box(770, 86, 800, 500) });
    h.injector.bindLease({ width: 800, height: 500 });
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    expect(sentPoints(h)[0]).toEqual([[770 + 400, 86 + 250]]);
    // The phone's normalized 0,0 is the tab's own top-left, whatever the window layout.
    await h.injector.inject([touch('start', [[1, 0, 0]]), touch('end', [])]);
    expect(sentPoints(h)[2]).toEqual([[770, 86]]);
  });

  // Measured on a real Desktop (defect A): received = sent - (rect.left, rect.top), rect being
  // the <webview> element's getBoundingClientRect() in the host's CSS px, with the host app at
  // 100%, 110% and 90% zoom and with the tab inside the keep-alive layer. The page point is
  // what the guest saw; the host zoom does not enter the offset.
  it.each([
    ['100% zoom', box(661, 86, 619, 714), { w: 619, h: 714 }, [339, 514], [1000, 600]],
    [
      'host zoom 110% (dpr 2.2)',
      box(660.99432373, 85.99431611, 502.64202881, 641.27838135),
      { w: 502, h: 641 },
      [339.1, 514.1],
      [1000, 600],
    ],
    [
      'host zoom 90% (dpr 1.8)',
      box(716.91845703, 85.99826813, 705.30383301, 802.89068604),
      { w: 705, h: 803 },
      [283.3, 513.9],
      [1000, 600],
    ],
    ['keep-alive layer', box(0, 40, 619, 714), { w: 619, h: 714 }, [255, 317], [255, 357]],
  ])('places a touch where the real host put it: %s', async (_name, rect, viewport, page, sent) => {
    const h = setup({ viewport, origin: async () => rect });
    h.injector.bindLease({ width: viewport.w, height: viewport.h });
    await h.injector.inject([
      touch('start', [[1, page[0] / viewport.w, page[1] / viewport.h]]),
      touch('end', []),
    ]);
    const [[x, y]] = sentPoints(h)[0];
    expect(Math.abs(x - sent[0])).toBeLessThan(0.5);
    expect(Math.abs(y - sent[1])).toBeLessThan(0.5);
  });

  it('scales page points by how much larger the page is drawn than its CSS viewport', async () => {
    // Only the guest was zoomed (1.25): 480 page px fill a 600 px wide webview.
    const h = setup({ viewport: { w: 480, h: 320 }, origin: async () => box(10, 20, 600, 400) });
    h.injector.bindLease({ width: 480, height: 320 });
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    expect(sentPoints(h)[0]).toEqual([[10 + 240 * 1.25, 20 + 160 * 1.25]]);
  });

  it('reads the origin when a gesture starts, and keeps it for the gesture', async () => {
    let origin = box(100, 40, 800, 500);
    const provider = vi.fn(async () => origin);
    const h = setup({ origin: provider });
    h.injector.bindLease({ width: 800, height: 500 });
    await h.injector.inject([touch('start', [[1, 0, 0]])]);
    origin = box(300, 40, 800, 500); // the side panel is dragged mid-gesture
    await h.injector.inject([touch('move', [[1, 0, 0]]), touch('end', [])]);
    expect(provider).toHaveBeenCalledOnce();
    await h.injector.inject([touch('start', [[1, 0, 0]]), touch('end', [])]);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sentPoints(h)).toEqual([[[100, 40]], [[100, 40]], [], [[300, 40]], []]);
  });

  it('keeps every sent point inside the tab rectangle, whatever the phone sends', async () => {
    const h = setup({ origin: async () => box(770, 86, 800, 500) });
    h.injector.bindLease({ width: 800, height: 500 });
    await h.injector.inject([
      touch('start', [[1, 0.5, 0.5]]),
      touch('move', [[1, 0, 0]]),
      touch('move', [[1, 1, 1]]),
      touch('move', [[1, 0.5, 1]]),
      touch('end', []),
    ]);
    for (const [x, y] of sentPoints(h).flat()) {
      expect(x).toBeGreaterThanOrEqual(770);
      expect(x).toBeLessThanOrEqual(770 + 800);
      expect(y).toBeGreaterThanOrEqual(86);
      expect(y).toBeLessThanOrEqual(86 + 500);
    }
    expect(sentPoints(h)[2]).toEqual([[770 + 800, 86 + 500]]);
  });

  it('refuses a gesture it cannot place, instead of sending it somewhere else', async () => {
    let answer: GuestOrigin | null | Error = null;
    const h = setup({
      origin: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    h.injector.bindLease({ width: 800, height: 500 });
    for (const bad of [
      null,
      new Error('no renderer'),
      box(Number.NaN, 0, 800, 500),
      box(0, 0, 0, 500),
      box(0, 0, 800, -1),
      box(1e9, 0, 800, 500),
      box(0, 0, 80_000, 500), // page drawn 100x larger than its viewport
    ]) {
      answer = bad;
      await expect(
        h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]),
      ).rejects.toThrow('PREVIEW_INPUT_INVALID');
    }
    expect(touches(h.commands)).toEqual([]);
    expect(h.injector.pressed.touches).toBe(0);
    answer = box(5, 6, 800, 500);
    await h.injector.inject([touch('start', [[1, 0, 0]]), touch('end', [])]);
    expect(sentPoints(h)[0]).toEqual([[5, 6]]);
  });

  it('does not need an origin when none is configured (a host window that is the page)', async () => {
    const h = setup();
    h.injector.bindLease({ width: 800, height: 500 });
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    expect(sentPoints(h)[0]).toEqual([[400, 250]]);
  });
});

describe('TabInputInjector touch presentation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const touchCommands = (h: ReturnType<typeof setup>) =>
    h.commands
      .filter((c) => c.method === 'Emulation.setTouchEmulationEnabled')
      .map((c) => c.params);
  const methods = (h: ReturnType<typeof setup>) => h.commands.map((c) => c.method);

  it('presents the page as a touch device before its first command, once', async () => {
    const h = setup();
    h.injector.presentAsTouch(5);
    // Nothing is sent until the injector first talks to the page.
    expect(h.commands).toEqual([]);
    await h.injector.measure();
    expect(methods(h).slice(0, 2)).toEqual([
      'Emulation.setTouchEmulationEnabled',
      'Page.getLayoutMetrics',
    ]);
    expect(touchCommands(h)).toEqual([{ enabled: true, maxTouchPoints: 5 }]);
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    await h.injector.inject([{ kind: 'text', text: 'x' }]);
    expect(touchCommands(h)).toHaveLength(1);
  });

  it('leaves a page alone that was never asked to look like a touch device', async () => {
    const h = setup();
    await h.injector.measure();
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    await h.injector.dispose();
    expect(touchCommands(h)).toEqual([]);
  });

  it('only uses setTouchEmulationEnabled: no media, metrics or mouse-to-touch emulation', async () => {
    const h = setup();
    h.injector.presentAsTouch(5);
    await h.injector.measure();
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    await h.injector.dispose();
    const used = new Set(methods(h));
    for (const forbidden of [
      'Emulation.setEmulatedMedia',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setEmitTouchEventsForMouse',
    ])
      expect(used.has(forbidden)).toBe(false);
  });

  it('applies it again after the session was replaced underneath, before the next command', async () => {
    const h = setup();
    h.injector.presentAsTouch(5);
    await h.injector.measure();
    // Somebody else detaches and attaches: the new session starts as a mouse device.
    h.state.attached = false;
    h.emit('detach');
    h.state.attached = true;
    const before = h.commands.length;
    await h.injector.inject([{ kind: 'text', text: 'again' }]);
    const after = h.commands.slice(before).map((c) => c.method);
    expect(after[0]).toBe('Emulation.setTouchEmulationEnabled');
    expect(touchCommands(h)).toHaveLength(2);
    // The same when the debugger is simply gone and the injector has to attach again.
    h.state.attached = false;
    const again = h.commands.length;
    await h.injector.inject([touch('start', [[1, 0.5, 0.5]]), touch('end', [])]);
    expect(h.commands.slice(again).map((c) => c.method)[0]).toBe(
      'Emulation.setTouchEmulationEnabled',
    );
    expect(touchCommands(h)).toHaveLength(3);
  });

  it('gives the page back before releasing the debugger, even when someone else still holds it', async () => {
    const h = setup();
    h.injector.presentAsTouch(5);
    await h.injector.measure();
    const automation = acquireDebuggerLease(h.transport); // the browser automation joins
    await h.injector.dispose();
    expect(touchCommands(h).at(-1)).toEqual({ enabled: false });
    // Still attached (the automation holds it) and no longer a touch device.
    expect(h.state.attached).toBe(true);
    expect(h.transport.detach).not.toHaveBeenCalled();
    expect(releaseDebuggerLease(h.transport, automation)).toBe(true);
    // Order: the disable went out before the lease was given back.
    expect(methods(h).lastIndexOf('Emulation.setTouchEmulationEnabled')).toBe(
      methods(h).length - 1,
    );
  });

  it('gives it back first when it is the last lease too, and does nothing for a session that is gone', async () => {
    const h = setup();
    h.injector.presentAsTouch(5);
    await h.injector.measure();
    const detach = h.transport.detach as ReturnType<typeof vi.fn>;
    detach.mockImplementation(() => {
      expect(touchCommands(h).at(-1)).toEqual({ enabled: false });
      h.state.attached = false;
    });
    await h.injector.dispose();
    expect(detach).toHaveBeenCalledOnce();

    const gone = setup();
    gone.injector.presentAsTouch(5);
    await gone.injector.measure();
    gone.state.attached = false; // the session ended by itself: nothing to undo, nothing to attach for
    const attaches = (gone.transport.attach as ReturnType<typeof vi.fn>).mock.calls.length;
    await gone.injector.dispose();
    expect(touchCommands(gone)).toHaveLength(1);
    expect((gone.transport.attach as ReturnType<typeof vi.fn>).mock.calls.length).toBe(attaches);
  });

  it('does not strand the emulation when the first command times out; it is retried', async () => {
    const h = setup();
    h.injector.presentAsTouch(5);
    let hang = true;
    h.handlers.set('Emulation.setTouchEmulationEnabled', async (params) => {
      if (hang && params?.enabled === true) return new Promise(() => {});
      return {};
    });
    const pending = h.injector.measure();
    const assertion = expect(pending).rejects.toThrow('PREVIEW_INPUT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(PREVIEW_INPUT_TIMEOUT_MS);
    await assertion;
    hang = false;
    await h.injector.measure();
    expect(touchCommands(h).filter((p) => p?.enabled === true)).toHaveLength(2);
    // The timed-out apply may still have gone through in the page: it is undone at the end.
    await h.injector.dispose();
    expect(touchCommands(h).at(-1)).toEqual({ enabled: false });
  });
});

describe('TabInputInjector touches into cross-process frames', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type Harness = ReturnType<typeof setup>;
  // A 300x300 iframe at (50, 100) in an 800x500 tab, turned 90 degrees (CSS transform): its
  // content box is a rotated quad in tab px, and its own viewport is 300x300.
  const rotated = { content: [350, 100, 350, 400, 50, 400, 50, 100], width: 300, height: 300 };
  const flat = { content: [50, 100, 350, 100, 350, 400, 50, 400], width: 300, height: 300 };
  const blocked: GuestOrigin = { x: 770, y: 86, width: 800, height: 500, hitBlocked: true };
  const clear: GuestOrigin = { x: 0, y: 0, width: 800, height: 500 };
  // Hit-testable, but not at the host's (0, 0): the browser looks for the frame under the finger
  // with the host-space numbers as if they were the tab's own.
  const offset: GuestOrigin = { x: 770, y: 86, width: 800, height: 500 };
  // The same, but close enough to the host's origin that a host point still falls inside the
  // webview's own size: the only place `synthesizeTapGesture` accepts it (see `gestureInBounds`).
  const near: GuestOrigin = { x: 30, y: 20, width: 800, height: 500 };
  const commandsOf = (h: Harness, method: string) => h.commands.filter((c) => c.method === method);
  const touchesOf = (h: Harness) =>
    h.commands
      .filter((c) => c.method === 'Input.dispatchTouchEvent')
      .map((c) => ({
        session: c.sessionId,
        type: c.params?.type,
        at: (c.params?.touchPoints as Array<{ x: number; y: number }>).map((p) => [p.x, p.y]),
      }));
  // A finger that travels 20 px: a touch gesture, not a tap.
  const swipe = (): PreviewInputEvent[] => [
    touch('start', [[1, 0.375, 0.4]]),
    touch('move', [[1, 0.4, 0.4]]),
    touch('end', []),
  ];
  const tapAtPoint = (): PreviewInputEvent[] => [
    touch('start', [[1, 0.375, 0.4]]),
    touch('end', []),
  ];
  const mouseOf = (h: Harness) =>
    commandsOf(h, 'Input.dispatchMouseEvent').map((c) => ({
      session: c.sessionId,
      type: c.params?.type,
      at: [c.params?.x, c.params?.y],
    }));
  const detaches = (h: Harness) =>
    commandsOf(h, 'Target.detachFromTarget').map((c) => c.params?.sessionId);

  /** The tab holds one cross-process iframe; `frames` are the targets that exist. */
  function withFrame(
    origin: GuestOrigin,
    box: { content: number[]; width: number; height: number } = rotated,
    frames: string[] = ['F1'],
    pointFree: (point: { x: number; y: number }) => Promise<boolean> = async () => true,
  ) {
    const h = setup({ origin: async () => origin, pointFree });
    h.injector.bindLease({ width: 800, height: 500 });
    h.handlers.set('DOM.getNodeForLocation', async () => ({ backendNodeId: 7 }));
    h.handlers.set('DOM.describeNode', async () => ({ node: { frameId: 'F1' } }));
    h.handlers.set('DOM.getBoxModel', async () => ({ model: box }));
    h.handlers.set('Target.getTargets', async () => ({
      targetInfos: frames.map((targetId) => ({ targetId, type: 'iframe' })),
    }));
    h.handlers.set('Target.attachToTarget', async (params) => ({
      sessionId: `session-${params?.targetId}`,
    }));
    return h;
  }

  it('leaves a webview at the host origin alone: no frame lookup, plain coordinates', async () => {
    const h = withFrame(clear);
    await h.injector.inject([touch('start', [[1, 0.375, 0.4]]), touch('end', [])]);
    expect(commandsOf(h, 'DOM.getNodeForLocation')).toEqual([]);
    expect(commandsOf(h, 'Target.attachToTarget')).toEqual([]);
    expect(touchesOf(h)[0]).toEqual({ session: undefined, type: 'touchStart', at: [[300, 200]] });
  });

  it('reaches a frame under a webview the host cannot hit-test, even at the host origin', async () => {
    const h = withFrame({ ...clear, hitBlocked: true });
    await h.injector.inject(swipe());
    expect(touchesOf(h)[0]).toEqual({ session: 'session-F1', type: 'touchStart', at: [[100, 50]] });
  });

  it('reaches a frame under a webview that sits away from the host origin too', async () => {
    const h = withFrame(offset);
    await h.injector.inject(swipe());
    expect(touchesOf(h)[0]).toEqual({ session: 'session-F1', type: 'touchStart', at: [[100, 50]] });
    // Over the tab's own page the host coordinates are still used.
    h.handlers.set('DOM.describeNode', async () => ({ node: { nodeName: 'DIV' } }));
    await h.injector.inject(tapAtPoint());
    expect(touchesOf(h)[3]).toEqual({ session: undefined, type: 'touchStart', at: [[1070, 286]] });
  });

  it("sends the gesture to the frame under the finger, in that frame's own coordinates", async () => {
    const h = withFrame(blocked);
    await h.injector.inject(swipe());
    // Page point (300, 200) is local (100, 50) in the turned frame; no host offset is added.
    expect(commandsOf(h, 'DOM.getNodeForLocation')[0].params).toMatchObject({
      x: 300,
      y: 200,
      ignorePointerEventsNone: true,
    });
    expect(commandsOf(h, 'Target.attachToTarget')[0].params).toEqual({
      targetId: 'F1',
      flatten: true,
    });
    expect(touchesOf(h)).toEqual([
      { session: 'session-F1', type: 'touchStart', at: [[100, 50]] },
      { session: 'session-F1', type: 'touchMove', at: [[100, 30]] },
      { session: 'session-F1', type: 'touchEnd', at: [] },
    ]);
    // The session is for this gesture only.
    expect(detaches(h)).toEqual(['session-F1']);
    expect(h.injector.pressed.touches).toBe(0);
  });

  it('keeps every finger of the gesture in the frame the first one landed in', async () => {
    const h = withFrame(blocked, flat);
    await h.injector.inject([
      touch('start', [[1, 0.125, 0.4]]), // page (100, 200) -> local (50, 100)
      touch('start', [
        [1, 0.125, 0.4],
        [2, 0.25, 0.5], // page (200, 250) -> local (150, 150)
      ]),
      touch('move', [
        [1, 0.125, 0.4],
        [2, 0.375, 0.5], // page (300, 250) -> local (250, 150)
      ]),
      touch('end', []),
    ]);
    expect(touchesOf(h)).toEqual([
      { session: 'session-F1', type: 'touchStart', at: [[50, 100]] },
      {
        session: 'session-F1',
        type: 'touchStart',
        at: [
          [50, 100],
          [150, 150],
        ],
      },
      {
        session: 'session-F1',
        type: 'touchMove',
        at: [
          [50, 100],
          [250, 150],
        ],
      },
      { session: 'session-F1', type: 'touchEnd', at: [] },
    ]);
    // One lookup for the gesture, not one per event.
    expect(commandsOf(h, 'Target.attachToTarget')).toHaveLength(1);
  });

  it('stays on the tab when the element under the finger hosts no cross-process frame', async () => {
    const h = withFrame(blocked);
    h.handlers.set('DOM.describeNode', async () => ({ node: { nodeName: 'DIV' } }));
    await h.injector.inject([touch('start', [[1, 0.375, 0.4]]), touch('end', [])]);
    expect(commandsOf(h, 'Target.attachToTarget')).toEqual([]);
    expect(touchesOf(h)[0]).toEqual({ session: undefined, type: 'touchStart', at: [[1070, 286]] });
    // A same-process iframe has no target of its own either.
    const same = withFrame(blocked, rotated, []);
    await same.injector.inject([touch('start', [[1, 0.375, 0.4]]), touch('end', [])]);
    expect(commandsOf(same, 'Target.attachToTarget')).toEqual([]);
    expect(touchesOf(same)[0].session).toBeUndefined();
  });

  it('follows frames nested in frames, and gives every session back', async () => {
    const h = withFrame(blocked, flat, ['F1', 'F2']);
    let depth = 0;
    h.handlers.set('DOM.describeNode', async () => ({
      node: { frameId: ['F1', 'F2'][depth++] },
    }));
    // The inner frame sits at (20, 30), 200x200, inside the outer one.
    h.handlers.set('DOM.getBoxModel', async () => ({
      model:
        depth === 1
          ? flat
          : { content: [20, 30, 220, 30, 220, 230, 20, 230], width: 200, height: 200 },
    }));
    await h.injector.inject([touch('start', [[1, 0.25, 0.5]]), touch('end', [])]); // page (200, 250)
    // (200, 250) -> (150, 150) in F1 -> (130, 120) in F2
    expect(commandsOf(h, 'DOM.getNodeForLocation').map((c) => c.sessionId)).toEqual([
      undefined,
      'session-F1',
      'session-F2', // the innermost frame is asked too, and hosts no further frame
    ]);
    // A tap on a webview the host cannot hit-test: a mouse click in the innermost frame.
    expect(touchesOf(h)).toEqual([]);
    expect(mouseOf(h)).toEqual([
      { session: 'session-F2', type: 'mousePressed', at: [130, 120] },
      { session: 'session-F2', type: 'mouseReleased', at: [130, 120] },
    ]);
    expect(detaches(h)).toEqual(['session-F2', 'session-F1']);
  });

  it('looks the frame up again for every gesture: it may load late, navigate or go away', async () => {
    const h = withFrame(blocked, rotated, []);
    // Not there yet.
    await h.injector.inject(swipe());
    expect(touchesOf(h).map((t) => t.session)).toEqual([undefined, undefined, undefined]);
    // Loaded: a target now exists.
    h.handlers.set('Target.getTargets', async () => ({
      targetInfos: [{ targetId: 'F1', type: 'iframe' }],
    }));
    await h.injector.inject(swipe());
    expect(touchesOf(h).map((t) => t.session)).toEqual([
      undefined,
      undefined,
      undefined,
      'session-F1',
      'session-F1',
      'session-F1',
    ]);
    // Navigated to another site: a different target answers.
    h.handlers.set('DOM.describeNode', async () => ({ node: { frameId: 'F2' } }));
    h.handlers.set('Target.getTargets', async () => ({
      targetInfos: [{ targetId: 'F2', type: 'iframe' }],
    }));
    await h.injector.inject(swipe());
    expect(touchesOf(h).at(-1)?.session).toBe('session-F2');
    // Destroyed mid-gesture: the dispatch is refused, the gesture is dropped, the next one works.
    h.handlers.set('Input.dispatchTouchEvent', async () => {
      throw new Error('Session with given id not found');
    });
    await expect(h.injector.inject(swipe().slice(0, 2))).rejects.toThrow('PREVIEW_INPUT_INVALID');
    expect(h.injector.pressed.touches).toBe(0);
    expect(detaches(h).at(-1)).toBe('session-F2');
    h.handlers.delete('Input.dispatchTouchEvent');
    h.handlers.set('DOM.describeNode', async () => ({ node: { nodeName: 'DIV' } }));
    await h.injector.inject(tapAtPoint());
    expect(touchesOf(h).at(-1)?.session).toBeUndefined();
  });

  it('falls back to the tab when the lookup fails', async () => {
    const h = withFrame(blocked);
    h.handlers.set('DOM.getBoxModel', async () => {
      throw new Error('Could not compute box model.');
    });
    await h.injector.inject([touch('start', [[1, 0.375, 0.4]]), touch('end', [])]);
    expect(commandsOf(h, 'Target.attachToTarget')).toEqual([]);
    expect(touchesOf(h)[0]).toEqual({ session: undefined, type: 'touchStart', at: [[1070, 286]] });
  });

  it('cancels in the frame and gives the session back on cancel, release and dispose', async () => {
    const h = withFrame(blocked);
    const down = () => swipe().slice(0, 2);
    await h.injector.inject([...down(), touch('cancel', [])]);
    expect(touchesOf(h).at(-1)).toEqual({ session: 'session-F1', type: 'touchCancel', at: [] });
    expect(detaches(h)).toEqual(['session-F1']);

    await h.injector.inject(down());
    await h.injector.release();
    expect(touchesOf(h).at(-1)).toEqual({ session: 'session-F1', type: 'touchCancel', at: [] });
    expect(detaches(h)).toEqual(['session-F1', 'session-F1']);

    await h.injector.inject(down());
    await h.injector.dispose();
    expect(touchesOf(h).at(-1)).toEqual({ session: 'session-F1', type: 'touchCancel', at: [] });
    expect(detaches(h)).toHaveLength(3);
    // Every attach has its detach, and the debugger itself went back.
    expect(commandsOf(h, 'Target.attachToTarget')).toHaveLength(3);
    expect(h.transport.detach).toHaveBeenCalledTimes(1);
  });

  describe('a tap on a frame', () => {
    it('is held, then sent whole as a tap gesture at the host point on a webview the host can hit-test', async () => {
      const h = withFrame(near);
      await h.injector.inject([touch('start', [[1, 0.375, 0.4]])]);
      // Nothing is sent while the finger might still move: no start, no stray click source.
      expect(touchesOf(h)).toEqual([]);
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toEqual([]);
      await h.injector.inject([touch('end', [])]);
      // Page (300, 200) in the host: origin + point. One tap, no touch sequence beside it.
      expect(
        commandsOf(h, 'Input.synthesizeTapGesture').map((c) => [c.sessionId, c.params]),
      ).toEqual([[undefined, { x: 330, y: 220, gestureSourceType: 'touch' }]]);
      expect(touchesOf(h)).toEqual([]);
      expect(mouseOf(h)).toEqual([]);
      expect(detaches(h)).toEqual(['session-F1']);
      expect(h.injector.pressed.touches).toBe(0);
    });

    it('is a click in the frame, at the finger, on a webview the host cannot hit-test', async () => {
      const h = withFrame(blocked);
      await h.injector.inject(tapAtPoint());
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toEqual([]);
      expect(touchesOf(h)).toEqual([]);
      expect(mouseOf(h)).toEqual([
        { session: 'session-F1', type: 'mousePressed', at: [100, 50] },
        { session: 'session-F1', type: 'mouseReleased', at: [100, 50] },
      ]);
      expect(commandsOf(h, 'Input.dispatchMouseEvent')[1].params).toMatchObject({
        button: 'left',
        clickCount: 1,
      });
      expect(detaches(h)).toEqual(['session-F1']);
    });

    it('stays a tap through the jitter of a finger, and becomes a touch once it really moves', async () => {
      const h = withFrame(near);
      await h.injector.inject([
        touch('start', [[1, 0.375, 0.4]]),
        touch('move', [[1, 0.38, 0.404]]), // 4 px
        touch('end', []),
      ]);
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toHaveLength(1);
      expect(touchesOf(h)).toEqual([]);

      await h.injector.inject([
        touch('start', [[1, 0.375, 0.4]]),
        touch('move', [[1, 0.4, 0.4]]), // 20 px
        touch('end', []),
      ]);
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toHaveLength(1);
      // The frame hears of the finger where it landed, then of the move.
      expect(touchesOf(h)).toEqual([
        { session: 'session-F1', type: 'touchStart', at: [[100, 50]] },
        { session: 'session-F1', type: 'touchMove', at: [[100, 30]] },
        { session: 'session-F1', type: 'touchEnd', at: [] },
      ]);
    });

    it('becomes a two-finger touch when a second finger lands, with the first where it was', async () => {
      const h = withFrame(near, flat);
      await h.injector.inject([
        touch('start', [[1, 0.125, 0.4]]), // page (100, 200) -> local (50, 100)
        touch('start', [
          [1, 0.125, 0.4],
          [2, 0.25, 0.5], // page (200, 250) -> local (150, 150)
        ]),
        touch('end', []),
      ]);
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toEqual([]);
      expect(touchesOf(h)).toEqual([
        { session: 'session-F1', type: 'touchStart', at: [[50, 100]] },
        {
          session: 'session-F1',
          type: 'touchStart',
          at: [
            [50, 100],
            [150, 150],
          ],
        },
        { session: 'session-F1', type: 'touchEnd', at: [] },
      ]);
    });

    it('ends one lifted finger on its own in the frame, and keeps moving the other', async () => {
      const h = withFrame(near, flat);
      await h.injector.inject([
        touch('start', [[1, 0.125, 0.4]]), // page (100, 200) -> local (50, 100)
        touch('start', [
          [1, 0.125, 0.4],
          [2, 0.25, 0.5], // page (200, 250) -> local (150, 150)
        ]),
        touch('end', [[1, 0.125, 0.4]]),
        touch('move', [[1, 0.25, 0.4]]),
        touch('end', []),
      ]);
      expect(touchesOf(h)).toEqual([
        { session: 'session-F1', type: 'touchStart', at: [[50, 100]] },
        {
          session: 'session-F1',
          type: 'touchStart',
          at: [
            [50, 100],
            [150, 150],
          ],
        },
        { session: 'session-F1', type: 'touchEnd', at: [[150, 150]] },
        { session: 'session-F1', type: 'touchMove', at: [[150, 100]] },
        { session: 'session-F1', type: 'touchEnd', at: [] },
      ]);
      expect(detaches(h)).toEqual(['session-F1']);
    });

    it('sends nothing when it is cancelled, released or the lease ends before the finger lifts', async () => {
      const h = withFrame(near);
      await h.injector.inject([touch('start', [[1, 0.375, 0.4]]), touch('cancel', [])]);
      await h.injector.inject([touch('start', [[1, 0.375, 0.4]])]);
      await h.injector.release();
      await h.injector.inject([touch('start', [[1, 0.375, 0.4]])]);
      await h.injector.dispose();
      expect(touchesOf(h)).toEqual([]);
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toEqual([]);
      expect(detaches(h)).toHaveLength(3);
      expect(h.injector.pressed.touches).toBe(0);
    });

    it('uses the frame click where the tap gesture would refuse the point (a side panel far from the host origin)', async () => {
      // The gesture checks the host point against the webview's own size and fails with
      // "Position out of bounds" (measured in the real app: x 942 against a 359 px view), so a
      // webview at x 770 can never be reached that way. The host is not even asked.
      logs.debug.mockClear();
      const asked = vi.fn(async () => true);
      const h = withFrame(offset, rotated, ['F1'], asked);
      await h.injector.inject(tapAtPoint());
      expect(asked).not.toHaveBeenCalled();
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toEqual([]);
      // Press and release only: a mouseMoved first waited 5 s for its acknowledgement on a
      // tab the browser holds back, while the press and release answered at once.
      expect(mouseOf(h)).toEqual([
        { session: 'session-F1', type: 'mousePressed', at: [100, 50] },
        { session: 'session-F1', type: 'mouseReleased', at: [100, 50] },
      ]);
      expect(logs.debug).toHaveBeenCalledWith('Frame tap delivered', {
        path: 'mouse',
        why: 'out-of-bounds',
        ms: 0,
      });
    });

    it('does not hand the tap to the host when the host app is drawn over that point', async () => {
      const asked: Array<{ x: number; y: number }> = [];
      const covered = async (point: { x: number; y: number }) => {
        asked.push(point);
        return false;
      };
      const h = withFrame(near, rotated, ['F1'], covered);
      await h.injector.inject(tapAtPoint());
      // The host was asked about the point the tap would land on, in its own space.
      expect(asked).toEqual([{ x: 330, y: 220 }]);
      // A tap through the host's hit test could land on its menu or dialog: the frame's own
      // session gets a click instead, which cannot reach any host control.
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toEqual([]);
      expect(mouseOf(h).map((m) => m.session)).toEqual(['session-F1', 'session-F1']);
      expect(detaches(h)).toEqual(['session-F1']);
    });

    it('treats an unknown, failed or slow answer as covered, and does not ask without need', async () => {
      const failing = withFrame(near, rotated, ['F1'], async () => {
        throw new Error('bridge gone');
      });
      await failing.injector.inject(tapAtPoint());
      expect(commandsOf(failing, 'Input.synthesizeTapGesture')).toEqual([]);
      expect(mouseOf(failing)).toHaveLength(2);

      const never = withFrame(near, rotated, ['F1'], () => new Promise<boolean>(() => {}));
      const done = never.injector.inject(tapAtPoint());
      const settled = expect(done).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(PREVIEW_INPUT_TIMEOUT_MS);
      await settled;
      expect(commandsOf(never, 'Input.synthesizeTapGesture')).toEqual([]);
      expect(mouseOf(never)).toHaveLength(2);

      // No way to ask (an injector built without one): same, and a blocked webview never asks.
      const none = setup({ origin: async () => near });
      none.injector.bindLease({ width: 800, height: 500 });
      none.handlers.set('DOM.getNodeForLocation', async () => ({ backendNodeId: 7 }));
      none.handlers.set('DOM.describeNode', async () => ({ node: { frameId: 'F1' } }));
      none.handlers.set('DOM.getBoxModel', async () => ({ model: rotated }));
      none.handlers.set('Target.getTargets', async () => ({
        targetInfos: [{ targetId: 'F1', type: 'iframe' }],
      }));
      none.handlers.set('Target.attachToTarget', async () => ({ sessionId: 'session-F1' }));
      await none.injector.inject(tapAtPoint());
      expect(commandsOf(none, 'Input.synthesizeTapGesture')).toEqual([]);
      const asked = vi.fn(async () => true);
      const blockedHost = withFrame(blocked, rotated, ['F1'], asked);
      await blockedHost.injector.inject(tapAtPoint());
      expect(asked).not.toHaveBeenCalled();
    });

    it('sends the start of a press that is still down after 300 ms, and goes on as a touch', async () => {
      const h = withFrame(near);
      await h.injector.inject([touch('start', [[1, 0.375, 0.4]])]);
      await vi.advanceTimersByTimeAsync(299);
      expect(touchesOf(h)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      // The frame hears the press while it lasts, at the finger, in its own coordinates.
      expect(touchesOf(h)).toEqual([
        { session: 'session-F1', type: 'touchStart', at: [[100, 50]] },
      ]);
      expect(h.injector.pressed.touches).toBe(1);
      await h.injector.inject([touch('end', [])]);
      // It does not become a tap gesture, and a hold that never moved lifts as a cancel: the
      // browser would place a click of its own for a stationary lift, away from the finger.
      expect(touchesOf(h)).toEqual([
        { session: 'session-F1', type: 'touchStart', at: [[100, 50]] },
        { session: 'session-F1', type: 'touchCancel', at: [] },
      ]);
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toEqual([]);
      expect(detaches(h)).toEqual(['session-F1']);
      expect(h.injector.pressed.touches).toBe(0);
    });

    it('lifts a hold as a touchEnd once it has moved, got a second finger, or when it is a fresh press', async () => {
      const held = async (events: PreviewInputEvent[]) => {
        const h = withFrame(near, flat);
        await h.injector.inject([touch('start', [[1, 0.125, 0.4]])]);
        await vi.advanceTimersByTimeAsync(300);
        await h.injector.inject(events);
        return touchesOf(h).map((t) => t.type);
      };
      // Jitter inside the slop is still a stationary hold.
      expect(await held([touch('move', [[1, 0.13, 0.4]]), touch('end', [])])).toEqual([
        'touchStart',
        'touchMove',
        'touchCancel',
      ]);
      // Travelled: a drag, which makes no click, ends as it always did.
      expect(await held([touch('move', [[1, 0.2, 0.4]]), touch('end', [])])).toEqual([
        'touchStart',
        'touchMove',
        'touchEnd',
      ]);
      // A second finger makes it a multi-touch gesture.
      expect(
        await held([
          touch('start', [
            [1, 0.125, 0.4],
            [2, 0.25, 0.5],
          ]),
          touch('end', []),
        ]),
      ).toEqual(['touchStart', 'touchStart', 'touchEnd']);
      // A press that is not a timed hold (it moved before 300 ms) is not touched.
      const h = withFrame(near, flat);
      await h.injector.inject([
        touch('start', [[1, 0.125, 0.4]]),
        touch('move', [[1, 0.2, 0.4]]),
        touch('end', []),
      ]);
      expect(touchesOf(h).map((t) => t.type)).toEqual(['touchStart', 'touchMove', 'touchEnd']);
      // And the next press starts clean: a hold, then a quick tap, is a tap.
      const again = withFrame(near);
      await again.injector.inject([touch('start', [[1, 0.375, 0.4]])]);
      await vi.advanceTimersByTimeAsync(300);
      await again.injector.inject([touch('end', [])]);
      await again.injector.inject(tapAtPoint());
      expect(commandsOf(again, 'Input.synthesizeTapGesture')).toHaveLength(1);
    });

    it('keeps a tap that lifts in time a tap, and cancels the wait when the press moves or is released', async () => {
      const h = withFrame(near);
      await h.injector.inject(tapAtPoint());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(commandsOf(h, 'Input.synthesizeTapGesture')).toHaveLength(1);
      expect(touchesOf(h)).toEqual([]);

      // Moved away: sent at once, and the timer does not send it again.
      await h.injector.inject(swipe().slice(0, 2));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(touchesOf(h).map((t) => t.type)).toEqual(['touchStart', 'touchMove']);
      await h.injector.release();
      expect(touchesOf(h).map((t) => t.type)).toEqual(['touchStart', 'touchMove', 'touchCancel']);

      // Released before the wait is over: nothing is ever sent for it.
      const before = touchesOf(h).length;
      await h.injector.inject([touch('start', [[1, 0.375, 0.4]])]);
      await h.injector.release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(touchesOf(h)).toHaveLength(before);
    });

    it('clicks in the frame instead when the tap gesture fails or never completes', async () => {
      logs.debug.mockClear();
      logs.warn.mockClear();
      const failing = withFrame(near);
      failing.handlers.set('Input.synthesizeTapGesture', async () => {
        throw new Error('nope');
      });
      await failing.injector.inject(tapAtPoint());
      // The tap is not lost: the frame's own session gets a click at the finger.
      expect(mouseOf(failing).map((m) => [m.session, m.type, ...m.at])).toEqual([
        ['session-F1', 'mousePressed', 100, 50],
        ['session-F1', 'mouseReleased', 100, 50],
      ]);
      expect(detaches(failing)).toEqual(['session-F1']);

      // A gesture on a tab that is not painted never completes: 800 ms, then the click.
      const hanging = withFrame(near);
      hanging.handlers.set('Input.synthesizeTapGesture', () => new Promise(() => {}));
      const done = hanging.injector.inject(tapAtPoint());
      const settled = expect(done).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(799);
      expect(mouseOf(hanging)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(mouseOf(hanging)).toHaveLength(2);

      // One line says which way each tap went and why: paths, reasons and times only.
      expect(logs.warn.mock.calls).toEqual([
        ['Frame tap gesture failed, clicking in the frame', { why: 'gesture-error', ms: 0 }],
        ['Frame tap gesture failed, clicking in the frame', { why: 'gesture-timeout', ms: 800 }],
      ]);
      expect(logs.debug.mock.calls).toEqual([
        ['Frame tap delivered', { path: 'mouse', why: 'gesture-error', ms: 0 }],
        ['Frame tap delivered', { path: 'mouse', why: 'gesture-timeout', ms: 800 }],
      ]);
    });

    it('logs which way a tap went: gesture, covered, blocked, unverified', async () => {
      const kinds = async (h: Harness) => {
        logs.debug.mockClear();
        await h.injector.inject(tapAtPoint());
        return logs.debug.mock.calls.map(([, f]) => f);
      };
      expect(await kinds(withFrame(near))).toEqual([{ path: 'gesture', ms: 0 }]);
      expect(await kinds(withFrame(near, rotated, ['F1'], async () => false))).toEqual([
        { path: 'mouse', why: 'covered', ms: 0 },
      ]);
      expect(await kinds(withFrame(blocked))).toEqual([{ path: 'mouse', why: 'blocked', ms: 0 }]);
      const throwing = withFrame(near, rotated, ['F1'], async () => {
        throw new Error('bridge gone');
      });
      expect(await kinds(throwing)).toEqual([{ path: 'mouse', why: 'unverified', ms: 0 }]);
    });

    it('drops the tap and gives the session back only when neither way can deliver it', async () => {
      logs.warn.mockClear();
      const h = withFrame(near);
      h.handlers.set('Input.synthesizeTapGesture', async () => {
        throw new Error('nope');
      });
      h.handlers.set('Input.dispatchMouseEvent', async () => {
        throw new Error('no session');
      });
      await h.injector.inject([touch('start', [[1, 0.375, 0.4]])]);
      await expect(h.injector.inject([touch('end', [])])).rejects.toThrow('PREVIEW_INPUT_INVALID');
      expect(detaches(h)).toEqual(['session-F1']);
      expect(h.injector.pressed.touches).toBe(0);
      expect(logs.warn).toHaveBeenLastCalledWith('Frame tap click failed', {
        why: 'gesture-error',
        code: 'error',
        ms: 0,
      });
    });
  });

  it('does not detach sessions that died with a replaced debugger session', async () => {
    const h = withFrame(blocked);
    await h.injector.inject([touch('start', [[1, 0.375, 0.4]])]);
    h.emit('detach');
    await h.injector.release();
    expect(detaches(h)).toEqual([]);
  });
});
