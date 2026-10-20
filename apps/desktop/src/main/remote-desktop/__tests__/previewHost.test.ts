import { describe, expect, it, vi } from 'vitest';
import type { PreviewTabBinding, PreviewTabEnded } from '../../rsb-browser-bridge/previewTabs';
import { createPreviewHost, type PreviewGuest } from '../previewHost';

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

function setup() {
  let bindings = [binding()];
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
      sendCommand: vi.fn(async (method: string) =>
        method === 'Page.getLayoutMetrics'
          ? { cssVisualViewport: { clientWidth: 800, clientHeight: 500 } }
          : {},
      ),
    },
    sendInputEvent: vi.fn(),
    insertText: vi.fn(async () => {}),
    setBackgroundThrottling: vi.fn(),
  };
  const guests = new Map<string, PreviewGuest>([['tab1', guest]]);
  const setCastingTabs = vi.fn();
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
  });
  return {
    host,
    guest,
    guests,
    index,
    setCastingTabs,
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
