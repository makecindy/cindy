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

function setup() {
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
