/** @vitest-environment jsdom */
/**
 * #1541 team plugin detail, permission table from #1504: creators add/remove maintainers and
 * maintainers only view; an administrator's delisting cannot be undone by authors; authors delist,
 * list again after their own delisting, cancel a pending review and change the audience.
 * Entry: TeamPluginDetail with a fake preload author API and the real confirm flow. jsdom tier.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonalPluginDetail, PluginMaintainer } from '../../../../shared/pluginAuthor';
import { TeamPluginDetail } from '../team/TeamPluginDetail';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args?.version ? `${key} ${args.version}` : args?.name ? `${key} ${args.name}` : key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));
const confirmation = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => confirmation }));
const reviews = vi.hoisted(() => ({ updates: [] as Array<Record<string, unknown>>, refresh: vi.fn(), markRead: vi.fn(async () => undefined) }));
vi.mock('@/contexts/PluginReviewUpdatesContext', () => ({ usePluginReviewUpdates: () => reviews }));

const team = 'settings.ghosts.contribution.team';
const copy = 'settings.ghosts.contribution';

function plugin(overrides: Partial<PersonalPluginDetail> = {}): PersonalPluginDetail {
  return {
    id: 'p1', ghostId: 'meeting-notes', namespace: 'acme', name: 'Meeting Notes', description: 'Summarize meetings',
    myRole: 'creator', status: 'active', disabledByAdmin: false,
    currentRelease: { id: 'r1', version: '1.0.0', reviewStatus: 'approved' },
    latestRelease: { id: 'r1', version: '1.0.0', reviewStatus: 'approved' },
    pendingRelease: null,
    visibilityAudience: { type: 'all' },
    ...overrides,
  };
}
const people: PluginMaintainer[] = [
  { id: 'a1', membershipId: 'm-li', authorizationRole: 'creator', displayName: '李安', email: 'li@acme.com' },
  { id: 'a2', membershipId: 'm-zx', authorizationRole: 'maintainer', displayName: '张晓', email: 'zx@acme.com' },
];

let api: Record<string, ReturnType<typeof vi.fn>>;
let windowHidden: ((hidden: boolean) => void) | null = null;
function mount(detail: PersonalPluginDetail) {
  api.plugin.mockResolvedValue(detail);
  render(<TeamPluginDetail pluginId="p1" memberName="李安" localPlugins={[]} onStartPublish={vi.fn(async () => true)} />);
}

beforeEach(() => {
  confirmation.confirm.mockClear();
  reviews.updates = [];
  reviews.markRead.mockClear();
  api = {
    plugin: vi.fn(),
    maintainers: vi.fn(async () => people),
    updatePlugin: vi.fn(async (_id: string, update: object) => plugin(update as Partial<PersonalPluginDetail>)),
    cancelReview: vi.fn(async () => undefined),
    addMaintainer: vi.fn(),
    removeMaintainer: vi.fn(async () => undefined),
    departments: vi.fn(async () => []),
    departmentMembers: vi.fn(),
    searchColleagues: vi.fn(async () => []),
    lookupColleagues: vi.fn(),
    listPlugins: vi.fn(),
    releases: vi.fn(async () => ({ nextCursor: null, releases: [] })),
  };
  windowHidden = null;
  Object.assign(window, { electronAPI: { pluginAuthor: api,
    onWindowHiddenChange: (callback: (hidden: boolean) => void) => { windowHidden = callback; return () => {}; } } });
});
afterEach(cleanup);

describe('TeamPluginDetail', () => {
  it('lets only the creator manage maintainers and never removes the creator', async () => {
    mount(plugin());
    const list = await screen.findByRole('list', { name: `${team}.maintainers` });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]!).queryByRole('button', { name: `${team}.removeMaintainer` })).toBeNull();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: `${team}.removeMaintainer` }));
    await waitFor(() => expect(api.removeMaintainer).toHaveBeenCalledWith('p1', 'a2'));
    expect(screen.getByRole('button', { name: `${team}.addMaintainer` })).toBeTruthy();

    cleanup();
    mount(plugin({ myRole: 'maintainer' }));
    await screen.findByRole('list', { name: `${team}.maintainers` });
    expect(screen.queryByRole('button', { name: `${team}.addMaintainer` })).toBeNull();
    expect(screen.queryByRole('button', { name: `${team}.removeMaintainer` })).toBeNull();
  });

  it('delists and lists again only when the author may, and explains an admin delisting', async () => {
    mount(plugin());
    fireEvent.click(await screen.findByRole('button', { name: `${team}.delist` }));
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('p1', { status: 'disabled' }));

    cleanup();
    mount(plugin({ status: 'disabled', disabledBy: 'author', disabledByAdmin: false }));
    fireEvent.click(await screen.findByRole('button', { name: `${team}.list` }));
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('p1', { status: 'active' }));

    cleanup();
    mount(plugin({ status: 'disabled', disabledBy: 'organization', disabledByAdmin: true }));
    expect(await screen.findByText(`${team}.delistedByAdmin`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: `${team}.list` })).toBeNull();
    expect(screen.queryByRole('button', { name: `${team}.delist` })).toBeNull();

    cleanup();
    // Never listed: nothing to list or delist yet.
    mount(plugin({ status: 'disabled', currentRelease: null, pendingRelease: { id: 'r0', version: '0.1.0', reviewStatus: 'pending' } }));
    const listed = await screen.findByRole('region', { name: `${copy}.listedVersion` });
    expect(within(listed).getByText(`${copy}.market.not_listed`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: `${team}.list` })).toBeNull();
  });

  // Review fix: answering a confirmation after the page (or account) went away sends nothing.
  it('does not write when the page is gone by the time the confirmation is answered', async () => {
    let answer!: (value: boolean) => void;
    confirmation.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    mount(plugin());
    fireEvent.click(await screen.findByRole('button', { name: `${team}.delist` }));
    await waitFor(() => expect(confirmation.confirm).toHaveBeenCalled());
    const signal = (confirmation.confirm.mock.calls[0] as unknown as [unknown, AbortSignal])[1];
    cleanup();
    expect(signal.aborted).toBe(true);
    answer(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.updatePlugin).not.toHaveBeenCalled();
  });

  it('cancels a pending review and shows the reason of a returned version', async () => {
    mount(plugin({ pendingRelease: { id: 'r2', version: '1.1.0', reviewStatus: 'pending', publishedAt: '2026-11-20T00:00:00.000Z' } }));
    fireEvent.click(await screen.findByRole('button', { name: `${copy}.cancelReview` }));
    await waitFor(() => expect(api.cancelReview).toHaveBeenCalledWith('p1', 'r2'));

    cleanup();
    mount(plugin({
      latestRelease: { id: 'r3', version: '1.2.0', reviewStatus: 'rejected' },
      lastRejection: { createdAt: '2026-11-20T00:00:00.000Z', detail: { reason: '缺少使用说明' } },
    }));
    expect(await screen.findByText('缺少使用说明')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `${copy}.cancelReview` })).toBeNull();
  });

  it('saves a changed audience and keeps the dialog open when saving fails', async () => {
    mount(plugin({
      visibilityAudience: { type: 'matchAny', emails: ['a@acme.com'], roles: ['admin'] },
    }));
    fireEvent.click(await screen.findByRole('button', { name: `${team}.edit` }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: `${team}.save` });
    expect(save).toHaveProperty('disabled', true);
    // Remove the legacy role condition; adding roles is not offered.
    fireEvent.click(within(dialog).getByRole('button', {
      name: 'settings.ghosts.audience.picker.remove settings.ghosts.audience.roleLabels.admin',
    }));
    api.updatePlugin.mockRejectedValueOnce(Object.assign(new Error('[PLUGIN_AUDIENCE_VALIDATION_UNAVAILABLE] x'), {}));
    fireEvent.click(save);
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('p1', {
      visibilityAudience: { type: 'matchAny', emails: ['a@acme.com'] },
    }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  // #1541 rule 5: opening the detail reads its review result — only the result it actually
  // shows; a newer result from the change signal reloads the detail first. Others stay unread.
  it('marks a result read only when the detail shows that exact result', async () => {
    const shown = JSON.stringify(['r1', 'approved']);
    reviews.updates = [
      { pluginId: 'org:p1', key: JSON.stringify(['r2', 'rejected']), status: 'rejected', unread: true },
      { pluginId: 'org:p9', key: 'k9', status: 'approved', unread: true },
    ];
    api.plugin.mockResolvedValueOnce(plugin()).mockResolvedValue(plugin({
      latestRelease: { id: 'r2', version: '1.1.0', reviewStatus: 'rejected' },
    }));
    render(<TeamPluginDetail pluginId="p1" memberName="李安" localPlugins={[]} onStartPublish={vi.fn(async () => true)} />);
    await waitFor(() => expect(api.plugin).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reviews.markRead).toHaveBeenCalledWith('org:p1', JSON.stringify(['r2', 'rejected'])));
    expect(reviews.markRead).not.toHaveBeenCalledWith('org:p1', shown);
    expect(reviews.markRead).toHaveBeenCalledTimes(1);
  });

  it('waits until the page is visible before marking a result read', async () => {
    const key = JSON.stringify(['r1', 'approved']);
    reviews.updates = [{ pluginId: 'org:p1', key, status: 'approved', unread: true }];
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      mount(plugin());
      await screen.findByRole('list', { name: `${team}.maintainers` });
      expect(reviews.markRead).not.toHaveBeenCalled();
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(reviews.markRead).toHaveBeenCalledWith('org:p1', key));
    } finally {
      visibility.mockRestore();
    }
  });

  // Greptile review on #12208: a minimized or hidden window can keep visibilityState 'visible'
  // while background throttling is off. Minimal failing input: Main reports the window hidden
  // before the detail loads — the result must stay unread until the window is shown.
  it('does not mark a result read while Main reports the window hidden', async () => {
    const key = JSON.stringify(['r1', 'approved']);
    reviews.updates = [{ pluginId: 'org:p1', key, status: 'approved', unread: true }];
    mount(plugin());
    act(() => windowHidden?.(true));
    await screen.findByRole('list', { name: `${team}.maintainers` });
    expect(reviews.markRead).not.toHaveBeenCalled();
    act(() => windowHidden?.(false));
    await waitFor(() => expect(reviews.markRead).toHaveBeenCalledWith('org:p1', key));
  });

  // Release history shows, per version, the submit time, review outcome, decision time and the
  // return reason; versions from older servers (no review field) only show what is known.
  it('shows each version with its review result when the history is opened', async () => {
    api.releases.mockResolvedValueOnce({ nextCursor: 'c2', releases: [
      { id: 'r3', version: '1.2.0', reviewStatus: 'rejected', publishedAt: '2026-11-18T00:00:00.000Z',
        review: { outcome: 'rejected', decidedAt: '2026-11-19T00:00:00.000Z', reason: '缺少使用说明', actorType: 'organization' } },
      { id: 'r2', version: '1.1.0', reviewStatus: 'pending', publishedAt: '2026-11-17T00:00:00.000Z', review: null },
    ] }).mockResolvedValueOnce({ nextCursor: null, releases: [
      { id: 'r1', version: '1.0.0', reviewStatus: 'approved', publishedAt: '2026-11-01T00:00:00.000Z' },
    ] });
    mount(plugin());
    await screen.findByRole('list', { name: `${team}.maintainers` });
    expect(api.releases).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(`${copy}.history`));
    const history = await screen.findByRole('list', { name: `${copy}.history` });
    const rows = within(history).getAllByRole('listitem');
    expect(within(rows[0]!).getByText(`${copy}.review.rejected`)).toBeTruthy();
    expect(within(rows[0]!).getByText(new RegExp(`${team}.decidedAt`))).toBeTruthy();
    expect(within(rows[0]!).getByText('缺少使用说明')).toBeTruthy();
    expect(within(rows[1]!).getByText(`${copy}.review.pending`)).toBeTruthy();
    expect(within(rows[1]!).queryByText(new RegExp(`${team}.decidedAt`))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `${copy}.loadMoreVersions` }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: `${copy}.history` })).getAllByRole('listitem')).toHaveLength(3));
    expect(api.releases).toHaveBeenLastCalledWith('p1', 'c2');
    const oldServer = within(screen.getByRole('list', { name: `${copy}.history` })).getAllByRole('listitem')[2]!;
    expect(within(oldServer).getByText(new RegExp(`${copy}.submittedAt`))).toBeTruthy();
    expect(within(oldServer).queryByText(new RegExp(`${team}.decidedAt`))).toBeNull();
  });

  // Greptile review on #12208: release history read before a refresh can be stale. Minimal
  // failing input: open the history (pending), refresh after it was rejected — the open list must
  // show the rejection, and a collapsed list must be read again when it is reopened.
  it('rereads open release history on refresh and drops collapsed history until reopened', async () => {
    const at = '2026-11-18T00:00:00.000Z';
    const release = (reviewStatus: string) => ({ nextCursor: null, releases: [{ id: 'r2', version: '1.1.0', reviewStatus, publishedAt: at,
      review: reviewStatus === 'pending' ? null : { outcome: reviewStatus, decidedAt: at, reason: null, actorType: 'organization' } }] });
    api.releases.mockResolvedValueOnce(release('pending')).mockResolvedValueOnce(release('rejected'))
      .mockResolvedValueOnce(release('approved'));
    api.plugin.mockResolvedValue(plugin());
    render(<TeamPluginDetail pluginId="p1" memberName="李安" localPlugins={[]} onStartPublish={vi.fn(async () => true)}
      renderHeaderAction={(refresh) => <button onClick={refresh}>refresh detail</button>} />);
    await screen.findByRole('list', { name: `${team}.maintainers` });
    fireEvent.click(screen.getByText(`${copy}.history`));
    expect(await screen.findByText(`${copy}.review.pending`)).toBeTruthy();
    fireEvent.click(screen.getByText('refresh detail'));
    expect(await screen.findByText(`${copy}.review.rejected`)).toBeTruthy();
    expect(api.releases).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText(`${copy}.history`));
    fireEvent.click(screen.getByText('refresh detail'));
    await waitFor(() => expect(api.plugin).toHaveBeenCalledTimes(3));
    expect(api.releases).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText(`${copy}.history`));
    expect(await screen.findByText(`${copy}.review.approved`)).toBeTruthy();
    expect(api.releases).toHaveBeenCalledTimes(3);
  });

  it('rereads open release history when a newer review result arrives', async () => {
    const at = '2026-11-18T00:00:00.000Z';
    api.releases.mockResolvedValueOnce({ nextCursor: null, releases: [{ id: 'r2', version: '1.1.0', reviewStatus: 'pending', publishedAt: at, review: null }] })
      .mockResolvedValueOnce({ nextCursor: null, releases: [{ id: 'r2', version: '1.1.0', reviewStatus: 'rejected', publishedAt: at,
        review: { outcome: 'rejected', decidedAt: at, reason: null, actorType: 'organization' } }] });
    api.plugin.mockResolvedValue(plugin());
    const view = render(<TeamPluginDetail pluginId="p1" memberName="李安" localPlugins={[]} onStartPublish={vi.fn(async () => true)} />);
    await screen.findByRole('list', { name: `${team}.maintainers` });
    fireEvent.click(screen.getByText(`${copy}.history`));
    expect(await screen.findByText(`${copy}.review.pending`)).toBeTruthy();
    reviews.updates = [{ pluginId: 'org:p1', key: JSON.stringify(['r2', 'rejected']), status: 'rejected', unread: true }];
    view.rerender(<TeamPluginDetail pluginId="p1" memberName="李安" localPlugins={[]} onStartPublish={vi.fn(async () => true)} />);
    expect(await screen.findByText(`${copy}.review.rejected`)).toBeTruthy();
    expect(api.releases).toHaveBeenCalledTimes(2);
  });
});
