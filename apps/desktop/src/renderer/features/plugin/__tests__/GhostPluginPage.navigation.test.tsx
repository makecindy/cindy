/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import type { PluginMarketDetail } from '../../../../shared/pluginMarket';
import type { InstalledGhost } from '../../../../shared/ghost';
import { __resetInstalledGhostsStoreForTest } from '@/cindy-brain/useInstalledGhosts';
import {
  cancelPendingPluginSuggestion,
  getPendingPluginSuggestion,
  readyPendingPluginSuggestion,
  startPendingPluginSuggestion,
  type PluginSuggestionRequest,
} from '@/features/cc-agent/pendingPluginSuggestion';
import { GhostPluginPage } from '../GhostPluginPage';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { leadingSlashInvocation, loadAllCommands, rewriteAgentSkillInvocationForDispatch } from '@/lib/slashCommands';
import { toast } from '@/lib/toast';
import { getDraft as getWorkspaceDraft, patchDraft, resetDraftWorkspaceTargets } from '@/state/newMakerDraft';

const { auth, translation, pickAndUpdateGhost } = vi.hoisted(() => ({
  pickAndUpdateGhost: vi.fn(),
  auth: { user: { membershipKind: 'personal' }, mode: 'local', dataOwnerId: 'navigation-owner' },
  translation: {
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  },
}));

vi.mock('../GhostPagePanelHost', () => ({
  GhostPagePanelHost: ({ ghost }: { ghost: { manifest: { id: string } } }) => (
    <aside data-testid="replacement-panel">{ghost.manifest.id}</aside>
  ),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/cindy-brain/installFlow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/cindy-brain/installFlow')>()),
  pickAndUpdateGhost,
}));
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
  suggestion: {
    id: 'plugin:navigation',
    category: 'email',
    label: 'Navigation suggestion',
    prompt: 'Do not continue after returning from plugin details',
    pluginId: detail.ghostId,
  },
};

const loadDetail = vi.fn<() => Promise<PluginMarketDetail>>();
const listAgentSkills = vi.fn();

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  translation.i18n.language = 'en';
  translation.i18n.resolvedLanguage = 'en';
  cancelPendingPluginSuggestion();
  __resetInstalledGhostsStoreForTest();
  loadDetail.mockReset().mockResolvedValue(detail);
  pickAndUpdateGhost.mockReset().mockResolvedValue(undefined);
  listAgentSkills.mockReset().mockResolvedValue({ success: true, skills: [] });
  patchDraft({ vendor: 'cc' });
  vi.stubGlobal('electronAPI', {
    platform: 'win32',
    maker: {
      listDesktopCommands: async () => ({ success: true, commands: [] }),
      listAgentCommands: async () => ({ success: true, commands: [] }),
      listAgentSkills,
    },
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
      onUpdateConsentHoldsChanged: () => () => {},
    },
    setApplicationMenuLocale: async () => {},
  });
});

afterEach(() => {
  cleanup();
  clearDraft(NEW_MAKER_DRAFT_KEY);
  resetDraftWorkspaceTargets();
  cancelPendingPluginSuggestion();
  __resetInstalledGhostsStoreForTest();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function RetirementNavigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/plugins?ghost=ios-simulator')}>Select legacy plugin</button>
      <button onClick={() => navigate('/plugins?retired=ios-simulator')}>Open retirement notice</button>
    </>
  );
}

function page(entry: string, withRetirementNavigation = false) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      {withRetirementNavigation && <RetirementNavigation />}
      <GhostPluginPage />
    </MemoryRouter>
  );
}

// Unit: PR #6433 reproduced a user Skill stealing the creation action when Claude
// namespaces the built-in command. Click the real action, then run the production
// command lookup/dispatch rewrite; existing prompt checks never covered ownership.
it.each([
  ['cc', 'claude-code', 'cindy-plugin-creator', 'cindy:cindy-plugin-creator'],
  ['cc', 'claude-code', 'cindy:cindy-plugin-creator', 'cindy:cindy-plugin-creator'],
  ['pi', 'pi', 'cindy-plugin-creator', 'skill:cindy-plugin-creator'],
] as const)('starts plugin creation through the built-in %s command %s / %s', async (vendor, agentKind, name, runtimeCommandName) => {
  const official = { kind: 'agent-skill', source: 'skill', name, runtimeCommandName, builtIn: true };
  listAgentSkills.mockResolvedValue({ success: true, skills: [
    { kind: 'agent-skill', source: 'skill', name: 'cindy-plugin-creator' },
    official,
  ] });
  patchDraft({ vendor });
  patchDraft({ workingDir: '/remote/project', deviceLinkDeviceId: 'remote-device', extraDirs: ['/unrelated'] });
  render(page('/plugins'));
  fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.page.addPluginAria' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.ghosts.page.createWithCindy' }));
  await waitFor(() => expect(getDraft(NEW_MAKER_DRAFT_KEY)).toBeDefined());
  const draft = getDraft(NEW_MAKER_DRAFT_KEY)!;
  const text = draft.text!.content![0]!.content![0]!.text!;
  const commands = await loadAllCommands(agentKind, null);
  const selected = commands.find((command) => command.name === leadingSlashInvocation(text)?.name);
  expect(selected).toEqual(official);
  expect(draft.builtInSkillIntent).toEqual({ name: 'cindy-plugin-creator', commandName: name });
  expect(rewriteAgentSkillInvocationForDispatch(text, selected)).toBe(`/${runtimeCommandName} settings.ghosts.page.createPrompt`);
  expect(listAgentSkills).toHaveBeenCalledWith(agentKind, expect.not.objectContaining({ workingDir: '/remote/project' }));
  expect(draft.attachments).toEqual([]);
  expect(draft.focusAtEnd).toBe(true);
  expect(getWorkspaceDraft()).toMatchObject({ workingDir: null, deviceLinkDeviceId: null, extraDirs: [] });
});

it.each(['missing', 'disabled', 'failed'] as const)('preserves the draft when the built-in creator is %s instead of falling back to a user Skill', async (state) => {
  const error = vi.spyOn(toast, 'error').mockReturnValue('creator-error');
  listAgentSkills.mockResolvedValue({ success: state !== 'failed', skills: [
    { kind: 'agent-skill', source: 'skill', name: 'cindy-plugin-creator' },
    ...(state === 'disabled' ? [{ kind: 'agent-skill', source: 'skill', name: 'cindy:cindy-plugin-creator', builtIn: true, enabled: false }] : []),
  ] });
  const original = { text: plainTextToTiptapDoc('Existing draft'), attachments: [] };
  saveDraft(NEW_MAKER_DRAFT_KEY, original);
  patchDraft({ workingDir: '/existing/project' });
  render(page('/plugins'));
  fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.page.addPluginAria' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.ghosts.page.createWithCindy' }));
  await waitFor(() => expect(error).toHaveBeenCalledWith('settings.ghosts.page.creatorUnavailable'));
  expect(getDraft(NEW_MAKER_DRAFT_KEY)).toEqual(original);
  expect(getWorkspaceDraft().workingDir).toBe('/existing/project');
});

it('keeps linked computer and project scope in the page heading without changing recommendation', async () => {
  Object.assign(window.electronAPI, { showOpenDirectoryDialog: vi.fn(async () => ({ canceled: false, path: '/fixture/Cindy' })) });
  Object.assign(window.electronAPI.ghosts, { workdirPrefsSync: vi.fn(() => ({ disabled: [] })) });
  render(page('/plugins'));
  const recommended = await screen.findByText(detail.name);
  const scope = screen.getByRole('button', { name: 'settings.ghosts.remote.device' });
  expect(scope.closest('[data-catalog-region="heading"]')).toBeTruthy();
  expect(document.querySelector('[data-catalog-region="notice"]')).toBeNull();
  fireEvent.keyDown(scope, { key: 'ArrowDown' });
  fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.ariaLabel' }), { key: 'ArrowRight' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.browse' }));
  await screen.findByText('settings.ghosts.projectBanner.desc');
  expect(screen.getByText(detail.name)).toBe(recommended);
  expect(window.electronAPI.ghosts.workdirPrefsSync).toHaveBeenCalledWith('/fixture/Cindy');
  fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.projectBanner.backToGlobal' }));
  expect(document.querySelector('[data-catalog-region="notice"]')).toBeNull();
  expect(screen.getByText(detail.name)).toBe(recommended);
});

async function openFromCatalog() {
  const plugin = await screen.findByText(detail.name);
  const catalog = screen.getByRole('main');
  fireEvent.scroll(catalog, { target: { scrollTop: 640 } });
  fireEvent.click(plugin);
  await screen.findByRole('button', { name: 'settings.ghosts.detail.backToList' });
  expect(catalog.isConnected).toBe(false);
}

describe('plugin page return navigation', () => {
  // Public-share deep links must open the existing installation without starting
  // an install. Catalog-only cases below cannot cover this query entry (unit).
  it.each(['installed', 'update-available'] as const)(
    'opens the local detail for a shared %s plugin without installing it',
    async (installState) => {
      const installed: InstalledGhost = {
        manifest: { ...detail.manifest, name: 'Installed Plugin', version: '0.9.0' },
        dir: path.join('plugins', detail.ghostId),
        enabled: true,
        approval: { state: 'approved', revision: 'market-navigation-revision' },
      };
      window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
      loadDetail.mockResolvedValue({ ...detail, installState });
      const install = vi.fn();
      Object.assign(window.electronAPI.pluginMarket, { install });

      render(page(`/plugins?market=${detail.pluginId}`));

      await screen.findByRole('heading', { level: 1, name: 'Installed Plugin' });
      expect(loadDetail).toHaveBeenCalledWith(detail.pluginId);
      expect(install).not.toHaveBeenCalled();
    },
  );

  // Regression #2871 (98929118d6): the real market-detail install flow must refresh
  // the current page after an update/replacement. The card helper only checks the
  // navigation decision; it cannot catch clearing marketDetail in the parent.
  // Minimal unit input: one installed plugin and either market update state.
  // Only IPC is faked; page/detail components and the install flow stay real.
  // File alone: 20 tests, Vitest 5.29s / wall 6.12s on 2026-10-16.
  it.each(['update-available', 'conflict'] as const)(
    'keeps the market detail visible and refreshed after %s succeeds',
    async (installState) => {
      const installed: InstalledGhost = {
        manifest: { ...detail.manifest, name: 'Installed Plugin', version: '0.9.0' },
        dir: path.join('plugins', detail.ghostId),
        enabled: true,
        approval: { state: 'approved', revision: 'market-navigation-revision' },
      };
      const marketDetail = { ...detail, installState };
      const refreshedDetail: PluginMarketDetail = {
        ...detail,
        installState: 'installed',
        enabled: true,
        description: 'Refreshed market details after installation',
      };
      window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
      const changed = new Set<Parameters<typeof window.electronAPI.ghosts.onChanged>[0]>();
      window.electronAPI.ghosts.onChanged = (listener) => {
        changed.add(listener);
        return () => { changed.delete(listener); };
      };
      const snapshot = vi.fn(window.electronAPI.pluginMarket.snapshot);
      window.electronAPI.pluginMarket.snapshot = snapshot;
      let installationComplete = false;
      loadDetail.mockImplementation(async () =>
        installationComplete ? refreshedDetail : marketDetail,
      );
      let finishInstall!: () => void;
      const committed = new Promise<void>((resolve) => { finishInstall = resolve; });
      const install = vi.fn(async () => {
        const ghost = { ...installed, manifest: { ...installed.manifest, version: detail.version } };
        changed.forEach((listener) => listener({ ghosts: [ghost] }));
        await committed;
        installationComplete = true;
        return {
          ghost,
        };
      });
      Object.assign(window.electronAPI.pluginMarket, { install });
      render(page('/plugins'));
      await openFromCatalog();
      await screen.findByRole('heading', { level: 1, name: detail.name });
      const marketPage = screen.getByRole('main');
      const snapshotsBeforeInstall = snapshot.mock.calls.length;

      try {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', {
            name: installState === 'conflict'
              ? 'settings.ghosts.market.replace'
              : 'settings.ghosts.market.update',
          }));
        });
        // The roster arrives before market provenance commits. Reading it here
        // caused an extra full scan and could expose a transient source conflict.
        expect(snapshot).toHaveBeenCalledTimes(snapshotsBeforeInstall);
      } finally {
        await act(async () => { finishInstall(); });
      }

      await screen.findByText(refreshedDetail.description!);
      expect(snapshot).toHaveBeenCalledTimes(snapshotsBeforeInstall + 1);
      expect(install).toHaveBeenCalledWith(detail.pluginId, expect.objectContaining({
        expectedReleaseId: detail.releaseId,
        expectedManifest: detail.manifest,
        expectedInstalledApproval: 'approved:market-navigation-revision',
        allowSourceReplacement: installState === 'conflict',
      }));
      expect(screen.getByRole('main')).toBe(marketPage);
      expect(screen.getByRole('heading', { level: 1, name: detail.name })).toBeTruthy();
      expect((screen.getByRole('button', {
        name: 'settings.ghosts.market.installed',
      }) as HTMLButtonElement).disabled).toBe(true);
    },
  );

  it.each(['xd-ordinary', 'filo-ordinary'])(
    'updates an ordinary root %s from a local file and offers export in packaged builds',
    async (ghostId) => {
      vi.stubEnv('DEV', false);
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      const installed: InstalledGhost = {
        manifest: { ...detail.manifest, id: ghostId, name: ghostId },
        dir: '/tmp/brain/' + ghostId,
        namespace: null,
        enabled: true,
        approval: { state: 'approved', revision: 'ordinary-root-revision' },
        trust: {
          level: 'unverified',
          publisherSigned: false,
          publisherVerified: false,
          reviewed: false,
        },
      };
      window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
      window.electronAPI.pluginMarket.snapshot = async () => ({
        items: [],
        unavailableReason: null,
        customSourceNames: [],
        unavailableCustomSourceNames: [],
      });
      render(page('/plugins?ghost=' + ghostId));
      await screen.findByRole('button', { name: 'settings.ghosts.detail.backToList' });
      fireEvent.pointerDown(
        screen.getByRole('button', { name: 'settings.ghosts.detail.moreActions' }),
        { button: 0, ctrlKey: false },
      );
      expect(
        screen.getByRole('menuitem', { name: 'settings.ghosts.detail.exportPackage' }),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'settings.ghosts.detail.updateFromFile' }),
      );
      expect(pickAndUpdateGhost).toHaveBeenCalledWith(ghostId, { t: translation.t });
    },
  );

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
        fireEvent.keyDown(document.body, { key: 'Escape' });
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
    fireEvent.keyDown(document.body, { key: 'Escape' });
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

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await act(async () => {
      finishRefresh({ ...detail, name: 'Refreshed Plugin' });
    });

    expect(screen.getByRole('main').scrollTop).toBe(640);
    expect(screen.queryByRole('button', { name: 'settings.ghosts.detail.backToList' })).toBeNull();
    expect(getPendingPluginSuggestion()).toBeNull();
  });
});

describe('retirement migration from the original plugin', () => {
  const old = {
    manifest: { ...detail.manifest, id: 'ios-simulator', name: 'Legacy Simulator' },
    dir: '/tmp/legacy-simulator',
    enabled: false,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    retirement: { id: 'embedded-ios-simulator', eligible: true, unread: true },
  };
  const replacement = {
    ...old,
    manifest: {
      ...detail.manifest,
      id: 'cindy-simulator',
      name: 'Baguette',
      command: 'baguette',
    },
    retirement: undefined,
    enabled: false,
  };

  function installFixture(ghosts: unknown[]) {
    const bridge = window.electronAPI;
    Object.assign(bridge.ghosts, {
      listSync: () => ({ ghosts }),
      acknowledgeRetirement: vi.fn(async () => ({ ok: true })),
      setEnabled: vi.fn(async () => ({ ok: true })),
    });
    return bridge;
  }

  it('exits market details and acknowledges the notice only after it is rendered', async () => {
    const bridge = installFixture([old]);
    const visibleAtAcknowledgement: boolean[] = [];
    vi.mocked(bridge.ghosts.acknowledgeRetirement).mockImplementation(async () => {
      visibleAtAcknowledgement.push(
        screen.queryByText('settings.ghosts.retirement.embeddedSimulator.title') !== null,
      );
      return { ok: true };
    });
    render(page('/plugins', true));
    await openFromCatalog();

    fireEvent.click(screen.getByRole('button', { name: 'Select legacy plugin' }));
    expect(screen.queryByText('settings.ghosts.retirement.embeddedSimulator.title')).toBeNull();
    expect(bridge.ghosts.acknowledgeRetirement).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open retirement notice' }));
    expect(await screen.findByText('settings.ghosts.retirement.embeddedSimulator.title')).toBeTruthy();
    expect(screen.queryByText(detail.name)).toBeNull();
    expect(bridge.ghosts.acknowledgeRetirement).toHaveBeenCalledWith('ios-simulator');
    expect(visibleAtAcknowledgement).toEqual([true]);
  });

  it('does not let a pending market detail request cover the retirement notice', async () => {
    installFixture([old]);
    let finishDetail!: (value: PluginMarketDetail) => void;
    loadDetail.mockImplementationOnce(() => new Promise((resolve) => { finishDetail = resolve; }));
    render(page('/plugins', true));
    fireEvent.click(await screen.findByText(detail.name));
    await waitFor(() => expect(loadDetail).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Open retirement notice' }));
    expect(await screen.findByText('settings.ghosts.retirement.embeddedSimulator.title')).toBeTruthy();
    await act(async () => { finishDetail(detail); });
    expect(screen.getByText('settings.ghosts.retirement.embeddedSimulator.title')).toBeTruthy();
    expect(screen.queryByText(detail.name)).toBeNull();
  });

  it('marks the notice read and uses the existing market installer with the live release', async () => {
    const bridge = installFixture([old]);
    const baguette = {
      ...detail,
      pluginId: 'cb93909aaa6ac600bbc2f6b8a',
      ghostId: 'cindy-simulator',
      manifest: replacement.manifest,
    };
    loadDetail.mockResolvedValue(baguette);
    const install = vi.fn(async () => ({ ghost: replacement }));
    Object.assign(bridge.pluginMarket, { install });
    render(page('/plugins?retired=ios-simulator'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.ghosts.retirement.install' }),
    );
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith(
        baguette.pluginId,
        expect.objectContaining({
          expectedReleaseId: baguette.releaseId,
          expectedManifest: baguette.manifest,
        }),
      ),
    );
    expect(bridge.ghosts.acknowledgeRetirement).toHaveBeenCalledWith('ios-simulator');
    expect(document.querySelector('webview')).toBeNull();
  });

  it.each(['legacy', 'root'] as const)('enables the %s replacement without reinstalling it', async (layout) => {
    const instanceId = layout === 'root' ? '_root__cindy-simulator' : 'cindy-simulator';
    const installed = { ...replacement, namespace: null,
      dir: path.join('plugins', ...(layout === 'root' ? ['_ns', '_root'] : []), 'cindy-simulator') };
    const bridge = installFixture([old, installed]);
    vi.mocked(bridge.ghosts.setEnabled).mockImplementation(async (id) => {
      if (id !== instanceId) throw new Error('[NOT_FOUND] Wrong plugin instance');
      return { ok: true };
    });
    render(page('/plugins?retired=ios-simulator'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.ghosts.retirement.enable' }),
    );
    await waitFor(() =>
      expect(bridge.ghosts.setEnabled).toHaveBeenCalledWith(instanceId, true,
        'approved:' + installed.approval.revision),
    );
    expect(loadDetail).not.toHaveBeenCalled();
  });

  it('enables the market-matched organization replacement instead of its root sibling', async () => {
    const root = { ...replacement, namespace: null, enabled: true, dir: 'plugins/cindy-simulator' };
    const organization = {
      ...replacement,
      namespace: 'acme',
      enabled: false,
      dir: 'plugins/_ns/acme/cindy-simulator',
    };
    const bridge = installFixture([old, root, organization]);
    const marketReplacement = {
      ...detail,
      pluginId: 'cb93909aaa6ac600bbc2f6b8a',
      ghostId: 'cindy-simulator',
      name: 'Baguette',
      namespace: 'acme',
      scope: 'organization' as const,
      organizationId: 'org-acme',
      installState: 'installed' as const,
      enabled: false,
      manifest: replacement.manifest,
    };
    bridge.pluginMarket.snapshot = async () => ({
      items: [marketReplacement],
      unavailableReason: null,
      customSourceNames: [],
      unavailableCustomSourceNames: [],
    });
    vi.mocked(bridge.ghosts.setEnabled).mockImplementation(async (id) => {
      if (id !== '_ns__acme__cindy-simulator') throw new Error('[NOT_FOUND] Wrong plugin instance');
      return { ok: true };
    });
    render(page('/plugins?retired=ios-simulator'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.ghosts.retirement.enable' }),
    );
    await waitFor(() =>
      expect(bridge.ghosts.setEnabled).toHaveBeenCalledWith(
        '_ns__acme__cindy-simulator',
        true,
        'approved:' + organization.approval.revision,
      ),
    );
  });

  // Unit regression, #7014 discussion_r4365645907: after the rename the real
  // retirement action must reuse the old installed ID in the market namespace,
  // including offline root installs, rather than offering a second installation.
  it.each([
    ['offline-legacy', false], ['offline-legacy', true],
    ['offline', false], ['offline', true],
    ['public', false], ['public', true],
    ['organization', false], ['organization', true],
  ] as const)('reuses the %s legacy replacement (enabled=%s)', async (source, enabled) => {
    const namespace = source === 'organization' ? 'acme' : null;
    const legacyManifest = {
      ...replacement.manifest, id: 'baguette-simulator',
      panel: { html: 'panel.html', position: 'tab' as const },
    };
    const installed = {
      ...replacement, manifest: legacyManifest, namespace, enabled,
      dir: source === 'offline-legacy' ? path.join('plugins', 'baguette-simulator')
        : path.join('plugins', '_ns', namespace ?? '_root', 'baguette-simulator'),
    };
    const wrongNamespace = { ...installed, namespace: 'other', enabled: true,
      dir: path.join('plugins', '_ns', 'other', 'baguette-simulator') };
    const bridge = installFixture([old, wrongNamespace, installed]);
    const install = vi.fn();
    Object.assign(bridge.pluginMarket, { install });
    bridge.pluginMarket.snapshot = async () => ({
      items: source.startsWith('offline') ? [] : [{
        ...detail, pluginId: 'cb93909aaa6ac600bbc2f6b8a',
        ghostId: 'cindy-simulator', namespace,
        scope: source === 'organization' ? 'organization' : 'public',
        organizationId: namespace, manifest: replacement.manifest,
      }],
      unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [],
    });
    render(page('/plugins?retired=ios-simulator'));
    fireEvent.click(await screen.findByRole('button', {
      name: `settings.ghosts.retirement.${enabled ? 'open' : 'enable'}`,
    }));
    if (enabled) {
      expect((await screen.findByTestId('replacement-panel')).textContent).toBe('baguette-simulator');
    } else {
      await waitFor(() => expect(bridge.ghosts.setEnabled).toHaveBeenCalledWith(
        namespace ? '_ns__acme__baguette-simulator' : source === 'offline-legacy'
          ? 'baguette-simulator' : '_root__baguette-simulator',
        true, 'approved:' + installed.approval.revision,
      ));
    }
    expect(install).not.toHaveBeenCalled();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  it('opens an enabled replacement panel from the retirement notice', async () => {
    installFixture([old, {
      ...replacement, namespace: null, enabled: true,
      dir: path.join('plugins', 'baguette-simulator'),
      manifest: { ...replacement.manifest, id: 'baguette-simulator', panel: { html: 'panel.html', position: 'tab' } },
    }, {
      ...replacement, enabled: true,
      manifest: { ...replacement.manifest, panel: { html: 'panel.html', position: 'tab' } },
    }]);
    render(page('/plugins?retired=ios-simulator'));
    fireEvent.click(await screen.findByRole('button', { name: 'settings.ghosts.retirement.open' }));
    expect((await screen.findByTestId('replacement-panel')).textContent).toBe('cindy-simulator');
    expect(screen.queryByText('settings.ghosts.retirement.embeddedSimulator.title')).toBeNull();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  it('does not manufacture a retirement entry for a user without the former installation', () => {
    installFixture([]);
    render(page('/plugins?retired=ios-simulator'));
    expect(screen.queryByText('settings.ghosts.retirement.embeddedSimulator.title')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.retirement.install' })).toBeNull();
  });
});

describe('organization catalog access notice', () => {
  function marketSnapshot(organizationAccessError?: string, items = [detail]) {
    window.electronAPI.pluginMarket.snapshot = async () => ({
      items,
      unavailableReason: null,
      customSourceNames: [],
      unavailableCustomSourceNames: [],
      ...(organizationAccessError ? { organizationAccessError } : {}),
    });
  }

  it('shows the upgrade hint beside a public plugin', async () => {
    marketSnapshot('PLUGIN_NAMESPACE_CLIENT_REQUIRED');
    render(page('/plugins'));
    expect(await screen.findByText('Navigation Plugin')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.market.errors.namespaceClientRequired')).toBeTruthy();
  });

  it('keeps the catalog notice when nothing is installable', async () => {
    marketSnapshot('PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE', []);
    render(page('/plugins'));
    expect(
      await screen.findByText('settings.ghosts.market.errors.organizationContextUnavailable'),
    ).toBeTruthy();
    expect(screen.getByText('settings.ghosts.page.recommendedSection')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.page.emptyFiltered')).toBeNull();
  });

  it('uses the generic hint for an unknown organization access code', async () => {
    marketSnapshot('PLUGIN_FUTURE_REASON');
    render(page('/plugins'));
    expect(await screen.findByText('settings.ghosts.market.errors.organizationUnavailable')).toBeTruthy();
    expect(screen.getByText('Navigation Plugin')).toBeTruthy();
  });

  it('does not show an organization access hint when the catalog is complete', async () => {
    render(page('/plugins'));
    expect(await screen.findByText('Navigation Plugin')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.market.errors.namespaceClientRequired')).toBeNull();
    expect(screen.queryByText('settings.ghosts.market.errors.organizationUnavailable')).toBeNull();
  });
});
