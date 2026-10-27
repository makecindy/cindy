/** @vitest-environment jsdom */
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { registerPluginContributionsIpc } from '../../../../main/plugin-contributions/registerIpc';
import type { ContributionReleaseView, PluginContributionsApi } from '../../../../shared/pluginContributions';
import { MyPluginsPage } from '../MyPluginsPage';

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

function view() {
  let current = pending;
  const plugin = () => ({
    pluginId: 'plugin', name: 'My Plugin', iconUrl: null, updatedAt: at,
    market: { state: 'not_listed' as const, version: null, releaseId: null, reason: null },
    latestSubmission: current, actions: { submitUpdate: true, viewMarket: false }, localInstanceId: null,
  });
  const api: PluginContributionsApi = {
    reviewUpdates: async () => [], markReviewRead: vi.fn(),
    prepare: vi.fn(), submit: vi.fn(), cancel: vi.fn(), discard: vi.fn(), status: vi.fn(),
    list: async () => ({ plugins: [plugin()], nextCursor: null, queriedAt: at }),
    setAnonymity: vi.fn(),
    detail: async () => ({ plugin: plugin(), history: [], nextCursor: null, queriedAt: at }),
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
beforeEach(() => { host.cancelReview.mockReset(); });
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
