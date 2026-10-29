/** @vitest-environment jsdom */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginReviewUpdate,
  PreparedPluginContribution,
  MyPluginDetailView,
  ContributionReleaseView,
  PluginContributionsApi,
} from '../../../../shared/pluginContributions';
import type { PluginMarketDetail } from '../../../../shared/pluginMarket';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';
import { MyPluginsPage, type MyPluginsPageCache, type PluginSubmitOptions } from '../MyPluginsPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args?.version ? `${key} ${args.version}` : args?.value !== undefined ? `${key} ${args.value}` : key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));
const confirmation = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => confirmation }));
const auth = vi.hoisted(() => ({ owner: 'A', generation: 1, membershipKind: 'personal' }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    dataOwnerId: `owner-${auth.owner}`,
    dataOwnerGeneration: auth.generation,
    user: { id: `member-${auth.owner}`, membershipKind: auth.membershipKind },
    mode: 'cloud',
  }),
}));
vi.mock('@/components/sidebar/AccountSwitcherDialog', () => ({
  AccountSwitcherDialog: () => null,
}));
vi.mock('@/hooks/useSignInToCindy', () => ({ useSignInToCindy: () => vi.fn() }));
vi.mock('@/hooks/useMacFullscreen', () => ({ useMacFullscreen: () => ({ isMac: false }) }));

const reviews = vi.hoisted(() => ({ updates: [] as PluginReviewUpdate[], refresh: vi.fn(), markRead: vi.fn() }));
vi.mock('@/contexts/PluginReviewUpdatesContext', () => ({ usePluginReviewUpdates: () => reviews }));
const prefix = 'settings.ghosts.contribution';
const at = '2026-10-15T00:00:00.000Z';
const detail: MyPluginDetailView = {
  plugin: {
    pluginId: 'plugin-1',
    name: 'My Plugin',
    iconUrl: null,
    updatedAt: at,
    market: { state: 'available', version: '1.0.0', releaseId: 'old-release', reason: null },
    latestSubmission: {
      releaseId: 'new-release',
      version: '2.0.0',
      sha256: 'a'.repeat(64),
      revision: at,
      revisionState: 'current',
      submissionId: 'submission-1',
      reviewStatus: 'rejected',
      submittedAt: at,
      reviewedAt: at,
      reason: 'Full reason, line one\nFull reason, line two',
      source: 'manual',
      content: {
        name: 'My Plugin',
        description: 'Plugin description',
        iconUrl: null,
        permissions: [],
        manifestView: { releaseNotes: 'New version changes' },
      },
    },
    actions: { submitUpdate: true, viewMarket: true },
    localInstanceId: 'exact-instance',
    localVersion: '1.2.0',
    localInstallation: { state: 'installed', instanceId: 'exact-instance', version: '1.2.0', origin: 'local', enabled: true },
  },
  history: ['submitted', 'approved', 'disabled'].map((type, index) => ({
    eventId: `event-${index}`,
    type: type as 'submitted' | 'approved' | 'disabled',
    at,
    releaseId: 'old-release',
    version: '1.0.0',
    submissionId: null,
    reason: null,
    revision: { releaseId: 'old-release', sha256: 'b'.repeat(64), displayUpdatedAt: at },
  })),
  nextCursor: null,
  queriedAt: at,
};
function packagePreview(instanceId: string, version = '1.0.0'): PreparedPluginContribution {
  return { preparedId: 'chosen-snapshot', instanceId, pluginId: null, ghostId: 'demo',
    name: 'Local Plugin', description: 'Actual selected package', version,
    sha256: 'a'.repeat(64), sizeBytes: 100, expiresAt: '2099-01-01T00:00:00Z',
    preflight: { subject: { authority: 'https://issuer.test', membershipId: 'member-A' },
      queriedAt: at, policyVersion: 2, target: { pluginId: null, ghostId: 'demo', version, expectedRelease: null },
      pendingRelease: null, blockers: [], actions: { canSubmit: true } } };
}
function reader(): PluginContributionsApi {
  return {
    reviewUpdates: vi.fn().mockResolvedValue([]),
    markReviewRead: vi.fn(),
    prepare: vi.fn(async (instanceId: string) => packagePreview(instanceId, '1.2.0')),
    submit: vi.fn(),
    cancel: vi.fn(),
    cancelReview: vi.fn(),
    discard: vi.fn().mockResolvedValue(undefined),
    status: vi.fn(),
    submission: vi.fn(),
    releases: vi.fn().mockResolvedValue({ releases: [], nextCursor: null, queriedAt: at }),
    setAnonymity: vi.fn(),
    detail: vi.fn().mockResolvedValue(detail),
    list: vi.fn().mockResolvedValue({ plugins: [detail.plugin], nextCursor: null, queriedAt: at }),
  };
}
function view(
  api: PluginContributionsApi,
  selected = true,
  cache: MyPluginsPageCache = {},
  localPlugins: GhostPluginListItem[] = [{ id: 'exact-instance', name: 'Local Plugin', version: '1.2.0' } as GhostPluginListItem],
  onSubmitUpdate = vi.fn().mockResolvedValue(false),
  installedPluginCount = localPlugins.length,
) {
  return render(
    <StrictMode>
      <MemoryRouter
        initialEntries={[`/plugins?myPlugins=1${selected ? '&contribution=plugin-1' : ''}`]}
      >
        <MyPluginsPage
          localPlugins={localPlugins}
          installedPluginCount={installedPluginCount}
          reader={api}
          cache={cache}
          onSubmitUpdate={onSubmitUpdate}
          onViewLocal={vi.fn()}
        />
      </MemoryRouter>
    </StrictMode>,
  );
}
async function openHistory() {
  const disclosure = (await screen.findByText(`${prefix}.history`)).closest('details')!;
  if (!disclosure.open) fireEvent.click(within(disclosure).getByText(`${prefix}.history`));
  await waitFor(() => expect(disclosure.open).toBe(true));
}
async function waitForManagement() {
  await screen.findByRole('region', { name: `${prefix}.versionManagement` });
}
async function selectPublishingPlugin(label: string) {
  const option = within(screen.getByRole('dialog')).getByRole('button', { name: label });
  await waitFor(() => expect(option).toHaveProperty('disabled', false));
  fireEvent.click(option);
}
beforeEach(() => {
  // Radix scrolls keyboard-focused options; jsdom has no layout implementation.
  Element.prototype.scrollIntoView = vi.fn();
  reviews.updates = []; reviews.refresh.mockReset(); reviews.markRead.mockReset();
  auth.owner = 'A';
  auth.generation = 1;
  auth.membershipKind = 'personal';
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('My Plugins facts', () => {
  it.each(['personal', 'org'])('shows the actual new package notes to a %s member before submitting the same prepared package', async membershipKind => {
    auth.membershipKind = membershipKind;
    const api = reader();
    const preview = { ...packagePreview('exact-instance', '1.2.0'), releaseNotes: 'Not yet submitted: new package changes' };
    vi.mocked(api.prepare).mockResolvedValue(preview);
    const submit = vi.fn().mockResolvedValue(false);
    view(api, true, {}, [{ id: 'exact-instance', name: 'Local Plugin', version: '1.2.0' } as GhostPluginListItem], submit);
    const local = await screen.findByRole('region', { name: `${prefix}.localVersion` });
    await within(local).findByText(preview.releaseNotes);
    expect(within(local).queryByText('New version changes')).toBeNull();
    expect(api.submit).not.toHaveBeenCalled();
    fireEvent.click(await within(local).findByRole('button', { name: `${prefix}.submitVersion 1.2.0` }));
    expect(submit).toHaveBeenCalledExactlyOnceWith('exact-instance', { prepared: preview, isCurrent: expect.any(Function) });
  });

  it('shows the new package preflight blocker without a submission button', async () => {
    const api = reader();
    const preview = packagePreview('exact-instance', '1.2.0');
    vi.mocked(api.prepare).mockResolvedValue({ ...preview, preflight: { ...preview.preflight!,
      blockers: [{ code: 'VERSION_ALREADY_SUBMITTED', message: 'This exact new package version is already submitted.' }], actions: { canSubmit: false } } });
    view(api);
    const local = await screen.findByRole('region', { name: `${prefix}.localVersion` });
    await within(local).findByText(`${prefix}.errors.VERSION_ALREADY_SUBMITTED`);
    expect(within(local).queryByText('This exact new package version is already submitted.')).toBeNull();
    expect(within(local).queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeNull();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('opens an independent management page with immediately visible versions and publishing controls', async () => {
    const api = reader();
    view(api);
    await waitForManagement();
    expect(screen.getByLabelText(`${prefix}.versionFacts`).closest('details')).toBeNull();
    expect(await screen.findByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeTruthy();
    expect(screen.getByText('New version changes')).toBeTruthy();
    expect(screen.queryByText(`${prefix}.versionUpdates`)).toBeNull();
    expect(screen.queryByRole('switch', { name: 'settings.ghosts.enableAria' })).toBeNull();
    expect(api.prepare).toHaveBeenCalledWith('exact-instance');
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('shows the running version in the developer list and opens management with a read-only package preview', async () => {
    const api = reader();
    view(api, false);
    const row = await screen.findByRole('button', { name: /My Plugin/ });
    expect(within(row).getByText('1.2.0')).toBeTruthy();
    expect(within(row).getByText(`${prefix}.versionManagement`)).toBeTruthy();
    fireEvent.click(row);
    await waitForManagement();
    expect(within(screen.getByLabelText(`${prefix}.versionFacts`)).getByText('1.2.0')).toBeTruthy();
    expect(await screen.findByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeTruthy();
    expect(api.prepare).toHaveBeenCalledWith('exact-instance');
    expect(api.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.myPlugins` }));
    expect(await screen.findByRole('button', { name: /My Plugin/ })).toBeTruthy();
  });

  it('keeps management readable without a submission action after publishing grant revocation', async () => {
    const api = reader();
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin,
      actions: { submitUpdate: false, viewMarket: true }, authorSettings: { anonymous: true, canEdit: true } } });
    view(api);
    await waitForManagement();
    expect(screen.getByText('New version changes')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeNull();
    expect(api.setAnonymity).not.toHaveBeenCalled();
  });
  it('hides submission while a version is pending without hiding its management details', async () => {
    const api = reader();
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin,
      latestSubmission: { ...detail.plugin.latestSubmission!, reviewStatus: 'pending' } } });
    view(api);
    await waitForManagement();
    expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeNull();
    expect(screen.getByText('New version changes')).toBeTruthy();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('hides submission when the installed version number has already been submitted', async () => {
    const api = reader();
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin, localVersion: '2.0.0', localInstallation: { state: 'installed', instanceId: 'exact-instance', version: '2.0.0', origin: 'local', enabled: true } } });
    view(api);
    await waitForManagement();
    expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeNull();
    expect(screen.getByText('New version changes')).toBeTruthy();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('keeps cached history readable but hides submission after the current permission read fails', async () => {
    const api = reader();
    view(api);
    await waitForManagement();
    const update = await screen.findByRole('button', { name: `${prefix}.submitVersion 1.2.0` });
    await waitFor(() => expect(update).toHaveProperty('disabled', false));
    vi.mocked(api.detail).mockRejectedValueOnce(new Error('[PERMISSION_DENIED] revoked'));
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.refreshDetail` }));
    await waitFor(() => expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeNull());
    expect(screen.getByText('New version changes')).toBeTruthy();
    expect(api.submit).not.toHaveBeenCalled();
    expect(api.setAnonymity).not.toHaveBeenCalled();
  });
  it('shows server submissions without querying or reconstructing an upload history', async () => {
    const api = reader();
    view(api, false);
    fireEvent.click(await screen.findByRole('button', { name: /My Plugin/ }));
    await waitForManagement();
    expect(screen.getByText('Full reason, line one Full reason, line two')).toBeTruthy();
    expect(screen.queryByText(`${prefix}.resume`)).toBeNull();
    expect(screen.queryByText(`${prefix}.retryPublish`)).toBeNull();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('keeps the exact publishing selection and package preview in the dialog until submission', async () => {
    const api = reader();
    vi.mocked(api.list).mockResolvedValue({ plugins: [], nextCursor: null, queriedAt: at });
    const submit = vi.fn().mockResolvedValue(false);
    const prepared = packagePreview('exact-instance-b');
    vi.mocked(api.prepare).mockResolvedValue(prepared);
    vi.mocked(api.discard).mockResolvedValue(undefined);
    const installations = ['exact-instance-a', 'exact-instance-b'].map(
      (id) =>
        ({
          id,
          name: 'Same Name',
          version: '1.0.0',
        }) as GhostPluginListItem,
    );
    view(api, false, {}, installations, submit);
    await screen.findByText(`${prefix}.empty`);
    expect(screen.queryByRole('textbox', { name: `${prefix}.search` })).toBeNull();
    expect(screen.queryByRole('button', { name: `${prefix}.viewLocal` })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.goPublish` }));
    const picker = screen.getByRole('dialog');
    expect(submit).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
    await selectPublishingPlugin('Same Name · 1.0.0 · exact-instance-b');
    await within(picker).findByText('Actual selected package');
    expect(api.prepare).toHaveBeenCalledWith('exact-instance-b');
    expect(api.submit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(picker);
    fireEvent.click(within(picker).getByRole('button', { name: `${prefix}.submitVersion 1.0.0` }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('exact-instance-b', expect.objectContaining({ prepared, isCurrent: expect.any(Function) })));
    expect(screen.getByRole('dialog')).toBe(picker);
  });

  // Unit: closing used to clear the real picker while Radix kept it mounted for
  // its exit animation, flashing Loading. Existing close/reopen cases unmounted
  // immediately in jsdom and missed this interval. One loaded choice is enough.
  it('retains the publishing choices and preview throughout the close animation', async () => {
    // jsdom lacks CSS.escape; the simulated animation names are plain identifiers.
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = computedStyle(element);
      if (element.getAttribute('role') === 'dialog') {
        Object.defineProperty(style, 'animationName', {
          get: () => element.getAttribute('data-state') === 'closed' ? 'modal-fade-out' : 'modal-panel-in',
        });
      }
      return style;
    });
    const api = reader();
    view(api, false);
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.publishPlugin` }));
    await selectPublishingPlugin('Local Plugin · 1.2.0 · exact-instance');
    const picker = screen.getByRole('dialog');
    await within(picker).findByText('Actual selected package');

    fireEvent.click(within(picker).getByRole('button', { name: 'settings.ghosts.detail.closeDialog' }));
    expect(picker.isConnected).toBe(true);
    expect(within(picker).getByText('Local Plugin')).toBeTruthy();
    expect(within(picker).getByText('Actual selected package')).toBeTruthy();
    expect(within(picker).queryByText(`${prefix}.loading`)).toBeNull();
    expect(within(picker).queryByText(`${prefix}.preparing`)).toBeNull();

    const end = new Event('animationend', { bubbles: true });
    Object.defineProperty(end, 'animationName', { value: 'modal-fade-out' });
    fireEvent(picker, end);
    await waitFor(() => expect(picker.isConnected).toBe(false));
    await waitFor(() => expect(api.discard).toHaveBeenCalledWith('chosen-snapshot'));
  });

  it('explains official GitHub publishing in management and the picker despite a submission grant', async () => {
    const api = reader();
    const official = { ...detail.plugin, publisherKind: 'official' as const };
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: official });
    vi.mocked(api.list).mockResolvedValue({ plugins: [official], nextCursor: null, queriedAt: at });
    view(api);
    await waitForManagement();
    expect(screen.getByText(`${prefix}.unavailable.officialGithubRequired`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.myPlugins` }));
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.publishPlugin` }));
    const picker = screen.getByRole('dialog');
    const option = within(picker).getByRole('button', { name: 'Local Plugin · 1.2.0 · exact-instance' });
    expect(await within(option).findByText(`${prefix}.unavailable.officialGithubRequired`)).toBeTruthy();
    expect(option).toHaveProperty('disabled', true);
    fireEvent.click(option);
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('explains GitHub publishing for an official plugin that is not installed on this computer', async () => {
    const api = reader();
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin,
      publisherKind: 'official', localInstanceId: null, localVersion: null, localInstallation: { state: 'missing' } } });
    view(api);
    await waitForManagement();
    expect(screen.getByText(`${prefix}.unavailable.officialGithubRequired`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeNull();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'pending', 'denied'] as const)(
    'explains an unavailable %s version before it can be selected', async state => {
      const api = reader();
      const plugin = { ...detail.plugin,
        market: { state: 'not_listed' as const, version: null, releaseId: null, reason: null },
        actions: { submitUpdate: state !== 'denied', viewMarket: false },
        latestSubmission: { ...detail.plugin.latestSubmission!,
          version: state === 'pending' ? '1.1.0' : '1.0.0',
          reviewStatus: state === 'cancelled' ? 'cancelled' as const : 'pending' as const } };
      vi.mocked(api.list).mockResolvedValue({ plugins: [plugin], nextCursor: null, queriedAt: at });
      const local = { id: 'exact-instance', name: 'Local Plugin', version: '1.0.0' } as GhostPluginListItem;
      view(api, false, {}, [local]);
      fireEvent.click(screen.getByRole('button', { name: `${prefix}.publishPlugin` }));
      const picker = screen.getByRole('dialog');
      const option = within(picker).getByRole('button', { name: 'Local Plugin · 1.0.0 · exact-instance' });
      const reason = state === 'denied' ? `${prefix}.permissionDenied`
        : `${prefix}.errors.${state === 'pending' ? 'PLUGIN_PENDING_RELEASE_EXISTS' : 'VERSION_ALREADY_SUBMITTED'}`;
      expect(await within(option).findByText(reason)).toBeTruthy();
      expect(option).toHaveProperty('disabled', true);
      fireEvent.click(option);
      expect(api.prepare).not.toHaveBeenCalled();
      expect(api.submit).not.toHaveBeenCalled();
      expect(within(picker).queryByRole('button', { name: `${prefix}.submitVersion 1.0.0` })).toBeNull();
    },
  );

  it('keeps an older-version preflight blocker outside the scrollable package summary', async () => {
    const api = reader();
    const local = { id: 'exact-instance', name: 'Local Plugin', version: '0.9.0' } as GhostPluginListItem;
    const prepared = packagePreview(local.id, local.version);
    prepared.preflight!.actions.canSubmit = false;
    prepared.preflight!.blockers = [{ code: 'VERSION_ALREADY_SUBMITTED', message: 'This earlier version was already submitted' }];
    vi.mocked(api.prepare).mockResolvedValue(prepared);
    view(api, false, {}, [local]);
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.publishPlugin` }));
    await selectPublishingPlugin('Local Plugin · 0.9.0 · exact-instance');
    const picker = screen.getByRole('dialog');
    const reason = await within(picker).findByText(`${prefix}.errors.VERSION_ALREADY_SUBMITTED`);
    expect(within(picker).queryByText('This earlier version was already submitted')).toBeNull();
    const summary = within(picker).getByRole('region', { name: `${prefix}.publishingVersion 0.9.0` });
    expect(summary.contains(reason)).toBe(false);
    expect(reason.getAttribute('role')).toBe('status');
    expect(within(picker).queryByRole('button', { name: `${prefix}.submitVersion 0.9.0` })).toBeNull();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('keeps choices unavailable when reading all submission pages fails', async () => {
    const api = reader();
    vi.mocked(api.list).mockImplementation(async options => {
      if (options?.cursor) throw new Error('Next page unavailable');
      return { plugins: [], nextCursor: 'unread-page', queriedAt: at };
    });
    const local = { id: 'exact-instance', name: 'Local Plugin', version: '1.0.0' } as GhostPluginListItem;
    view(api, false, {}, [local]);
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.publishPlugin` }));
    const picker = screen.getByRole('dialog');
    expect(await within(picker).findByRole('alert')).toHaveProperty('textContent', `${prefix}.loadFailed`);
    const option = within(picker).getByRole('button', { name: 'Local Plugin · 1.0.0 · exact-instance' });
    expect(option).toHaveProperty('disabled', true);
    fireEvent.click(option);
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

  // Unit: the old picker navigated on selection. These cases exercise the real
  // dialog lifecycle; ordinary page-entry tests did not cover close/reopen ABA.
  it('discards a snapshot that arrives after closing and reopening the same selection', async () => {
    const api = reader();
    vi.mocked(api.list).mockResolvedValue({ plugins: [], nextCursor: null, queriedAt: at });
    const local = { id: 'exact-instance', name: 'Local Plugin', version: '1.0.0' } as GhostPluginListItem;
    let finish!: (value: Awaited<ReturnType<PluginContributionsApi['prepare']>>) => void;
    const old = new Promise<Awaited<ReturnType<PluginContributionsApi['prepare']>>>(resolve => { finish = resolve; });
    const current = { ...packagePreview(local.id), preparedId: 'current-package', description: 'Current package preview' };
    vi.mocked(api.prepare).mockReturnValueOnce(old).mockResolvedValue(current);
    view(api, false, {}, [local]);
    const choose = async () => {
      fireEvent.click(screen.getByRole('button', { name: `${prefix}.publishPlugin` }));
      await selectPublishingPlugin('Local Plugin · 1.0.0 · exact-instance');
    };
    await choose();
    await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(1));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.ghosts.detail.closeDialog' }));
    await choose();
    await screen.findByText('Current package preview');
    await act(async () => { finish({ ...current, preparedId: 'abandoned-package', description: 'Abandoned package preview' }); });
    expect(screen.queryByText('Abandoned package preview')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(api.discard).toHaveBeenCalledWith('abandoned-package');
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('keeps a reopened dialog when an earlier submission finishes', async () => {
    const api = reader();
    vi.mocked(api.list).mockResolvedValue({ plugins: [], nextCursor: null, queriedAt: at });
    const local = { id: 'exact-instance', name: 'Local Plugin', version: '1.0.0' } as GhostPluginListItem;
    const prepared = packagePreview(local.id);
    vi.mocked(api.prepare).mockResolvedValue(prepared);
    let finish!: (submitted: boolean) => void;
    const submit = vi.fn<(id: string, options?: PluginSubmitOptions) => Promise<boolean>>().mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    view(api, false, {}, [local], submit);
    const choose = async () => {
      fireEvent.click(screen.getByRole('button', { name: `${prefix}.publishPlugin` }));
      await selectPublishingPlugin('Local Plugin · 1.0.0 · exact-instance');
      return within(screen.getByRole('dialog')).findByRole('button', { name: `${prefix}.submitVersion 1.0.0` });
    };
    fireEvent.click(await choose());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.ghosts.detail.closeDialog' }));
    await choose();
    await act(async () => { finish(true); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(submit.mock.calls[0][1]?.isCurrent?.()).toBe(false);
  });

  it.each([
    { installed: 0, expected: 'noLocalPlugins', absent: 'noPublishablePlugins' },
    { installed: 3, expected: 'noPublishablePlugins', absent: 'noLocalPlugins' },
  ])(
    'distinguishes an empty publishing selection with $installed installed plugins',
    async ({ installed, expected, absent }) => {
      const api = reader();
      const open = vi.fn();
      view(api, false, {}, [], open, installed);
      fireEvent.click(screen.getByRole('button', { name: `${prefix}.publishPlugin` }));
      const picker = screen.getByRole('dialog');
      expect(within(picker).getByText(`${prefix}.${expected}`)).toBeTruthy();
      expect(within(picker).queryByText(`${prefix}.${absent}`)).toBeNull();
      expect(within(picker).getAllByRole('button')).toHaveLength(1); // Close only.
      expect(open).not.toHaveBeenCalled();
      expect(api.prepare).not.toHaveBeenCalled();
      expect(api.submit).not.toHaveBeenCalled();
    },
  );

  it('closes the local selection on an owner change without opening an old installation', async () => {
    const api = reader();
    const cache: MyPluginsPageCache = {};
    const open = vi.fn();
    const localPlugins = [
      { id: 'private-A', name: 'Owner A', version: '1' } as GhostPluginListItem,
    ];
    const element = () => (
      <MemoryRouter initialEntries={['/plugins?myPlugins=1']}>
        <MyPluginsPage
          reader={api}
          cache={cache}
          localPlugins={localPlugins}
          installedPluginCount={localPlugins.length}
          onSubmitUpdate={vi.fn()}
          onViewLocal={vi.fn()}
        />
      </MemoryRouter>
    );
    const rendered = render(element());
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.publishPlugin` }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    auth.owner = 'B';
    auth.generation++;
    rendered.rerender(element());
    expect(screen.queryByRole('dialog')).toBeNull();
    auth.owner = 'A';
    auth.generation++;
    rendered.rerender(element());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps an available old market version separate from the latest rejected version', async () => {
    const api = reader();
    view(api);
    await waitForManagement();
    const facts = await screen.findByLabelText(`${prefix}.versionFacts`);
    expect(within(facts).getByText('1.0.0')).toBeTruthy();
    expect(within(facts).getByText('1.2.0')).toBeTruthy();
    expect(within(facts).getByText(`${prefix}.noPendingVersion`)).toBeTruthy();
    expect(screen.getByText('2.0.0')).toBeTruthy();
    expect(screen.getByText(`${prefix}.review.rejected`)).toBeTruthy();
    expect(screen.getByText('Full reason, line one Full reason, line two')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `${prefix}.viewMarket` })).toBeNull();
    expect(screen.queryByRole('button', { name: `${prefix}.openLocal` })).toBeNull();
    expect(await screen.findByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeTruthy();
    const history = screen.getByText(`${prefix}.history`).closest('details')!;
    expect(history.open).toBe(false);
    await openHistory();
    // Effect replay must still accept the result; all three events share a revision.
    expect(screen.getByText(`1.0.0 · ${prefix}.event.submitted`)).toBeTruthy();
    expect(screen.getByText(`1.0.0 · ${prefix}.event.approved`)).toBeTruthy();
    expect(screen.getByText(`1.0.0 · ${prefix}.event.disabled`)).toBeTruthy();
  });

  it('rechecks Main association before enabling submission after installation replacement', async () => {
    const api = reader();
    const element = (revision: string) => <MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
      <MyPluginsPage reader={api} localPlugins={[{ id: 'exact-instance', name: 'Local Plugin', version: '1.2.0' } as GhostPluginListItem]} installedPluginCount={1} cache={{}} onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()}
        installedRevision={revision} />
    </MemoryRouter>;
    const rendered = render(element('original-approved-package'));
    await waitFor(() => expect(screen.getByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toHaveProperty('disabled', false));
    let finish!: (value: MyPluginDetailView) => void;
    vi.mocked(api.detail).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const reads = vi.mocked(api.detail).mock.calls.length;
    vi.mocked(api.prepare).mockClear();
    rendered.rerender(element('replacement-package'));
    expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })?.hasAttribute('disabled') ?? true).toBe(true);
    await waitFor(() => expect(vi.mocked(api.detail).mock.calls.length).toBeGreaterThan(reads));
    await act(async () => { finish({ ...detail, plugin: { ...detail.plugin, localInstanceId: null, localVersion: null, localInstallation: { state: 'missing' } } }); });
    expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })?.hasAttribute('disabled') ?? true).toBe(true);
    expect(within(screen.getByLabelText(`${prefix}.versionFacts`)).getByText(`${prefix}.localState.missing`)).toBeTruthy();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'replacement', 'other-owner'] as const)(
    'does not enable submission from offline cached management data (%s)', async scenario => {
      const api = reader(); vi.mocked(api.detail).mockRejectedValue(new Error('Offline'));
      const cache: MyPluginsPageCache = { ownerKey: JSON.stringify(['owner-A', 1, 'member-A', 'cloud']),
        detail, installationRevision: 'approved-installation' };
      if (scenario === 'other-owner') { auth.owner = 'B'; auth.generation++; }
      render(<MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
        <MyPluginsPage reader={api} localPlugins={[]} installedPluginCount={0} cache={cache}
          onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()} installedRevision={scenario === 'replacement' ? 'replaced' : 'approved-installation'}
          />
      </MemoryRouter>);
      await waitFor(() => expect(api.detail).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })?.hasAttribute('disabled') ?? true).toBe(true);
      expect(Boolean(screen.queryByRole('heading', { name: 'My Plugin' }))).toBe(scenario !== 'other-owner');
      expect(api.prepare).not.toHaveBeenCalled();
    },
  );

  it('refreshes the current installation generation after an awaited normal install completes', async () => {
    const api = reader();
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin, localInstanceId: null, localVersion: null, localInstallation: { state: 'missing' } } });
    let finish!: () => void;
    const install = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const element = (revision: string) => <MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
      <MyPluginsPage reader={api} localPlugins={[]} installedPluginCount={0} cache={{}}
        onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()} installedRevision={revision}
        onInstallPublished={install} />
    </MemoryRouter>;
    const rendered = render(element('not-installed'));
    await waitForManagement();
    fireEvent.click(await screen.findByRole('button', { name: `${prefix}.installPublished` }));
    vi.mocked(api.detail).mockResolvedValue(detail);
    rendered.rerender(element('new-approved-installation'));
    await waitFor(() => expect(within(screen.getByLabelText(`${prefix}.versionFacts`)).getByText('1.2.0')).toBeTruthy());
    const reads = vi.mocked(api.detail).mock.calls.length;
    await act(async () => { finish(); });
    await waitFor(() => expect(vi.mocked(api.detail).mock.calls.length).toBeGreaterThan(reads));
    expect(within(screen.getByLabelText(`${prefix}.versionFacts`)).getByText('1.2.0')).toBeTruthy();
    expect(install).toHaveBeenCalledExactlyOnceWith('plugin-1');
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('refreshes a confirmed submission in place without replacing the management page', async () => {
    const api = reader();
    const cache: MyPluginsPageCache = {};
    const tree = (revision: number) => (
      <MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
        <MyPluginsPage reader={api} localPlugins={[]} installedPluginCount={1} cache={cache}
          onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()} submissionRevision={revision} />
      </MemoryRouter>
    );
    const rendered = render(tree(0));
    await waitForManagement();
    const heading = screen.getByRole('heading', { name: 'My Plugin' });
    const reads = vi.mocked(api.detail).mock.calls.length;
    const pending = { ...detail.plugin.latestSubmission!, releaseId: 'confirmed-submission',
      version: '2.1.0', reviewStatus: 'pending' as const, reviewedAt: null, reason: null };
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin, latestSubmission: pending } });
    vi.mocked(api.releases).mockResolvedValue({ releases: [pending], nextCursor: null, queriedAt: at });
    rendered.rerender(tree(1));
    await waitFor(() => expect(vi.mocked(api.detail).mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(within(screen.getByLabelText(`${prefix}.versionFacts`)).getByText('2.1.0')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'My Plugin' })).toBe(heading);
    const facts = screen.getByLabelText(`${prefix}.versionFacts`);
    expect(within(facts).getByText('1.0.0')).toBeTruthy();
    expect(within(facts).getByText('1.2.0')).toBeTruthy();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('retains this account snapshot after a failed foreground read and labels it as cached', async () => {
    const api = reader();
    view(api);
    await waitForManagement();
    await screen.findByLabelText(`${prefix}.versionFacts`);
    vi.mocked(api.detail).mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      screen.getByRole('button', { name: `${prefix}.refreshDetail` }).click();
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(`${prefix}.cachedResult`),
    );
    expect(within(screen.getByLabelText(`${prefix}.versionFacts`)).getByText('1.0.0')).toBeTruthy();
  });
  it('selects an exact historical version with its own notes, decision and timestamps', async () => {
    const api = reader();
    const historic: ContributionReleaseView = {
      ...detail.plugin.latestSubmission!,
      releaseId: 'old-release',
      version: '1.0.0',
      submissionId: 'old-submission',
      sha256: 'b'.repeat(64),
      reviewStatus: 'approved',
      approvedAt: '2026-10-11T09:00:00.000Z',
      submittedAt: '2026-10-10T08:00:00.000Z',
      reviewedAt: '2026-10-11T09:00:00.000Z',
      reason: null,
      content: null,
    };
    vi.mocked(api.releases).mockResolvedValue({
      releases: [detail.plugin.latestSubmission!, historic],
      nextCursor: null,
      queriedAt: at,
    });
    vi.mocked(api.submission).mockResolvedValue({
      ...historic,
      content: {
        name: 'Old plugin content',
        description: 'Old description',
        permissions: [],
        iconUrl: null,
        manifestView: { releaseNotes: 'First released functionality' },
      },
    });
    view(api);
    await waitForManagement();
    await openHistory();
    const selector = await screen.findByRole('combobox', { name: `${prefix}.chooseVersion` });
    expect(selector.textContent).toBe('2.0.0');
    fireEvent.keyDown(selector, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /1.0.0/ }));
    expect(await screen.findByText('First released functionality')).toBeTruthy();
    expect(screen.getAllByText('Plugin description').some(element => !element.closest('details'))).toBe(true); // Historical selection never replaces the overview.
    expect(api.submission).toHaveBeenCalledWith('plugin-1', 'old-submission');
    expect(screen.getByText(`${prefix}.review.published`)).toBeTruthy();
    const version = screen.getByRole('region', { name: `${prefix}.versionContent` });
    expect(
      within(version).getByText(new Date(historic.submittedAt!).toLocaleString('en')),
    ).toBeTruthy();
    expect(
      within(version).getByText(new Date(historic.approvedAt!).toLocaleString('en')),
    ).toBeTruthy();
    expect(within(version).queryByText('New version changes')).toBeNull();
    expect(screen.getByText(`${prefix}.history`).closest('details')!.open).toBe(true);
  });

  it('refreshes the selected decision without letting cached package content restore an old result', async () => {
    const api = reader();
    const pending = {
      ...detail.plugin.latestSubmission!,
      content: null,
      reviewStatus: 'pending' as const,
      reviewedAt: null,
      reason: null,
    };
    vi.mocked(api.detail).mockResolvedValue({
      ...detail,
      plugin: { ...detail.plugin, latestSubmission: pending },
    });
    vi.mocked(api.releases).mockResolvedValue({
      releases: [pending],
      nextCursor: null,
      queriedAt: at,
    });
    vi.mocked(api.submission).mockResolvedValue({
      ...pending,
      content: detail.plugin.latestSubmission!.content,
    });
    view(api);
    await waitForManagement();
    await screen.findByText('New version changes');
    const approved = {
      ...pending,
      reviewStatus: 'approved' as const,
      approvedAt: at,
      reviewedAt: '2026-10-16T09:00:00.000Z',
    };
    const newAt = '2026-10-16T10:00:00.000Z';
    vi.mocked(api.detail).mockResolvedValue({
      ...detail,
      queriedAt: newAt,
      plugin: { ...detail.plugin, latestSubmission: approved },
    });
    vi.mocked(api.releases).mockResolvedValue({
      releases: [approved],
      nextCursor: null,
      queriedAt: newAt,
    });
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.refreshDetail` }));
    expect(await screen.findByText(`${prefix}.review.approved`)).toBeTruthy();
    expect(screen.queryByText(`${prefix}.review.pending`)).toBeNull();
    expect(screen.getByText('New version changes')).toBeTruthy();
    expect(api.releases).toHaveBeenLastCalledWith('plugin-1', undefined);
  });

  it('paginates versions and keeps duplicate revisions out of the selector', async () => {
    const api = reader();
    vi.mocked(api.releases).mockResolvedValue({
      releases: [detail.plugin.latestSubmission!],
      nextCursor: 'older',
      queriedAt: at,
    });
    view(api);
    await waitForManagement();
    await openHistory();
    const more = await screen.findByRole('button', { name: `${prefix}.loadMoreVersions` });
    vi.mocked(api.releases).mockResolvedValue({
      releases: [
        detail.plugin.latestSubmission!,
        {
          ...detail.plugin.latestSubmission!,
          releaseId: 'old-release',
          version: '1.0.0',
          submissionId: 'older',
        },
      ],
      nextCursor: null,
      queriedAt: at,
    });
    fireEvent.click(more);
    await openHistory();
    const selector = await screen.findByRole('combobox', { name: `${prefix}.chooseVersion` });
    expect(api.releases).toHaveBeenCalledWith('plugin-1', 'older');
    fireEvent.keyDown(selector, { key: 'ArrowDown' });
    expect(await screen.findAllByRole('option')).toHaveLength(2);
  });

  it('drops a late version page after the owner generation changes', async () => {
    const api = reader();
    let finish!: (value: Awaited<ReturnType<PluginContributionsApi['releases']>>) => void;
    vi.mocked(api.releases).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const cache: MyPluginsPageCache = {};
    const tree = () => (
      <MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
        <MyPluginsPage
          reader={api}
          cache={cache}
          localPlugins={[]}
          installedPluginCount={0}
          onSubmitUpdate={vi.fn()}
          onViewLocal={vi.fn()}
        />
      </MemoryRouter>
    );
    const mounted = render(tree());
    await screen.findByText('New version changes');
    auth.owner = 'B';
    auth.generation++;
    vi.mocked(api.releases).mockResolvedValue({ releases: [], nextCursor: null, queriedAt: at });
    mounted.rerender(tree());
    await waitFor(() => expect(api.releases).toHaveBeenCalledTimes(2));
    await act(async () =>
      finish({
        releases: [{ ...detail.plugin.latestSubmission!, version: 'SECRET-OLD-OWNER' }],
        nextCursor: null,
        queriedAt: at,
      }),
    );
    expect(screen.queryByText('SECRET-OLD-OWNER')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
  it.each(['approved', 'rejected'] as const)(
    'shows the actual %s decision instead of a historical submitted outcome',
    async (reviewStatus) => {
      const api = reader();
      vi.mocked(api.list).mockResolvedValue({
        plugins: [
          {
            ...detail.plugin,
            latestSubmission: { ...detail.plugin.latestSubmission!, reviewStatus },
          },
        ],
        nextCursor: null,
        queriedAt: at,
      });
      view(api, false);
      expect(await screen.findByText(`2.0.0 · ${prefix}.review.${reviewStatus}`)).toBeTruthy();
      expect(screen.queryByText('Finished upload')).toBeNull();
      expect(screen.queryByText(`${prefix}.outcome.submitted_for_review`)).toBeNull();
      expect(screen.queryByText(`${prefix}.review.published`)).toBeNull();
    },
  );
  it.each(['loaded', 'pending'] as const)(
    'clears %s submission snapshots and their loading state across owners',
    async (state) => {
      const api = reader();
      const ownDetail = structuredClone(detail);
      ownDetail.history = [{ ...ownDetail.history[0], submissionId: 'same-submission-id' }];
      vi.mocked(api.detail).mockResolvedValue(ownDetail);
      const snapshot = (name: string) => ({
        ...ownDetail.plugin.latestSubmission!,
        content: { name, description: '', iconUrl: null, permissions: [], manifestView: {} },
      });
      let finishOld!: (value: ReturnType<typeof snapshot>) => void;
      const old = new Promise<ReturnType<typeof snapshot>>((resolve) => {
        finishOld = resolve;
      });
      vi.mocked(api.submission).mockReturnValueOnce(old);
      const cache: MyPluginsPageCache = {};
      const tree = () => (
        <MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
          <MyPluginsPage
            localPlugins={[]}
            installedPluginCount={0}
            reader={api}
            cache={cache}
            onSubmitUpdate={vi.fn()}

            onViewLocal={vi.fn()}
          />
        </MemoryRouter>
      );
      const rendered = render(tree());
      await waitForManagement();
      fireEvent.click(await screen.findByText(`${prefix}.history`));
      const contentButton = await screen.findByRole('button', {
        name: `${prefix}.submittedContent`,
      });
      await act(async () => {
        contentButton.click();
      });
      if (state === 'loaded') {
        await act(async () => {
          finishOld(snapshot('OldOwnerSnapshot'));
        });
        await screen.findByText('OldOwnerSnapshot');
      }
      auth.owner = 'B';
      auth.generation++;
      vi.mocked(api.detail).mockResolvedValue({
        ...ownDetail,
        plugin: {
          ...ownDetail.plugin,
          name: 'Current Owner Plugin',
          latestSubmission: {
            ...ownDetail.plugin.latestSubmission!,
            reason: 'Current owner reason',
          },
        },
      });
      vi.mocked(api.submission).mockResolvedValueOnce(snapshot('CurrentOwnerSnapshot'));
      rendered.rerender(tree());
      await screen.findByText('Current Owner Plugin');
      await waitForManagement();
      const currentHistory = screen.getByText(`${prefix}.history`).closest('details')!;
      if (!currentHistory.open) fireEvent.click(within(currentHistory).getByText(`${prefix}.history`));
      expect(screen.queryByText('OldOwnerSnapshot')).toBeNull();
      expect(JSON.stringify(cache)).not.toContain('Full reason, line one');
      const newContentButton = await screen.findByRole('button', {
        name: `${prefix}.submittedContent`,
      }) as HTMLButtonElement;
      expect(newContentButton.disabled).toBe(false);
      await act(async () => {
        newContentButton.click();
      });
      await screen.findByText('CurrentOwnerSnapshot');
      expect(api.submission).toHaveBeenCalledTimes(2);
      if (state === 'pending') {
        await act(async () => {
          finishOld(snapshot('OldOwnerSnapshot'));
        });
        expect(screen.queryByText('OldOwnerSnapshot')).toBeNull();
      }
    },
  );
});


describe('cancelling a version review', () => {
  it.each(['cancelled', 'approved'] as const)('shows the actual %s outcome and sends the displayed revision only', async status => {
    const api = reader();
    const pending = { ...detail.plugin.latestSubmission!, reviewStatus: 'pending' as const, canCancelReview: true, };
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin, latestSubmission: pending } });
    vi.mocked(api.releases).mockResolvedValue({ releases: [pending], nextCursor: null, queriedAt: at });
    vi.mocked(api.submission).mockResolvedValue(pending);
    vi.mocked(api.cancelReview).mockResolvedValue({ ...pending, reviewStatus: status, canCancelReview: false, cancelledAt: status === 'cancelled' ? at : null, approvedAt: status === 'approved' ? at : null });
    view(api);
    await waitForManagement();
    fireEvent.click(await screen.findByRole('button', { name: `${prefix}.cancelReview` }));
    await waitFor(() => expect(api.cancelReview).toHaveBeenCalledExactlyOnceWith('plugin-1', { releaseId: pending.releaseId, sha256: pending.sha256, revision: pending.revision }));
    expect(await screen.findByText(`${prefix}.${status === 'cancelled' ? 'cancelReviewCompleted' : 'cancelReviewAlreadyFinal'}`)).toBeTruthy();
    expect(confirmation.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: `${prefix}.cancelReviewDescription ${pending.version}` }));
  });
});

describe('review result indicators in My Plugins', () => {
  const result = (): PluginReviewUpdate => ({ pluginId: 'plugin-1', key: 'exact-review', releaseId: 'new-release',
    version: '2.0.0', sha256: 'a'.repeat(64), revision: at, status: 'rejected', decidedAt: at, unread: true });
  it('shows an unread dot on the plugin row without acknowledging the list', async () => {
    reviews.updates = [result()];
    view(reader(), false);
    expect(await screen.findByRole('img', { name: `${prefix}.unreadReview` })).toBeTruthy();
    expect(reviews.markRead).not.toHaveBeenCalled();
  });
  it('acknowledges only the exact decision displayed in the version result', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    reviews.updates = [result()];
    view(reader());
    await waitForManagement();
    expect(screen.getByLabelText(`${prefix}.versionFacts`).closest('details')).toBeNull();
    await waitFor(() => expect(reviews.markRead).toHaveBeenCalledWith('plugin-1', 'exact-review'));
    const count = reviews.markRead.mock.calls.length;
    await act(async () => {});
    expect(reviews.markRead.mock.calls.length).toBe(count);
  });
  it('does not clear an older unread decision when viewing a newer pending version; opens its exact paginated version', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    reviews.updates = [{ ...result(), releaseId: 'older', sha256: 'b'.repeat(64), version: '1.0.0', status: 'approved' }];
    const api = reader();
    const pending = { ...detail.plugin.latestSubmission!, reviewStatus: 'pending' as const, reviewedAt: null };
    const older = { ...detail.plugin.latestSubmission!, releaseId: 'older', sha256: 'b'.repeat(64), version: '1.0.0',
      reviewStatus: 'approved' as const, reason: null, submissionId: 'older-submission' };
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin, latestSubmission: pending } });
    vi.mocked(api.releases).mockImplementation(async (_id, cursor) => cursor
      ? { releases: [older], nextCursor: null, queriedAt: at }
      : { releases: [pending], nextCursor: 'older-page', queriedAt: at });
    view(api);
    await waitForManagement();
    const link = await screen.findByRole('button', { name: `${prefix}.viewReviewResult 1.0.0` });
    expect(reviews.markRead).not.toHaveBeenCalled();
    await waitFor(() => expect((link as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(link);
    await waitFor(() => expect(reviews.markRead).toHaveBeenCalledWith('plugin-1', 'exact-review'));
    expect(api.releases).toHaveBeenCalledWith('plugin-1', 'older-page');
    const facts = screen.getByLabelText(`${prefix}.versionFacts`);
    expect(within(facts).getByText('1.2.0')).toBeTruthy();
    expect(within(facts).getByText('2.0.0')).toBeTruthy(); // Still the real pending version after opening old approval.
    expect(within(facts).getByText('1.0.0')).toBeTruthy();
  });
});


// Value: Main's installation projection distinguishes missing from unreadable,
// while published content must match the actual market release. Minimal inputs
// are an absent projection or mismatched release. Shared counters use the existing
// cumulative totals and hide missing metrics and unlisted plugins. Tier: unit; real component entry.
describe('installation state and published content', () => {
  const publicDetail = (releaseId = 'old-release'): PluginMarketDetail => ({
    pluginId: 'plugin-1', ghostId: 'plugin', name: 'Public name', description: 'Published purpose',
    author: null, scope: 'public', organizationId: null, defaultInstall: false,
    releaseId, version: '1.0.0', publishedAt: at, icon: null, installState: 'not-installed',
    enabled: null, sourceType: 'server', sourceMarketName: null,
    downloadStatistics: { requestCount: '2000', last7DaysRequestCount: '35' },
    usageStatistics: { usageCount: '9000', usageCountLast7Days: '27', asOf: at },
    manifest: { schemaVersion: 2, id: 'plugin', name: 'Public name', version: '1.0.0', kind: 'chip',
      entry: 'main.js', description: 'Published purpose', releaseNotes: 'Published changes' },
  });
  it.each(['missing', 'unavailable', undefined] as const)(
    'offers only the action justified by the %s local state', async state => {
      const api = reader(), install = vi.fn();
      vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin,
        localInstanceId: null, localVersion: null, localInstallation: state ? { state } : undefined } });
      render(<MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
        <MyPluginsPage reader={api} localPlugins={[]} installedPluginCount={0} cache={{}} onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()} onInstallPublished={install} />
      </MemoryRouter>);
      await waitForManagement();
      await waitFor(() => expect(within(screen.getByLabelText(`${prefix}.versionFacts`)).getByText(`${prefix}.localState.${state ?? 'unavailable'}`)).toBeTruthy());
      expect(Boolean(screen.queryByRole('button', { name: `${prefix}.installPublished` }))).toBe(state === 'missing');
      expect(screen.queryByRole('button', { name: `${prefix}.submitVersion 1.2.0` })).toBeNull();
      expect(api.prepare).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
    },
  );
  it.each(['exact', 'different-release', 'failed'] as const)(
    'keeps the published version fact while handling %s published content', async result => {
      const api = reader();
      const readPublished = result === 'failed' ? vi.fn().mockRejectedValue(new Error('Unavailable'))
        : vi.fn().mockResolvedValue(publicDetail(result === 'exact' ? 'old-release' : 'newer-release'));
      render(<MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
        <MyPluginsPage reader={api} localPlugins={[]} installedPluginCount={0} cache={{}} onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()} onReadPublished={readPublished} />
      </MemoryRouter>);
      await waitForManagement();
      const published = screen.getByRole('region', { name: `${prefix}.listedVersion` });
      if (result === 'exact') {
        expect(await within(published).findByText('Published purpose')).toBeTruthy();
        expect(within(published).getByText('Published changes')).toBeTruthy();
        expect(screen.getByRole('group', { name: 'settings.ghosts.usage.downloadsValue 2,000' })).toBeTruthy();
        expect(screen.getByRole('group', { name: 'settings.ghosts.usage.usesValue 9,000' })).toBeTruthy();
      } else {
        expect(await within(published).findByText(`${prefix}.publishedContentUnavailable`)).toBeTruthy();
        expect(within(published).queryByText('Published changes')).toBeNull();
        expect(screen.queryByRole('group', { name: /^settings\.ghosts\.usage\./ })).toBeNull();
      }
      expect(within(published).queryByText('New version changes')).toBeNull();
      expect(within(screen.getByLabelText(`${prefix}.versionFacts`)).getByText('1.0.0')).toBeTruthy();
      expect(within(screen.getByRole('region', { name: `${prefix}.currentSubmission` })).getByText('New version changes')).toBeTruthy();
    },
  );
  it.each(['missing', 'zero'] as const)('keeps the existing display for %s shared counters', async state => {
    const api = reader(), value = publicDetail();
    value.downloadStatistics = state === 'zero' ? { requestCount: '0' } : undefined;
    value.usageStatistics = state === 'zero' ? { usageCount: '0', asOf: at } : undefined;
    render(<MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
      <MyPluginsPage reader={api} localPlugins={[]} installedPluginCount={0} cache={{}} onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()} onReadPublished={vi.fn().mockResolvedValue(value)} />
    </MemoryRouter>);
    await screen.findByText('Published purpose');
    if (state === 'zero') {
      expect(screen.getByRole('group', { name: 'settings.ghosts.usage.downloadsValue 0' })).toBeTruthy();
      expect(screen.getByRole('group', { name: 'settings.ghosts.usage.usesValue 0' })).toBeTruthy();
    } else {
      expect(screen.queryByRole('group', { name: /^settings\.ghosts\.usage\./ })).toBeNull();
    }
  });
  it('does not read or display shared counters before the plugin is listed', async () => {
    const api = reader(), readPublished = vi.fn().mockResolvedValue(publicDetail());
    vi.mocked(api.detail).mockResolvedValue({ ...detail, plugin: { ...detail.plugin,
      market: { state: 'not_listed', version: null, releaseId: null, reason: null } } });
    render(<MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
      <MyPluginsPage reader={api} localPlugins={[]} installedPluginCount={0} cache={{}} onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()} onReadPublished={readPublished} />
    </MemoryRouter>);
    await waitForManagement();
    expect(readPublished).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /^settings\.ghosts\.usage\./ })).toBeNull();
  });
  it('keeps the same published content mounted during a refresh of that exact release', async () => {
    const api = reader(), readPublished = vi.fn().mockResolvedValue(publicDetail());
    render(<MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin-1']}>
      <MyPluginsPage reader={api} localPlugins={[]} installedPluginCount={0} cache={{}} onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()} onReadPublished={readPublished} />
    </MemoryRouter>);
    const notes = await screen.findByText('Published changes');
    const calls = readPublished.mock.calls.length;
    readPublished.mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.detail).mockResolvedValue({ ...detail, queriedAt: '2026-10-16T00:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: `${prefix}.refreshDetail` }));
    await waitFor(() => expect(readPublished.mock.calls.length).toBeGreaterThan(calls));
    expect(screen.getByText('Published changes')).toBe(notes);
    expect(notes.isConnected).toBe(true);
    expect(within(screen.getByRole('region', { name: `${prefix}.listedVersion` })).queryByText(`${prefix}.loading`)).toBeNull();
  });
});
