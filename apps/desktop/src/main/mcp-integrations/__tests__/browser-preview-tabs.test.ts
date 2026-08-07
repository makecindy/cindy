import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  _resetPreviewRevocationGenerationForTests,
  _resetRsbPreviewTabsForTests,
  closePreviewTabs,
  registerRsbPreviewTab,
  trackPreviewTabNavigation,
  unregisterRsbPreviewTab,
  type PreviewTabCloserDeps,
} from '../browser-preview-tabs.js';

afterEach(() => {
  _resetRsbPreviewTabsForTests();
  _resetPreviewRevocationGenerationForTests();
});

const PREVIEW_URL =
  'http://127.0.0.1:49152/preview/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/index.html';
const OTHER_URL = 'https://example.com/';

function fakeDeps(overrides: Partial<PreviewTabCloserDeps> = {}): PreviewTabCloserDeps & {
  listVendoredTabs: ReturnType<typeof vi.fn>;
  closeVendoredTab: ReturnType<typeof vi.fn>;
  listRsbTabs: ReturnType<typeof vi.fn>;
  closeRsbTab: ReturnType<typeof vi.fn>;
} {
  const listVendoredTabs = vi.fn(async () => [
    { targetId: 't1', url: PREVIEW_URL },
    { suggestedTargetId: 't2', url: OTHER_URL },
  ]);
  const closeVendoredTab = vi.fn(async () => {});
  const closeRsbTab = vi.fn(async () => true);
  const rsbPreviewWc = { getURL: () => PREVIEW_URL, isDestroyed: () => false };
  const rsbOtherWc = { getURL: () => OTHER_URL, isDestroyed: () => false };
  const listRsbTabs = vi.fn(() => [
    { tabId: 'r1', sessionId: 's1', wc: rsbPreviewWc },
    { tabId: 'r2', sessionId: 's1', wc: rsbOtherWc },
  ]);
  return {
    everCalled: () => true,
    listVendoredTabs,
    closeVendoredTab,
    listRsbTabs,
    closeRsbTab,
    isPreviewUrl: (u: string) => u.startsWith('http://127.0.0.1:') && u.includes('/preview/'),
    ...overrides,
  } as never;
}

describe('closePreviewTabs (browser-preview-tabs)', () => {
  it('closes preview tabs on BOTH backends when the vendored runtime was used', async () => {
    const deps = fakeDeps();
    await closePreviewTabs(deps);
    expect(deps.listVendoredTabs).toHaveBeenCalledOnce();
    // only the preview URL tab is closed
    expect(deps.closeVendoredTab).toHaveBeenCalledTimes(1);
    expect(deps.closeVendoredTab).toHaveBeenCalledWith('t1');
    // RSB sweep also runs: preview tab closed through the bridge, other tab untouched
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(1);
    expect(deps.closeRsbTab).toHaveBeenCalledWith('s1', 'r1');
  });

  it('skips the vendored probe when the runtime was never used, but still sweeps RSB (round 16)', async () => {
    const deps = fakeDeps({ everCalled: () => false });
    await closePreviewTabs(deps);
    expect(deps.listVendoredTabs).not.toHaveBeenCalled();
    expect(deps.closeVendoredTab).not.toHaveBeenCalled();
    // RSB sweep stays unconditional (it boots nothing)
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(1);
  });

  it('still sweeps RSB when the vendored tabs response is malformed (round 17 fallthrough)', async () => {
    const deps = fakeDeps({ listVendoredTabs: vi.fn(async () => null) });
    await closePreviewTabs(deps);
    expect(deps.closeVendoredTab).not.toHaveBeenCalled();
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(1);
  });

  it('skips destroyed RSB WebContents', async () => {
    const destroyed = { getURL: () => PREVIEW_URL, isDestroyed: () => true };
    const deps = fakeDeps({
      listRsbTabs: vi.fn(() => [{ tabId: 'r1', sessionId: 's1', wc: destroyed }]),
    });
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).not.toHaveBeenCalled();
  });

  it('is best-effort: a throwing vendored probe does not abort the RSB sweep', async () => {
    const deps = fakeDeps({ listVendoredTabs: vi.fn(async () => Promise.reject(new Error('boom')) as never) });
    await expect(closePreviewTabs(deps)).resolves.toBeUndefined();
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(1);
  });

  it('closes registered preview tabs with NO live WebContents (LRU-evicted, round 21)', async () => {
    // A preview tab that was LRU-evicted (or the detached sidebar closed)
    // keeps its persisted store row but has no live WebContents — it never
    // appears in listRsbTabs. The registration set must still close it.
    registerRsbPreviewTab('s9', 'evicted-1');
    const deps = fakeDeps({ listRsbTabs: vi.fn(() => []) });
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(1);
    expect(deps.closeRsbTab).toHaveBeenCalledWith('s9', 'evicted-1');
    // the entry is drained after a successful sweep
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(1);
  });

  it('keeps the registration when the bridge close fails (round 22)', async () => {
    registerRsbPreviewTab('s9', 'sticky-1');
    const deps = fakeDeps({
      listRsbTabs: vi.fn(() => []),
      closeRsbTab: vi.fn(async () => false),
    });
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(1);
    // failed close keeps the entry → next revocation retries
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(2);
  });

  it('unregistered tabs are not closed (navigate-away / manual close, round 22)', async () => {
    registerRsbPreviewTab('s9', 'gone-1');
    unregisterRsbPreviewTab('gone-1');
    const deps = fakeDeps({ listRsbTabs: vi.fn(() => []) });
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).not.toHaveBeenCalled();
  });

  it('does NOT close a live preview row twice: live sweep success unregisters it (round 23 dedupe)', async () => {
    // The same tab appears BOTH in the live registry (has a WebContents) and
    // in the registration set (registered at open time). The live sweep must
    // close it once and drop the registration, so the registration sweep
    // does not close the same tab a second time (duplicated-cleanup smell,
    // new Codex reviewer P1, round 23).
    registerRsbPreviewTab('s1', 'r1');
    const deps = fakeDeps();
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(1);
    expect(deps.closeRsbTab).toHaveBeenCalledWith('s1', 'r1');
  });

  it('registration sweep repeats while new registrations arrive (revocation race, round 23)', async () => {
    // A navigation that committed DURING the revocation registers between
    // sweep iterations; the sweep must pick it up in the next pass instead
    // of leaving it behind (new Codex reviewer P1, round 23).
    registerRsbPreviewTab('s9', 'early-1');
    let registeredLate = false;
    const deps = fakeDeps({
      listRsbTabs: vi.fn(() => []),
      closeRsbTab: vi.fn(async (sessionId: string, tabId: string) => {
        if (tabId === 'early-1' && !registeredLate) {
          registeredLate = true;
          registerRsbPreviewTab('s9', 'late-2');
        }
        return true;
      }),
    });
    await closePreviewTabs(deps);
    // early-1 closed on pass 1; late-2 registered mid-pass and closed on pass 2
    expect(deps.closeRsbTab.mock.calls.map((c) => c[1]).sort()).toEqual(['early-1', 'late-2']);
  });

  it('stops the loop when a close keeps failing (no progress)', async () => {
    registerRsbPreviewTab('s9', 'stuck-1');
    const deps = fakeDeps({
      listRsbTabs: vi.fn(() => []),
      closeRsbTab: vi.fn(async () => false),
    });
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).toHaveBeenCalledTimes(1); // one pass, then no progress → stop
  });
});

describe('trackPreviewTabNavigation (address-bar provenance, round 23 P0)', () => {
  function fakeWc() {
    const ee = new EventEmitter();
    return {
      ee,
      on: ee.on.bind(ee),
      once: ee.once.bind(ee),
      removeListener: ee.removeListener.bind(ee),
      emitDidNavigate: (url: string) => ee.emit('did-navigate', {}, url),
      emitDestroyed: () => ee.emit('destroyed'),
    };
  }

  it('unregisters the tab when a committed navigation leaves the preview origin', async () => {
    registerRsbPreviewTab('s1', 't1');
    const wc = fakeWc();
    trackPreviewTabNavigation(wc, 't1');
    wc.emitDidNavigate('https://example.com/');
    // revocation must no longer close the tab
    const deps = fakeDeps({ listRsbTabs: vi.fn(() => []) });
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).not.toHaveBeenCalled();
  });

  it('keeps the registration while navigations stay on the preview origin', async () => {
    registerRsbPreviewTab('s1', 't1');
    const wc = fakeWc();
    trackPreviewTabNavigation(wc, 't1');
    wc.emitDidNavigate(PREVIEW_URL); // same-origin preview navigation
    const deps = fakeDeps({ listRsbTabs: vi.fn(() => []) });
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).toHaveBeenCalledWith('s1', 't1');
  });

  it('stops tracking when the WebContents is destroyed', async () => {
    registerRsbPreviewTab('s1', 't1');
    const wc = fakeWc();
    trackPreviewTabNavigation(wc, 't1');
    wc.emitDestroyed();
    wc.emitDidNavigate('https://example.com/'); // listener was removed
    const deps = fakeDeps({ listRsbTabs: vi.fn(() => []) });
    await closePreviewTabs(deps);
    expect(deps.closeRsbTab).toHaveBeenCalledWith('s1', 't1');
  });
});
