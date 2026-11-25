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
/** Times as the detail renders them for the mocked 'en' language. */
const formatted = (value: string) => new Date(value).toLocaleString('en');
const copy = 'settings.ghosts.contribution';

function plugin(overrides: Partial<PersonalPluginDetail> = {}): PersonalPluginDetail {
  return {
    id: 'p1', ghostId: 'meeting-notes', namespace: 'acme', name: 'Meeting Notes', description: 'Summarize meetings',
    myRole: 'creator', status: 'active', disabledByAdmin: false,
    currentRelease: { id: 'r1', version: '1.0.0', reviewStatus: 'approved' },
    latestRelease: { id: 'r1', version: '1.0.0', reviewStatus: 'approved' },
    pendingRelease: null,
    visibilityAudience: { type: 'all' },
    latestReviewEvent: { id: 'e1', kind: 'approved', at: '2026-11-10T00:00:00.000Z', releaseId: 'r1', actorType: 'organization' },
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
  render(<TeamPluginDetail pluginId="p1" memberId="m-li" orgName="Acme" localPlugins={[]} onStartPublish={vi.fn(async () => true)} />);
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
    // Product prototype: 「移除维护者 张晓？」 with a destructive 「移除」.
    expect(confirmation.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: `${team}.removeMaintainerTitle 张晓`, description: `${team}.removeMaintainerDescription`,
      confirmText: `${team}.removeMaintainer`, confirmVariant: 'destructive',
    }), expect.anything());
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
    // Product prototype wording: 下架「周报助手」？ and what members keep.
    expect(confirmation.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: `${team}.delistTitle Meeting Notes`, description: `${team}.delistDescription` }), expect.anything());

    cleanup();
    mount(plugin({ status: 'disabled', disabledBy: 'author', disabledByAdmin: false }));
    fireEvent.click(await screen.findByRole('button', { name: `${team}.list` }));
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('p1', { status: 'active' }));
    // Product prototype: 「上架插件」 / 「上架这个插件？…」, without the name in the title.
    expect(confirmation.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: `${team}.listTitle`, description: `${team}.listDescription`, confirmText: `${team}.list` }),
      expect.anything());

    cleanup();
    mount(plugin({ status: 'disabled', disabledBy: 'organization', disabledByAdmin: true }));
    const delisted = await screen.findByRole('region', { name: `${copy}.listedVersion` });
    expect(within(delisted).getByText(`${team}.delistedByAdminVersion 1.0.0`)).toBeTruthy();
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
    // Greptile review on #12495: the failure only reached the page behind the dialog. Minimal
    // failing input: the save is rejected — the error shows inside the dialog (not twice on the
    // page) and the user's choice stays, so saving again sends the same change.
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(`${copy}.errors.PLUGIN_AUDIENCE_VALIDATION_UNAVAILABLE`);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(dialog).queryByRole('button', {
      name: 'settings.ghosts.audience.picker.remove settings.ghosts.audience.roleLabels.admin',
    })).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledTimes(2));
    expect(api.updatePlugin).toHaveBeenLastCalledWith('p1', { visibilityAudience: { type: 'matchAny', emails: ['a@acme.com'] } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Product prototype: 「+ 添加」 opens the 添加维护者 dialog; results read 「名字 / 部门」 (or the
  // email on servers without departments) and existing maintainers are not offered. A failed
  // addition shows inside the dialog (#12495 review) and keeps the search.
  it('adds maintainers in a dialog and shows a failed addition inside it', async () => {
    api.searchColleagues.mockResolvedValue([
      { membershipId: 'm-new', displayName: '王五', email: 'w5@acme.com', department: { id: 'd1', name: '技术部 / 后端组' }, active: true },
      { membershipId: 'm-old', displayName: '赵六', email: 'z6@acme.com', active: true },
      { membershipId: 'm-zx', displayName: '张晓', email: 'zx@acme.com', active: true },
    ]);
    api.addMaintainer.mockRejectedValueOnce(new Error('[PLUGIN_MAINTAINER_EXISTS] exists')).mockResolvedValueOnce({});
    mount(plugin());
    fireEvent.click(await screen.findByRole('button', { name: `${team}.addMaintainer` }));
    const dialog = await screen.findByRole('dialog', { name: `${team}.addMaintainer` });
    fireEvent.change(within(dialog).getByRole('searchbox', { name: `${team}.searchMaintainer` }), { target: { value: '王' } });
    const results = await within(dialog).findByRole('list', { name: 'settings.ghosts.audience.picker.members' });
    expect(within(results).getByText('技术部 / 后端组')).toBeTruthy();
    expect(within(results).getByText('z6@acme.com')).toBeTruthy();
    // 张晓 is already a maintainer.
    expect(within(results).queryByText('张晓')).toBeNull();
    fireEvent.click(within(results).getByRole('button', { name: `${team}.add 王五` }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(`${copy}.errors.PLUGIN_MAINTAINER_EXISTS`);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(dialog).getByRole('searchbox', { name: `${team}.searchMaintainer` })).toHaveProperty('value', '王');
    fireEvent.click(within(results).getByRole('button', { name: `${team}.add 王五` }));
    await waitFor(() => expect(api.addMaintainer).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // Product prototype: maintainers in one framed list, 「名字（你） · 部门」, only the creator labelled.
  it('lists maintainers with their department, marks yourself and labels only the creator', async () => {
    api.maintainers.mockResolvedValue([
      { id: 'a1', membershipId: 'm-li', authorizationRole: 'creator', displayName: '李安', email: 'li@acme.com', department: { id: 'd2', name: '产品部' } },
      { id: 'a2', membershipId: 'm-zx', authorizationRole: 'maintainer', displayName: '张晓', email: 'zx@acme.com' },
    ]);
    mount(plugin());
    const list = await screen.findByRole('list', { name: `${team}.maintainers` });
    const [creator, other] = within(list).getAllByRole('listitem');
    expect(within(creator!).getByText(`${team}.self`)).toBeTruthy();
    expect(within(creator!).getByText('产品部')).toBeTruthy();
    expect(within(creator!).getByText(`${team}.role.creator`)).toBeTruthy();
    // No department from this server: the email tells people apart.
    expect(within(other!).getByText('zx@acme.com')).toBeTruthy();
    expect(within(other!).queryByText(`${team}.self`)).toBeNull();
    expect(within(other!).getByRole('button', { name: `${team}.removeMaintainer` })).toBeTruthy();
    // 可见范围 names the organization and carries no explanation under it (only the edit dialog does).
    const audience = screen.getByRole('region', { name: 'settings.ghosts.audience.title' });
    expect(within(audience).getByText('settings.ghosts.audience.allMembersOf')).toBeTruthy();
    expect(within(audience).queryByText(`${team}.saveImpact`)).toBeNull();
  });

  // Product prototype: download and use counts only once a version has been listed.
  it('shows download and use counts only for a listed plugin', async () => {
    mount(plugin({ downloadStatistics: { requestCount: '12' }, usageStatistics: { usageCount: '34' } }));
    expect(await screen.findByRole('group', { name: 'settings.ghosts.usage.downloadsValue' })).toBeTruthy();
    cleanup();
    mount(plugin({ currentRelease: null, downloadStatistics: { requestCount: '0' }, usageStatistics: { usageCount: '0' } }));
    await screen.findByRole('list', { name: `${team}.maintainers` });
    expect(screen.queryByRole('group', { name: 'settings.ghosts.usage.downloadsValue' })).toBeNull();
  });

  // Greptile review on #12495 (P1): a refresh while the dialog was open replaced the audience the
  // dialog compared against, so an untouched copy counted as a change and saving restored an
  // audience someone else had just narrowed. Minimal failing input: open, a refresh narrows the
  // audience elsewhere — save stays disabled, the dialog says so and shows the latest audience;
  // only a new edit enables saving, and it is based on the latest audience.
  it('does not save an old copy over an audience changed elsewhere while the dialog is open', async () => {
    const wide = plugin({ visibilityAudience: { type: 'matchAny', emails: ['a@acme.com', 'b@acme.com'] } });
    const narrowed = plugin({ visibilityAudience: { type: 'matchAny', emails: ['a@acme.com'] } });
    api.plugin.mockResolvedValueOnce(wide).mockResolvedValue(narrowed);
    const page = (signal: string) => <TeamPluginDetail pluginId="p1" memberId="m-li" orgName="Acme" localPlugins={[]}
      onStartPublish={vi.fn(async () => true)} refreshSignal={signal} />;
    const view = render(page('s1'));
    fireEvent.click(await screen.findByRole('button', { name: `${team}.edit` }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: `${team}.save` });
    expect(save).toHaveProperty('disabled', true);
    expect(within(dialog).getByText('b@acme.com')).toBeTruthy();
    view.rerender(page('s2'));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByText(`${team}.audienceChangedElsewhere`)).toBeTruthy();
    await waitFor(() => expect(within(dialog).queryByText('b@acme.com')).toBeNull());
    expect(save).toHaveProperty('disabled', true);
    expect(within(dialog).queryByText(`${team}.saveImpact`)).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'settings.ghosts.audience.all' }));
    expect(save).toHaveProperty('disabled', false);
    // Only here, once the audience really changes: who can install after saving.
    expect(within(dialog).getByText(`${team}.saveImpact`)).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('p1', { visibilityAudience: { type: 'all' } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // Greptile review on #12495: the detail saved an audience over the protocol's per-kind limit
  // (500) and only learned from the server. Minimal failing input: 502 stored emails, one removed —
  // a real change, yet still 501: the dialog says so and saving stays disabled.
  it('does not save an audience over the per-kind limit', async () => {
    const emails = Array.from({ length: 502 }, (_, index) => `u${index}@acme.com`);
    mount(plugin({ visibilityAudience: { type: 'matchAny', emails } }));
    fireEvent.click(await screen.findByRole('button', { name: `${team}.edit` }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.audience.picker.remove u0@acme.com' }));
    expect(within(dialog).getByText('settings.ghosts.audience.tooMany')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: `${team}.save` })).toHaveProperty('disabled', true);
  });

  // Like the public detail (product prototype): opening the detail while the window is shown reads
  // its review result, and a dot stays beside 「当前提审」 for this visit.
  it('reads a new review result on opening and marks 当前提审 with a dot', async () => {
    reviews.updates = [
      { pluginId: 'org:p1', key: 'e1', status: 'rejected', unread: true },
      { pluginId: 'org:p9', key: 'k9', status: 'approved', unread: true },
    ];
    mount(plugin());
    await waitFor(() => expect(reviews.markRead).toHaveBeenCalledWith('org:p1', 'e1'));
    expect(reviews.markRead).toHaveBeenCalledTimes(1);
    const submission = screen.getByRole('region', { name: `${copy}.currentSubmission` });
    expect(within(submission).getByRole('img', { name: `${copy}.unreadReview` })).toBeTruthy();
  });

  // Product prototype: 当前提审 shows the latest submission whatever its result, like the public
  // detail — 「版本 · 状态」, when it was submitted, and why it was returned right under that.
  it('shows the latest submission with its state, submit time and return reason', async () => {
    const at = '2026-11-18T00:00:00.000Z';
    mount(plugin({ currentRelease: { id: 'r1', version: '1.0.0', reviewStatus: 'approved', publishedAt: at } }));
    let submission = await screen.findByRole('region', { name: `${copy}.currentSubmission` });
    expect(within(submission).getByText(`${copy}.review.published`)).toBeTruthy();
    expect(within(submission).getByText(`${copy}.submittedAt`)).toBeTruthy();
    expect(within(submission).queryByText(`${copy}.timeUnavailable`)).toBeNull();

    cleanup();
    mount(plugin({ status: 'disabled', disabledBy: 'organization', disabledByAdmin: true }));
    submission = await screen.findByRole('region', { name: `${copy}.currentSubmission` });
    expect(within(submission).getByText(`${copy}.market.disabled`)).toBeTruthy();

    cleanup();
    // The returned version's submit time is not in the detail: it comes from the history read with the page.
    api.releases.mockResolvedValue({ nextCursor: null, releases: [{ id: 'r3', version: '1.2.0', reviewStatus: 'rejected', publishedAt: at, review: null }] });
    mount(plugin({
      latestRelease: { id: 'r3', version: '1.2.0', reviewStatus: 'rejected' },
      lastRejection: { createdAt: at, detail: { reason: '缺少使用说明' } },
    }));
    submission = await screen.findByRole('region', { name: `${copy}.currentSubmission` });
    expect(within(submission).getByText('1.2.0')).toBeTruthy();
    expect(within(submission).getByText(`${copy}.review.rejected`)).toBeTruthy();
    expect(within(submission).getByText('缺少使用说明')).toBeTruthy();
    await waitFor(() => expect(within(submission).queryByText(`${copy}.timeUnavailable`)).toBeNull());
  });

  it('waits until the page is visible before marking a result read', async () => {
    const key = 'e1';
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
    const key = 'e1';
    reviews.updates = [{ pluginId: 'org:p1', key, status: 'approved', unread: true }];
    mount(plugin());
    act(() => windowHidden?.(true));
    await screen.findByRole('list', { name: `${team}.maintainers` });
    expect(reviews.markRead).not.toHaveBeenCalled();
    act(() => windowHidden?.(false));
    await waitFor(() => expect(reviews.markRead).toHaveBeenCalledWith('org:p1', key));
  });

  // Release history starts expanded (product prototype) and shows, per version, the submit time,
  // review outcome, decision time and the return reason; versions from older servers (no review
  // field) only show what is known.
  it('shows each version with its review result in the expanded history', async () => {
    api.releases.mockResolvedValueOnce({ nextCursor: 'c2', releases: [
      { id: 'r3', version: '1.2.0', reviewStatus: 'rejected', publishedAt: '2026-11-18T00:00:00.000Z',
        review: { outcome: 'rejected', decidedAt: '2026-11-19T00:00:00.000Z', reason: '缺少使用说明', actorType: 'organization' } },
      { id: 'r2', version: '1.1.0', reviewStatus: 'pending', publishedAt: '2026-11-17T00:00:00.000Z', review: null },
    ] }).mockResolvedValueOnce({ nextCursor: null, releases: [
      { id: 'r1', version: '1.0.0', reviewStatus: 'approved', publishedAt: '2026-11-01T00:00:00.000Z' },
    ] });
    mount(plugin());
    const history = await screen.findByRole('list', { name: `${copy}.history` });
    expect(api.releases).toHaveBeenCalledTimes(1);
    const rows = within(history).getAllByRole('listitem');
    expect(within(rows[0]!).getByText(`${copy}.review.rejected`)).toBeTruthy();
    // Product prototype: version · result, when it was submitted, then the reason — no headings and
    // no decision time.
    expect(within(rows[0]!).getByText(formatted('2026-11-18T00:00:00.000Z'))).toBeTruthy();
    expect(rows[0]!.textContent).not.toContain(formatted('2026-11-19T00:00:00.000Z'));
    expect(within(rows[0]!).getByText('缺少使用说明')).toBeTruthy();
    expect(within(history).queryByText(`${copy}.reason`)).toBeNull();
    expect(within(history).queryByText(new RegExp(`${copy}.submittedAt|${team}.decidedAt`))).toBeNull();
    expect(within(rows[1]!).getByText(`${copy}.review.pending`)).toBeTruthy();
    expect(within(rows[1]!).getByText(formatted('2026-11-17T00:00:00.000Z'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `${copy}.loadMoreVersions` }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: `${copy}.history` })).getAllByRole('listitem')).toHaveLength(3));
    expect(api.releases).toHaveBeenLastCalledWith('p1', 'c2');
    const oldServer = within(screen.getByRole('list', { name: `${copy}.history` })).getAllByRole('listitem')[2]!;
    expect(within(oldServer).getByText(formatted('2026-11-01T00:00:00.000Z'))).toBeTruthy();
    // The listed version reads 「已上架」 like 当前提审 (product prototype).
    expect(within(oldServer).getByText(`${copy}.review.published`)).toBeTruthy();
  });

  // Greptile review on #12208: release history read before a refresh can be stale. Minimal
  // failing input: the history shows pending, refresh after it was rejected — the open list must
  // show the rejection, and a collapsed list must be read again when it is reopened.
  it('rereads open release history on refresh and drops collapsed history until reopened', async () => {
    const at = '2026-11-18T00:00:00.000Z';
    const release = (reviewStatus: string) => ({ nextCursor: null, releases: [{ id: 'r2', version: '1.1.0', reviewStatus, publishedAt: at,
      review: reviewStatus === 'pending' ? null : { outcome: reviewStatus, decidedAt: at, reason: null, actorType: 'organization' } }] });
    api.releases.mockResolvedValueOnce(release('pending')).mockResolvedValueOnce(release('rejected'))
      .mockResolvedValueOnce(release('approved'));
    api.plugin.mockResolvedValue(plugin());
    render(<TeamPluginDetail pluginId="p1" memberId="m-li" orgName="Acme" localPlugins={[]} onStartPublish={vi.fn(async () => true)}
      renderHeaderAction={(refresh) => <button onClick={refresh}>refresh detail</button>} />);
    const history = () => screen.getByRole('list', { name: `${copy}.history` });
    await screen.findByRole('list', { name: `${copy}.history` });
    expect(within(history()).getByText(`${copy}.review.pending`)).toBeTruthy();
    fireEvent.click(screen.getByText('refresh detail'));
    await waitFor(() => expect(within(history()).getByText(`${copy}.review.rejected`)).toBeTruthy());
    expect(api.releases).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText(`${copy}.history`));
    fireEvent.click(screen.getByText('refresh detail'));
    await waitFor(() => expect(api.plugin).toHaveBeenCalledTimes(3));
    expect(api.releases).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText(`${copy}.history`));
    await waitFor(() => expect(within(history()).getByText(`${copy}.review.approved`)).toBeTruthy());
    expect(api.releases).toHaveBeenCalledTimes(3);
  });

  // Greptile review on #12495: collapsing kept the old list (and a read still on its way), so
  // reopening showed stale records. Minimal failing input: the first read is still pending, collapse,
  // the old read answers, reopen — the old answer is dropped and reopening reads again.
  it('drops release history and a pending read on collapse and reads again when reopened', async () => {
    const at = '2026-11-18T00:00:00.000Z';
    let answerOld!: (value: unknown) => void;
    api.releases.mockReturnValueOnce(new Promise((resolve) => { answerOld = resolve; }))
      .mockResolvedValueOnce({ nextCursor: null, releases: [{ id: 'r2', version: '1.1.0', reviewStatus: 'rejected', publishedAt: at,
        review: { outcome: 'rejected', decidedAt: at, reason: null, actorType: 'organization' } }] });
    api.plugin.mockResolvedValue(plugin());
    render(<TeamPluginDetail pluginId="p1" memberId="m-li" orgName="Acme" localPlugins={[]} onStartPublish={vi.fn(async () => true)} />);
    await screen.findByRole('list', { name: `${team}.maintainers` });
    await waitFor(() => expect(api.releases).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.click(screen.getByText(`${copy}.history`));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    await act(async () => answerOld({ nextCursor: null, releases: [{ id: 'r2', version: '1.1.0', reviewStatus: 'pending', publishedAt: at, review: null }] }));
    expect(screen.queryByRole('list', { name: `${copy}.history` })).toBeNull();
    fireEvent.click(screen.getByText(`${copy}.history`));
    const history = await screen.findByRole('list', { name: `${copy}.history` });
    expect(within(history).getByText(`${copy}.review.rejected`)).toBeTruthy();
    expect(within(history).queryByText(`${copy}.review.pending`)).toBeNull();
    expect(api.releases).toHaveBeenCalledTimes(2);
  });

  // A new review event and a new change signal arrive together: the change signal reloads the
  // detail, the maintainers and the open history once; the review result alone never reads again.
  it('reloads once when a change signal and a newer review result arrive together', async () => {
    const at = '2026-11-18T00:00:00.000Z';
    api.releases.mockResolvedValue({ nextCursor: null, releases: [{ id: 'r1', version: '1.0.0', reviewStatus: 'approved', publishedAt: at, review: null }] });
    const newer = plugin({ latestReviewEvent: { id: 'e2', kind: 'approved', at, releaseId: 'r1', actorType: 'organization' } });
    api.plugin.mockResolvedValueOnce(plugin()).mockResolvedValue(newer);
    const page = (signal: string) => <TeamPluginDetail pluginId="p1" memberId="m-li" orgName="Acme" localPlugins={[]}
      onStartPublish={vi.fn(async () => true)} refreshSignal={signal} />;
    const view = render(page('s1'));
    await screen.findByRole('list', { name: `${copy}.history` });
    expect(api.releases).toHaveBeenCalledTimes(1);
    reviews.updates = [{ pluginId: 'org:p1', key: 'e2', status: 'approved', unread: true }];
    view.rerender(page('s2'));
    await waitFor(() => expect(reviews.markRead).toHaveBeenCalledWith('org:p1', 'e2'));
    await waitFor(() => expect(api.releases).toHaveBeenCalledTimes(2));
    expect(api.plugin).toHaveBeenCalledTimes(2);
    expect(api.maintainers).toHaveBeenCalledTimes(2);
    // A review result without a change signal is only read, not reloaded.
    reviews.updates = [{ pluginId: 'org:p1', key: 'e3', status: 'approved', unread: true }];
    view.rerender(page('s2'));
    await waitFor(() => expect(reviews.markRead).toHaveBeenCalledWith('org:p1', 'e3'));
    expect(api.plugin).toHaveBeenCalledTimes(2);
  });

  // Greptile review on #12208: when the first detail read fails there is no detail and so no
  // header refresh. Minimal failing input: plugin() rejects once — the page must offer a retry that
  // recovers once the network is back.
  it('offers a retry when the first detail read fails and recovers in place', async () => {
    api.plugin.mockRejectedValueOnce(new Error('[NETWORK_UNREACHABLE] offline')).mockResolvedValue(plugin());
    render(<TeamPluginDetail pluginId="p1" memberId="m-li" orgName="Acme" localPlugins={[]} onStartPublish={vi.fn(async () => true)} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.audience.picker.retry' }));
    expect(await screen.findByRole('list', { name: `${team}.maintainers` })).toBeTruthy();
    expect(api.plugin).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
