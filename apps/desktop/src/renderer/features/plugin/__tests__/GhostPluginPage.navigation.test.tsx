/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import type { PluginMarketDetail } from '../../../../shared/pluginMarket';
import type { ContributionTransferView, MyPluginDetailView, MyPluginReleasePageView } from '../../../../shared/pluginContributions';
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

const { auth, translation, pickAndUpdateGhost, catalog } = vi.hoisted(() => ({
  catalog: { device: null as { deviceId: string; name: string } | null },
  pickAndUpdateGhost: vi.fn(),
  auth: { user: { membershipKind: 'personal' }, mode: 'local', dataOwnerId: 'navigation-owner' },
  translation: {
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  },
}));

vi.mock('../useCatalogDevice', () => ({ CatalogDeviceScope: ({ children }: { children: (...args: unknown[]) => unknown }) =>
  children(catalog.device, false, 1, { selected: catalog.device, onSelect: vi.fn(), directory: { candidates: [], online: false, relayOnline: false } }) }));

vi.mock('../GhostPagePanelHost', () => ({
  GhostPagePanelHost: ({ ghost }: { ghost: { manifest: { id: string } } }) => (
    <aside data-testid="replacement-panel">{ghost.manifest.id}</aside>
  ),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth, useOptionalDataOwnerGeneration: () => 0 }));
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
  catalog.device = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  auth.mode = 'local';
  auth.user.membershipKind = 'personal';
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
      legacyRecoveryStatus: vi.fn().mockResolvedValue({ state: 'none' }),
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

it('opens a shared package before the selected remote plugin catalogue', async () => {
  catalog.device = { deviceId: 'remote-computer', name: 'Remote Computer' };
  render(<MemoryRouter initialEntries={['/plugins?share=' + 's'.repeat(32)]}><GhostPluginPage /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'sharing.localSignIn' })).toBeTruthy();
  expect(loadDetail).not.toHaveBeenCalled();
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

  it.each([
    { state: 'installed', author: 'Published nickname', installedAuthor: undefined, expected: 'Published nickname' },
    { state: 'installed', author: null, installedAuthor: undefined, expected: null },
    { state: 'update-available', author: 'New release nickname', installedAuthor: 'Installed release nickname', expected: 'Installed release nickname' },
    { state: 'update-available', author: 'New release nickname', installedAuthor: null, expected: null },
  ] as const)('preserves installed attribution and anonymity ($state, $expected)', async ({ state, author, installedAuthor, expected }) => {
    const installed: InstalledGhost = {
      manifest: { ...detail.manifest, author: 'Package author must not leak' },
      dir: '/tmp/brain/' + detail.ghostId,
      namespace: null, namespaceState: 'confirmed', enabled: true,
      publishingSource: { kind: 'public-market', pluginId: detail.pluginId },
      approval: { state: 'approved', revision: 'revision' },
    };
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    window.electronAPI.pluginMarket.snapshot = async () => ({
      items: [{ ...detail, namespace: null, installState: state, author, installedAuthor,
        version: state === 'update-available' ? '1.1.0' : detail.version }],
      unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [],
    });
    render(page('/plugins'));
    const card = screen.getByRole('button', { name: detail.name });
    await within(card).findByText('settings.ghosts.page.origin.public');
    if (expected) expect(within(card).getByText(expected)).toBeTruthy();
    if (author !== expected && author) expect(within(card).queryByText(author)).toBeNull();
    expect(within(card).queryByText('Package author must not leak')).toBeNull();
  });

  it.each(['local', 'public-market'] as const)('keeps the original local author fallback without exposing an unconfirmed public author (%s)', async (kind) => {
    const installed: InstalledGhost = {
      manifest: { ...detail.manifest, author: 'Local package author' },
      dir: '/tmp/brain/' + detail.ghostId,
      namespace: null, namespaceState: 'confirmed', enabled: true,
      publishingSource: kind === 'local'
        ? { kind: 'local', source: 'manual' }
        : { kind: 'public-market', pluginId: detail.pluginId },
      approval: { state: 'approved', revision: 'revision' },
    };
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    window.electronAPI.pluginMarket.snapshot = async () => ({
      items: [], unavailableReason: 'OFFLINE', customSourceNames: [], unavailableCustomSourceNames: [],
    });
    render(page('/plugins'));
    const card = screen.getByRole('button', { name: detail.name });
    await within(card).findByText('settings.ghosts.page.origin.local');
    expect(Boolean(within(card).queryByText('Local package author'))).toBe(kind === 'local');
  });

  it.each([
    { id: 'cindy-art', namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, approval: 'approved', reason: 'reservedId' },
    { id: 'personal-plugin', namespace: 'org', namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, approval: 'approved', reason: 'privatePlugin' },
    { id: 'personal-plugin', namespace: null, namespaceState: 'pending', approval: 'approved', reason: 'identityPending' },
    { id: 'personal-plugin', namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, approval: 'invalid', reason: 'approvalRequired' },
  ])('keeps publishing restrictions out of use details for $id ($reason)', async ({ id, namespace, namespaceState, approval, reason }) => {
    const installed = {
      manifest: { ...detail.manifest, id, name: 'Installed Plugin' },
      dir: '/tmp/brain/' + id, namespace, namespaceState, publishingSource: { kind: 'local', source: 'manual' },
      enabled: true, approval: { state: approval, revision: 'revision' },
    } as InstalledGhost;
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    window.electronAPI.pluginMarket.snapshot = async () => ({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
    render(page('/plugins'));
    fireEvent.click(await screen.findByText('Installed Plugin'));
    expect(screen.queryByText('settings.ghosts.contribution.versionUpdates')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' })).toBeNull();
    expect(screen.queryByText('settings.ghosts.contribution.unavailable.' + reason)).toBeNull();
  });

  it('offers only locally publishable exact installations and opens a read-only package summary without uploading or publishing', async () => {
    auth.mode = 'cloud';
    const installed = {
      manifest: { ...detail.manifest, id: 'local-author-plugin', name: 'Local Author Plugin' },
      dir: '/tmp/brain/local-author-plugin', namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' },
      enabled: true, approval: { state: 'approved', revision: 'revision' },
    } as InstalledGhost;
    const unavailable = [
      { ...installed, manifest: { ...installed.manifest, id: 'cindy-art', name: 'Reserved Plugin' } },
      { ...installed, manifest: { ...installed.manifest, id: 'organization-plugin', name: 'Organization Plugin' }, namespace: 'org' },
      { ...installed, manifest: { ...installed.manifest, id: 'unapproved-plugin', name: 'Unapproved Plugin' }, approval: { state: 'legacy-unapproved' } },
      { ...installed, manifest: { ...installed.manifest, id: 'pending-plugin', name: 'Pending Identity Plugin' }, namespaceState: 'pending' },
    ] as InstalledGhost[];
    const ghosts = [...unavailable.map((ghost) => ({ ...ghost, dir: path.join(path.dirname(installed.dir), ghost.manifest.id) })), installed];
    window.electronAPI.ghosts.listSync = () => ({ ghosts });
    const api = { list: vi.fn().mockResolvedValue({ plugins: [], nextCursor: null, queriedAt: '2026-10-15T00:00:00Z' }), transfers: vi.fn().mockResolvedValue([]), prepare: vi.fn().mockResolvedValue({ preparedId: 'preview', instanceId: 'local-author-plugin', version: '1.0.0', releaseNotes: 'Initial release', preflight: { blockers: [], actions: { canSubmit: true } } }), discard: vi.fn().mockResolvedValue(undefined), submit: vi.fn() };
    Object.assign(window.electronAPI, { pluginContributions: api });
    render(page('/plugins?myPlugins=1'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' }));
    const picker = screen.getByRole('dialog');
    expect(within(picker).getAllByRole('button')).toHaveLength(2); // One installation and Close; select before submitting.
    for (const ghost of unavailable) expect(within(picker).queryByText(ghost.manifest.name)).toBeNull();
    const option = within(picker).getByRole('button', { name: 'Local Author Plugin · 1.0.0 · local-author-plugin' });
    await waitFor(() => expect(option).toHaveProperty('disabled', false));
    fireEvent.click(option);
    expect(await within(picker).findByRole('button', { name: 'settings.ghosts.contribution.submitVersion' })).toHaveProperty('disabled', false);
    // Radix correctly removes the page behind an open modal from the accessibility tree.
    expect(screen.getByText('settings.ghosts.contribution.myPlugins', { selector: 'h1' })).toBeTruthy();
    expect(api.prepare).toHaveBeenCalledWith('local-author-plugin', expect.objectContaining({ directory: installed.dir }));
    expect(api.submit).not.toHaveBeenCalled();
    fireEvent.click(within(picker).getByRole('button', { name: 'settings.ghosts.detail.closeDialog' }));
    expect(screen.getByRole('heading', { level: 1, name: 'settings.ghosts.contribution.myPlugins' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.title' }));
    expect(await screen.findByRole('button', { name: 'settings.ghosts.contribution.myPlugins' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Local Author Plugin' })).toBeNull();
  });

  it.each(['VERSION_ALREADY_SUBMITTED', 'PLUGIN_PENDING_RELEASE_EXISTS', 'RELEASE_NOTES_REQUIRED', 'PLUGIN_GHOST_ID_CONFLICT'])(
    'hides the unavailable submit action after reading the real preflight projection (%s)', async code => {
      auth.mode = 'cloud';
      const installed: InstalledGhost = {
        manifest: { ...detail.manifest, id: 'local-author-plugin', name: 'Local Author Plugin' },
        dir: path.resolve('brain', 'local-author-plugin'), namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' },
        enabled: true, approval: { state: 'approved', revision: 'revision' },
      };
      window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
      const api = {
        list: vi.fn().mockResolvedValue({ plugins: [], nextCursor: null, queriedAt: '2026-10-15T00:00:00Z' }),
        prepare: vi.fn().mockResolvedValue({ preparedId: 'preview', instanceId: 'local-author-plugin', version: '1.0.0', releaseNotes: 'Initial release', preflight: { blockers: [{ code, message: 'Publication blocked' }], actions: { canSubmit: false } } }),
        discard: vi.fn().mockResolvedValue(undefined), submit: vi.fn(),
      };
      Object.assign(window.electronAPI, { pluginContributions: api });
      render(page('/plugins'));
      fireEvent.click(await screen.findByText('Local Author Plugin'));
      expect(api.prepare).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' }));
      const picker = screen.getByRole('dialog');
      await within(picker).findAllByText(`settings.ghosts.contribution.errors.${code}`);
      expect(within(picker).queryByText('Publication blocked')).toBeNull();
      expect(within(picker).queryByRole('button', { name: 'settings.ghosts.contribution.submitVersion' })).toBeNull();
      expect(within(picker).getByRole('button', { name: 'settings.ghosts.detail.closeDialog' })).toHaveProperty('disabled', false);
      expect(api.submit).not.toHaveBeenCalled();
    },
  );

  it('shows no publishable installations instead of no installations when only a reserved plugin is installed', async () => {
    auth.mode = 'cloud';
    const installed: InstalledGhost = {
      manifest: { ...detail.manifest, id: 'cindy-art', name: 'Art' },
      dir: path.resolve('brain', 'cindy-art'),
      namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, enabled: true,
      approval: { state: 'approved', revision: 'revision' },
    };
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    const api = { list: vi.fn().mockResolvedValue({ plugins: [], nextCursor: null, queriedAt: '2026-10-15T00:00:00Z' }), transfers: vi.fn().mockResolvedValue([]), prepare: vi.fn().mockResolvedValue({ preparedId: 'preview', instanceId: 'local-author-plugin', version: '1.0.0', releaseNotes: 'Initial release', preflight: { blockers: [], actions: { canSubmit: true } } }), discard: vi.fn().mockResolvedValue(undefined), submit: vi.fn() };
    Object.assign(window.electronAPI, { pluginContributions: api });
    render(page('/plugins?myPlugins=1'));
    await screen.findByText('settings.ghosts.contribution.empty');
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' }));
    const picker = screen.getByRole('dialog');
    expect(within(picker).getByText('settings.ghosts.contribution.noPublishablePlugins')).toBeTruthy();
    expect(within(picker).queryByText('settings.ghosts.contribution.noLocalPlugins')).toBeNull();
    expect(within(picker).queryByText('Art')).toBeNull();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

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


describe('plugin use details and independent author management', () => {
  const prefix = 'settings.ghosts.contribution';
  async function openLocalPublishing() {
    fireEvent.click(await screen.findByRole('button', { name: `${prefix}.publishPlugin` }));
    return screen.getByRole('dialog');
  }
  function authorApi(localInstanceId: string | null = '_root__navigation-plugin') {
    const own: MyPluginDetailView = {
      plugin: { pluginId: detail.pluginId, name: 'Published snapshot name', iconUrl: null,
        updatedAt: '2026-10-19T00:00:00Z', market: { state: 'available', version: '1.0.0', releaseId: detail.releaseId, reason: null },
        localInstanceId, localVersion: localInstanceId ? '1.2.0' : null,
        localInstallation: localInstanceId ? { state: 'installed', instanceId: localInstanceId, version: '1.2.0', origin: 'local', enabled: true } : { state: 'missing' },
        actions: { submitUpdate: true, viewMarket: true }, authorSettings: { anonymous: true, canEdit: false },
        latestSubmission: { releaseId: 'pending-release', version: '1.2.0', sha256: 'a'.repeat(64), revision: 'revision',
          revisionState: 'current', submissionId: 'pending-submission', reviewStatus: 'pending',
          submittedAt: '2026-10-19T00:00:00Z', reviewedAt: null, reason: null, source: 'manual', canCancelReview: true,
          content: { name: 'Submitted snapshot name', description: 'Submitted snapshot description', iconUrl: null,
            permissions: [], manifestView: { releaseNotes: 'Changes since the published 1.0.0' } } } },
      history: [], nextCursor: null, queriedAt: '2026-10-19T00:00:00Z',
    };
    return { list: vi.fn().mockResolvedValue({ plugins: [own.plugin], nextCursor: null, queriedAt: own.queriedAt }),
      detail: vi.fn().mockResolvedValue(own), releases: vi.fn<() => Promise<MyPluginReleasePageView>>().mockResolvedValue({ releases: [], nextCursor: null, queriedAt: own.queriedAt }),
      prepare: vi.fn(), submit: vi.fn(), setAnonymity: vi.fn() };
  }

  function localAuthorInstallation(version: string): InstalledGhost {
    return {
      manifest: { ...detail.manifest, name: 'Local Author Plugin', version, releaseNotes: 'Complete changes' },
      dir: path.resolve('brain', '_ns', '_root', detail.ghostId), instanceKey: '_root__navigation-plugin',
      namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' },
      enabled: true, approval: { state: 'approved', revision: 'revision' },
    };
  }

  it.each([
    ['failed', 'Missing entry file: main.js\nPackage validation stopped.'],
    ['failed', 'Expected SHA256 aabb, received ccdd.'],
    ['failed', 'Package is 120 MB; maximum size is 100 MB.'],
    ['failed', 'Release storage could not retain the validated package.'],
    ['unconfirmed', null],
    ['processing', null],
    ['succeeded', null],
  ] as const)('keeps a %s submission in the original detail without an upload-management page', async (stage, message) => {
    auth.mode = 'cloud';
    const installed = localAuthorInstallation('1.3.0');
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    const api = authorApi();
    const own = await api.detail();
    own.plugin.latestSubmission = null;
    const prepared: ContributionTransferView['prepared'] = { preparedId: 'submit-package', instanceId: installed.instanceKey!, pluginId: detail.pluginId,
      ghostId: detail.ghostId, name: 'Local Author Plugin', description: '', version: '1.3.0', releaseNotes: 'Complete changes',
      sha256: 'a'.repeat(64), sizeBytes: 100, expiresAt: '2099-01-01T00:00:00Z',
      preflight: { subject: { authority: 'https://issuer.test', membershipId: 'member-A' }, queriedAt: '2026-10-21T00:00:00Z', policyVersion: 2,
        target: { pluginId: detail.pluginId, ghostId: detail.ghostId, version: '1.3.0', expectedRelease: null }, pendingRelease: null, blockers: [], actions: { canSubmit: true } } };
    api.prepare.mockResolvedValue(prepared);
    const transfer: ContributionTransferView = {
      localId: prepared.preparedId, prepared, stage: stage === 'processing' ? 'processing' : 'complete',
      errorCode: stage === 'unconfirmed' ? 'INTERNAL' : null,
      operation: { subject: { authority: 'https://issuer.test', membershipId: 'member-A' }, operationId: 'operation',
        status: stage === 'failed' ? 'failed' : stage === 'succeeded' ? 'succeeded' : 'validating', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z', receipt: stage === 'succeeded' ? { operationId: 'operation', submissionId: 'new-submission', pluginId: detail.pluginId, releaseId: 'new-release', ghostId: detail.ghostId, version: '1.3.0', source: 'manual', submittedAt: '2026-10-21T00:00:00Z', uploadedPackage: { sha256: prepared.sha256, sizeBytes: prepared.sizeBytes }, releaseRevision: { releaseId: 'new-release', sha256: prepared.sha256, displayUpdatedAt: '2026-10-21T00:00:00Z' }, outcome: 'submitted_for_review' } : null, submission: null,
        failure: message ? { code: 'PLUGIN_PACKAGE_INVALID', message } : null },
    };
    api.submit.mockResolvedValue(transfer);
    let finish!: (value: ContributionTransferView) => void;
    const status = vi.fn(() => new Promise<ContributionTransferView>(resolve => { finish = resolve; }));
    const error = vi.spyOn(toast, 'error').mockReturnValue('submit-error');
    Object.assign(window.electronAPI, { pluginContributions: { ...api, status, discard: vi.fn().mockResolvedValue(undefined) } });
    render(page(`/plugins?ghost=${installed.instanceKey}`));
    await screen.findByRole('heading', { name: 'Local Author Plugin' });
    expect(api.prepare).not.toHaveBeenCalled();
    const picker = await openLocalPublishing();
    const submit = await within(picker).findByRole('button', { name: `${prefix}.submitVersion` });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(api.submit).toHaveBeenCalledExactlyOnceWith(prepared.preparedId));
    if (stage === 'processing') {
      expect(submit).toHaveProperty('disabled', true);
      await waitFor(() => expect(status).toHaveBeenCalledWith(transfer.localId), { timeout: 2500 });
      await act(async () => { finish({ ...transfer, stage: 'complete', errorCode: 'INTERNAL' }); });
    }
    if (stage === 'succeeded') {
      await screen.findByRole('heading', { name: 'Published snapshot name' });
      expect(error).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: `${prefix}.myPlugins` }));
      await screen.findByRole('heading', { level: 1, name: `${prefix}.myPlugins` });
      fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.title' }));
      await screen.findByRole('heading', { level: 1, name: 'settings.ghosts.title' });
    } else {
      await waitFor(() => expect(error).toHaveBeenCalledWith(`${prefix}.errors.${message ? 'PLUGIN_PACKAGE_INVALID' : 'INTERNAL'}`));
      if (message) expect(error).not.toHaveBeenCalledWith(message);
      expect(screen.getByText('Local Author Plugin', { selector: 'h1' })).toBeTruthy();
    }
    expect(screen.queryByText(`${prefix}.resume`)).toBeNull();
    expect(screen.queryByText(`${prefix}.retryPublish`)).toBeNull();
    expect(screen.queryByRole('region', { name: `${prefix}.publicationProgress` })).toBeNull();
  });

  // Unit: a cancelled 1.0.0 still offered submission and only failed after clicking.
  // Exercise the real installed-detail entry; preflight-only coverage missed updates.
  it.each(['cancelled', 'rejected', 'approved', 'pending'] as const)(
    'hides the installed-version submit action after a %s submission', async reviewStatus => {
      auth.mode = 'cloud';
      const installed = localAuthorInstallation('1.2.0');
      window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
      const api = authorApi();
      const own = await api.detail();
      own.plugin.latestSubmission!.reviewStatus = reviewStatus;
      Object.assign(window.electronAPI, { pluginContributions: api });
      render(page(`/plugins?ghost=${installed.instanceKey}`));
      await screen.findByRole('heading', { name: 'Local Author Plugin' });
      const picker = await openLocalPublishing();
      await within(picker).findAllByText(`${prefix}.errors.${reviewStatus === 'pending' ? 'PLUGIN_PENDING_RELEASE_EXISTS' : 'VERSION_ALREADY_SUBMITTED'}`);
      expect(within(picker).queryByRole('button', { name: `${prefix}.submitVersion` })).toBeNull();
      expect(api.prepare).not.toHaveBeenCalled();
      expect(api.submit).not.toHaveBeenCalled();
    },
  );

  it('checks older release pages before enabling submission of an installed version', async () => {
    auth.mode = 'cloud';
    const installed = localAuthorInstallation('0.9.0');
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    const api = authorApi();
    const own = await api.detail();
    const latest = own.plugin.latestSubmission!;
    latest.reviewStatus = 'approved';
    api.releases.mockResolvedValueOnce({ releases: [latest], nextCursor: 'older', queriedAt: own.queriedAt })
      .mockResolvedValueOnce({ releases: [{ ...latest, version: '0.9.0', reviewStatus: 'cancelled' }], nextCursor: null, queriedAt: own.queriedAt });
    Object.assign(window.electronAPI, { pluginContributions: api });
    render(page(`/plugins?ghost=${installed.instanceKey}`));
    await screen.findByRole('heading', { name: 'Local Author Plugin' });
    const picker = await openLocalPublishing();
    await within(picker).findAllByText(`${prefix}.errors.VERSION_ALREADY_SUBMITTED`);
    expect(api.releases).toHaveBeenCalledWith(detail.pluginId, 'older');
    expect(within(picker).queryByRole('button', { name: `${prefix}.submitVersion` })).toBeNull();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('keeps the entry usable and offers no submission while dialog eligibility is loading or failed', async () => {
    auth.mode = 'cloud';
    const installed = localAuthorInstallation('2.0.0');
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    const api = authorApi();
    (await api.detail()).plugin.latestSubmission!.reviewStatus = 'approved';
    let fail!: (error: Error) => void;
    api.releases.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    Object.assign(window.electronAPI, { pluginContributions: api });
    render(page(`/plugins?ghost=${installed.instanceKey}`));
    const action = await screen.findByRole('button', { name: `${prefix}.publishPlugin` });
    expect(action).toHaveProperty('disabled', false);
    expect(api.releases).not.toHaveBeenCalled();
    const picker = await openLocalPublishing();
    await waitFor(() => expect(api.releases).toHaveBeenCalled());
    expect(within(picker).queryByRole('button', { name: `${prefix}.submitVersion` })).toBeNull();
    await act(async () => { fail(new Error('Offline')); });
    expect(await within(picker).findByRole('alert')).toHaveProperty('textContent', `${prefix}.loadFailed`);
    expect(within(picker).queryByRole('button', { name: `${prefix}.submitVersion` })).toBeNull();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

  // An unused version can still fail preflight (for example, missing update notes).
  // Exercise the installed-detail action: it must use the same preview as first publication.
  it.each([{ allowed: true, membershipKind: 'personal' }, { allowed: false, membershipKind: 'personal' }, { allowed: true, membershipKind: 'org' }])('preflights an unused installed update for $membershipKind before submission (allowed=$allowed)', async ({ allowed, membershipKind }) => {
    auth.mode = 'cloud';
    auth.user.membershipKind = membershipKind;
    const installed = localAuthorInstallation('2.0.0');
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    const api = authorApi();
    const own = await api.detail();
    own.plugin.latestSubmission!.reviewStatus = 'approved';
    api.releases.mockResolvedValueOnce({ releases: [own.plugin.latestSubmission!], nextCursor: 'older', queriedAt: own.queriedAt })
      .mockResolvedValueOnce({ releases: [], nextCursor: null, queriedAt: own.queriedAt });
    const prepared: ContributionTransferView['prepared'] = { preparedId: 'checked-update', instanceId: installed.instanceKey!, pluginId: detail.pluginId,
      ghostId: detail.ghostId, name: 'Local Author Plugin', description: '', version: '2.0.0', releaseNotes: 'Checked update notes',
      sha256: 'a'.repeat(64), sizeBytes: 100, expiresAt: '2099-01-01T00:00:00Z',
      preflight: { subject: { authority: 'https://issuer.test', membershipId: 'member-A' }, queriedAt: own.queriedAt, policyVersion: 2,
        target: { pluginId: detail.pluginId, ghostId: detail.ghostId, version: '2.0.0', expectedRelease: null }, pendingRelease: null,
        blockers: allowed ? [] : [{ code: 'RELEASE_NOTES_REQUIRED', message: 'Missing release notes' }], actions: { canSubmit: allowed } } };
    let finishPreview!: (value: ContributionTransferView['prepared']) => void;
    api.prepare.mockImplementation(() => new Promise<ContributionTransferView['prepared']>(resolve => { finishPreview = resolve; }));
    Object.assign(window.electronAPI, { pluginContributions: { ...api, discard: vi.fn().mockResolvedValue(undefined) } });
    render(page(`/plugins?ghost=${installed.instanceKey}`));
    expect(api.prepare).not.toHaveBeenCalled();
    const picker = await openLocalPublishing();
    await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(1));
    expect(within(picker).queryByRole('button', { name: `${prefix}.submitVersion` })).toBeNull();
    expect(api.submit).not.toHaveBeenCalled();
    await act(async () => { finishPreview(prepared); });
    if (allowed) {
      expect(await screen.findByRole('button', { name: `${prefix}.submitVersion` })).toHaveProperty('disabled', false);
      expect(within(picker).getByText('Checked update notes')).toBeTruthy();
    } else {
      expect(await within(picker).findByText(`${prefix}.errors.RELEASE_NOTES_REQUIRED`)).toBeTruthy();
      expect(within(picker).queryByText('Missing release notes')).toBeNull();
      expect(screen.queryByRole('button', { name: `${prefix}.submitUpdate` })).toBeNull();
      expect(screen.queryByRole('button', { name: `${prefix}.submitVersion` })).toBeNull();
    }
    expect(api.releases).toHaveBeenCalledWith(detail.pluginId, 'older');
    expect(api.submit).not.toHaveBeenCalled();
  });
  it.each([undefined, { kind: 'unavailable' }, { kind: 'public-market', pluginId: detail.pluginId }] satisfies InstalledGhost['publishingSource'][])(
    'does not expose publishing or prepare ordinary/unknown downloads (%j)', async publishingSource => {
      auth.mode = 'cloud';
      const installed: InstalledGhost = { manifest: { ...detail.manifest, name: 'Downloaded Plugin' },
        dir: path.resolve('brain', '_ns', '_root', detail.ghostId), instanceKey: '_root__navigation-plugin',
        namespace: null, namespaceState: 'confirmed', publishingSource, enabled: true,
        approval: { state: 'approved', revision: 'revision' } };
      window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
      const api = authorApi();
      const readonly = { ...(await api.detail()).plugin, actions: { submitUpdate: false, viewMarket: true } };
      api.list.mockResolvedValue({ plugins: [readonly], nextCursor: null, queriedAt: detail.publishedAt });
      api.detail.mockResolvedValue({ ...(await api.detail()), plugin: readonly });
      Object.assign(window.electronAPI, { pluginContributions: api });
      render(page(`/plugins?ghost=${installed.instanceKey}`));
      await screen.findByRole('heading', { name: 'Downloaded Plugin' });
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole('heading', { name: `${prefix}.publishing` })).toBeNull();
      expect(screen.queryByRole('button', { name: `${prefix}.publishPlugin` })).toBeNull();
      expect(api.prepare).not.toHaveBeenCalled();
      expect(api.submit).not.toHaveBeenCalled();
      // 普通下载详情无需扫描本人投稿权限，公开安装也不能开启 UI 提审。
      expect(api.list).not.toHaveBeenCalled();
    });
  it.each(['author-list', 'installed', 'installed-market', 'market'] as const)('keeps use and version management separate when entering from %s', async entry => {
    auth.mode = 'cloud';
    const installed: InstalledGhost = { manifest: { ...detail.manifest, name: 'Actual installed name', version: '1.2.0' },
      dir: path.resolve('brain', '_ns', '_root', detail.ghostId), instanceKey: '_root__navigation-plugin', namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, enabled: true,
      approval: { state: 'approved', revision: 'revision' } };
    if (entry === 'installed-market') installed.publishingSource = { kind: 'public-market', pluginId: detail.pluginId };
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    const api = authorApi(); Object.assign(window.electronAPI, { pluginContributions: api });
    render(page(entry === 'author-list' ? '/plugins?myPlugins=1' : entry === 'market' ? `/plugins?market=${detail.pluginId}` : '/plugins'));
    if (entry === 'author-list') fireEvent.click(await screen.findByText('Published snapshot name'));
    if (entry === 'installed' || entry === 'installed-market') fireEvent.click(await screen.findByText('Actual installed name'));
    if (entry === 'author-list') {
      await screen.findByRole('heading', { level: 1, name: 'Published snapshot name' });
      const facts = screen.getByLabelText(`${prefix}.versionFacts`);
      expect(facts.closest('details')).toBeNull();
      expect(within(facts).getAllByText('1.2.0')).toHaveLength(2);
      expect(within(facts).getByText('1.0.0')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /settings\.ghosts\.contribution\.submitVersion/ })).toBeNull();
      expect(screen.queryByRole('button', { name: `${prefix}.openPlugin` })).toBeNull();
      expect(screen.getByRole('button', { name: `${prefix}.cancelReview` })).toBeTruthy();
      expect(screen.queryByRole('switch', { name: 'settings.ghosts.enableAria' })).toBeNull();
      expect(screen.queryByRole('switch', { name: `${prefix}.anonymous` })).toBeNull();
    } else {
      await screen.findByRole('heading', { level: 1, name: entry === 'market' ? detail.name : 'Actual installed name' });
      expect(screen.queryByLabelText(`${prefix}.versionFacts`)).toBeNull();
      expect(screen.queryByRole('button', { name: `${prefix}.cancelReview` })).toBeNull();
      expect(screen.queryByRole('switch', { name: `${prefix}.anonymous` })).toBeNull();
      if (entry !== 'market') expect(screen.getByRole('switch', { name: 'settings.ghosts.enableAria' }).getAttribute('aria-checked')).toBe('true');
      if (entry === 'installed-market' || entry === 'market') expect(screen.queryByRole('button', { name: `${prefix}.submitUpdate` })).toBeNull();
    }
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(api.prepare).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled();
    expect(api.setAnonymity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: entry === 'author-list' ? `${prefix}.myPlugins` : 'settings.ghosts.detail.backToList' }));
    if (entry === 'author-list') await screen.findByRole('heading', { name: `${prefix}.myPlugins` });
    else await screen.findByRole('heading', { level: 1, name: 'settings.ghosts.title' });
  });
  it('honors an explicit installed deep link while leaving the author detail', async () => {
    auth.mode = 'cloud';
    const installed: InstalledGhost = { manifest: { ...detail.manifest, name: 'Actual installed name', version: '1.2.0' },
      dir: path.resolve('brain', '_ns', '_root', detail.ghostId), instanceKey: '_root__navigation-plugin', namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, enabled: true,
      approval: { state: 'approved', revision: 'revision' } };
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    const api = authorApi(); Object.assign(window.electronAPI, { pluginContributions: api });
    function NavigateInstalled() {
      const navigate = useNavigate();
      return <button onClick={() => navigate(`/plugins?ghost=${installed.instanceKey}`)}>Installed deep link</button>;
    }
    render(<MemoryRouter initialEntries={[`/plugins?myPlugins=1&contribution=${detail.pluginId}`]}>
      <NavigateInstalled /><GhostPluginPage />
    </MemoryRouter>);
    await screen.findByLabelText(`${prefix}.versionFacts`);
    fireEvent.click(screen.getByRole('button', { name: 'Installed deep link' }));
    await screen.findByRole('heading', { level: 1, name: 'Actual installed name' });
    expect(screen.queryByLabelText(`${prefix}.versionFacts`)).toBeNull();
    expect(api.prepare).not.toHaveBeenCalled();
  });
  it('does not guess first publication or prepare a package when author association cannot be read', async () => {
    auth.mode = 'cloud';
    const installed: InstalledGhost = { manifest: { ...detail.manifest, name: 'Unknown author association' },
      dir: path.resolve('brain', '_ns', '_root', detail.ghostId), instanceKey: '_root__navigation-plugin',
      namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, enabled: true, approval: { state: 'approved', revision: 'revision' } };
    window.electronAPI.ghosts.listSync = () => ({ ghosts: [installed] });
    window.electronAPI.pluginMarket.snapshot = async () => ({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
    const api = authorApi(null); api.list.mockRejectedValue(new Error('Offline'));
    Object.assign(window.electronAPI, { pluginContributions: api });
    render(page(`/plugins?ghost=${installed.instanceKey}`));
    expect(api.list).not.toHaveBeenCalled();
    const picker = await openLocalPublishing();
    await within(picker).findAllByText(`${prefix}.loadFailed`);
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });
  it('keeps a remote author detail usable without selecting a same-name local plugin', async () => {
    auth.mode = 'cloud';
    const api = authorApi(null); Object.assign(window.electronAPI, { pluginContributions: api });
    render(page(`/plugins?myPlugins=1&contribution=${detail.pluginId}`));
    const facts = await screen.findByLabelText(`${prefix}.versionFacts`);
    expect(within(facts).getByText(`${prefix}.localState.missing`)).toBeTruthy();
    expect(screen.getByRole('button', { name: `${prefix}.installPublished` })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'settings.ghosts.enableAria' })).toBeNull();
    expect(screen.queryByRole('button', { name: `${prefix}.submitUpdate` })).toBeNull();
    expect(api.prepare).not.toHaveBeenCalled();
  });
  it('keeps an ordinary market viewer outside author management', async () => {
    auth.mode = 'cloud';
    const api = authorApi(null); api.detail.mockRejectedValue(new Error('PERMISSION_DENIED'));
    Object.assign(window.electronAPI, { pluginContributions: api });
    render(page(`/plugins?market=${detail.pluginId}`));
    await screen.findByRole('heading', { name: detail.name });
    expect(api.detail).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(`${prefix}.versionFacts`)).toBeNull();
    expect(screen.queryByRole('heading', { name: `${prefix}.publishing` })).toBeNull();
    expect(screen.queryByText(`${prefix}.anonymous`)).toBeNull();
    expect(api.prepare).not.toHaveBeenCalled();
  });
});
