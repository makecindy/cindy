/** @vitest-environment jsdom */
/**
 * #1541 publish confirmation screen (conversation and UI publishing share it).
 * Protects: the audience the user sees and returns — conversation preselection with unmatched
 * names, "specified" needs at least one item, and a screen that may not edit the audience never
 * returns one. Entry: PluginPublisherConfirmHost driven by the real preload push shape. jsdom tier.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginPublisherConfirmPayload } from '../../../../shared/pluginPublisher';
import { PluginPublisherConfirmHost } from '../PluginPublisherConfirmHost';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  isDataOwnerPushStampCurrent: (stamp: { dataOwnerId: string }) => stamp.dataOwnerId === 'owner-a',
}));

const audience = 'settings.ghosts.audience';
let push: ((request: unknown) => void) | null = null;
const resolveConfirm = vi.fn(async () => ({ handled: true }));

beforeEach(() => {
  push = null;
  resolveConfirm.mockClear();
  Object.assign(window, {
    electronAPI: {
      pluginPublisher: {
        onConfirm: (callback: (request: unknown) => void) => {
          push = callback;
          return () => { push = null; };
        },
        resolveConfirm,
      },
      pluginAuthor: {
        departments: vi.fn(async () => [
          { id: 'd-tech', name: '技术部', parentId: null, sortOrder: 1 },
          { id: 'd-fe', name: '前端组', parentId: 'd-tech', sortOrder: 1 },
        ]),
        departmentMembers: vi.fn(async () => ({
          members: [{ membershipId: 'm-zx', displayName: '张晓', email: 'zx@acme.com', active: true }], total: 1,
        })),
        searchColleagues: vi.fn(async () => []),
        lookupColleagues: vi.fn(),
      },
      onAuthStateChange: () => () => undefined,
    },
  });
});
afterEach(cleanup);

function request(audienceContext: PluginPublisherConfirmPayload['audience'], requestId = 'request-1'): PluginPublisherConfirmPayload {
  return {
    requestId,
    ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    facts: { orgSlug: 'acme', orgName: 'Acme', ghostId: 'meeting-notes', name: 'Meeting Notes', version: '1.0.0', sizeBytes: 2048 },
    audience: audienceContext,
  };
}

function deliver(payload: PluginPublisherConfirmPayload) {
  act(() => push?.(payload));
  return screen.getByRole('dialog');
}

describe('PluginPublisherConfirmHost', () => {
  it('preselects what the user asked for and marks names it could not match', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' },
      initial: { type: 'matchAny', departmentIds: ['d-tech'], membershipIds: ['m-wang', 'm-zhao'] },
      members: [
        { membershipId: 'm-wang', displayName: '王一鸣', email: 'wang@acme.com' },
        { membershipId: 'm-zhao', displayName: '赵晴', email: 'zhao@acme.com', department: { id: 'd-fin', name: '财务部' } },
      ],
      unresolved: [{ kind: 'member', text: '赵六', reason: 'not_found' }, { kind: 'member', text: '李安', reason: 'ambiguous' }],
    }));
    // Preselected people read 「名字 · 部门」, or 「名字 · 邮箱」 when the server gives no department,
    // so namesakes can be told apart.
    expect(within(dialog).getByText('· wang@acme.com')).toBeTruthy();
    expect(within(dialog).getByText('· 财务部')).toBeTruthy();
    expect(within(dialog).queryByText('· zhao@acme.com')).toBeNull();
    expect((within(dialog).getByRole('radio', { name: `${audience}.specified` }) as HTMLInputElement).checked).toBe(true);
    expect(await within(dialog).findByText('技术部')).toBeTruthy();
    expect(within(dialog).getByText('赵六').nextSibling?.textContent).toBe(`${audience}.notFound`);
    expect(within(dialog).getByText('李安').nextSibling?.textContent).toBe(`${audience}.ambiguous`);

    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, {
      type: 'matchAny', departmentIds: ['d-tech'], membershipIds: ['m-wang', 'm-zhao'],
    }));
  });

  // Product decision on #12495: a nested department reads 「前端组 · 技术部」 (its parent, from the
  // department tree already read) on the confirmation chips and in the picker's selected list, and
  // people there read 「名字 · 部门」 like the chips. Minimal failing input: a selected child
  // department and a member with a department.
  it('names the parent department of a nested department and the department of a member', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' },
      initial: { type: 'matchAny', departmentIds: ['d-tech', 'd-fe'], membershipIds: ['m-zhao'] },
      members: [{ membershipId: 'm-zhao', displayName: '赵晴', email: 'zhao@acme.com', department: { id: 'd-fin', name: '财务部' } }],
      unresolved: [],
    }));
    const chips = await within(dialog).findByRole('list', { name: `${audience}.selectedLabel` });
    await waitFor(() => expect(within(chips).getByText('前端组')).toBeTruthy());
    expect(within(chips).getByText('前端组').closest('li')?.textContent).toContain('· 技术部');
    // A top-level department has no parent to name.
    expect(within(chips).getByText('技术部').closest('li')?.textContent).not.toContain('·');

    fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`${audience}.add`) }));
    const picker = await screen.findByRole('dialog', { name: `${audience}.picker.title` });
    const pickedDepartments = within(picker).getAllByRole('list', { name: `${audience}.picker.departments` }).at(-1)!;
    expect(within(pickedDepartments).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['技术部', '前端组技术部']);
    const pickedMembers = within(picker).getByRole('list', { name: `${audience}.picker.members` });
    expect(pickedMembers.textContent).toContain('财务部');
    expect(pickedMembers.textContent).not.toContain('zhao@acme.com');
  });

  // Product prototype: choosing 指定部门和成员 with nothing selected opens the picker at once, and
  // cancelling it with still nothing selected goes back to 全部成员. A specified audience needs at
  // least one item: removing the last one shows the requirement and blocks publishing.
  it('opens the picker for a new specified audience, reverts on cancel, and requires at least one item', async () => {
    render(<PluginPublisherConfirmHost />);
    let dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'all' }, members: [], unresolved: [],
    }));
    const publish = within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' });
    expect((within(dialog).getByRole('radio', { name: `${audience}.all` }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: `${audience}.specified` }));
    const picker = await screen.findByRole('dialog', { name: `${audience}.picker.title` });
    fireEvent.click(within(picker).getByRole('button', { name: `${audience}.picker.cancel` }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `${audience}.picker.title` })).toBeNull());
    expect((within(dialog).getByRole('radio', { name: `${audience}.all` }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(publish);
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, { type: 'all' }));

    dialog = await waitFor(() => deliver(request({
      kind: 'editable', isNew: false, current: { type: 'matchAny', emails: ['a@acme.com'] },
      initial: { type: 'matchAny', emails: ['a@acme.com'] }, members: [], unresolved: [],
    }, 'request-2')));
    expect(within(dialog).queryByText(`${audience}.requireOne`)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: `${audience}.picker.remove` }));
    expect(within(dialog).getByText(`${audience}.requireOne`)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' })).toHaveProperty('disabled', true);
    // The screen does not repeat what happens to people outside the audience (only the edit dialog does).
    expect(within(dialog).queryByText(`${audience}.impact`)).toBeNull();
  });

  it('blocks publishing when the audience the user asked for cannot be applied', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({ kind: 'blocked', reason: 'locked' }));
    expect(within(dialog).getByRole('alert').textContent).toContain(`${audience}.blockedLocked`);
    expect(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' })).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.cancel' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', false, undefined));
  });

  // #1593 publish-context: an upload the server rejects for anyone (member publishing off,
  // archived or managed plugin) is explained and cannot be confirmed.
  it('explains why a plugin cannot be published and blocks confirming', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({ kind: 'denied', reason: 'forbidden' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('settings.ghosts.publish.denied.forbidden');
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' })).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.cancel' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', false, undefined));
  });

  it('keeps the current audience when it may not be edited', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({ kind: 'locked' }));
    expect(within(dialog).getByText(`${audience}.keepCurrent`)).toBeTruthy();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, undefined));
  });

  // #1541 review: publish requests parse roles strictly, so a current audience with legacy role
  // names is shown read-only with where to change it, and confirming sends no audience.
  it('keeps a current audience with legacy roles read-only and explains where to change it', async () => {
    render(<PluginPublisherConfirmHost />);
    let dialog = deliver(request({ kind: 'locked', reason: 'legacyRoles' }));
    expect(within(dialog).getByText(`${audience}.keepCurrent`)).toBeTruthy();
    expect(within(dialog).getByText(`${audience}.legacyRolesNote`)).toBeTruthy();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, undefined));

    dialog = await waitFor(() => deliver(request({ kind: 'blocked', reason: 'legacyRoles' }, 'request-2')));
    expect(within(dialog).getByRole('alert').textContent).toContain(`${audience}.blockedLegacyRoles`);
    expect(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' })).toHaveProperty('disabled', true);
  });

  // #1504 rule 1 picker shape: members of a selected department show "included"; a full email with
  // no active member can be added on its own; the result returns to the confirmation screen.
  it('picks departments, shows included members and adds an email from the picker', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'all' }, members: [], unresolved: [],
    }));
    fireEvent.click(within(dialog).getByRole('radio', { name: `${audience}.specified` }));
    const picker = await screen.findByRole('dialog', { name: `${audience}.picker.title` });
    fireEvent.click(await within(picker).findByRole('button', { name: `${audience}.picker.expand` }));
    const member = await within(picker).findByText('张晓');
    fireEvent.click(within(picker).getAllByRole('checkbox')[0]!);
    await waitFor(() => expect(member.closest('label')?.textContent).toContain(`${audience}.picker.included`));
    expect(within(member.closest('label')!).getByRole('checkbox')).toHaveProperty('disabled', true);

    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: 'Guest@Partner.com' } });
    fireEvent.click(await within(picker).findByText(`${audience}.picker.addEmail`));
    fireEvent.click(within(picker).getByRole('button', { name: `${audience}.picker.confirm` }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, {
      type: 'matchAny', departmentIds: ['d-tech'], emails: ['guest@partner.com'],
    }));
  });

  // Greptile review on #12208: a failed department read replaced the whole picker body, hiding
  // member search results and adding by email while those requests still ran. Minimal failing
  // input: departments() rejects, then searching a name and an email.
  it('keeps member search and adding by email when the department list fails', async () => {
    const author = (window as unknown as { electronAPI: { pluginAuthor: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.pluginAuthor;
    author.departments.mockRejectedValue(new Error('[NETWORK_UNREACHABLE] offline'));
    author.searchColleagues.mockResolvedValue([{ membershipId: 'm-wang', displayName: '王一鸣', email: 'wang@acme.com', active: true }]);
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'all' }, members: [], unresolved: [],
    }));
    fireEvent.click(within(dialog).getByRole('radio', { name: `${audience}.specified` }));
    const picker = await screen.findByRole('dialog', { name: `${audience}.picker.title` });
    expect(await within(picker).findByRole('alert')).toBeTruthy();
    expect(within(picker).getByRole('button', { name: `${audience}.picker.retry` })).toBeTruthy();
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: '王一鸣' } });
    expect(await within(picker).findByText('王一鸣')).toBeTruthy();
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: 'guest@partner.com' } });
    expect(await within(picker).findByText(`${audience}.picker.addEmail`)).toBeTruthy();
    expect(within(picker).getByRole('button', { name: `${audience}.picker.retry` })).toBeTruthy();
  });

  // Greptile review on #12495: an audience over the protocol's per-kind limit (500) was only
  // rejected after the upload. Minimal failing input: 501 emails — the screen says which kind is
  // over and publishing stays disabled; at 500 it may publish.
  it('blocks publishing an audience over the per-kind limit and says which kind', async () => {
    const emails = (count: number) => Array.from({ length: count }, (_, index) => `u${index}@acme.com`);
    render(<PluginPublisherConfirmHost />);
    const over = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'matchAny', emails: emails(501) }, members: [], unresolved: [],
    }));
    expect(within(over).getByText(`${audience}.tooMany`)).toBeTruthy();
    expect(within(over).getByRole('button', { name: 'settings.ghosts.publish.confirm' })).toHaveProperty('disabled', true);
    fireEvent.click(within(over).getByRole('button', { name: 'settings.ghosts.publish.cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const within500 = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'matchAny', emails: emails(500) }, members: [], unresolved: [],
    }, 'request-2'));
    expect(within(within500).queryByText(`${audience}.tooMany`)).toBeNull();
    expect(within(within500).getByRole('button', { name: 'settings.ghosts.publish.confirm' })).toHaveProperty('disabled', false);
  });

  // Greptile review on #12469: adding by email waited for a successful colleague search. Minimal
  // failing input: the search fails, or the email is longer than the search accepts (254) but
  // within the protocol limit (320) — the email can still be added, and the long one is never
  // sent to the search.
  // Department search (cindy-server, same /api/me/colleagues?q=): searching 「前端」 lists the
  // department and, among members, the people of that department. Minimal failing input: select
  // the department found by the search — its members (by primary department, also through a
  // selected parent) must read 「已包含」 and not be picked again; a member without a department
  // (older servers) stays selectable.
  it('marks members found through their department as included once that department is selected', async () => {
    const author = (window as unknown as { electronAPI: { pluginAuthor: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.pluginAuthor;
    author.searchColleagues.mockResolvedValue([
      { membershipId: 'm-zz', displayName: '周舟', email: 'zz@acme.com', department: { id: 'd-fe', name: '前端组' }, active: true },
      { membershipId: 'm-old', displayName: '钱前', email: 'qq@acme.com', active: true },
    ]);
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'all' }, members: [], unresolved: [],
    }));
    fireEvent.click(within(dialog).getByRole('radio', { name: `${audience}.specified` }));
    const picker = await screen.findByRole('dialog', { name: `${audience}.picker.title` });
    await within(picker).findByText('技术部');
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: '前端' } });
    const members = await within(picker).findByRole('list', { name: `${audience}.picker.members` });
    const row = (name: string) => within(members).getByText(name).closest('label')!;
    expect(row('周舟').textContent).not.toContain(`${audience}.picker.included`);
    expect(within(row('周舟')).getByRole('checkbox')).toHaveProperty('disabled', false);

    const departments = within(picker).getByRole('list', { name: `${audience}.picker.departments` });
    fireEvent.click(within(within(departments).getByText('前端组').closest('label')!).getByRole('checkbox'));
    await waitFor(() => expect(row('周舟').textContent).toContain(`${audience}.picker.included`));
    expect(within(row('周舟')).getByRole('checkbox')).toHaveProperty('disabled', true);
    expect(within(row('周舟')).getByRole('checkbox')).toHaveProperty('checked', true);
    expect(row('钱前').textContent).not.toContain(`${audience}.picker.included`);
    expect(within(row('钱前')).getByRole('checkbox')).toHaveProperty('disabled', false);

    // Through a selected parent department as well.
    fireEvent.click(within(within(departments).getByText('前端组').closest('label')!).getByRole('checkbox'));
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: '技术' } });
    const parents = await within(picker).findByRole('list', { name: `${audience}.picker.departments` });
    await waitFor(() => expect(within(parents).getByText('技术部')).toBeTruthy());
    fireEvent.click(within(within(parents).getByText('技术部').closest('label')!).getByRole('checkbox'));
    const again = await within(picker).findByRole('list', { name: `${audience}.picker.members` });
    await waitFor(() => expect(within(again).getByText('周舟').closest('label')!.textContent).toContain(`${audience}.picker.included`));

    fireEvent.click(within(picker).getByRole('button', { name: `${audience}.picker.confirm` }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, { type: 'matchAny', departmentIds: ['d-tech'] }));
  });

  it('adds an email when the colleague search fails or cannot take the text', async () => {
    const author = (window as unknown as { electronAPI: { pluginAuthor: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.pluginAuthor;
    author.searchColleagues.mockRejectedValue(new Error('[NETWORK_UNREACHABLE] offline'));
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'all' }, members: [], unresolved: [],
    }));
    fireEvent.click(within(dialog).getByRole('radio', { name: `${audience}.specified` }));
    const picker = await screen.findByRole('dialog', { name: `${audience}.picker.title` });
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: 'guest@partner.com' } });
    expect(await within(picker).findByText(`${audience}.picker.addEmail`)).toBeTruthy();
    const calls = author.searchColleagues.mock.calls.length;
    const long = `${'a'.repeat(260)}@partner.com`;
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: long } });
    expect(await within(picker).findByText(`${audience}.picker.addEmail`)).toBeTruthy();
    // Never searched: the member group says "no members" at once instead of loading or failing.
    expect(within(picker).getByText(`${audience}.picker.noMembers`)).toBeTruthy();
    expect(within(picker).queryByRole('alert')).toBeNull();
    expect(author.searchColleagues.mock.calls.length).toBe(calls);
    expect(author.searchColleagues).not.toHaveBeenCalledWith(long);
    // Beyond the protocol's 320 characters it is not an email the server accepts.
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: `${'a'.repeat(320)}@partner.com` } });
    await waitFor(() => expect(within(picker).queryByText(`${audience}.picker.addEmail`)).toBeNull());
  });
});
