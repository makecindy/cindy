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
import { __resetPluginInstallProgressForTest } from '../lib/pluginInstallProgress';
import { pluginCatalogMemory, pluginCatalogOwnerKey, resetPluginCatalogMemoryForTest } from '../lib/pluginCatalogMemory';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { leadingSlashInvocation, loadAllCommands, rewriteAgentSkillInvocationForDispatch } from '@/lib/slashCommands';
import { toast } from '@/lib/toast';
import { getDraft as getWorkspaceDraft, patchDraft, resetDraftWorkspaceTargets } from '@/state/newMakerDraft';

const { auth, translation, pickAndUpdateGhost, catalog, detailRenders, readmeRenders } = vi.hoisted(() => ({
  readmeRenders: vi.fn(),
  detailRenders: vi.fn(),
  catalog: { device: null as { deviceId: string; name: string } | null },
  pickAndUpdateGhost: vi.fn(),
  auth: { user: { membershipKind: 'personal' }, mode: 'local', dataOwnerId: 'navigation-owner', dataOwnerGeneration: 0 },
  translation: {
    t: ((key: string) => key) as (key: string, options?: Record<string, unknown>) => string,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  },
}));

vi.mock('../MarketPluginDetailView', async importOriginal => {
  const original = await importOriginal<typeof import('../MarketPluginDetailView')>();
  return { ...original, MarketPluginDetailView: (props: Parameters<typeof original.MarketPluginDetailView>[0]) => {
    detailRenders();
    return <original.MarketPluginDetailView {...props} />;
  } };
});
vi.mock('../PluginReadmeSection', async importOriginal => {
  const original = await importOriginal<typeof import('../PluginReadmeSection')>();
  return { ...original, PluginReadmeSection: (props: Parameters<typeof original.PluginReadmeSection>[0]) => {
    readmeRenders();
    return <original.PluginReadmeSection {...props} />;
  } };
});

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
  resetPluginCatalogMemoryForTest();
  auth.dataOwnerGeneration += 1;
  detailRenders.mockClear();
  readmeRenders.mockClear();
  catalog.device = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom has no layout. Use a viewport for real virtual ranges, rather than
  // relying on the removed transient fallback cards.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.tagName === 'MAIN' ? 800 : 150; });
  auth.mode = 'local';
  auth.dataOwnerId = 'navigation-owner';
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
      // Market installs bracket a progress ring; these navigation cases push no steps.
      onInstallProgress: () => () => undefined,
      recommendations: async () => [],
      query: async (input: { query?: string; cursor?: string | null }) => {
        const snapshot = await window.electronAPI.pluginMarket.snapshot();
        return { ...snapshot, items: snapshot.items.filter(item => !input.query || item.name.toLowerCase().includes(input.query.toLowerCase())),
          nextCursor: null, counts: { all: snapshot.items.length, public: snapshot.items.length, organization: 0, personal: 0, custom: 0 } };
      },
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
  // Install progress is window-level; an install a case leaves running must not leak into the next.
  act(() => __resetPluginInstallProgressForTest());
  vi.useRealTimers();
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

describe('market action feedback', () => {
  // Unit, #10358: exercise the real page with one delayed detail response.
  // Card-only pending props cannot detect the page confusing viewing with installing.
  async function openCard(compact: boolean) {
    const item = { ...detail, downloadStatistics: { requestCount: '123' } };
    window.electronAPI.pluginMarket.snapshot = async () => ({ items: [item], unavailableReason: null,
      customSourceNames: [], unavailableCustomSourceNames: [] });
    if (compact) window.electronAPI.pluginMarket.recommendations = async () => [item,
      ...[1, 2].map(index => ({ ...item, pluginId: `other-${index}`, ghostId: `other-${index}`, name: `Other ${index}` }))];
    const view = render(page('/plugins'));
    if (!compact) fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    const body = await screen.findByRole('button', { name: detail.name });
    return { ...view, body, card: within(body.closest('article')!) };
  }

  it.each([
    [false, 'body'], [false, 'arrow'], [false, 'downloads'],
    [true, 'body'], [true, 'downloads'],
  ] as const)('opens detail immediately without installation from compact=%s %s', async (compact, entry) => {
    let finish!: (value: PluginMarketDetail) => void;
    loadDetail.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const install = vi.fn();
    Object.assign(window.electronAPI.pluginMarket, { install });
    const { body, card } = await openCard(compact);
    const action = card.getByRole('button', { name: 'settings.ghosts.page.installAria' });
    fireEvent.click(entry === 'body' ? body : entry === 'arrow'
      ? card.getByRole('button', { name: 'settings.ghosts.market.detailsAria' })
      : card.getByRole('group'));
    expect(action.getAttribute('aria-busy')).not.toBe('true');
    expect(action.querySelector('.animate-spinner')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: detail.name })).toBeTruthy();
    const detailAction = screen.getByRole('button', { name: 'settings.ghosts.market.install' });
    expect((detailAction as HTMLButtonElement).disabled).toBe(true);
    expect(detailAction.querySelector('.animate-spinner')).toBeNull();
    fireEvent.click(detailAction);
    expect(loadDetail).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    await act(async () => { finish(detail); });
    await screen.findByRole('heading', { level: 1, name: detail.name });
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.backToList' }));
    expect((await screen.findByRole('button', { name: detail.name }) as HTMLButtonElement).disabled).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  // The ring replaces the install button from the click through detail and install; after a
  // failure it stays with the reason and the button returns as a retry.
  it.each([false, true])('keeps install progress across detail and install and offers a retry with compact=%s', async compact => {
    let finishDetail!: (value: PluginMarketDetail) => void;
    let failInstall!: (error: Error) => void;
    loadDetail.mockImplementationOnce(() => new Promise(resolve => { finishDetail = resolve; }));
    const install = vi.fn(() => new Promise((_resolve, reject) => { failInstall = reject; }));
    Object.assign(window.electronAPI.pluginMarket, { install });
    vi.spyOn(toast, 'error').mockReturnValue('install-error');
    const { body, card } = await openCard(compact);
    const action = card.getByRole('button', { name: 'settings.ghosts.page.installAria' });
    fireEvent.click(action);
    const ring = () => card.getByRole('progressbar', { name: 'settings.ghosts.page.installAria' });
    expect(ring().textContent).toBe('downloadProgress.phase.preparing');
    expect(action.getAttribute('aria-hidden')).toBe('true');
    expect(card.queryByRole('status')).toBeNull();
    expect(install).not.toHaveBeenCalled();
    await act(async () => { finishDetail(detail); });
    expect(install).toHaveBeenCalledTimes(1);
    expect(ring().textContent).toBe('downloadProgress.phase.preparing');
    fireEvent.click(body);
    fireEvent.click(action);
    expect(loadDetail).toHaveBeenCalledTimes(1);
    await act(async () => { failInstall(new Error('Installation failed')); });
    expect(ring().textContent).toBe('settings.ghosts.installProgress.installFailed');
    // The install button gives way to a square retry icon button with the same accessible name.
    const retry = card.getByRole('button', { name: 'settings.ghosts.page.installAria' });
    expect(retry.textContent).toBe('');
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows failed detail in the page and allows a fresh explicit install after returning', async () => {
    let fail!: (error: Error) => void;
    loadDetail.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const error = vi.spyOn(toast, 'error').mockReturnValue('detail-error');
    const { body } = await openCard(false);
    fireEvent.click(body);
    expect(screen.getByRole('heading', { level: 1, name: detail.name })).toBeTruthy();
    await act(async () => { fail(new Error('Details unavailable')); });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.backToList' }));
    const action = screen.getByRole('button', { name: 'settings.ghosts.page.installAria' });
    expect((action as HTMLButtonElement).disabled).toBe(false);
    loadDetail.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    fireEvent.click(action);
    expect(action.getAttribute('aria-busy')).toBe('true');
    await act(async () => { fail(new Error('Details unavailable')); });
    // The failed card offers a fresh attempt through its retry button (same accessible name).
    const retry = screen.getByRole('button', { name: 'settings.ghosts.page.installAria' });
    expect(retry.getAttribute('aria-busy')).not.toBe('true');
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['owner', 'mode'] as const)('retires detail feedback on %s change without clearing a newer install', async change => {
    let finishOld!: (value: PluginMarketDetail) => void;
    let failNew!: (error: Error) => void;
    loadDetail.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const install = vi.fn();
    Object.assign(window.electronAPI.pluginMarket, { install });
    vi.spyOn(toast, 'error').mockReturnValue('detail-error');
    const { body, rerender } = await openCard(false);
    fireEvent.click(body);
    expect(screen.getByRole('heading', { level: 1, name: detail.name })).toBeTruthy();
    if (change === 'owner') auth.dataOwnerId = 'another-owner';
    else auth.mode = 'cloud';
    rerender(page('/plugins'));
    expect(screen.queryByRole('heading', { level: 1, name: detail.name })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    loadDetail.mockImplementationOnce(() => new Promise((_resolve, reject) => { failNew = reject; }));
    const action = await screen.findByRole('button', { name: 'settings.ghosts.page.installAria' });
    fireEvent.click(action);
    expect(action.getAttribute('aria-busy')).toBe('true');
    await act(async () => { finishOld(detail); });
    expect(screen.queryByRole('heading', { level: 1, name: detail.name })).toBeNull();
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(install).not.toHaveBeenCalled();
    await act(async () => { failNew(new Error('Details unavailable')); });
    const retry = screen.getByRole('button', { name: 'settings.ghosts.page.installAria' });
    expect(retry.getAttribute('aria-busy')).not.toBe('true');
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });
});

// Unit: route unmount used to discard all catalog view state. Only IPC is
// stubbed; the same page mounts again with its real catalog and search controls.
// Unit / Codex 4584198380: Settings can remount the local Plugins pane
// underneath Skills. Cached installed-tab prewarming and hidden revisions must
// not query the catalog; activation resumes the existing page/count readers.
it('defers local catalog prewarming and hidden revisions until activation', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  vi.useFakeTimers();
  const query = vi.fn(window.electronAPI.pluginMarket.query);
  window.electronAPI.pluginMarket.query = query;
  const view = (active: boolean) => <MemoryRouter initialEntries={['/plugins']}><GhostPluginPage active={active} /></MemoryRouter>;
  const warm = render(view(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(query.mock.calls.some(([input]) => input.counts)).toBe(true);
  const memory = pluginCatalogMemory(pluginCatalogOwnerKey('local', auth.dataOwnerId, auth.dataOwnerGeneration, 'en'), 'local');
  const pages = memory.browser.current.pages;
  warm.unmount();
  query.mockClear();
  clock.mockReturnValue(131_000);
  const mounted = render(view(false));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(query).not.toHaveBeenCalled();
  memory.catalogRevision += 1;
  mounted.rerender(view(false));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(query).not.toHaveBeenCalled();
  expect(memory.browser.current.pages).toBe(pages);
  mounted.rerender(view(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(query.mock.calls.filter(([input]) => !input.counts)).toHaveLength(1);
  expect(query.mock.calls.filter(([input]) => input.counts)).toHaveLength(1);
  fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
  expect(screen.getByRole('button', { name: detail.name })).toBeTruthy();
});

it('restores tab, search, source and scroll together after leaving the plugin route', async () => {
  const mounted = render(page('/plugins'));
  fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
  await screen.findByRole('button', { name: detail.name });
  const search = screen.getByRole('textbox');
  fireEvent.change(search, { target: { value: 'Navigation' } });
  fireEvent.click(screen.getByRole('radio', { name: /settings.ghosts.page.origin.public/ }));
  await screen.findByRole('button', { name: detail.name });
  fireEvent.scroll(screen.getByRole('main'), { target: { scrollTop: 640 } });
  mounted.unmount();
  render(page('/plugins'));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Navigation');
  expect(screen.getByRole('radio', { name: /settings.ghosts.page.origin.public/ }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('main').scrollTop).toBe(640);
  expect(screen.getByRole('button', { name: detail.name })).toBeTruthy();
});

// Unit: the new recommendation pool must survive tab/search/detail navigation;
// existing tests covered installs but did not exercise a fixed three-card pool.
it.each(['few', 'failed'] as const)('hides today recommendations on %s while keeping the market reachable', async state => {
  const recommendations = vi.fn(async () => {
    if (state === 'failed') throw new Error('unavailable');
    return [detail, { ...detail, pluginId: 'second', ghostId: 'second' }];
  });
  window.electronAPI.pluginMarket.recommendations = recommendations;
  render(page('/plugins'));
  const tab = await screen.findByRole('tab', { name: /settings.ghosts.page.marketSection/ });
  await waitFor(() => expect(recommendations).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('settings.ghosts.page.todayRecommendations')).toBeNull();
  fireEvent.click(tab);
  expect(await screen.findByRole('button', { name: detail.name })).toBeTruthy();
});

it('fills installed recommendation slots from the original pool and hides the incomplete remainder', async () => {
  const pool = Array.from({ length: 5 }, (_, index): PluginMarketDetail => ({ ...detail, pluginId: `pool-${index}`,
    ghostId: `pool-${index}`, name: `Pool ${index}`, publisherKind: 'official', namespace: null,
    manifest: { ...detail.manifest, id: `pool-${index}`, name: `Pool ${index}` } }));
  let installed: InstalledGhost[] = [];
  const changed = new Set<Parameters<typeof window.electronAPI.ghosts.onChanged>[0]>();
  window.electronAPI.ghosts.listSync = () => ({ ghosts: installed });
  window.electronAPI.ghosts.onChanged = callback => { changed.add(callback); return () => { changed.delete(callback); }; };
  const recommendations = vi.fn(async () => pool);
  window.electronAPI.pluginMarket.recommendations = recommendations;
  window.electronAPI.pluginMarket.snapshot = async () => ({ items: pool.map(item => installed.some(ghost => ghost.manifest.id === item.ghostId)
    ? { ...item, installState: 'installed', enabled: true } : item), unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
  loadDetail.mockImplementation(async (id?: string) => pool.find(item => item.pluginId === id)!);
  Object.assign(window.electronAPI.pluginMarket, { install: vi.fn(async (id: string) => {
    const item = pool.find(item => item.pluginId === id)!;
    const ghost: InstalledGhost = { manifest: item.manifest, namespace: null, dir: `/plugins/${id}`, enabled: true,
      approval: { state: 'approved', revision: `approval-${id}` } };
    installed = [...installed, ghost];
    changed.forEach(callback => callback({ ghosts: installed }));
    return { ghost };
  }) });
  render(page('/plugins'));
  await screen.findByText('settings.ghosts.page.todayRecommendations');
  for (let index = 0; index < 3; index++) {
    const section = screen.getByText('settings.ghosts.page.todayRecommendations').closest('section')!;
    expect(within(section).getAllByRole('button', { name: 'settings.ghosts.page.installAria' })).toHaveLength(3);
    fireEvent.click(within(section).getAllByRole('button', { name: 'settings.ghosts.page.installAria' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.ghosts.detail.backToList' }));
    if (index < 2) await waitFor(() => expect(within(screen.getByText('settings.ghosts.page.todayRecommendations').closest('section')!)
      .getByRole('button', { name: `Pool ${index + 3}` })).toBeTruthy());
  }
  await waitFor(() => expect(screen.queryByText('settings.ghosts.page.todayRecommendations')).toBeNull());
  expect(recommendations).toHaveBeenCalledTimes(1);
});

it('searches globally and returns to the original market tab without rerolling recommendations', async () => {
  const pool = [0, 1, 2].map(index => ({ ...detail, pluginId: `today-${index}`, ghostId: `today-${index}`, name: `Today ${index}` }));
  const recommendations = vi.fn(async () => pool);
  window.electronAPI.pluginMarket.recommendations = recommendations;
  render(page('/plugins'));
  fireEvent.click(await screen.findByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Navigation' } });
  expect(screen.queryByRole('tab', { name: /settings.ghosts.page.marketSection/ })).toBeNull();
  expect(screen.queryByText('settings.ghosts.page.todayRecommendations')).toBeNull();
  await screen.findByRole('button', { name: detail.name });
  fireEvent.change(input, { target: { value: '' } });
  expect(await screen.findByRole('tab', { name: /settings.ghosts.page.marketSection/, selected: true })).toBeTruthy();
  expect(recommendations).toHaveBeenCalledTimes(1);
});

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
  fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
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

// Unit: another window's project toggle must update the real detail switch
// without a global installed-list broadcast or another synchronous policy read.
it('updates the selected project from a scoped push without refreshing unrelated projects', async () => {
  const installed: InstalledGhost = {
    manifest: { ...detail.manifest, name: 'Scoped Plugin' },
    dir: path.join('plugins', detail.ghostId), enabled: true,
    approval: { state: 'approved', revision: 'scoped-revision' },
  };
  let push!: (policy: { workdirKey: string; disabled: string[] }) => void;
  const workdirPrefsSync = vi.fn(() => ({ disabled: [], workdirKey: '/fixture/Cindy' }));
  Object.assign(window.electronAPI, { showOpenDirectoryDialog: async () => ({ canceled: false, path: '/fixture/Cindy/' }) });
  Object.assign(window.electronAPI.ghosts, {
    listSync: () => ({ ghosts: [installed] }), workdirPrefsSync,
    onWorkdirPrefsChanged: (callback: typeof push) => { push = callback; return () => {}; },
  });
  render(page('/plugins'));
  fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }), { key: 'ArrowDown' });
  fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.ariaLabel' }), { key: 'ArrowRight' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.browse' }));
  await screen.findByText('settings.ghosts.projectBanner.desc');
  fireEvent.click(await screen.findByText('Scoped Plugin'));
  const control = await screen.findByRole('switch', { name: 'settings.ghosts.enableAria' });
  expect(control.getAttribute('aria-checked')).toBe('true');
  act(() => push({ workdirKey: '/other', disabled: [detail.ghostId] }));
  expect(control.getAttribute('aria-checked')).toBe('true');
  act(() => push({ workdirKey: '/fixture/Cindy', disabled: [detail.ghostId] }));
  expect(control.getAttribute('aria-checked')).toBe('false');
  expect(workdirPrefsSync).toHaveBeenCalledOnce();
});

async function openFromCatalog() {
  fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
  const plugin = await screen.findByText(detail.name);
  const catalog = screen.getByRole('main');
  fireEvent.scroll(catalog, { target: { scrollTop: 640 } });
  fireEvent.click(plugin);
  await screen.findByRole('button', { name: 'settings.ghosts.detail.backToList' });
  expect(catalog.isConnected).toBe(false);
}

describe('plugin page return navigation', () => {
  // Unit / audit-2 N2: the real empty installed search action must leave the
  // query view. Existing tab tests never activated this empty-search entry.
  it('clears the empty search when browsing the plugin market', async () => {
    render(page('/plugins'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zz-no-ux-plugin' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.browseMarket' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('button', { name: detail.name })).toBeTruthy();
  });

  // Unit / UX-06: real card -> detail -> back/Escape must preserve keyboard
  // position, not just scroll. Previous navigation cases never checked focus.
  it.each([['market', 'back'], ['market', 'escape'], ['installed', 'back'], ['installed', 'escape']] as const)(
    'restores the originating %s card focus after %s', async (kind, method) => {
      const name = kind === 'market' ? detail.name : 'Focus Installed';
      if (kind === 'installed') {
        window.electronAPI.ghosts.listSync = () => ({ ghosts: [{ manifest: { ...detail.manifest, name },
          dir: '/plugins/navigation-plugin', enabled: true, approval: { state: 'approved', revision: 'focus' } }] });
        window.electronAPI.pluginMarket.snapshot = async () => ({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
      }
      render(page('/plugins'));
      if (kind === 'market') fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
      const card = await screen.findByRole('button', { name });
      card.focus(); fireEvent.click(card);
      const back = await screen.findByRole('button', { name: 'settings.ghosts.detail.backToList' });
      if (method === 'back') fireEvent.click(back);
      else fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      const returned = await screen.findByRole('button', { name });
      expect(document.activeElement).toBe(returned);
    },
  );

  // Unit / UX-04: installing opens configuration before the follow-up snapshot.
  // Hold that read to verify all previously known header identity stays visible.
  it('keeps the verified market header when first installation opens before its snapshot', async () => {
    vi.spyOn(translation, 't').mockImplementation((key, options) =>
      key === 'settings.ghosts.detail.byAuthor' || key === 'settings.ghosts.usage.downloadsValue'
        ? `${key} ${Object.values(options ?? {}).join(' ')}` : key);
    const official = { ...detail, namespace: null, publisherKind: 'official' as const, downloadStatistics: { requestCount: '42' } };
    let ghosts: InstalledGhost[] = [];
    let installed = false;
    const changed = new Set<Parameters<typeof window.electronAPI.ghosts.onChanged>[0]>();
    window.electronAPI.ghosts.listSync = () => ({ ghosts });
    window.electronAPI.ghosts.onChanged = callback => { changed.add(callback); return () => { changed.delete(callback); }; };
    window.electronAPI.pluginMarket.snapshot = () => installed ? new Promise(() => {}) : Promise.resolve({
      items: [official], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
    loadDetail.mockResolvedValue(official);
    Object.assign(window.electronAPI.pluginMarket, { install: vi.fn(async () => {
      // Real Main receipt can precede its hydrated namespace/source projection.
      const ghost: InstalledGhost = { manifest: detail.manifest, instanceKey: '_root__navigation-plugin', dir: '/plugins/_ns/_root/navigation-plugin', enabled: true,
        publishingSource: { kind: 'unavailable' }, approval: { state: 'approved', revision: 'installed' } };
      installed = true; ghosts = [{ ...ghost, namespace: null, namespaceState: 'confirmed' }];
      changed.forEach(callback => callback({ ghosts })); return { ghost };
    }) });
    render(page('/plugins'));
    await openFromCatalog();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', false));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.market.install' })); });
    const heading = await screen.findByRole('heading', { level: 1, name: detail.name });
    const header = heading.closest('header')!;
    expect(header.textContent).toContain('Cindy');
    expect(header.textContent).toContain('42');
    expect(header.textContent).toContain('settings.ghosts.market.publisherKind.official');
    // Audit-2 R4: author/statistics do not cover the separately confirmed source
    // line. Keep its layout slot without claiming a source before confirmation.
    expect(header.textContent).not.toContain('settings.ghosts.detail.publicInstall');
    const lines = header.querySelectorAll('p').length;
    await act(async () => {
      ghosts = ghosts.map(ghost => ({ ...ghost, namespaceState: 'confirmed' as const, publishingSource: { kind: 'public-market' as const, pluginId: detail.pluginId } }));
      changed.forEach(callback => callback({ ghosts }));
    });
    expect(header.textContent).toContain('settings.ghosts.detail.publicInstall');
    expect(header.querySelectorAll('p').length).toBe(lines);
  });

  // Unit / review N1: the V2 freshness cases stayed in one detail. A same-page
  // publishing route keeps this component mounted, so an old install waiter
  // must be cancelled there too, including a return/remount before it settles.
  it.each(['publishing', 'publishing-return', 'back', 'unmount-remount'] as const)('cancels an installation waiting for detail after %s', async target => {
    auth.mode = 'cloud';
    Object.assign(window.electronAPI, { pluginContributions: { discard: vi.fn(), prepare: vi.fn(),
      list: vi.fn().mockResolvedValue({ plugins: [], nextCursor: null, queriedAt: detail.publishedAt }) } });
    function Navigation() {
      const navigate = useNavigate();
      return <>
        <button onClick={() => navigate('/plugins?myPlugins=1')}>Open publishing route</button>
        <button onClick={() => navigate('/plugins')}>Return to catalog route</button>
      </>;
    }
    const view = () => <MemoryRouter initialEntries={['/plugins']}><Navigation /><GhostPluginPage /></MemoryRouter>;
    let mounted = render(view());
    await openFromCatalog();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', false));
    vi.useFakeTimers();
    let finish!: (value: PluginMarketDetail) => void;
    loadDetail.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const install = vi.fn(() => new Promise(() => {}));
    Object.assign(window.electronAPI.pluginMarket, { install });
    await act(async () => { vi.advanceTimersByTime(31_000); fireEvent.focus(window); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.market.install' })); });
    expect(install).not.toHaveBeenCalled();
    vi.useRealTimers();
    if (target.startsWith('publishing')) {
      fireEvent.click(screen.getByRole('button', { name: 'Open publishing route' }));
      expect(screen.getByRole('heading', { name: 'settings.ghosts.contribution.myPlugins' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: detail.name })).toBeNull();
      if (target === 'publishing-return') fireEvent.click(screen.getByRole('button', { name: 'Return to catalog route' }));
    } else if (target === 'back') {
      fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.backToList' }));
    } else {
      mounted.unmount();
      mounted = render(view());
    }
    if (target !== 'publishing') await openFromCatalog();
    const fresh = { ...detail, releaseId: 'after-cancellation-v2', manifest: { ...detail.manifest, version: '2.0.0' } };
    loadDetail.mockResolvedValue(fresh);
    await act(async () => { finish(fresh); });
    expect(install).not.toHaveBeenCalled();
    if (target === 'publishing') {
      expect(screen.getByRole('heading', { name: 'settings.ghosts.contribution.myPlugins' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: detail.name })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Return to catalog route' }));
      await openFromCatalog();
    }
    const button = screen.getByRole('button', { name: 'settings.ghosts.market.install' });
    expect(button).toHaveProperty('disabled', false);
    await act(async () => { fireEvent.click(button); });
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(detail.pluginId, expect.objectContaining({ expectedReleaseId: fresh.releaseId, expectedManifest: fresh.manifest }));
  });

  // Unit / Codex C1: the foreground path requests preserveOnError. Even after
  // the reader accepts partial data, this caller must publish successful custom
  // metadata while retaining the official cards and bounded outage behavior.
  it('publishes partial custom-source refreshes during an official outage', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const snapshots = vi.fn().mockResolvedValue({ items: [detail], unavailableReason: null,
      customSourceNames: [], unavailableCustomSourceNames: [] });
    window.electronAPI.pluginMarket.snapshot = snapshots;
    render(page('/plugins'));
    const memory = pluginCatalogMemory(pluginCatalogOwnerKey('local', auth.dataOwnerId, auth.dataOwnerGeneration, 'en'), 'local');
    await waitFor(() => expect(memory.snapshot?.items).toHaveLength(1));
    const custom = { ...detail, pluginId: 'custom-updated', ghostId: 'custom-updated', sourceType: 'local-market' as const,
      sourceMarketName: 'working', version: '2.0.0' };
    snapshots.mockResolvedValue({ items: [custom], unavailableReason: 'official offline',
      customSourceNames: ['working'], unavailableCustomSourceNames: [] });
    clock.mockReturnValue(32_000);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(memory.snapshot?.customSourceNames).toEqual(['working']));
    expect(memory.snapshot?.items.map(item => item.pluginId)).toEqual([detail.pluginId, custom.pluginId]);
    expect(memory.snapshot?.unavailableReason).toBe('official offline');
  });

  // Unit / Codex C1 (approved convergence): the retained catalog can miss
  // ghosts:changed while its route is closed. Warm-page tests did not change
  // the installed set off-route. Both directions must re-read within the TTL,
  // retain the usable page while pending, and preserve it on a failed read.
  it.each([
    ['install', 'success'], ['uninstall', 'success'],
    ['install', 'failure'], ['uninstall', 'failure'],
  ] as const)('revalidates a local warm remount after an off-page %s: %s', async (change, outcome) => {
    type Snapshot = Awaited<ReturnType<typeof window.electronAPI.pluginMarket.snapshot>>;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const stable: PluginMarketDetail = { ...detail, pluginId: 'stable-market', ghostId: 'stable-tool', name: 'Stable warm card',
      manifest: { ...detail.manifest, id: 'stable-tool', name: 'Stable warm card' } };
    const ghost: InstalledGhost = { manifest: detail.manifest, dir: '/fixture/installed', namespace: null, enabled: true,
      approval: { state: 'approved', revision: 'remount-test' }, publishingSource: { kind: 'public-market', pluginId: detail.pluginId } };
    let installed = change === 'uninstall';
    const listeners = new Set<Parameters<typeof window.electronAPI.ghosts.onChanged>[0]>();
    window.electronAPI.ghosts.listSync = () => ({ ghosts: installed ? [ghost] : [] });
    window.electronAPI.ghosts.onChanged = listener => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const value = (): Snapshot => ({ items: [{ ...detail, installState: installed ? 'installed' : 'not-installed' }, stable],
      unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
    const snapshots = vi.fn(async () => value());
    window.electronAPI.pluginMarket.snapshot = snapshots;
    window.electronAPI.pluginMarket.query = async () => ({ ...value(), items: installed ? [stable] : [detail, stable],
      nextCursor: null, counts: { all: installed ? 1 : 2, public: installed ? 1 : 2, organization: 0, personal: 0, custom: 0 } });
    const first = render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    await screen.findByText(stable.name);
    const memory = pluginCatalogMemory(pluginCatalogOwnerKey('local', auth.dataOwnerId, auth.dataOwnerGeneration, 'en'), 'local');
    await waitFor(() => expect(memory.localeReady && !memory.snapshotFlight).toBe(true));
    const pages = memory.browser.current.pages;
    first.unmount();
    installed = !installed;
    act(() => listeners.forEach(listener => listener({ ghosts: installed ? [ghost] : [] })));
    clock.mockReturnValue(10_001);
    let finish!: (next: Snapshot) => void, fail!: (error: Error) => void;
    const pending = new Promise<Snapshot>((resolve, reject) => { finish = resolve; fail = reject; });
    snapshots.mockReturnValueOnce(pending);
    const reads = snapshots.mock.calls.length;
    render(page('/plugins'));
    expect(screen.getByText(stable.name)).toBeTruthy();
    expect(memory.browser.current.pages).toBe(pages);
    expect(snapshots).toHaveBeenCalledTimes(reads + 1);
    await act(async () => { if (outcome === 'success') finish(value()); else fail(new Error('temporary snapshot failure')); });
    if (outcome === 'success') {
      await waitFor(() => expect(memory.snapshot?.items.find(item => item.pluginId === detail.pluginId)?.installState)
        .toBe(installed ? 'installed' : 'not-installed'));
      await waitFor(() => expect([...memory.browser.current.pages.values()].flat().some(item => item.pluginId === detail.pluginId)).toBe(!installed));
      const list = screen.getByText(stable.name).closest('section')!;
      await waitFor(() => expect(Boolean(within(list).queryByText(detail.name))).toBe(!installed));
    }
    expect(screen.getByText(stable.name)).toBeTruthy();
    expect(screen.queryByText('ccAgent.common.loading')).toBeNull();
  });

  // Unit / review finding 3: settled partition-switch tests miss a pending old
  // locale. Snapshot success/error and recommendations may only publish to their
  // initiating bucket; the new language still waits for Main's locale sync.
  it.each(['success', 'failure'] as const)('discards the old language snapshot and recommendations: %s', async outcome => {
    type Snapshot = Awaited<ReturnType<typeof window.electronAPI.pluginMarket.snapshot>>;
    let finish!: (value: Snapshot) => void, fail!: (error: Error) => void;
    let finishRecommendations!: (value: PluginMarketDetail[]) => void, failRecommendations!: (error: Error) => void;
    let finishLocale!: () => void;
    const english = new Promise<Snapshot>((resolve, reject) => { finish = resolve; fail = reject; });
    const oldRecommendations = new Promise<PluginMarketDetail[]>((resolve, reject) => { finishRecommendations = resolve; failRecommendations = reject; });
    const localeGate = new Promise<void>(resolve => { finishLocale = resolve; });
    const chinese: Snapshot = { items: [{ ...detail, name: 'Chinese snapshot' }], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] };
    const snapshots = vi.fn().mockReturnValueOnce(english).mockResolvedValue(chinese);
    const recommendations = vi.fn().mockReturnValueOnce(oldRecommendations).mockResolvedValue([{ ...detail, name: 'Chinese recommendation' }]);
    Object.assign(window.electronAPI.pluginMarket, { snapshot: snapshots, recommendations,
      query: async () => ({ ...chinese, items: [], counts: null, nextCursor: null }) });
    window.electronAPI.setApplicationMenuLocale = async locale => {
      if (locale === 'zh-CN') await localeGate;
      return { ok: true };
    };
    const mounted = render(page('/plugins'));
    await waitFor(() => expect(recommendations).toHaveBeenCalledOnce());
    translation.i18n.language = 'zh-CN'; translation.i18n.resolvedLanguage = 'zh-CN';
    mounted.rerender(page('/plugins'));
    const bucket = pluginCatalogMemory(pluginCatalogOwnerKey('local', auth.dataOwnerId, auth.dataOwnerGeneration, 'zh-CN'), 'local');
    const refresh = vi.fn(async () => {});
    bucket.browser.current.refresh = refresh;
    await act(async () => {
      if (outcome === 'success') { finish({ ...chinese, items: [{ ...detail, name: 'Old English snapshot' }] }); finishRecommendations([{ ...detail, name: 'Old English recommendation' }]); }
      else { fail(new Error('old snapshot failed')); failRecommendations(new Error('old recommendations failed')); }
    });
    expect(bucket.snapshot).toBeNull();
    expect(bucket.todayPool).toEqual([]);
    expect(bucket.todayLoaded).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { finishLocale(); });
    await waitFor(() => expect(bucket.snapshot?.items[0]?.name).toBe('Chinese snapshot'));
    expect(bucket.todayPool[0]?.name).toBe('Chinese recommendation');
  });

  // Unit / review finding 1 (R2): existing freshness cases only reopened a cache.
  // A visible V1 plus a pending foreground V2 must never install V1; failure
  // must leave installation blocked while the readable cached detail stays.
  it.each(['success', 'failure', 'access-denied-before-focus'] as const)('waits for the foreground detail before installing: %s', async outcome => {
    render(page('/plugins'));
    await openFromCatalog();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', false));
    vi.useFakeTimers();
    let finish!: (value: PluginMarketDetail) => void;
    let fail!: (error: Error) => void;
    loadDetail.mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const install = vi.fn(() => new Promise(() => {}));
    Object.assign(window.electronAPI.pluginMarket, { install });
    await act(async () => {
      vi.advanceTimersByTime(31_000);
      if (outcome !== 'access-denied-before-focus') fireEvent.focus(window);
    });
    expect(loadDetail).toHaveBeenCalledTimes(outcome === 'access-denied-before-focus' ? 1 : 2);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.market.install' })); });
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: detail.name })).toBeTruthy();
    const fresh = { ...detail, releaseId: 'foreground-v2', version: '2.0.0', manifest: { ...detail.manifest, version: '2.0.0' } };
    await act(async () => {
      if (outcome === 'success') finish(fresh);
      else fail(new Error(outcome === 'failure' ? 'temporary foreground failure' : '[PERMISSION_DENIED] detail revoked'));
    });
    if (outcome === 'success') {
      expect(install).toHaveBeenCalledWith(detail.pluginId, expect.objectContaining({ expectedReleaseId: fresh.releaseId, expectedManifest: fresh.manifest }));
    } else {
      expect(install).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent).toContain(`settings.ghosts.market.errors.${outcome === 'failure' ? 'generic' : 'accessDenied'}`);
      expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', true);
      if (outcome === 'access-denied-before-focus') expect(screen.queryByText('settings.ghosts.perm.grantsTitle')).toBeNull();
    }
    expect(loadDetail).toHaveBeenCalledTimes(2);
  });

  // Integration: both caches must leave the same owner/language partition. A
  // mounted page with a warm detail and saved query detects mismatched keys.
  it.each(['generation', 'language'] as const)('invalidates catalog state and warm details together when %s changes', async boundary => {
    const mounted = render(page('/plugins'));
    await openFromCatalog();
    await screen.findByRole('button', { name: 'settings.ghosts.market.install' });
    expect(loadDetail).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.backToList' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Navigation' } });
    if (boundary === 'generation') auth.dataOwnerGeneration += 1;
    else { translation.i18n.language = 'ja'; translation.i18n.resolvedLanguage = 'ja'; }
    mounted.rerender(page('/plugins'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('tab', { name: /settings.ghosts.page.installedSection/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    fireEvent.click(await screen.findByRole('button', { name: detail.name }));
    await waitFor(() => expect(loadDetail).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: 'settings.ghosts.market.install' });
  });

  // Unit: pointer/focus prefetch uses real card events; a fast pass must not
  // create network work, and an equal background response must not render detail.
  it('prefetches only a sustained hover, opens warm details and skips unchanged background renders', async () => {
    const warm = { ...detail, icon: { mimeType: 'image/png', sha256: 'a'.repeat(64), sizeBytes: 42,
      url: 'https://example.invalid/icon.png?signature=first', expiresAt: '2099-01-01T00:00:00.000Z' } };
    loadDetail.mockResolvedValue(warm);
    render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    const card = await screen.findByRole('button', { name: detail.name });
    vi.useFakeTimers();
    fireEvent.pointerEnter(card.closest('article')!);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.pointerLeave(card.closest('article')!);
    act(() => { vi.advanceTimersByTime(100); });
    expect(loadDetail).not.toHaveBeenCalled();
    fireEvent.focus(card);
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(loadDetail).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(30_001); });
    let finishRefresh!: (value: PluginMarketDetail) => void;
    loadDetail.mockReturnValueOnce(new Promise(resolve => { finishRefresh = resolve; }));
    fireEvent.click(card);
    expect(screen.getByRole('button', { name: 'settings.ghosts.remote.detailLoading' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBeNull();
    const renders = readmeRenders.mock.calls.length;
    await act(async () => { finishRefresh({ ...warm, icon: { ...warm.icon, url: 'https://example.invalid/icon.png?signature=second' } }); });
    expect(readmeRenders).toHaveBeenCalledTimes(renders);
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.backToList' }));
    fireEvent.click(screen.getByRole('button', { name: detail.name }));
    expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', false);
    expect(loadDetail).toHaveBeenCalledTimes(2);
    const beforeForeground = detailRenders.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(30_001);
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(loadDetail).toHaveBeenCalledTimes(3);
    expect(detailRenders).toHaveBeenCalledTimes(beforeForeground);
  });

  it('uses the refreshed release and manifest for installation instead of cached confirmation data', async () => {
    render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    const card = await screen.findByRole('button', { name: detail.name });
    vi.useFakeTimers();
    fireEvent.focus(card);
    await act(async () => { vi.advanceTimersByTime(250); });
    act(() => { vi.advanceTimersByTime(30_001); });
    const fresh: PluginMarketDetail = { ...detail, releaseId: 'fresh-release', version: '2.0.0', manifest: { ...detail.manifest, version: '2.0.0', notify: true } };
    let finish!: (value: PluginMarketDetail) => void;
    loadDetail.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const install = vi.fn().mockResolvedValue({ ghost: { manifest: fresh.manifest, dir: '/plugins/navigation-plugin', enabled: true } });
    Object.assign(window.electronAPI.pluginMarket, { install });
    fireEvent.click(card);
    const button = screen.getByRole('button', { name: 'settings.ghosts.remote.detailLoading' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(install).not.toHaveBeenCalled();
    await act(async () => { finish(fresh); });
    await act(async () => { fireEvent.click(button); });
    expect(install).toHaveBeenCalledWith(detail.pluginId, expect.objectContaining({ expectedReleaseId: fresh.releaseId, expectedManifest: fresh.manifest }));
  });

  it('does not keep a prefetch response after the pointer leaves its card', async () => {
    render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    const card = await screen.findByRole('button', { name: detail.name });
    let finish!: (value: PluginMarketDetail) => void;
    loadDetail.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    vi.useFakeTimers();
    fireEvent.pointerEnter(card.closest('article')!);
    await act(async () => { vi.advanceTimersByTime(250); });
    fireEvent.pointerLeave(card.closest('article')!);
    await act(async () => { finish(detail); });
    fireEvent.click(card);
    expect(loadDetail).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', true);
    await act(async () => { await Promise.resolve(); });
  });

  it('keeps prefetch to one request and suppresses it while the catalog is scrolling', async () => {
    const second = { ...detail, pluginId: 'prefetch-second', name: 'Prefetch Second' };
    window.electronAPI.pluginMarket.snapshot = async () => ({ items: [detail, second],
      unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
    render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    const firstCard = (await screen.findByRole('button', { name: detail.name })).closest('article')!;
    const secondCard = screen.getByRole('button', { name: second.name }).closest('article')!;
    let finish!: (value: PluginMarketDetail) => void;
    loadDetail.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    vi.useFakeTimers();
    fireEvent.pointerEnter(firstCard);
    await act(async () => { vi.advanceTimersByTime(250); });
    fireEvent.pointerLeave(firstCard);
    fireEvent.pointerEnter(secondCard);
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(loadDetail).toHaveBeenCalledOnce();
    await act(async () => { finish(detail); });
    fireEvent.pointerLeave(secondCard);
    fireEvent.pointerEnter(secondCard);
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.scroll(screen.getByRole('main'));
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(loadDetail).toHaveBeenCalledOnce();
  });

  it.each([
    ['[PERMISSION_DENIED] denied', 'accessDenied'],
    ['network failure', 'generic'],
  ])('keeps installation disabled after an unsuccessful fresh detail read: %s', async (message, errorKey) => {
    render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    const card = await screen.findByRole('button', { name: detail.name });
    vi.useFakeTimers();
    fireEvent.focus(card);
    await act(async () => { vi.advanceTimersByTime(250); });
    act(() => { vi.advanceTimersByTime(30_001); });
    loadDetail.mockRejectedValueOnce(new Error(message));
    await act(async () => { fireEvent.click(card); });
    expect(screen.getByRole('alert').textContent).toContain(`settings.ghosts.market.errors.${errorKey}`);
    expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBeNull();
  });
  // Unit / plugin-page-ux-fix: the old selection waited for IPC and held the
  // install lock. Existing navigation cases resolve immediately and miss this
  // timing: one pending detail must show its catalog identity without allowing
  // installation, and cannot overwrite a newer selection after returning.
  it('opens catalog details immediately and discards a previous pending selection', async () => {
    let finishFirst!: (value: PluginMarketDetail) => void;
    const first = new Promise<PluginMarketDetail>(resolve => { finishFirst = resolve; });
    const second = { ...detail, pluginId: 'second-plugin', ghostId: 'second-plugin', name: 'Second Plugin' };
    window.electronAPI.pluginMarket.snapshot = async () => ({ items: [detail, second],
      unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
    loadDetail.mockReturnValueOnce(first).mockResolvedValueOnce(second);
    const install = vi.fn();
    Object.assign(window.electronAPI.pluginMarket, { install });
    render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    fireEvent.click(await screen.findByRole('button', { name: detail.name }));

    const heading = screen.getByRole('heading', { level: 1, name: detail.name });
    expect(screen.getByText(detail.description!)).toBeTruthy();
    expect(screen.getByRole('main').contains(document.activeElement)).toBe(true);
    const pendingAction = screen.getByRole('button', { name: 'settings.ghosts.market.install' });
    expect(pendingAction).toHaveProperty('disabled', true);
    expect(pendingAction.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(pendingAction);
    expect(install).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    const secondCard = await screen.findByRole('button', { name: second.name });
    expect(secondCard).toHaveProperty('disabled', false);
    fireEvent.click(secondCard);
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', false));
    await act(async () => { finishFirst({ ...detail, description: 'Stale response' }); });
    expect(screen.getByRole('heading', { level: 1, name: second.name })).toBeTruthy();
    expect(heading.isConnected).toBe(false);
    expect(screen.queryByText('Stale response')).toBeNull();
  });

  it.each(['[PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE] private detail', 'network failure'])(
    'keeps a readable unavailable detail with retry after %s', async message => {
      let fail!: (error: Error) => void;
      loadDetail.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
      render(page('/plugins'));
      fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
      fireEvent.click(await screen.findByRole('button', { name: detail.name }));
      const heading = screen.getByRole('heading', { level: 1, name: detail.name });
      await act(async () => { fail(new Error(message)); });
      const errorKey = message.startsWith('[') ? 'organizationContextUnavailable' : 'generic';
      expect(screen.getByRole('alert').textContent).toContain(`settings.ghosts.market.errors.${errorKey}`);
      expect(screen.queryByText(message)).toBeNull();
      expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', true);
      fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.remote.retry' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', false));
      expect(screen.getByRole('heading', { level: 1, name: detail.name })).toBe(heading);
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );
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
      // "Updated" holds the button's place briefly (timing covered in pluginInstallProgress.test).
      expect(screen.getByRole('progressbar', { name: detail.name }).textContent).toBe(
        'settings.ghosts.updateAll.statusDone',
      );
      act(() => __resetPluginInstallProgressForTest());
      expect((screen.getByRole('button', {
        name: 'settings.ghosts.market.installed',
      }) as HTMLButtonElement).disabled).toBe(true);
    },
  );

  it.each([
    { state: 'installed', author: 'Published nickname', installedAuthor: undefined, expected: null },
    { state: 'installed', author: null, installedAuthor: undefined, expected: null },
    { state: 'update-available', author: 'New release nickname', installedAuthor: 'Installed release nickname', expected: null },
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
    await within(card).findByText('settings.ghosts.detail.publicInstall');
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
    await within(card).findByText(`settings.ghosts.detail.${kind === 'local' ? 'localDevelopment' : 'publicInstall'}`);
    expect(Boolean(within(card).queryByText('Local package author'))).toBe(kind === 'local');
  });

  it.each([
    { id: 'cindy-art', namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, approval: 'approved', reason: 'reservedId', canPublish: true },
    { id: 'personal-plugin', namespace: 'org', namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, approval: 'approved', reason: 'privatePlugin', canPublish: false },
    { id: 'personal-plugin', namespace: null, namespaceState: 'pending', approval: 'approved', reason: 'identityPending', canPublish: false },
    { id: 'personal-plugin', namespace: null, namespaceState: 'confirmed', publishingSource: { kind: 'local', source: 'manual' }, approval: 'invalid', reason: 'approvalRequired', canPublish: false },
  ])('uses installation facts for publishing without cluttering use details for $id ($reason)', async ({ id, namespace, namespaceState, approval, reason, canPublish }) => {
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
    expect(Boolean(screen.queryByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' }))).toBe(canPublish);
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
      { ...installed, manifest: { ...installed.manifest, id: 'organization-plugin', name: 'Organization Plugin' }, namespace: 'org' },
      { ...installed, manifest: { ...installed.manifest, id: 'unapproved-plugin', name: 'Unapproved Plugin' }, approval: { state: 'legacy-unapproved' } },
      { ...installed, manifest: { ...installed.manifest, id: 'pending-plugin', name: 'Pending Identity Plugin' }, namespaceState: 'pending' },
    ] as InstalledGhost[];
    const sameNameLocal = { ...installed, manifest: { ...installed.manifest, id: 'cindy-art', name: 'Same-name Local Plugin' },
      dir: '/tmp/brain/cindy-art', namespace: 'local' } as InstalledGhost;
    const ghosts = [...unavailable.map((ghost) => ({ ...ghost, dir: path.join(path.dirname(installed.dir), ghost.manifest.id) })), installed, sameNameLocal];
    window.electronAPI.ghosts.listSync = () => ({ ghosts });
    const api = { list: vi.fn().mockResolvedValue({ plugins: [], nextCursor: null, queriedAt: '2026-10-15T00:00:00Z' }), transfers: vi.fn().mockResolvedValue([]), prepare: vi.fn().mockResolvedValue({ preparedId: 'preview', instanceId: 'local-author-plugin', version: '1.0.0', releaseNotes: 'Initial release', preflight: { blockers: [], actions: { canSubmit: true } } }), discard: vi.fn().mockResolvedValue(undefined), submit: vi.fn() };
    Object.assign(window.electronAPI, { pluginContributions: api });
    render(page('/plugins?myPlugins=1'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' }));
    const picker = screen.getByRole('dialog');
    expect(within(picker).getAllByRole('button')).toHaveLength(3); // Two installations and Close; select before submitting.
    expect(within(picker).getByRole('button', { name: 'Same-name Local Plugin · 1.0.0 · cindy-art' })).toBeTruthy();
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

  it('shows no publishable installations instead of no installations when only a builtin plugin is installed', async () => {
    auth.mode = 'cloud';
    const installed: InstalledGhost = {
      manifest: { ...detail.manifest, id: 'cindy-art', name: 'Art' },
      builtin: true,
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
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
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
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    expect(await screen.findByText('Navigation Plugin')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.market.errors.namespaceClientRequired')).toBeTruthy();
  });

  it('keeps the catalog notice when nothing is installable', async () => {
    marketSnapshot('PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE', []);
    render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    expect(
      await screen.findByText('settings.ghosts.market.errors.organizationContextUnavailable'),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ })).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.page.emptyFiltered')).toBeNull();
  });

  it('uses the generic hint for an unknown organization access code', async () => {
    marketSnapshot('PLUGIN_FUTURE_REASON');
    render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
    expect(await screen.findByText('settings.ghosts.market.errors.organizationUnavailable')).toBeTruthy();
    expect(screen.getByText('Navigation Plugin')).toBeTruthy();
  });

  it('does not show an organization access hint when the catalog is complete', async () => {
    render(page('/plugins'));
    fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
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

// Unit / round-5: source selection must not pull a still-visible secondary bar
// to the viewport edge; only a bar already scrolled past starts the new list.
it.each([[120, 50], [-50, 0]])('keeps the source switch viewport appropriate at marker top %s', async (top, expected) => {
  render(page('/plugins'));
  fireEvent.click(screen.getByRole('tab', { name: /settings.ghosts.page.marketSection/ }));
  await screen.findByRole('button', { name: detail.name });
  const radio = screen.getByRole('radio', { name: /settings.ghosts.page.origin.public/ });
  const sticky = radio.closest('[role="radiogroup"]')!.parentElement!.parentElement!;
  const marker = sticky.previousElementSibling!;
  const root = screen.getByRole('main');
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 800));
  vi.spyOn(marker, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 800, 0));
  root.scrollTop = 50;
  fireEvent.click(radio);
  expect(root.scrollTop).toBe(expected);
});
