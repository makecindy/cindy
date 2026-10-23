import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { RSB_BROWSER_BRIDGE_PREVIEW_CASTING_CHANNEL } from '../../../shared/rsbBrowserBridge.js';
import {
  PreviewCastingController,
  setActivePreviewCastingController,
  setCastingTabs,
} from '../previewCasting.js';
import { TabRegistry } from '../registry.js';

interface FakeWc {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  once: (event: string, cb: () => void) => void;
  removeListener: () => void;
  host?: FakeWc;
}

function makeWc(id: number, host?: FakeWc): FakeWc {
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    once: () => undefined,
    removeListener: () => undefined,
    host,
  };
}

function setup(fallback: 'none' | 'hostA' = 'none') {
  const wcs = new Map<number, FakeWc>();
  const hostA = makeWc(1);
  const hostB = makeWc(2);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const registry = new TabRegistry({
    lookupWebContents: (id) => (wcs.get(id) as unknown as WebContents) ?? null,
    logger,
  });
  const controller = new PreviewCastingController({
    registry,
    resolveOwner: (guest) => ((guest as unknown as FakeWc).host as unknown as WebContents) ?? null,
    getFallbackHost: () => (fallback === 'hostA' ? (hostA as unknown as WebContents) : null),
    logger,
  });
  const addGuest = (tabId: string, guestId: number, host: FakeWc) => {
    wcs.set(guestId, makeWc(guestId, host));
    registry.report({ sessionId: 's1', tabId, webContentsId: guestId });
  };
  return { registry, controller, hostA, hostB, addGuest, wcs };
}

const lastPush = (wc: FakeWc) => wc.send.mock.calls.at(-1);

describe('PreviewCastingController', () => {
  it('pins the tab and pushes the full set to the hosting renderer only', () => {
    const { registry, controller, hostA, hostB, addGuest } = setup();
    addGuest('t1', 101, hostA);
    addGuest('t2', 102, hostA);
    addGuest('t3', 103, hostB);

    controller.setCastingTabs(['t1', 't3']);

    expect(registry.isPinned('t1')).toBe(true);
    expect(registry.isPinned('t2')).toBe(false);
    expect(lastPush(hostA)).toEqual([
      RSB_BROWSER_BRIDGE_PREVIEW_CASTING_CHANNEL,
      { tabIds: ['t1'] },
    ]);
    expect(lastPush(hostB)).toEqual([
      RSB_BROWSER_BRIDGE_PREVIEW_CASTING_CHANNEL,
      { tabIds: ['t3'] },
    ]);
  });

  it('is idempotent: re-applying the same set does not push again', () => {
    const { controller, hostA, addGuest } = setup();
    addGuest('t1', 101, hostA);
    controller.setCastingTabs(['t1']);
    controller.setCastingTabs(['t1']);
    expect(hostA.send).toHaveBeenCalledTimes(1);
  });

  it('removing a tab releases its pin and tells the old host', () => {
    const { registry, controller, hostA, addGuest } = setup();
    addGuest('t1', 101, hostA);
    addGuest('t2', 102, hostA);
    controller.setCastingTabs(['t1', 't2']);

    controller.setCastingTabs(['t2']);

    expect(registry.isPinned('t1')).toBe(false);
    expect(registry.isPinned('t2')).toBe(true);
    expect(lastPush(hostA)?.[1]).toEqual({ tabIds: ['t2'] });

    controller.setCastingTabs([]);
    expect(registry.isPinned('t2')).toBe(false);
    expect(lastPush(hostA)?.[1]).toEqual({ tabIds: [] });
  });

  it('keeps an existing manual / automation pin when casting ends', () => {
    const { registry, controller, hostA, addGuest } = setup();
    addGuest('t1', 101, hostA);
    registry.pin('t1');
    controller.setCastingTabs(['t1']);
    controller.setCastingTabs([]);
    expect(registry.isPinned('t1')).toBe(true);
  });

  it('retargets and re-pins when a casting tab is re-reported (guest rebuilt / host moved)', () => {
    const { registry, controller, hostA, hostB, addGuest } = setup();
    addGuest('t1', 101, hostA);
    controller.setCastingTabs(['t1']);

    // guest destroyed: registry.release drops the lease with the record
    registry.release('t1');
    expect(registry.isPinned('t1')).toBe(false);

    addGuest('t1', 201, hostB);

    expect(registry.isPinned('t1')).toBe(true);
    expect(lastPush(hostB)?.[1]).toEqual({ tabIds: ['t1'] });
    expect(lastPush(hostA)?.[1]).toEqual({ tabIds: [] });
  });

  it('accepts a tab that is not registered yet and pushes once it reports', () => {
    const { registry, controller, hostA, addGuest } = setup();
    controller.setCastingTabs(['late']);
    expect(hostA.send).not.toHaveBeenCalled();
    expect(registry.isPinned('late')).toBe(true);

    addGuest('late', 301, hostA);
    expect(lastPush(hostA)?.[1]).toEqual({ tabIds: ['late'] });
  });

  it('tells the fallback host about a casting tab that has no live guest, so it can rebuild one', () => {
    const { registry, controller, hostA, hostB, addGuest } = setup('hostA');
    controller.setCastingTabs(['gone']);
    expect(lastPush(hostA)?.[1]).toEqual({ tabIds: ['gone'] });
    expect(registry.isPinned('gone')).toBe(true);

    // the rebuilt guest registers under another host: ownership follows it
    addGuest('gone', 401, hostB);
    expect(lastPush(hostB)?.[1]).toEqual({ tabIds: ['gone'] });
    expect(lastPush(hostA)?.[1]).toEqual({ tabIds: [] });
  });

  it('keeps targeting the last host after the guest is destroyed (it must rebuild it)', () => {
    const { registry, controller, hostA, addGuest } = setup('none');
    addGuest('t1', 101, hostA);
    controller.setCastingTabs(['t1']);
    registry.release('t1');
    expect(controller.listHostedBy(hostA as unknown as WebContents)).toEqual(['t1']);
  });

  it('lists the casting tabs hosted by one renderer (snapshot recovery)', () => {
    const { controller, hostA, hostB, addGuest } = setup();
    addGuest('t1', 101, hostA);
    addGuest('t3', 103, hostB);
    controller.setCastingTabs(['t1', 't3']);
    expect(controller.listHostedBy(hostA as unknown as WebContents)).toEqual(['t1']);
    expect(controller.list().sort()).toEqual(['t1', 't3']);
  });

  it('dispose releases every lease', () => {
    const { registry, controller, hostA, addGuest } = setup();
    addGuest('t1', 101, hostA);
    controller.setCastingTabs(['t1']);
    controller.dispose();
    expect(registry.isPinned('t1')).toBe(false);
  });
});

describe('PreviewCastingController phone viewports', () => {
  const phone = { width: 402, height: 786 };

  it('pushes a shape only to the host of that tab, with the full set, and nothing when unchanged', () => {
    const { controller, hostA, hostB, addGuest } = setup();
    addGuest('t1', 101, hostA);
    addGuest('t3', 103, hostB);
    controller.setCastingTabs(['t1', 't3']);
    hostA.send.mockClear();
    hostB.send.mockClear();

    controller.setCastingViewports({ t1: phone });

    expect(lastPush(hostA)).toEqual([
      RSB_BROWSER_BRIDGE_PREVIEW_CASTING_CHANNEL,
      { tabIds: ['t1'], viewports: { t1: phone } },
    ]);
    expect(hostB.send).not.toHaveBeenCalled();
    controller.setCastingViewports({ t1: { ...phone } });
    expect(hostA.send).toHaveBeenCalledTimes(1);
  });

  it('hands the layout back by dropping the shape, and with it leaving the set', () => {
    const { controller, hostA, addGuest } = setup();
    addGuest('t1', 101, hostA);
    controller.setCastingTabs(['t1']);
    controller.setCastingViewports({ t1: phone });

    controller.setCastingViewports({});
    // No shape left: the payload is what it was before shapes existed.
    expect(lastPush(hostA)?.[1]).toEqual({ tabIds: ['t1'] });

    controller.setCastingViewports({ t1: phone });
    controller.setCastingTabs([]);
    expect(lastPush(hostA)?.[1]).toEqual({ tabIds: [] });
    // A tab that comes back casting does not inherit the old shape.
    controller.setCastingTabs(['t1']);
    expect(lastPush(hostA)?.[1]).toEqual({ tabIds: ['t1'] });
  });

  it('ignores shapes of tabs that are not casting and shapes that make no sense', () => {
    const { controller, hostA, addGuest } = setup();
    addGuest('t1', 101, hostA);
    addGuest('t2', 102, hostA);
    controller.setCastingTabs(['t1']);
    hostA.send.mockClear();
    controller.setCastingViewports({
      t2: phone,
      t1: { width: 0, height: 786 },
    });
    expect(hostA.send).not.toHaveBeenCalled();
    expect(controller.listViewportsHostedBy(hostA as unknown as WebContents)).toEqual({});
  });

  it('lets a reloaded renderer recover the shapes it hosts', () => {
    const { controller, hostA, hostB, addGuest } = setup();
    addGuest('t1', 101, hostA);
    addGuest('t3', 103, hostB);
    controller.setCastingTabs(['t1', 't3']);
    controller.setCastingViewports({ t1: phone, t3: { width: 500, height: 700 } });
    expect(controller.listViewportsHostedBy(hostA as unknown as WebContents)).toEqual({
      t1: phone,
    });
    controller.dispose();
    expect(controller.listViewportsHostedBy(hostA as unknown as WebContents)).toEqual({});
  });
});

describe('setCastingTabs (module API)', () => {
  it('returns false without a registered controller and applies once one is active', () => {
    setActivePreviewCastingController(null);
    expect(setCastingTabs(['x'])).toBe(false);

    const { controller, registry, hostA, addGuest } = setup();
    addGuest('t1', 101, hostA);
    setActivePreviewCastingController(controller);
    expect(setCastingTabs(['t1'])).toBe(true);
    expect(registry.isPinned('t1')).toBe(true);
    setActivePreviewCastingController(null);
    expect(registry.isPinned('t1')).toBe(false);
  });
});
