import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewTabBinding, PreviewTabEnded } from '../../rsb-browser-bridge/previewTabs';
import { PREVIEW_CAPTURE_TIMEOUT_MS } from '../previewTabCapture';
import { createPreviewHost, type PreviewGuest, type PreviewHostEnv } from '../previewHost';

function binding(extra: Partial<PreviewTabBinding> = {}): PreviewTabBinding {
  return {
    tabId: 'tab1',
    sessionId: 'task1',
    webContentsId: 11,
    ghostId: 'baguette',
    pluginName: 'Baguette',
    origin: 'http://127.0.0.1:5000',
    generation: 1,
    boundAt: 1,
    ...extra,
  };
}

function setup(
  metrics: Array<{ w: number; h: number }> = [{ w: 800, h: 500 }],
  guestOrigin?: PreviewHostEnv['guestOrigin'],
  withViewports = false,
  extra: Partial<PreviewHostEnv> = {},
) {
  let bindings = [binding()];
  const order: string[] = [];
  const touchEmulation: object[] = [];
  let measured = 0;
  const listeners = new Set<(event: PreviewTabEnded) => void>();
  const attached = { value: false };
  const hostWindow = {
    isDestroyed: () => false,
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
  };
  const guest: PreviewGuest = {
    id: 11,
    hostWebContents: hostWindow,
    invalidate: vi.fn(),
    getTitle: () => 'Simulator',
    isDestroyed: () => false,
    capturePage: vi.fn(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 250 }),
      resize: vi.fn(),
      toJPEG: () => Buffer.from('jpeg'),
    })) as unknown as PreviewGuest['capturePage'],
    debugger: {
      isAttached: () => attached.value,
      attach: () => {
        attached.value = true;
      },
      detach: () => {
        attached.value = false;
        order.push('detach');
      },
      sendCommand: vi.fn(async (method: string, params?: object) => {
        order.push(method);
        if (method === 'Page.getLayoutMetrics') {
          const size = metrics[Math.min(measured++, metrics.length - 1)];
          return { cssVisualViewport: { clientWidth: size.w, clientHeight: size.h } };
        }
        if (method === 'Input.dispatchTouchEvent') order.push(JSON.stringify(params));
        if (method === 'Emulation.setTouchEmulationEnabled') touchEmulation.push(params ?? {});
        return {};
      }),
    },
    sendInputEvent: vi.fn(),
    insertText: vi.fn(async () => {}),
    setBackgroundThrottling: vi.fn(),
  };
  const guests = new Map<string, PreviewGuest>([['tab1', guest]]);
  const setCastingTabs = vi.fn((tabIds: string[]) => {
    order.push(`casting:${tabIds.join(',')}`);
  });
  const setCastingViewports = vi.fn((viewports: Record<string, { width: number; height: number }>) => {
    order.push(`viewports:${JSON.stringify(viewports)}`);
  });
  const delay = vi.fn(async () => {});
  const index = {
    list: vi.fn((sessionId?: string) =>
      bindings.filter((item) => sessionId === undefined || item.sessionId === sessionId),
    ),
    current: vi.fn(
      (tabId: string, webContentsId: number) =>
        bindings.find((item) => item.tabId === tabId && item.webContentsId === webContentsId) ??
        null,
    ),
    onEnded: vi.fn((listener: (event: PreviewTabEnded) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const host = createPreviewHost({
    index,
    guest: (tabId) => guests.get(tabId) ?? null,
    setCastingTabs,
    ...(withViewports ? { setCastingViewports } : {}),
    delay,
    guestOrigin,
    ...extra,
  });
  return {
    hostWindow,
    setCastingViewports,
    host,
    guest,
    guests,
    index,
    setCastingTabs,
    delay,
    order,
    touchEmulation,
    attached,
    end: (reason: PreviewTabEnded['reason'] = 'released') => {
      const [first] = bindings;
      bindings = [];
      for (const listener of listeners) listener({ binding: first, reason });
    },
    setBindings: (next: PreviewTabBinding[]) => (bindings = next),
  };
}

describe('preview host', () => {
  it('lists the index tabs with the guest title, and only guests that still match', () => {
    const h = setup();
    expect(h.host.list('task1')).toEqual([
      {
        tabId: 'tab1',
        webContentsId: 11,
        generation: 1,
        sessionId: 'task1',
        ghostId: 'baguette',
        pluginName: 'Baguette',
        title: 'Simulator',
      },
    ]);
    expect(h.host.list('other')).toEqual([]);
    h.guests.set('tab1', { ...h.guest, id: 99 });
    expect(h.host.list()).toEqual([]);
    h.guests.clear();
    expect(h.host.list()).toEqual([]);
  });

  it('opens a tab with its CSS viewport, keeps it casting, and gives everything back on end', async () => {
    const h = setup();
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    expect(source).toMatchObject({ width: 800, height: 500, tabId: 'tab1' });
    expect(h.setCastingTabs).toHaveBeenLastCalledWith(['tab1']);
    expect(h.host.current(source)).toBe(true);
    expect(await h.host.frame(source, { purpose: 'relay' })).toBe(
      Buffer.from('jpeg').toString('base64'),
    );
    await h.host.input(source, [{ kind: 'text', text: 'hi' }]);
    expect(h.guest.insertText).toHaveBeenCalledWith('hi');
    expect(h.attached.value).toBe(true);
    h.host.end(source);
    h.host.end(source);
    await vi.waitFor(() => expect(h.attached.value).toBe(false));
    expect(h.setCastingTabs).toHaveBeenLastCalledWith([]);
    expect(h.host.current(source)).toBe(false);
    await expect(h.host.input(source, [{ kind: 'release' }])).rejects.toThrow(
      'PREVIEW_SOURCE_ENDED',
    );
  });

  it('keeps the tab painting before it measures, and measures once the layout has settled', async () => {
    // A hidden tab first reports a collapsed size; the keep-alive layer then restores it.
    const h = setup([
      { w: 300, h: 150 },
      { w: 640, h: 400 },
      { w: 800, h: 500 },
      { w: 800, h: 500 },
    ]);
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    expect(source).toMatchObject({ width: 800, height: 500 });
    const firstMeasure = h.order.indexOf('Page.getLayoutMetrics');
    expect(h.order.indexOf('casting:tab1')).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf('casting:tab1')).toBeLessThan(firstMeasure);
    expect(h.delay).toHaveBeenCalledTimes(3);
    // Idempotent: the same set is pushed again once the lease owns the tab.
    expect(h.setCastingTabs.mock.calls.map(([ids]) => ids)).toEqual([['tab1'], ['tab1']]);
  });

  it('waits, boundedly, for a guest that is not ready to be measured', async () => {
    // Just materialized: the page has no size yet, then it does.
    const h = setup([
      { w: 0, h: 0 },
      { w: 0, h: 0 },
      { w: 800, h: 500 },
      { w: 800, h: 500 },
    ]);
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    expect(source).toMatchObject({ width: 800, height: 500 });
    expect(h.delay.mock.calls.length).toBeGreaterThanOrEqual(3);

    // A guest that never becomes ready is reported after a bounded wait, not hung on.
    const never = setup([{ w: 0, h: 0 }]);
    const [stuck] = never.host.list();
    await expect(never.host.open(stuck)).rejects.toThrow('PREVIEW_CAPTURE_UNAVAILABLE');
    expect(never.delay.mock.calls.length).toBeLessThanOrEqual(30);
    expect(never.setCastingTabs).toHaveBeenLastCalledWith([]);
    await vi.waitFor(() => expect(never.attached.value).toBe(false));
  });

  it('retries a measurement a throttled hidden tab did not answer', async () => {
    const h = setup();
    const original = h.guest.debugger.sendCommand;
    let first = true;
    h.guest.debugger.sendCommand = vi.fn(async (method: string, params?: object) => {
      if (first && method === 'Page.getLayoutMetrics') {
        first = false;
        throw new Error('PREVIEW_INPUT_TIMEOUT');
      }
      return original(method, params);
    });
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    expect(source).toMatchObject({ width: 800, height: 500 });
    expect(h.guest.setBackgroundThrottling).toHaveBeenCalledWith(false);
  });

  it('gives up waiting for a layout that never settles and takes the last size', async () => {
    const h = setup(Array.from({ length: 12 }, (_, i) => ({ w: 400 + i * 20, h: 300 })));
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    expect(h.delay.mock.calls.length).toBeLessThanOrEqual(6);
    expect(source.width).toBeGreaterThan(400);
  });

  it('does not keep casting a tab that failed to open', async () => {
    const h = setup();
    h.guest.debugger.sendCommand = vi.fn(async () => ({}));
    const [tab] = h.host.list();
    await expect(h.host.open(tab)).rejects.toThrow('PREVIEW_CAPTURE_UNAVAILABLE');
    expect(h.setCastingTabs).toHaveBeenLastCalledWith([]);
    // Never opened because the tab was already gone: nothing was asked to stay painted.
    const gone = setup();
    const [stale] = gone.host.list();
    gone.setBindings([]);
    expect(await gone.host.open(stale)).toBeNull();
    expect(gone.setCastingTabs).not.toHaveBeenCalled();
  });

  it('maps touches through the size the phone was given, not the tab size at touch time', async () => {
    // Opened at 800x500; the panel is later resized so the tab becomes square.
    const h = setup([
      { w: 800, h: 500 },
      { w: 800, h: 500 },
      { w: 800, h: 800 },
    ]);
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    await h.host.input(source, [
      { kind: 'touch', phase: 'start', points: [{ id: 1, x: 0.5, y: 0.5 }] },
      { kind: 'touch', phase: 'end', points: [] },
    ]);
    const start = h.order.find((entry) => entry.includes('touchStart'))!;
    expect(JSON.parse(start).touchPoints[0]).toMatchObject({ id: 1, x: 400, y: 400 });
  });

  it('places touches in the host window using the tab origin the renderer reports', async () => {
    const guestOrigin = vi.fn(async () => ({ x: 770, y: 86, width: 800, height: 500 }));
    const h = setup([{ w: 800, h: 500 }], guestOrigin);
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    await h.host.input(source, [
      { kind: 'touch', phase: 'start', points: [{ id: 1, x: 0.5, y: 0.5 }] },
      { kind: 'touch', phase: 'end', points: [] },
    ]);
    expect(guestOrigin).toHaveBeenCalledWith({ tabId: 'tab1', sessionId: 'task1' });
    const start = h.order.find((entry) => entry.includes('touchStart'))!;
    expect(JSON.parse(start).touchPoints[0]).toMatchObject({ x: 1170, y: 336 });
    // A renderer that cannot answer refuses the gesture rather than guessing.
    guestOrigin.mockResolvedValueOnce(null as never);
    await expect(
      h.host.input(source, [
        { kind: 'touch', phase: 'start', points: [{ id: 1, x: 0.5, y: 0.5 }] },
      ]),
    ).rejects.toThrow('PREVIEW_INPUT_INVALID');
  });

  it('keeps the tab painting, then presents it as a touch device, then measures', async () => {
    const h = setup();
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    const casting = h.order.indexOf('casting:tab1');
    const touchOn = h.order.indexOf('Emulation.setTouchEmulationEnabled');
    const measure = h.order.indexOf('Page.getLayoutMetrics');
    expect(casting).toBeGreaterThanOrEqual(0);
    expect(touchOn).toBeGreaterThan(casting);
    expect(measure).toBeGreaterThan(touchOn);
    expect(h.touchEmulation).toEqual([{ enabled: true, maxTouchPoints: 5 }]);
    // The phone is told the size the page has after the touch layout settled.
    expect(source).toMatchObject({ width: 800, height: 500 });
  });

  it('turns the touch emulation off whenever the lease ends, before the debugger goes', async () => {
    const h = setup();
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    h.host.end(source);
    await vi.waitFor(() => expect(h.attached.value).toBe(false));
    expect(h.touchEmulation.at(-1)).toEqual({ enabled: false });
    expect(h.order.lastIndexOf('Emulation.setTouchEmulationEnabled')).toBeLessThan(
      h.order.indexOf('detach'),
    );

    // The tab ending by itself (index event) goes through the same end.
    const ended = setup();
    const [other] = ended.host.list();
    const sourceB = (await ended.host.open(other))!;
    ended.end('released');
    ended.host.end(sourceB);
    await vi.waitFor(() => expect(ended.attached.value).toBe(false));
    expect(ended.touchEmulation.at(-1)).toEqual({ enabled: false });

    // A tab that never became ready is given back too.
    const never = setup([{ w: 0, h: 0 }]);
    const [stuck] = never.host.list();
    await expect(never.host.open(stuck)).rejects.toThrow('PREVIEW_CAPTURE_UNAVAILABLE');
    await vi.waitFor(() => expect(never.attached.value).toBe(false));
    expect(never.touchEmulation.at(-1)).toEqual({ enabled: false });
  });

  it('refuses to open a tab whose guest was rebuilt or whose binding moved on', async () => {
    const h = setup();
    const [tab] = h.host.list();
    h.setBindings([binding({ generation: 2 })]);
    expect(await h.host.open(tab)).toBeNull();
    h.setBindings([binding()]);
    h.guests.set('tab1', { ...h.guest, id: 12 });
    expect(await h.host.open(tab)).toBeNull();
    expect(h.setCastingTabs).not.toHaveBeenCalled();
    expect(h.attached.value).toBe(false);
  });

  it('reports a tab that cannot be measured without keeping the debugger', async () => {
    const h = setup();
    h.guest.debugger.sendCommand = vi.fn(async () => ({}));
    const [tab] = h.host.list();
    await expect(h.host.open(tab)).rejects.toThrow('PREVIEW_CAPTURE_UNAVAILABLE');
    await vi.waitFor(() => expect(h.attached.value).toBe(false));
  });

  it('tells the watcher when the index ends the tab, for that generation only', async () => {
    const h = setup();
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    const ended = vi.fn();
    h.host.watch(source, ended);
    h.index.onEnded.mock.calls[0][0]({
      binding: binding({ generation: 7 }),
      reason: 'replaced',
    });
    expect(ended).not.toHaveBeenCalled();
    h.end('origin-changed');
    expect(ended).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledWith('ended');
    expect(h.host.current(source)).toBe(false);
  });

  it('gives a stream frame the screen profile budget, and relay frames the small one', async () => {
    const h = setup();
    const toJPEG = vi.fn((quality: number) => Buffer.alloc(quality === 80 ? 400_000 : 1000, 1));
    h.guest.capturePage = vi.fn(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 250 }),
      resize: vi.fn(),
      toJPEG,
      toBitmap: () => Buffer.alloc(400 * 250 * 4),
    })) as unknown as PreviewGuest['capturePage'];
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    // Stream: the profile's quality (auto = 80), its 1.5 MB budget, one encode.
    const stream = await h.host.frame(source, { purpose: 'stream' });
    expect(Buffer.from(stream!, 'base64').length).toBe(400_000);
    expect(toJPEG).toHaveBeenCalledTimes(1);
    expect(toJPEG).toHaveBeenCalledWith(80);
    // Relay: over 180 KB means re-encoding at a lower quality.
    toJPEG.mockClear();
    const relay = await h.host.frame(source, { purpose: 'relay' });
    expect(Buffer.from(relay!, 'base64').length).toBeLessThanOrEqual(180_000);
    expect(toJPEG).toHaveBeenCalled();
  });

  it('wakes the capture when input arrives and passes the phone view state through', async () => {
    const h = setup();
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    h.host.setView(source, { hidden: true });
    const calls = (h.guest.capturePage as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    // A hidden preview with no picture yet still needs one; afterwards it captures nothing.
    await h.host.frame(source, { purpose: 'stream' });
    const afterFirst = (h.guest.capturePage as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(afterFirst).toBe(calls + 1);
    h.host.setView(source, { hidden: false, background: true });
    await h.host.input(source, [{ kind: 'text', text: 'x' }]);
    await h.host.frame(source, { purpose: 'stream' });
    expect(
      (h.guest.capturePage as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(afterFirst);
  });

  it('stops serving frames once the tab no longer matches the index', async () => {
    const h = setup();
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    h.setBindings([]);
    expect(await h.host.frame(source, { purpose: 'relay' })).toBeNull();
    expect(h.guest.capturePage).not.toHaveBeenCalled();
    await expect(h.host.input(source, [{ kind: 'release' }])).rejects.toThrow(
      'PREVIEW_SOURCE_ENDED',
    );
  });

  it('lets a watcher on an already finished source hear about it', async () => {
    const h = setup();
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    h.host.end(source);
    const late = vi.fn();
    h.host.watch(source, late);
    expect(late).toHaveBeenCalledWith('ended');
  });
});

describe('preview host phone viewport', () => {
  const phone = { width: 402, height: 786 };
  // The renderer lays the tab out a moment after being asked: the first readings are stale.
  const relayout = [
    { w: 800, h: 500 },
    { w: 800, h: 500 },
    { w: 402, h: 786 },
    { w: 402, h: 786 },
  ];

  it('asks for the phone shape before measuring, waits for it, and gives the layout back on end', async () => {
    const h = setup(relayout, undefined, true);
    const [tab] = h.host.list();
    const source = (await h.host.open(tab, phone))!;
    expect(source).toMatchObject({ width: 402, height: 786 });
    const asked = h.order.indexOf(`viewports:${JSON.stringify({ tab1: phone })}`);
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(asked).toBeGreaterThan(h.order.indexOf('casting:tab1'));
    expect(asked).toBeLessThan(h.order.indexOf('Page.getLayoutMetrics'));
    expect(h.setCastingViewports).toHaveBeenLastCalledWith({ tab1: phone });
    h.host.end(source);
    expect(h.setCastingViewports).toHaveBeenLastCalledWith({});
    expect(h.setCastingTabs).toHaveBeenLastCalledWith([]);
  });

  it('keeps the tab as it is when no shape is asked for', async () => {
    const h = setup(undefined, undefined, true);
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    expect(source).toMatchObject({ width: 800, height: 500 });
    expect(h.setCastingViewports).toHaveBeenCalledWith({});
    expect(h.setCastingViewports).not.toHaveBeenCalledWith({ tab1: expect.anything() });
    expect(h.host.setViewport).toBeTypeOf('function');
  });

  it('does not offer the shape (nor setViewport) where the renderer cannot lay a tab out', async () => {
    const h = setup(undefined, undefined, false);
    expect(h.host.setViewport).toBeUndefined();
    const [tab] = h.host.list();
    const source = (await h.host.open(tab, phone))!;
    expect(source).toMatchObject({ width: 800, height: 500 });
    expect(h.setCastingViewports).not.toHaveBeenCalled();
  });

  it('gives up waiting for a tab that never takes the shape, after a bounded wait', async () => {
    const h = setup([{ w: 800, h: 500 }], undefined, true);
    const [tab] = h.host.list();
    const source = (await h.host.open(tab, phone))!;
    expect(source).toMatchObject({ width: 800, height: 500 });
    expect(h.delay.mock.calls.length).toBeLessThanOrEqual(30);
  });

  it('a tab already in the shape is not waited for', async () => {
    const h = setup([{ w: 402, h: 786 }], undefined, true);
    const [tab] = h.host.list();
    await h.host.open(tab, phone);
    // Settling only: two readings, no extra waits for the shape.
    expect(h.delay).toHaveBeenCalledTimes(1);
  });

  it('applies a new shape to the open tab and keeps the lease size it was told', async () => {
    const landscape = { width: 786, height: 402 };
    const h = setup(
      [
        { w: 402, h: 786 },
        { w: 402, h: 786 },
        { w: 402, h: 786 },
        { w: 786, h: 402 },
        { w: 786, h: 402 },
      ],
      undefined,
      true,
    );
    const [tab] = h.host.list();
    const source = (await h.host.open(tab, phone))!;
    await h.host.setViewport!(source, landscape);
    expect(h.setCastingViewports).toHaveBeenLastCalledWith({ tab1: landscape });
    // The source the controller holds is the lease's: its size is what the phone was told.
    expect(source).toMatchObject({ width: 402, height: 786 });
    h.host.end(source);
    expect(h.setCastingViewports).toHaveBeenLastCalledWith({});
  });

  it('refuses a new shape for a source that has ended', async () => {
    const h = setup(relayout, undefined, true);
    const [tab] = h.host.list();
    const source = (await h.host.open(tab, phone))!;
    h.end();
    await expect(h.host.setViewport!(source, { width: 500, height: 700 })).rejects.toThrow(
      'PREVIEW_SOURCE_ENDED',
    );
  });

  it('gives the layout back when opening fails', async () => {
    const h = setup([{ w: 0, h: 0 }], undefined, true);
    const [tab] = h.host.list();
    await expect(h.host.open(tab, phone)).rejects.toThrow('PREVIEW_CAPTURE_UNAVAILABLE');
    expect(h.setCastingViewports).toHaveBeenLastCalledWith({});
  });
});

describe('preview host on a locked screen', () => {
  afterEach(() => vi.useRealTimers());

  /** A capture that never answers, until the host gives up on it (3 abandoned calls). */
  async function wedge(h: ReturnType<typeof setup>, source: Awaited<ReturnType<typeof h.host.open>>) {
    h.guest.capturePage = vi.fn(() => new Promise<never>(() => {})) as PreviewGuest['capturePage'];
    for (let i = 0; i < 3; i++) {
      const frame = h.host.frame(source!, { purpose: 'relay' });
      await vi.advanceTimersByTimeAsync(PREVIEW_CAPTURE_TIMEOUT_MS);
      expect(await frame).toBeNull();
    }
    expect(await h.host.frame(source!, { purpose: 'relay' })).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
  }

  it('tells a capture that gave up on a locked screen apart from a plain failure', async () => {
    vi.useFakeTimers();
    const locked = setup(undefined, undefined, false, { readScreenLock: async () => 'locked' });
    const source = (await locked.host.open(locked.host.list()[0]))!;
    const ends: string[] = [];
    locked.host.watch(source, (end) => ends.push(end));
    await wedge(locked, source);
    expect(ends).toEqual(['screen-locked']);

    // The same hang with the screen unlocked, or unreadable, keeps its old meaning.
    for (const state of ['unlocked', 'unknown'] as const) {
      const other = setup(undefined, undefined, false, { readScreenLock: async () => state });
      const opened = (await other.host.open(other.host.list()[0]))!;
      const seen: string[] = [];
      other.host.watch(opened, (end) => seen.push(end));
      await wedge(other, opened);
      expect(seen).toEqual(['capture-unavailable']);
    }
  });

  it('refuses a start while the screen is still locked, and starts once it is unlocked', async () => {
    vi.useFakeTimers();
    let state: 'locked' | 'unlocked' = 'locked';
    const h = setup(undefined, undefined, false, { readScreenLock: async () => state });
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    await wedge(h, source);
    h.host.end(source);
    h.setCastingTabs.mockClear();

    await expect(h.host.open(tab)).rejects.toThrow('HOST_SCREEN_LOCKED');
    // Refused before the tab is touched: no layout, no casting, no throttling change.
    expect(h.setCastingTabs).not.toHaveBeenCalled();
    state = 'unlocked';
    expect(await h.host.open(tab)).toMatchObject({ tabId: 'tab1' });
    // The lock is forgotten once seen unlocked, even if the screen locks again later.
    h.host.end((await h.host.open(tab))!);
    state = 'locked';
    expect(await h.host.open(tab)).toMatchObject({ tabId: 'tab1' });
  });

  it('keeps the tab and its window painting while cast and gives their setting back after', async () => {
    const h = setup();
    const source = (await h.host.open(h.host.list()[0]))!;
    expect(h.guest.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    expect(h.hostWindow.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    h.host.end(source);
    expect(h.guest.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(h.hostWindow.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    h.host.end(source); // idempotent
    expect(h.hostWindow.setBackgroundThrottling).toHaveBeenCalledTimes(2);
  });

  it('gives the throttling back when a tab fails to open, and leaves it alone when switched off', async () => {
    const failing = setup([{ w: 0, h: 0 }]);
    failing.guest.debugger.sendCommand = vi.fn(async () => {
      throw new Error('PREVIEW_INPUT_TIMEOUT');
    });
    await expect(failing.host.open(failing.host.list()[0])).rejects.toThrow();
    expect(failing.hostWindow.setBackgroundThrottling).toHaveBeenLastCalledWith(true);

    const off = setup(undefined, undefined, false, { keepRendering: false });
    await off.host.open(off.host.list()[0]);
    expect(off.hostWindow.setBackgroundThrottling).not.toHaveBeenCalled();
    expect(off.guest.invalidate).not.toHaveBeenCalled();
  });

  it('asks the tab and its window for a new frame when a capture stalls', async () => {
    vi.useFakeTimers();
    const h = setup();
    const source = (await h.host.open(h.host.list()[0]))!;
    h.guest.capturePage = vi.fn(() => new Promise<never>(() => {})) as PreviewGuest['capturePage'];
    const frame = h.host.frame(source, { purpose: 'relay' });
    await vi.advanceTimersByTimeAsync(PREVIEW_CAPTURE_TIMEOUT_MS);
    await frame;
    expect(h.guest.invalidate).toHaveBeenCalledOnce();
    expect(h.hostWindow.invalidate).toHaveBeenCalledOnce();
  });
});
