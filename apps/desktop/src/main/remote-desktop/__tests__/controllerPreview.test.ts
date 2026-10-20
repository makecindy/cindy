import { describe, expect, it, vi } from 'vitest';
import { isPreviewGrant, type RemoteDesktopLease } from '@cindy/device-link';
import {
  RemoteDesktopController,
  type DesktopControllerDeps,
  type DesktopPreviewDeps,
  type DesktopPreviewEnd,
  type DesktopPreviewSource,
  type DesktopPreviewTab,
} from '../controller';

const tab: DesktopPreviewTab = {
  tabId: 'tab1',
  webContentsId: 11,
  generation: 1,
  sessionId: 'task1',
  ghostId: 'baguette',
  pluginName: 'Baguette',
  title: 'Simulator',
};

function harness(options: { tabs?: DesktopPreviewTab[]; withPreview?: boolean } = {}) {
  let tabs = options.tabs ?? [tab];
  const watchers = new Map<DesktopPreviewSource, (end: DesktopPreviewEnd) => void>();
  const alive = new Set<DesktopPreviewSource>();
  const preview: DesktopPreviewDeps = {
    maxTouchPoints: 5,
    list: vi.fn((sessionId?: string) =>
      tabs.filter((item) => sessionId === undefined || item.sessionId === sessionId),
    ),
    open: vi.fn(async (item: DesktopPreviewTab) => {
      const source = { ...item, width: 800, height: 500 };
      alive.add(source);
      return source;
    }),
    current: vi.fn((source: DesktopPreviewSource) => alive.has(source)),
    watch: vi.fn((source, listener) => {
      watchers.set(source, listener);
      return () => watchers.delete(source);
    }),
    input: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    frame: vi.fn(async () => 'tabjpeg'),
    end: vi.fn((source: DesktopPreviewSource) => {
      alive.delete(source);
    }),
  };
  const deps: DesktopControllerDeps = {
    authorized: () => true,
    capabilities: vi.fn(async () => ({
      version: 1 as const,
      enabled: true,
      canControl: true,
      platform: 'darwin' as const,
      displays: [{ id: '1', name: 'Main', width: 1920, height: 1080 }],
    })),
    frame: vi.fn(async () => 'screen'),
    startInput: vi.fn(async () => {}),
    input: vi.fn(),
    stopInput: vi.fn(),
    stopVideo: vi.fn(),
    offer: vi.fn(async () => 'answer'),
    lockScreen: vi.fn(async () => {}),
    clipboard: vi.fn(async () => 'host clipboard'),
    displayModes: vi.fn(async () => []),
    changed: vi.fn(),
    ...(options.withPreview === false ? {} : { preview }),
  };
  const controller = new RemoteDesktopController(deps);
  const grantFor = async (peer = 'phone') => {
    const reply = (await controller.request(peer, { op: 'previewTabs' })) as {
      tabs: Array<{ grant: string }>;
    };
    return reply.tabs[0].grant;
  };
  const open = async (peer = 'phone') =>
    (await controller.request(peer, {
      op: 'previewStart',
      grant: await grantFor(peer),
    })) as RemoteDesktopLease;
  return {
    controller,
    deps,
    preview,
    open,
    grantFor,
    watchers,
    setTabs: (next: DesktopPreviewTab[]) => (tabs = next),
    alive,
  };
}
const send = (h: ReturnType<typeof harness>, request: Record<string, unknown>, peer = 'phone') =>
  h.controller.request(peer, request);

describe('preview tab leases', () => {
  it('advertises the capability only when the host serves previews', async () => {
    const caps = (await send(harness(), { op: 'capabilities' })) as { previewTab?: unknown };
    expect(caps.previewTab).toEqual({ version: 1, maxTouchPoints: 5 });
    const none = (await send(harness({ withPreview: false }), { op: 'capabilities' })) as object;
    expect(none).not.toHaveProperty('previewTab');
    await expect(send(harness({ withPreview: false }), { op: 'previewTabs' })).rejects.toThrow(
      'DESKTOP_UNAVAILABLE',
    );
  });

  it('lists tabs with one-time grants and no side effects, filtered by task', async () => {
    const h = harness({ tabs: [tab, { ...tab, tabId: 'tab2', sessionId: 'task2' }] });
    const all = (await send(h, { op: 'previewTabs' })) as {
      tabs: Array<{ grant: string; sessionId: string; pluginName: string; title: string }>;
    };
    expect(all.tabs.map((t) => t.sessionId)).toEqual(['task1', 'task2']);
    expect(all.tabs.every((t) => isPreviewGrant(t.grant))).toBe(true);
    expect(all.tabs[0]).toMatchObject({ pluginName: 'Baguette', title: 'Simulator' });
    const one = (await send(h, { op: 'previewTabs', sessionId: 'task2' })) as typeof all;
    expect(one.tabs).toHaveLength(1);
    // Listing touches neither the tab nor the screen.
    expect(h.preview.open).not.toHaveBeenCalled();
    expect(h.deps.capabilities).not.toHaveBeenCalled();
    expect(h.controller.state).toBeNull();
    // Polling returns the same unused grant.
    const again = (await send(h, { op: 'previewTabs', sessionId: 'task2' })) as typeof all;
    expect(again.tabs[0].grant).toBe(one.tabs[0].grant);
  });

  it('labels each tab with a stable, opaque, non-credential ref', async () => {
    const h = harness({ tabs: [tab, { ...tab, tabId: 'tab2' }] });
    const list = async (peer = 'phone') =>
      (
        (await send(h, { op: 'previewTabs' }, peer)) as {
          tabs: Array<{ ref?: string; grant: string }>;
        }
      ).tabs;
    const [first, second] = await list();
    expect(first.ref).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(first.ref).not.toBe(second.ref);
    expect(first.ref).not.toContain('tab1');
    expect(first.ref).not.toBe(first.grant);
    // Same binding, same ref: across polls and across phones; the grant is separate.
    expect((await list())[0].ref).toBe(first.ref);
    expect((await list('tablet'))[0].ref).toBe(first.ref);
    expect((await list('tablet'))[0].grant).not.toBe(first.grant);
    // A rebuilt guest (new generation) is a different tab to the phone.
    h.setTabs([
      { ...tab, generation: 2 },
      { ...tab, tabId: 'tab2' },
    ]);
    const [rebuilt, untouched] = await list();
    expect(rebuilt.ref).not.toBe(first.ref);
    expect(untouched.ref).toBe(second.ref);
  });

  it('starts a view-only lease on the tab and never reads a display', async () => {
    const h = harness();
    const lease = await h.open();
    expect(lease.controlling).toBe(false);
    expect(lease.preview).toEqual({ pluginName: 'Baguette', title: 'Simulator' });
    expect(lease.display).toMatchObject({ width: 800, height: 500 });
    expect(lease.display.id.startsWith('preview:')).toBe(true);
    expect(h.preview.open).toHaveBeenCalledWith(tab);
    expect(h.deps.capabilities).not.toHaveBeenCalled();
    expect(h.deps.startInput).not.toHaveBeenCalled();
    expect(h.controller.displayId).toBeNull();
    expect(h.controller.previewSource(lease.lease)).toMatchObject({ tabId: 'tab1' });
    expect(h.controller.state).toEqual({ peer: 'phone', controlling: false });
  });

  it('rejects forged, spent, expired and foreign grants without opening anything', async () => {
    const h = harness();
    await expect(send(h, { op: 'previewStart', grant: 'x'.repeat(43) })).rejects.toThrow(
      'PREVIEW_GRANT_INVALID',
    );
    await expect(send(h, { op: 'previewStart', grant: 'short' })).rejects.toThrow(
      'PREVIEW_GRANT_INVALID',
    );
    const grant = await h.grantFor('phone');
    await expect(send(h, { op: 'previewStart', grant }, 'intruder')).rejects.toThrow(
      'PREVIEW_GRANT_INVALID',
    );
    const lease = (await send(h, { op: 'previewStart', grant })) as RemoteDesktopLease;
    await send(h, { op: 'stop', lease: lease.lease });
    await expect(send(h, { op: 'previewStart', grant })).rejects.toThrow('PREVIEW_GRANT_INVALID');
    expect(h.preview.open).toHaveBeenCalledOnce();
  });

  it('refuses a grant whose tab is gone, and one that cannot be measured', async () => {
    const h = harness();
    const grant = await h.grantFor();
    h.preview.open = vi.fn(async () => null);
    await expect(send(h, { op: 'previewStart', grant })).rejects.toThrow('PREVIEW_SOURCE_ENDED');
    expect(h.controller.state).toBeNull();
    const h2 = harness();
    const second = await h2.grantFor();
    h2.preview.open = vi.fn(async () => {
      throw new Error('PREVIEW_CAPTURE_UNAVAILABLE');
    });
    await expect(send(h2, { op: 'previewStart', grant: second })).rejects.toThrow(
      'PREVIEW_CAPTURE_UNAVAILABLE',
    );
    expect(h2.controller.state).toBeNull();
    expect(h2.deps.capabilities).not.toHaveBeenCalled();
  });

  it('keeps one active slot across screen, window and preview sources', async () => {
    const h = harness();
    const screen = (await send(h, { op: 'start', displayId: '1' })) as RemoteDesktopLease;
    const grant = await h.grantFor('tablet');
    await expect(send(h, { op: 'previewStart', grant }, 'tablet')).rejects.toThrow('DESKTOP_BUSY');
    // A refused start leaves the grant usable once the slot is free.
    await send(h, { op: 'stop', lease: screen.lease });
    expect(await send(h, { op: 'previewStart', grant }, 'tablet')).toMatchObject({
      controlling: false,
    });
    await expect(send(h, { op: 'start', displayId: '1' })).rejects.toThrow('DESKTOP_BUSY');
    await expect(
      send(h, { op: 'start', displayId: '1', takeover: true }, 'phone'),
    ).resolves.toBeTruthy();
    expect(h.preview.end).toHaveBeenCalledOnce();
  });

  it('lets the same phone re-enter its own preview, replacing the old lease', async () => {
    const h = harness();
    const first = await h.open();
    const second = await h.open();
    expect(second.lease).not.toBe(first.lease);
    expect(h.preview.end).toHaveBeenCalledOnce();
    await expect(send(h, { op: 'heartbeat', lease: first.lease })).rejects.toThrow(
      'DESKTOP_LEASE_EXPIRED',
    );
    expect(await send(h, { op: 'heartbeat', lease: second.lease })).toEqual({ controlling: false });
  });

  it('allows only preview-safe operations', async () => {
    const h = harness();
    const { lease } = await h.open();
    for (const request of [
      { op: 'control', lease, enabled: true },
      { op: 'input', lease, sequence: 1, events: [{ kind: 'move', x: 0.5, y: 0.5 }] },
      { op: 'clipboard', lease, action: 'copy' },
      { op: 'privacyScreen', lease, enabled: true },
      { op: 'displayModes', lease },
      { op: 'windowAction', lease, action: 'desktop' },
      { op: 'resolution', lease, modeId: '1' },
      { op: 'viewerDisplay', lease, width: 1280, height: 720 },
    ])
      await expect(send(h, request)).rejects.toThrow('DESKTOP_PREVIEW_ONLY');
    expect(h.deps.input).not.toHaveBeenCalled();
    expect(h.deps.clipboard).not.toHaveBeenCalled();
    expect(h.deps.displayModes).not.toHaveBeenCalled();
    expect(await send(h, { op: 'heartbeat', lease, lockOnExit: true })).toEqual({
      controlling: false,
    });
  });

  it('serves frames from the tab and offers through the host, never from the screen', async () => {
    const h = harness();
    const { lease } = await h.open();
    expect(await send(h, { op: 'frame', lease })).toEqual({ jpeg: 'tabjpeg' });
    expect(h.deps.frame).not.toHaveBeenCalled();
    await send(h, { op: 'offer', lease, sdp: 'v=0' });
    expect(h.deps.offer).toHaveBeenCalledWith(
      expect.objectContaining({ lease, preview: expect.any(Object) }),
      'v=0',
      undefined,
      undefined,
      undefined,
    );
  });

  it('injects ordered input batches and ignores repeats', async () => {
    const h = harness();
    const { lease } = await h.open();
    const events = [{ kind: 'touch', phase: 'start', points: [{ id: 1, x: 0.5, y: 0.5 }] }];
    expect(await send(h, { op: 'previewInput', lease, sequence: 3, events })).toEqual({
      sequence: 3,
    });
    expect(h.preview.input).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab1' }),
      events,
    );
    expect(await send(h, { op: 'previewInput', lease, sequence: 3, events })).toEqual({
      sequence: 3,
    });
    expect(await send(h, { op: 'previewInput', lease, sequence: 2, events })).toEqual({
      sequence: 2,
    });
    expect(h.preview.input).toHaveBeenCalledOnce();
    // Touches beyond what the host advertises are refused.
    const six = Array.from({ length: 6 }, (_, id) => ({ id, x: 0.1, y: 0.1 }));
    await expect(
      send(h, {
        op: 'previewInput',
        lease,
        sequence: 4,
        events: [{ kind: 'touch', phase: 'start', points: six }],
      }),
    ).rejects.toThrow('PREVIEW_INPUT_INVALID');
    expect(h.deps.input).not.toHaveBeenCalled();
    expect(h.deps.startInput).not.toHaveBeenCalled();
  });

  it('reports an injector failure as an input error and keeps the lease', async () => {
    const h = harness();
    const { lease } = await h.open();
    h.preview.input = vi.fn(async () => {
      throw new Error('whatever internal');
    });
    await expect(
      send(h, { op: 'previewInput', lease, sequence: 1, events: [{ kind: 'release' }] }),
    ).rejects.toThrow('PREVIEW_INPUT_INVALID');
    expect(h.controller.state).not.toBeNull();
  });

  it('refuses input in picture-in-picture and lets go of what is pressed', async () => {
    const h = harness();
    const { lease } = await h.open();
    await send(h, { op: 'presentation', lease, enabled: true });
    expect(h.preview.release).toHaveBeenCalledOnce();
    expect(h.deps.stopInput).not.toHaveBeenCalled();
    await expect(
      send(h, { op: 'previewInput', lease, sequence: 1, events: [{ kind: 'release' }] }),
    ).rejects.toThrow('DESKTOP_VIEW_ONLY');
    await send(h, { op: 'presentation', lease, enabled: false });
    expect(
      await send(h, { op: 'previewInput', lease, sequence: 1, events: [{ kind: 'release' }] }),
    ).toEqual({ sequence: 1 });
  });

  it('a screen lease has no preview input', async () => {
    const h = harness();
    const screen = (await send(h, {
      op: 'start',
      displayId: '1',
      control: true,
    })) as RemoteDesktopLease;
    await expect(
      send(h, {
        op: 'previewInput',
        lease: screen.lease,
        sequence: 1,
        events: [{ kind: 'release' }],
      }),
    ).rejects.toThrow('PREVIEW_INPUT_INVALID');
  });

  it('stop never locks the screen or touches OS input, even when asked to', async () => {
    const h = harness();
    const { lease } = await h.open();
    await send(h, { op: 'stop', lease, lockScreen: true });
    expect(h.deps.lockScreen).not.toHaveBeenCalled();
    expect(h.controller.state).toBeNull();
    expect(h.preview.end).toHaveBeenCalledOnce();
    const noLock = harness();
    delete noLock.deps.lockScreen;
    const again = await noLock.open();
    await expect(
      send(noLock, { op: 'stop', lease: again.lease, lockScreen: true }),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it('ends with PREVIEW_SOURCE_ENDED when the tab ends, and never falls back to the screen', async () => {
    const h = harness();
    const { lease } = await h.open();
    const source = h.controller.previewSource(lease)!;
    h.watchers.get(source)!('ended');
    expect(h.controller.state).toBeNull();
    expect(h.preview.end).toHaveBeenCalledOnce();
    await expect(send(h, { op: 'heartbeat', lease })).rejects.toThrow('PREVIEW_SOURCE_ENDED');
    await expect(send(h, { op: 'frame', lease })).rejects.toThrow('PREVIEW_SOURCE_ENDED');
    expect(h.deps.frame).not.toHaveBeenCalled();
    expect(h.deps.capabilities).not.toHaveBeenCalled();
    // A later, unrelated lease expiry reads as before.
    await expect(send(h, { op: 'heartbeat', lease: 'other' })).rejects.toThrow(
      'DESKTOP_LEASE_EXPIRED',
    );
  });

  it('ends when capture gives up, and notices a source that vanished without an event', async () => {
    const h = harness();
    const { lease } = await h.open();
    h.watchers.get(h.controller.previewSource(lease)!)!('capture-unavailable');
    await expect(send(h, { op: 'heartbeat', lease })).rejects.toThrow(
      'PREVIEW_CAPTURE_UNAVAILABLE',
    );

    const quiet = harness();
    const second = await quiet.open();
    quiet.alive.clear();
    quiet.controller.tick();
    expect(quiet.controller.state).toBeNull();
    await expect(
      send(quiet, {
        op: 'previewInput',
        lease: second.lease,
        sequence: 1,
        events: [{ kind: 'release' }],
      }),
    ).rejects.toThrow('PREVIEW_SOURCE_ENDED');
  });

  it('handles a source that has already ended by the time the lease subscribes', async () => {
    const h = harness();
    h.preview.watch = vi.fn((_source, listener) => {
      listener('ended');
      return () => {};
    });
    const lease = await h.open();
    expect(h.controller.state).toBeNull();
    expect(h.preview.end).toHaveBeenCalledOnce();
    await expect(send(h, { op: 'heartbeat', lease: lease.lease })).rejects.toThrow(
      'PREVIEW_SOURCE_ENDED',
    );
  });

  it('reports an input batch that finds the tab gone', async () => {
    const h = harness();
    const { lease } = await h.open();
    h.preview.input = vi.fn(async () => {
      throw new Error('PREVIEW_SOURCE_ENDED');
    });
    await expect(
      send(h, { op: 'previewInput', lease, sequence: 1, events: [{ kind: 'release' }] }),
    ).rejects.toThrow('PREVIEW_SOURCE_ENDED');
    expect(h.controller.state).toBeNull();
  });

  it('ends when the phone loses authorization, and releases the tab', async () => {
    const h = harness();
    let allowed = true;
    h.deps.authorized = () => allowed;
    await h.open();
    allowed = false;
    h.controller.tick();
    expect(h.controller.state).toBeNull();
    expect(h.preview.end).toHaveBeenCalledOnce();
    await expect(send(h, { op: 'previewTabs' })).rejects.toThrow('DESKTOP_DISABLED');
  });

  it('is refused while a display lease is still being restored', async () => {
    const h = harness();
    const grant = await h.grantFor();
    (h.controller as unknown as { originalResolution: object }).originalResolution = {
      displayId: '1',
      modeId: 'm',
      width: 1,
      height: 1,
    };
    await expect(send(h, { op: 'previewStart', grant })).rejects.toThrow('DESKTOP_BUSY');
    expect(h.preview.open).not.toHaveBeenCalled();
  });
});
