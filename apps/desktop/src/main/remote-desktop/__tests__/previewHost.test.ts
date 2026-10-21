import { describe, expect, it, vi } from 'vitest';
import type { PreviewTabBinding, PreviewTabEnded } from '../../rsb-browser-bridge/previewTabs';
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
) {
  let bindings = [binding()];
  const order: string[] = [];
  let measured = 0;
  const listeners = new Set<(event: PreviewTabEnded) => void>();
  const attached = { value: false };
  const guest: PreviewGuest = {
    id: 11,
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
      },
      sendCommand: vi.fn(async (method: string, params?: object) => {
        order.push(method);
        if (method === 'Page.getLayoutMetrics') {
          const size = metrics[Math.min(measured++, metrics.length - 1)];
          return { cssVisualViewport: { clientWidth: size.w, clientHeight: size.h } };
        }
        if (method === 'Input.dispatchTouchEvent') order.push(JSON.stringify(params));
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
    delay,
    guestOrigin,
  });
  return {
    host,
    guest,
    guests,
    index,
    setCastingTabs,
    delay,
    order,
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
    expect(await h.host.frame(source)).toBe(Buffer.from('jpeg').toString('base64'));
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
    const guestOrigin = vi.fn(async () => ({ x: 770, y: 86, scale: 1 }));
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

  it('stops serving frames once the tab no longer matches the index', async () => {
    const h = setup();
    const [tab] = h.host.list();
    const source = (await h.host.open(tab))!;
    h.setBindings([]);
    expect(await h.host.frame(source)).toBeNull();
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
