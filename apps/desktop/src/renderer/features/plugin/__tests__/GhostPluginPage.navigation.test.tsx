/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginMarketDetail } from '../../../../shared/pluginMarket';
import { __resetInstalledGhostsStoreForTest } from '@/cindy-brain/useInstalledGhosts';
import {
  cancelPendingPluginSuggestion,
  getPendingPluginSuggestion,
  readyPendingPluginSuggestion,
  startPendingPluginSuggestion,
  type PluginSuggestionRequest,
} from '@/features/cc-agent/pendingPluginSuggestion';
import { GhostPluginPage } from '../GhostPluginPage';

const { auth, translation } = vi.hoisted(() => ({
  auth: { user: { membershipKind: 'personal' }, mode: 'local', dataOwnerId: 'navigation-owner' },
  translation: {
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => translation,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

const detail: PluginMarketDetail = {
  pluginId: 'navigation-market-plugin',
  ghostId: 'navigation-plugin',
  name: 'Navigation Plugin',
  description: 'Navigation regression fixture',
  author: 'Cindy',
  scope: 'public',
  organizationId: null,
  defaultInstall: false,
  releaseId: 'navigation-release',
  version: '1.0.0',
  publishedAt: '2026-09-07T00:00:00.000Z',
  icon: null,
  installState: 'not-installed',
  enabled: null,
  sourceType: 'server',
  sourceMarketName: null,
  manifest: {
    schemaVersion: 2,
    id: 'navigation-plugin',
    name: 'Navigation Plugin',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
  },
};

const suggestion: PluginSuggestionRequest = {
  ownerId: 'navigation-owner',
  targetKey: 'local',
  workingDir: null,
  model: 'test',
  effort: 'medium',
  permissionMode: 'default',
  files: [],
  suggestion: {
    id: 'plugin:navigation',
    category: 'email',
    label: 'Navigation suggestion',
    prompt: 'Do not continue after returning from plugin details',
    pluginId: detail.ghostId,
  },
};

const loadDetail = vi.fn<() => Promise<PluginMarketDetail>>();

beforeEach(() => {
  translation.i18n.language = 'en';
  translation.i18n.resolvedLanguage = 'en';
  cancelPendingPluginSuggestion();
  __resetInstalledGhostsStoreForTest();
  loadDetail.mockReset().mockResolvedValue(detail);
  vi.stubGlobal('electronAPI', {
    platform: 'win32',
    sidebarSettings: {
      loadSnapshot: () => ({ hiddenMainViewGhostIds: [], dataOwnerId: null, ownerGeneration: 0 }),
      onHiddenMainViewGhostIdsChanged: () => () => {},
    },
    ghosts: {
      listSync: () => ({ ghosts: [] }),
      recentUsageSync: () => ({ ids: [] }),
      onChanged: () => () => {},
      onRecentUsageChanged: () => () => {},
    },
    pluginMarket: {
      snapshot: async () => ({
        items: [detail],
        unavailableReason: null,
        customSourceNames: [],
        unavailableCustomSourceNames: [],
      }),
      detail: loadDetail,
    },
    setApplicationMenuLocale: async () => {},
  });
});

afterEach(() => {
  cleanup();
  cancelPendingPluginSuggestion();
  __resetInstalledGhostsStoreForTest();
  vi.unstubAllGlobals();
});

function page(entry: string) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <GhostPluginPage />
    </MemoryRouter>
  );
}

async function openFromCatalog() {
  const plugin = await screen.findByText(detail.name);
  const catalog = screen.getByRole('main');
  fireEvent.scroll(catalog, { target: { scrollTop: 640 } });
  fireEvent.click(plugin);
  await screen.findByRole('button', { name: 'settings.ghosts.detail.backToList' });
  expect(catalog.isConnected).toBe(false);
}

describe('plugin page return navigation', () => {
  it.each(['button', 'Escape'] as const)(
    '%s cancels the recommendation and restores the catalog scroll position',
    async (method) => {
      const nonce = startPendingPluginSuggestion(suggestion);
      render(page(`/plugins?recommendation=${nonce}`));
      await openFromCatalog();
      expect(screen.getByRole('status')).toBeTruthy();
      expect(getPendingPluginSuggestion()?.nonce).toBe(nonce);

      if (method === 'button') {
        fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.backToList' }));
      } else {
        fireEvent.keyDown(window, { key: 'Escape' });
      }

      expect(screen.getByRole('main').scrollTop).toBe(640);
      expect(
        screen.queryByRole('button', { name: 'settings.ghosts.detail.backToList' }),
      ).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(getPendingPluginSuggestion()).toBeNull();
      expect(readyPendingPluginSuggestion(nonce, suggestion.ownerId, detail.ghostId)).toBeNull();
    },
  );

  it('restores ordinary catalog navigation without a pending recommendation', async () => {
    render(page('/plugins'));
    await openFromCatalog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('main').scrollTop).toBe(640);
    expect(getPendingPluginSuggestion()).toBeNull();
  });

  it('does not reopen details when a locale refresh completes after returning', async () => {
    const nonce = startPendingPluginSuggestion(suggestion);
    const mounted = render(page(`/plugins?recommendation=${nonce}`));
    await openFromCatalog();
    let finishRefresh!: (value: PluginMarketDetail) => void;
    loadDetail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    translation.i18n.language = 'ja';
    translation.i18n.resolvedLanguage = 'ja';
    mounted.rerender(page(`/plugins?recommendation=${nonce}`));
    await waitFor(() => expect(loadDetail).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => {
      finishRefresh({ ...detail, name: 'Refreshed Plugin' });
    });

    expect(screen.getByRole('main').scrollTop).toBe(640);
    expect(screen.queryByRole('button', { name: 'settings.ghosts.detail.backToList' })).toBeNull();
    expect(getPendingPluginSuggestion()).toBeNull();
  });
});
