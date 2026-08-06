import { describe, expect, it, vi } from 'vitest';

import {
  closePreviewTabs,
  type PreviewTabCloserDeps,
} from '../browser-preview-tabs.js';

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
  const closeRsbTab = vi.fn(async () => {});
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
});
