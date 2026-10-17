import { afterEach, describe, expect, it, vi } from 'vitest';

const { createTargetViaCdpMock } = vi.hoisted(() => ({
  createTargetViaCdpMock: vi.fn(),
}));

vi.mock('../_generated/extension/src/browser/cdp.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../_generated/extension/src/browser/cdp.js')>();
  return { ...original, createTargetViaCdp: createTargetViaCdpMock };
});

import {
  resolveBrowserConfig,
  resolveProfile,
} from '../_generated/extension/src/browser/config.js';
import { createProfileSelectionOps } from '../_generated/extension/src/browser/server-context.selection.js';
import { createProfileTabOps } from '../_generated/extension/src/browser/server-context.tab-ops.js';
import type {
  BrowserServerState,
  ProfileRuntimeState,
} from '../_generated/extension/src/browser/server-context.types.js';

function createProfileFixture() {
  const resolved = resolveBrowserConfig({
    enabled: true,
    defaultProfile: 'Cindy',
    profiles: {
      Cindy: { driver: 'openclaw', cdpPort: 18800, color: '#00D9C5' },
    },
  });
  const profile = resolveProfile(resolved, 'Cindy');
  if (!profile) throw new Error('test profile did not resolve');
  const profileState: ProfileRuntimeState = { profile, running: null };
  const serverState: BrowserServerState = {
    port: 0,
    resolved,
    profiles: new Map([[profile.name, profileState]]),
  };
  return { profile, profileState, serverState };
}

afterEach(() => {
  createTargetViaCdpMock.mockReset();
  vi.restoreAllMocks();
});

describe('background tab creation', () => {
  it('opens the implicit first tab in the background before an agent navigation', async () => {
    const { profile, profileState } = createProfileFixture();
    const openedTab = {
      targetId: 'created-in-background',
      title: '',
      url: 'about:blank',
      type: 'page',
      wsUrl: 'ws://127.0.0.1:18800/devtools/page/created-in-background',
    };
    const openTab = vi.fn(async () => openedTab);
    const selection = createProfileSelectionOps({
      profile,
      getProfileState: () => profileState,
      getCdpControlPolicy: () => undefined,
      ensureBrowserAvailable: vi.fn(async () => {}),
      listTabs: vi.fn(async () => []),
      openTab,
    });

    await expect(selection.ensureTabAvailable()).resolves.toMatchObject({
      targetId: openedTab.targetId,
    });
    expect(openTab).toHaveBeenCalledWith('about:blank', { background: true });
  });

  it('does not fall back to /json/new after background CDP creation fails', async () => {
    const { profile, profileState, serverState } = createProfileFixture();
    const cdpError = new Error('CDP target creation failed');
    createTargetViaCdpMock.mockRejectedValueOnce(cdpError);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const tabs = createProfileTabOps({
      profile,
      state: () => serverState,
      getProfileState: () => profileState,
    });

    await expect(tabs.openTab('https://example.com', { background: true })).rejects.toBe(cdpError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
