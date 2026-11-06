/** @vitest-environment jsdom */
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { registerPluginContributionsIpc } from '../../../../main/plugin-contributions/registerIpc';
import type { ContributionReleaseView, PluginContributionsApi, PluginReviewUpdate } from '../../../../shared/pluginContributions';
import { MyPluginsPage } from '../MyPluginsPage';

const review = vi.hoisted(() => ({ updates: [] as PluginReviewUpdate[], markRead: vi.fn(), refresh: vi.fn() }));
vi.mock('@/contexts/PluginReviewUpdatesContext', () => ({ usePluginReviewUpdates: () => review }));
const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  cancelReview: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => host.handlers.set(name, handler) },
}));
vi.mock('../../../../main/security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../../../main/plugin-contributions/host', () => ({
  cancelPluginReview: host.cancelReview,
  setPluginAnonymity: vi.fn(),
  prepareContribution: vi.fn(),
  submitContribution: vi.fn(),
  contributionTransferStatus: vi.fn(),
  cancelContribution: vi.fn(),
  discardContribution: vi.fn(),
  listMyPlugins: vi.fn(),
  myPluginSubmission: vi.fn(),
  myPluginReleases: vi.fn(),
  myPluginDetail: vi.fn(),
  mapContributionError: (error: unknown) => { throw error; },
}));
vi.mock('../../../../main/plugin-contributions/reviewUpdates', () => ({ reviewUpdates: vi.fn(), markReviewRead: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' } }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'owner', dataOwnerGeneration: 1, user: { id: 'member', membershipKind: 'personal' }, mode: 'cloud' }),
}));
vi.mock('@/components/sidebar/AccountSwitcherDialog', () => ({ AccountSwitcherDialog: () => null }));
vi.mock('@/hooks/useSignInToCindy', () => ({ useSignInToCindy: () => vi.fn() }));
vi.mock('@/hooks/useMacFullscreen', () => ({ useMacFullscreen: () => ({ isMac: false }) }));

const prefix = 'settings.ghosts.contribution';
const at = '2026-10-16T00:00:00.000Z';
const pending: ContributionReleaseView = {
  releaseId: 'release', version: '1.1.0', sha256: 'a'.repeat(64), revision: at,
  reviewStatus: 'pending', revisionState: 'current', submissionId: 'submission',
  submittedAt: at, reviewedAt: null, approvedAt: null, cancelledAt: null,
  canCancelReview: true, reason: null, source: 'manual',
  content: { name: 'My Plugin', description: 'Description', iconUrl: null, permissions: [], manifestView: { releaseNotes: 'Complete version changes' } },
};

function view(options: { market?: 'disabled' | 'archived'; queriedAt?: string } = {}) {
  let current = pending;
  const plugin = () => ({
    pluginId: 'plugin', name: 'My Plugin', iconUrl: null, updatedAt: at,
    market: { state: options.market ?? 'not_listed' as const, version: null, releaseId: null, reason: options.market ? '停止维护，现已归档' : null },
    latestSubmission: current, actions: { submitUpdate: true, viewMarket: false }, localInstanceId: null,
  });
  const api: PluginContributionsApi = {
    reviewUpdates: async () => [], markReviewRead: vi.fn(),
    prepare: vi.fn(), submit: vi.fn(), cancel: vi.fn(), discard: vi.fn(), status: vi.fn(),
    list: async () => ({ plugins: [plugin()], nextCursor: null, queriedAt: at }),
    setAnonymity: vi.fn(),
    detail: async () => ({ plugin: plugin(), history: options.market ? [{ eventId: 'archive', type: 'disabled', ...(options.market === 'archived' ? { pluginStatus: 'archived' as const } : {}), at, releaseId: null, version: null, submissionId: null, revision: null, reason: '归档处理原因' }] : [], nextCursor: null, queriedAt: options.queriedAt ?? at }),
    releases: async () => ({ releases: [current], nextCursor: null, queriedAt: at }),
    submission: async () => current,
    // Match preload's real envelope, then exercise the actual strict Main IPC handler.
    cancelReview: vi.fn(async (pluginId, release) => {
      const result = await host.handlers.get('plugin-contributions:cancel-review')!({}, { pluginId, release });
      current = result as ContributionReleaseView;
      return current;
    }),
  };
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/plugins?myPlugins=1&contribution=plugin']}>
        <ConfirmDialogProvider>
          <MyPluginsPage reader={api} localPlugins={[]} installedPluginCount={0} cache={{}}
            onSubmitUpdate={vi.fn()} onViewLocal={vi.fn()} />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </StrictMode>,
  );
  return api;
}

beforeAll(() => registerPluginContributionsIpc());
beforeEach(() => { host.cancelReview.mockReset(); review.updates = []; review.markRead.mockReset().mockResolvedValue(undefined); review.refresh.mockReset().mockResolvedValue(undefined); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); });
afterEach(() => vi.restoreAllMocks());
afterEach(cleanup);

describe('review cancellation through the real confirmation and IPC validation', () => {
  it('keeps the review when the user dismisses the confirmation and enables the opener again', async () => {
    const api = view();
    await screen.findByRole('region', { name: `${prefix}.versionManagement` });
    fireEvent.click(await screen.findByRole('button', { name: `${prefix}.cancelReview` }));
    const dialog = await screen.findByRole('alertdialog');
    expect(host.cancelReview).not.toHaveBeenCalled();
    const keep = within(dialog).getByRole('button', { name: `${prefix}.keepReview` });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    fireEvent.click(keep);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.cancelReview).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: `${prefix}.cancelReview` }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['cancelled', 'approved'] as const)('sends only the frozen revision and displays the actual %s result after confirmation', async status => {
    host.cancelReview.mockResolvedValue({ ...pending, reviewStatus: status, canCancelReview: false, cancelledAt: status === 'cancelled' ? at : null, approvedAt: status === 'approved' ? at : null });
    const api = view();
    await screen.findByRole('region', { name: `${prefix}.versionManagement` });
    fireEvent.click(await screen.findByRole('button', { name: `${prefix}.cancelReview` }));
    const dialog = await screen.findByRole('alertdialog');
    expect(api.cancelReview).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: `${prefix}.cancelReview` }));
    await waitFor(() => expect(host.cancelReview).toHaveBeenCalledExactlyOnceWith('plugin', {
      releaseId: pending.releaseId, sha256: pending.sha256, revision: pending.revision,
    }));
    expect(await screen.findByText(`${prefix}.${status === 'cancelled' ? 'cancelReviewCompleted' : 'cancelReviewAlreadyFinal'}`)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: `${prefix}.cancelReview` })).toBeNull());
  });

  it('shows a rejected cancellation and allows the user to try again without losing the pending version', async () => {
    host.cancelReview.mockRejectedValue(new Error('[PERMISSION_DENIED] Permission changed'));
    view();
    fireEvent.click(await screen.findByRole('button', { name: `${prefix}.cancelReview` }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: `${prefix}.cancelReview` }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(`${prefix}.permissionDenied`);
    expect(host.cancelReview).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: `${prefix}.cancelReview` }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Complete version changes')).toBeTruthy();
  });
});

// Production detail visibility is the acknowledgement boundary for market results.
// Existing cancellation tests do not cover archive reasons or stale detail reads.
describe('market result visibility', () => {
  it('shows the market reason and compatible archive event, and acknowledges it after a fresh detail read', async () => {
    review.updates = [{ pluginId: 'plugin', key: 'archive', status: 'archived', decidedAt: at, unread: true,
      releaseId: null, version: null, sha256: null, revision: null }];
    view({ market: 'archived' });
    expect(await screen.findByText('停止维护，现已归档')).toBeTruthy();
    await waitFor(() => expect(review.markRead).toHaveBeenCalledWith('plugin', 'archive'));
    fireEvent.click(screen.getByText(`${prefix}.history`));
    expect(await screen.findByText(`${prefix}.event.archived`)).toBeTruthy();
    expect(screen.getByText('归档处理原因')).toBeTruthy();
  });
  it('keeps a market result unread when the displayed detail predates that event', async () => {
    review.updates = [{ pluginId: 'plugin', key: 'disabled', status: 'disabled', decidedAt: '2026-10-17T00:00:00.000Z', unread: true,
      releaseId: null, version: null, sha256: null, revision: null }];
    view({ market: 'disabled', queriedAt: at });
    await screen.findByText('停止维护，现已归档');
    expect(review.markRead).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: `${prefix}.viewMarketResult` })).toBeTruthy();
  });
});
