import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import type { WebContents, BrowserWindow } from 'electron';
import { installNativeTrackpad } from '../nativeTrackpad';

// Unit tier: production input entry with native/CDP endpoints. No OS I/O or sleeps.
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function setup({ optIn = true, occupied = false, iframe = false, contacts = false } = {}) {
  let focused = true,
    current = true;
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getZoomFactor: (): number => 1,
    executeJavaScript: vi.fn(async (): Promise<any> => ({
      x: 770,
      y: 46,
      width: 510,
      height: 754,
    })),
  });
  const debug = Object.assign(new EventEmitter(), {
    isAttached: () => occupied,
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(
      async (method: string, _args?: Record<string, unknown>, session?: string): Promise<any> => {
        if (method === 'Target.setAutoAttach' && iframe && !session)
          debug.emit('message', {}, 'Target.attachedToTarget', {
            targetInfo: { type: 'iframe', targetId: 'child' },
            sessionId: 'child-session',
          });
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
        if (method === 'Runtime.callFunctionOn' && _args?.arguments)
          return { result: { value: true } };
        if (
          method === 'Runtime.callFunctionOn' &&
          String(_args?.functionDeclaration).includes('getAttribute')
        )
          return { result: { value: contacts ? 'contacts' : '' } };
        if (
          method === 'Runtime.callFunctionOn' &&
          String(_args?.functionDeclaration).includes('getBoundingClientRect')
        )
          return { result: { value: { x: 20, y: 10 } } };
        if (method === 'Runtime.callFunctionOn')
          return { result: { objectId: iframe && !session ? undefined : 'surface' } };
        if (method === 'DOM.describeNode')
          return { node: { nodeName: 'IFRAME', frameId: 'child' } };
        if (method === 'DOM.getBoxModel')
          return {
            model: {
              content:
                iframe && !session
                  ? [40, 60, 540, 60, 540, 660, 40, 660]
                  : [30, 20, 430, 20, 430, 520, 30, 520],
            },
          };
        return {};
      },
    ),
  });
  const guest = Object.assign(new EventEmitter(), {
    id: 6,
    debugger: debug,
    isDestroyed: () => false,
    isFocused: () => focused,
    getZoomFactor: (): number => 1,
    executeJavaScript: vi.fn(async () => optIn),
  });
  const window = Object.assign(new EventEmitter(), {
    isFocused: () => true,
    isVisible: () => true,
    getNativeWindowHandle: () => Buffer.alloc(8),
  });
  const callbacks: ((p: string) => void)[] = [];
  const native = {
    position: undefined as undefined | (() => { x: number; y: number }),
    start: vi.fn((_h: Buffer, cb: (p: string) => void) => {
      callbacks.push(cb);
      return callbacks.length;
    }),
    stop: vi.fn(),
  };
  installNativeTrackpad(
    host as unknown as WebContents,
    guest as unknown as WebContents,
    () => current,
    {
      platform: 'darwin',
      load: () => native,
      window: () => window as unknown as BrowserWindow,
    },
  );
  const hover = async () => {
    guest.emit('before-mouse-event', {}, { type: 'mouseMove', x: 270, y: 330 });
    await settle();
  };
  const arm = async () => {
    guest.emit('dom-ready');
    await settle();
    await hover();
  };
  const points = [
    { id: 0, x: 0.3, y: 0.5 },
    { id: 1, x: 0.7, y: 0.5 },
  ];
  const emit = (phase: string, touches = points, index = callbacks.length - 1) =>
    callbacks[index](JSON.stringify({ phase, touches, width: 100, height: 70 }));
  const inputs = () =>
    debug.sendCommand.mock.calls
      .filter(([m]) => m === 'Input.dispatchTouchEvent')
      .map(([, p]) => p);
  return {
    host,
    guest,
    debug,
    window,
    native,
    callbacks,
    arm,
    hover,
    emit,
    inputs,
    points,
    focus: (v: boolean) => (focused = v),
    owner: (v: boolean) => (current = v),
  };
}

test('requires an opted-in focused surface and leaves another debugger alone', async () => {
  for (const options of [{ optIn: false }, { occupied: true }]) {
    const h = setup(options);
    await h.arm();
    expect(h.native.start).not.toHaveBeenCalled();
    expect(h.debug.detach).not.toHaveBeenCalled();
  }
  const h = setup();
  h.focus(false);
  await h.arm();
  expect(h.native.start).not.toHaveBeenCalled();
  h.focus(true);
  h.owner(false);
  await h.hover();
  expect(h.native.start).not.toHaveBeenCalled();
  h.owner(true);
  await h.hover();
  expect(h.native.start).toHaveBeenCalledOnce();
});

// User regression: a portrait sidebar compressed translation to its narrow
// width. Through the production entry, verify useful travel in both axes while
// retaining pair geometry (pinch ratio/rotation) and a stationary finger.
// Unit tier; previous independent-motion cases did not test portrait gain.
test('portrait mapping uses the long edge without changing pinch ratio or rotation', async () => {
  const h = setup();
  await h.arm();
  const pair = [
    { id: 0, x: 0.4, y: 0.5 },
    { id: 1, x: 0.6, y: 0.5 },
  ];
  h.emit('begin', pair);
  h.emit(
    'change',
    pair.map((p) => ({ ...p, x: p.x + 0.05, y: p.y + 0.1 })),
  );
  const start = h.inputs()[0]!.touchPoints as { x: number; y: number }[];
  const moved = h.inputs()[1]!.touchPoints as { x: number; y: number }[];
  expect(moved[0].x - start[0].x).toBeCloseTo(25);
  expect(moved[0].y - start[0].y).toBeCloseTo(35);
  expect(moved[1].x - moved[0].x).toBeCloseTo(start[1].x - start[0].x);
  h.emit('change', [
    { id: 0, x: 0.55, y: 0.6 - 0.1 / 0.7 },
    { id: 1, x: 0.55, y: 0.6 + 0.1 / 0.7 },
  ]);
  const rotated = h.inputs()[2]!.touchPoints as { x: number; y: number }[];
  expect(rotated[1].x - rotated[0].x).toBeCloseTo(0);
  expect(rotated[1].y - rotated[0].y).toBeCloseTo(start[1].x - start[0].x);
  h.emit('change', [
    { id: 0, x: 0.55, y: 0.6 - 0.15 / 0.7 },
    { id: 1, x: 0.55, y: 0.6 + 0.15 / 0.7 },
  ]);
  const expanded = h.inputs()[3]!.touchPoints as { x: number; y: number }[];
  expect((expanded[1].y - expanded[0].y) / (start[1].x - start[0].x)).toBeCloseTo(1.5);
});

test('maps independent contacts without scale hysteresis, including iframe offsets and liftoff', async () => {
  const h = setup({ iframe: true });
  await h.arm();
  h.emit('begin');
  expect(h.inputs()[0]).toMatchObject({
    type: 'touchStart',
    touchPoints: [
      { id: 0, x: 170, y: 330 },
      { id: 1, x: 370, y: 330 },
    ],
  });
  h.emit('change', [h.points[0], { id: 1, x: 0.8, y: 0.6 }]);
  expect(h.inputs()[1]).toMatchObject({
    type: 'touchMove',
    touchPoints: [
      { id: 0, x: 170, y: 330 },
      { id: 1, x: expect.closeTo(420, 8), y: 365 },
    ],
  });
  h.emit('change', [h.points[0], { id: 1, x: 0.6, y: 0.5 }]);
  expect(h.inputs()[2]).toMatchObject({
    touchPoints: [
      { id: 0, x: 170, y: 330 },
      { id: 1, x: expect.closeTo(320, 8), y: 330 },
    ],
  });
  h.emit('change', [h.points[0]]);
  expect(h.inputs()[3]).toMatchObject({
    type: 'touchEnd',
    touchPoints: [{ id: 1, x: expect.closeTo(320, 8), y: 330 }],
  });
  h.emit('end', []);
  expect(h.inputs()[4]).toMatchObject({
    type: 'touchEnd',
    touchPoints: [],
  });
});

// Review regression: a cached contacts element can be replaced without mouse
// movement or navigation. Its failed delivery must cancel and re-hit-test;
// existing tests covered navigation, not same-document element replacement.
test('invalid contacts targets cancel and rearm without requiring another pointer event', async () => {
  for (const phase of ['begin', 'change']) {
    const h = setup({ contacts: true });
    await h.arm();
    if (phase === 'change') {
      h.emit('begin');
      await settle();
    }
    const command = h.debug.sendCommand.getMockImplementation()!;
    let invalid = true;
    h.debug.sendCommand.mockImplementation(async (method, args, session) => {
      if (method === 'Runtime.callFunctionOn' && args?.arguments && invalid) {
        invalid = false;
        return { result: { value: false } };
      }
      return command(method, args, session);
    });
    h.emit(phase);
    await settle();
    expect(h.native.stop).toHaveBeenCalledWith(1);
    expect(h.native.start).toHaveBeenCalledTimes(2);
    expect(h.debug.sendCommand.mock.calls).toContainEqual([
      'Runtime.callFunctionOn',
      expect.objectContaining({
        arguments: expect.arrayContaining([{ value: { phase: 'cancel', touches: [] } }]),
      }),
      undefined,
    ]);
    const count = h.debug.sendCommand.mock.calls.length;
    h.emit('change', h.points, 0);
    expect(h.debug.sendCommand).toHaveBeenCalledTimes(count);
    h.emit('begin');
    await settle();
    expect(h.native.stop).not.toHaveBeenCalledWith(2);
  }
});

test('a late invalid-target response cannot cancel a newer capture after blur', async () => {
  const h = setup({ contacts: true });
  await h.arm();
  const command = h.debug.sendCommand.getMockImplementation()!;
  let resolve!: (value: any) => void;
  let pending = true;
  h.debug.sendCommand.mockImplementation(async (method, args, session) => {
    if (method === 'Runtime.callFunctionOn' && args?.arguments && pending) {
      pending = false;
      return new Promise((done) => {
        resolve = done;
      });
    }
    return command(method, args, session);
  });
  h.emit('begin');
  h.window.emit('blur');
  await settle();
  await h.hover();
  h.emit('begin');
  await settle();
  resolve({ result: { value: false } });
  await settle();
  expect(h.native.start).toHaveBeenCalledTimes(2);
  expect(h.native.stop).not.toHaveBeenCalledWith(2);
});

test('owner revocation cancels active contacts; late frames never cross a navigation', async () => {
  const h = setup();
  await h.arm();
  h.emit('begin');
  h.owner(false);
  h.emit('change');
  expect(h.native.stop).toHaveBeenCalledWith(1);
  expect(h.inputs().at(-1)).toEqual({ type: 'touchCancel', touchPoints: [] });
  h.owner(true);
  await h.hover();
  h.emit('begin');
  h.guest.emit('did-start-navigation', {}, 'https://example.test', false, true);
  const count = h.inputs().length;
  h.emit('change', h.points, 1);
  expect(h.inputs()).toHaveLength(count);
  expect(h.native.stop).toHaveBeenCalledWith(2);
});

test('malformed native contacts and mouse clicks release input', async () => {
  const h = setup();
  await h.arm();
  h.emit('begin');
  h.emit('change', [{ id: 0, x: 2, y: 0.5 }]);
  expect(h.inputs().at(-1)).toEqual({ type: 'touchCancel', touchPoints: [] });
  await h.hover();
  h.emit('begin');
  h.guest.emit('before-mouse-event', {}, { type: 'mouseDown', x: 0, y: 0 });
  expect(h.native.stop).toHaveBeenCalledWith(2);
  expect(h.inputs().at(-1)).toEqual({ type: 'touchCancel', touchPoints: [] });
});

// Regression: Chromium split one native begin into 1/2 contacts and held moves
// for input ACK. A contacts surface gets an atomic pair in its own frame space.
test('atomic contacts preserve the pair and cancel before releasing their frame object', async () => {
  const h = setup({ iframe: true, contacts: true });
  await h.arm();
  h.emit('begin');
  h.emit('change', [h.points[0], { id: 1, x: 0.8, y: 0.6 }]);
  const packets = () =>
    h.debug.sendCommand.mock.calls.filter(
      ([m, p]) => m === 'Runtime.callFunctionOn' && p?.arguments,
    );
  expect(packets()[0]).toMatchObject([
    'Runtime.callFunctionOn',
    {
      arguments: [
        {
          value: {
            phase: 'begin',
            touches: [
              { id: 0, x: 120, y: 260 },
              { id: 1, x: 320, y: 260 },
            ],
          },
        },
        { value: { x: 220, y: 260 } },
      ],
    },
    'child-session',
  ]);
  expect(packets()[1][1]).toMatchObject({
    arguments: [
      {
        value: {
          phase: 'change',
          touches: [
            { id: 0, x: 120, y: 260 },
            { id: 1, x: expect.closeTo(370, 8), y: 295 },
          ],
        },
      },
      { value: { x: 220, y: 260 } },
    ],
  });
  expect(h.inputs()).toEqual([]);
  const command = h.debug.sendCommand.getMockImplementation()!;
  let release!: () => void;
  h.debug.sendCommand.mockImplementation(async (method, args, session) => {
    if (method === 'Runtime.releaseObject' && args?.objectId === 'surface')
      return new Promise<void>((done) => {
        release = done;
      });
    return command(method, args, session);
  });
  h.window.emit('blur');
  expect(packets().at(-1)?.[1]).toMatchObject({
    arguments: [{ value: { phase: 'cancel', touches: [] } }, { value: { x: 220, y: 260 } }],
  });
  const n = packets().length;
  h.emit('change');
  await settle();
  expect(packets()).toHaveLength(n);
  expect(h.debug.sendCommand).toHaveBeenCalledWith(
    'Runtime.releaseObject',
    { objectId: 'surface' },
    'child-session',
  );
  expect(h.debug.detach).not.toHaveBeenCalled();
  release();
  await settle();
  expect(h.debug.detach).toHaveBeenCalledOnce();
});

test('reversing at a screen edge moves immediately without unwinding offscreen distance', async () => {
  const h = setup();
  await h.arm();
  h.emit('begin');
  h.emit('change', [h.points[0], { id: 1, x: 1, y: 0.5 }]);
  expect(h.inputs().at(-1)?.touchPoints).toMatchObject([{ id: 0 }, { id: 1, x: 429.5 }]);
  h.emit('change', [h.points[0], { id: 1, x: 0.99, y: 0.5 }]);
  expect(h.inputs().at(-1)?.touchPoints).toMatchObject([{ id: 0 }, { id: 1, x: 424.5 }]);
});

test('same-document route updates cancel old contacts and rearm the opted-in surface', async () => {
  const h = setup({ contacts: true });
  await h.arm();
  h.emit('begin');
  h.guest.emit('did-start-navigation', {}, 'http://localhost/control?udid=selected', true, true);
  await h.hover();
  expect(h.native.start).toHaveBeenCalledTimes(2);
  const before = h.debug.sendCommand.mock.calls.length;
  h.emit('change', h.points, 0);
  expect(h.debug.sendCommand.mock.calls).toHaveLength(before);
});

// A route update or initial focus change can precede the async opt-in reply.
// It must not disable this document forever; a real navigation must reject it.
test('pending document opt-in survives input teardown but never a document replacement', async () => {
  for (const replacement of [false, true]) {
    const h = setup({ contacts: true });
    let resolve!: (value: boolean) => void;
    h.guest.executeJavaScript.mockImplementationOnce(
      () => new Promise<boolean>((done) => (resolve = done)),
    );
    h.guest.emit('dom-ready');
    h.window.emit('blur');
    h.guest.emit('did-start-navigation', {}, 'https://example.test/viewer', !replacement, true);
    resolve(true);
    await settle();
    await h.hover();
    expect(h.native.start).toHaveBeenCalledTimes(replacement ? 0 : 1);
  }
});

test('embedded guest subtracts its host viewport origin before native hit testing', async () => {
  const h = setup();
  h.native.position = () => ({ x: 1040, y: 376 });
  await h.arm();
  expect(h.debug.sendCommand).toHaveBeenCalledWith(
    'DOM.getNodeForLocation',
    { x: 270, y: 330, includeUserAgentShadowDOM: true },
    undefined,
  );
  h.emit('begin');
  expect(h.inputs()[0]?.touchPoints).toMatchObject([
    { x: 170, y: 330 },
    { x: 370, y: 330 },
  ]);
});

test('embedded coordinates respect independent host/guest zoom and reject a missing view', async () => {
  const h = setup();
  h.host.getZoomFactor = () => 1.25;
  h.guest.getZoomFactor = () => 2;
  h.native.position = () => ({ x: 1502.5, y: 717.5 });
  await h.arm();
  expect(h.debug.sendCommand).toHaveBeenCalledWith(
    'DOM.getNodeForLocation',
    { x: 270, y: 330, includeUserAgentShadowDOM: true },
    undefined,
  );
  const missing = setup();
  missing.native.position = () => ({ x: 1040, y: 376 });
  missing.host.executeJavaScript.mockResolvedValue(null);
  await missing.arm();
  expect(missing.native.start).not.toHaveBeenCalled();
});

test('blur invalidates an outstanding embedded pointer conversion', async () => {
  const h = setup();
  h.native.position = () => ({ x: 1040, y: 376 });
  let resolve!: (v: any) => void;
  h.host.executeJavaScript.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await h.arm();
  h.window.emit('blur');
  resolve({ x: 770, y: 46, width: 510, height: 754 });
  await settle();
  expect(h.native.start).not.toHaveBeenCalled();
});
