import type { PreviewInputEvent } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const transport: GuestDebugger = {
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
  return {
    injector: new TabInputInjector(guest),
    guest,
    transport,
    commands,
    handlers,
    keyEvents,
    state,
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
