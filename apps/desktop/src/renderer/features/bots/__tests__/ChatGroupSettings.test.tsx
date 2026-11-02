// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import { transferableAbortController } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatGroupSettings } from '../ChatGroupSettings';
import { BotSettingsDrawer } from '../BotSettingsDrawer';
import type { BotGroupSummary } from '../../../../shared/botGroupChat';
const mocks = vi.hoisted(() => ({ manage: vi.fn(), ownedBots: vi.fn(), refresh: vi.fn(), confirm: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));
const profiles = vi.hoisted(() => ({
  list: [{ id: 'bot', name: 'Partner', status: 'active', sessions: [] as Array<{ id: string }>, capabilities: {}, skills: [] as string[] }],
}));
const translate = (key: string, options?: { name?: string }) =>
  typeof options?.name === 'string' ? `${key}:${options.name}` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('../botPronounContext', () => ({
  useBotTranslation: () => ({ t: translate }),
  BotPronounProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('../RemoteBotSettings', () => ({ RemoteBotSettings: () => null }));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => ({ demotedBotIds: [] as string[] }) }));
vi.mock('../BotsHomeView', () => ({
  BotSettings: ({ bot, initialPage }: { bot: { id: string; name: string }; initialPage?: string }) => (
    <div data-testid="bot-settings" data-bot-id={bot.id} data-initial-page={initialPage}>{bot.name}</div>
  ),
}));
vi.mock('../ChatInviteDialog', () => ({ ChatInviteDialog: ({ groupId }: { groupId: string }) => <div data-testid="invite-link-dialog" data-group={groupId} /> }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/components/settings/ProfileEditDialog', () => ({ ProfileEditDialog: ({ open, avatarEditor }: {
  open: boolean; avatarEditor?: { hint: string; save(avatar: { type: 'reset' }): Promise<void> };
}) => open && avatarEditor ? <button onClick={() => void avatarEditor.save({ type: 'reset' })}>{avatarEditor.hint}</button> : null }));
vi.mock('../botStore', () => ({ useBotProfiles: () => profiles.list }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => null }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: mocks.refresh }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => true }));
const key = (name: string) => `bots.groupChat.server.settings.${name}`;
const LEAVE = 'bots.groupChat.lifecycle.leave';
/** A settings row's accessible name is its title followed by its one-line hint. */
const row = (title: string) => screen.getByRole('button', { name: name => name.startsWith(title) });
const queryRow = (title: string) => screen.queryByRole('button', { name: name => name.startsWith(title) });
const field = (name: string) => screen.getByRole('textbox', { name: key(name) }) as HTMLInputElement;
const openMenu = (trigger: HTMLElement) => fireEvent.keyDown(trigger, { key: 'Enter' });

function renderAt(value: BotGroupSummary, page?: string) {
  const entry = `/bots/groups/room?groupSettings=1${page ? `&groupSettingsPage=${encodeURIComponent(page)}` : ''}`;
  const tree = (next: BotGroupSummary) => <MemoryRouter initialEntries={[entry]}><LocationProbe /><ChatGroupSettings group={next} /></MemoryRouter>;
  const view = render(tree(value));
  return { ...view, update: (next: BotGroupSummary) => view.rerender(tree(next)) };
}

it('keeps saved fields until a newer snapshot arrives and retries the read without repeating the write', async () => {
  const initial = { ...group(true), topic: 'Old topic', description: 'Old description' };
  const view = renderAt(initial, 'edit');
  fireEvent.change(field('name'), { target: { value: 'Saved name' } });
  fireEvent.change(field('topic'), { target: { value: 'Saved topic' } });
  fireEvent.change(field('description'), { target: { value: 'Saved description' } });
  fireEvent.submit(field('name').closest('form')!);
  // Back on the main page, the saved values show while the server snapshot is on its way.
  expect(await screen.findByText('Saved name')).toBeTruthy();
  expect([screen.getByText('Saved topic'), screen.getByText('Saved description')]).toHaveLength(2);
  expect(mocks.refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: key('edit') }));
  expect([field('name').value, field('topic').value, field('description').value]).toEqual(['Saved name', 'Saved topic', 'Saved description']);
  expect(field('name').disabled).toBe(true);
  // A delayed/failed list read leaves the old projection; retry must not write with its stale CAS.
  view.update({ ...initial });
  fireEvent.submit(field('name').closest('form')!);
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  expect(mocks.manage).toHaveBeenCalledOnce();
  view.update({ ...initial, name: 'Saved name', topic: 'Saved topic', description: 'Saved description', revision: 2 });
  fireEvent.click(await screen.findByRole('button', { name: key('edit') }));
  expect(field('name').disabled).toBe(false);
  fireEvent.change(field('topic'), { target: { value: 'Next draft' } });
  fireEvent.submit(field('name').closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(2));
  expect(mocks.manage.mock.calls[1]![0].action).toMatchObject({ name: 'Saved name', topic: 'Next draft', description: 'Saved description', expectedRevision: 2 });
});
it.each([false, true])('keeps fields paired with their revision when a remote update precedes the save response, edit again=%s', async editAgain => {
  let completeSave!: (result: { ok: true }) => void;
  mocks.manage.mockImplementationOnce(() => new Promise(resolve => { completeSave = resolve; }));
  const initial = { ...group(true), topic: 'Initial topic', description: 'Initial description', replyMode: 'all' as const, speakingMode: 'auto' as const };
  const view = renderAt(initial, 'edit');
  fireEvent.change(field('name'), { target: { value: 'My saved name' } });
  fireEvent.submit(field('name').closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
  const remote = { ...initial, revision: 3, name: 'Remote name', topic: 'Remote topic', description: 'Remote description', replyMode: 'mentioned' as const, speakingMode: 'sequential' as const };
  view.update(remote);
  expect(field('name').value).toBe('My saved name');
  await act(async () => { completeSave({ ok: true }); });
  expect(screen.getByText(remote.name)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: key('edit') }));
  expect([field('name').value, field('topic').value, field('description').value]).toEqual([remote.name, remote.topic, remote.description]);
  if (editAgain) fireEvent.change(field('name'), { target: { value: 'My next draft' } });
  fireEvent.submit(field('name').closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(2));
  expect(mocks.manage.mock.calls[1]![0].action).toEqual({ type: 'update', name: editAgain ? 'My next draft' : remote.name, topic: remote.topic, description: remote.description, responseMode: remote.replyMode, speakingMode: remote.speakingMode, expectedRevision: remote.revision });
});
// #6806: the update payload must follow refreshed data only when no draft is pending.
it('uses the latest group revision when saving again after a successful save', async () => {
  const initial = { ...group(true), replyMode: 'mentioned' as const, speakingMode: 'sequential' as const };
  const view = renderAt(initial, 'edit');
  fireEvent.change(field('name'), { target: { value: 'Renamed' } });
  fireEvent.submit(field('name').closest('form')!);
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  view.update({ ...initial, name: 'Renamed', revision: 2 });
  // Without a topic or description the 群介绍 card offers 添加 instead of 编辑.
  fireEvent.click(await screen.findByRole('button', { name: key('add') }));
  fireEvent.submit(field('name').closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(2));
  expect(mocks.manage.mock.calls[1]![0].action.expectedRevision).toBe(2);
});
it.each([false, true])('preserves optimistic conflict detection after a remote refresh, pending draft=%s', async dirty => {
  const initial = { ...group(true), replyMode: 'all' as const, speakingMode: 'auto' as const };
  const view = renderAt(initial, 'edit');
  if (dirty) fireEvent.change(field('name'), { target: { value: 'My draft' } });
  view.update({ ...initial, name: 'Remote name', revision: 2 });
  expect(field('name').value).toBe(dirty ? 'My draft' : 'Remote name');
  if (dirty) mocks.manage.mockResolvedValue({ ok: false, errorCode: 'REVISION_CONFLICT' });
  fireEvent.submit(field('name').closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
  expect(mocks.manage.mock.calls[0]![0].action).toMatchObject({ name: dirty ? 'My draft' : 'Remote name', expectedRevision: dirty ? 1 : 2 });
  if (dirty) {
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(field('name').value).toBe('My draft');
    fireEvent.submit(field('name').closest('form')!);
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(2));
    expect(mocks.manage.mock.calls[1]![0].action.expectedRevision).toBe(1);
  }
});
function group(owned = false): BotGroupSummary {
  return { id: 'room', name: 'Team', serverBacked: true, revision: 1, members: [
    { actorId: 'me', botId: 'me', actorKind: 'human', isSelf: true, isOwned: true, name: 'My name', displayName: 'My name', role: 'member' },
    { actorId: 'bot', botId: 'bot', actorKind: 'bot', name: 'Partner', role: 'owner', isOwned: owned, guestAccess: 'chat', accessRevision: 1 },
  ] } as BotGroupSummary;
}
function activeProfile(id: string, name: string, status = 'active') {
  return { id, name, status, sessions: [] as Array<{ id: string }>, capabilities: {}, skills: [] as string[] };
}
beforeEach(() => {
  const nativeAbortController = transferableAbortController();
  vi.stubGlobal('AbortController', nativeAbortController.constructor);
  vi.stubGlobal('AbortSignal', nativeAbortController.signal.constructor);
  profiles.list = [activeProfile('bot', 'Partner')];
  vi.clearAllMocks(); mocks.manage.mockResolvedValue({ ok: true }); mocks.ownedBots.mockResolvedValue({ ok: true, bots: [] });
  mocks.confirm.mockResolvedValue(true);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: mocks } } });
});
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}
function renderGroupEntry(groupValue: BotGroupSummary, page: string) {
  return render(<RouterProvider router={createMemoryRouter([
    { path: '/bots/groups/:groupId', element: <><div data-testid="group-chat" /><LocationProbe /><ChatGroupSettings group={groupValue} /><BotSettingsDrawer /></> },
    { path: '/bots/list', element: <LocationProbe /> },
    { path: '/bots/:botId', element: <><LocationProbe /><BotSettingsDrawer /></> },
    { path: '*', element: <LocationProbe /> },
  ], { initialEntries: [`/bots/groups/room?groupSettings=1&groupSettingsPage=${encodeURIComponent(page)}`] })} />);
}

it('guides a sole owner to archive instead of offering an impossible leave', async () => {
  const alone = group();
  alone.members = [{ ...alone.members[0]!, role: 'owner' }];
  renderAt(alone);
  expect(queryRow(LEAVE)).toBeNull();
  expect(screen.queryByText(key('leaveBlocked'))).toBeNull();
  expect(screen.getByText(key('soleOwnerHint'))).toBeTruthy();
  fireEvent.click(row(key('manage')));
  fireEvent.click(row(key('archive')));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room',
    action: { type: 'archive', archived: true, expectedRevision: 1 },
  }));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({
    description: key('archiveHint'), confirmText: key('archive'),
  }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it('keeps a sole archived owner in the group and offers restoring its history', async () => {
  const alone = group();
  alone.archived = true;
  alone.members = [{ ...alone.members[0]!, role: 'owner' }];
  renderAt(alone, 'manage');
  expect(queryRow(LEAVE)).toBeNull();
  expect(screen.queryByText(key('soleOwnerHint'))).toBeNull();
  fireEvent.click(row(key('unarchive')));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room',
    action: { type: 'archive', archived: false, expectedRevision: 1 },
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// The actual dialog is covered by ProfileEditDialog.avatarCrop.test.tsx.
// Here the real group settings must supply a group destination, never account editing.
it('edits only this member avatar and hides editing on older servers', async () => {
  const view = renderAt(group(), 'profile');
  expect(screen.queryByRole('button', { name: key('editProfile') })).toBeNull();
  expect(screen.queryByRole('button', { name: key('groupAvatar') })).toBeNull();
  view.update({ ...group(), supportsMemberAvatar: true });
  fireEvent.click(screen.getByRole('button', { name: key('groupAvatar') }));
  fireEvent.click(screen.getByRole('button', { name: key('groupAvatarHint') }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({
    groupId: 'room', action: { type: 'avatar', actorId: 'me', avatar: { type: 'reset' } },
  }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
// A member keeps their own profile, but group defaults and another owner's teammate are not theirs to change.
it('lets a member change their own nickname while group management and another owner’s grant stay out of reach', async () => {
  renderAt(group(), 'edit');
  expect(screen.queryByRole('textbox', { name: key('name') })).toBeNull();
  await waitFor(() => expect(screen.getByTestId('location').textContent).not.toContain('groupSettingsPage'));
  expect(queryRow(key('manage'))).toBeNull();
  expect(queryRow('Partner')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /bots\.groupChat\.settings\.members/ }));
  expect(screen.queryByRole('button', { name: 'Partner' })).toBeNull();
  expect(screen.getByText(`${key('teammateTag')} · ${key('accessChat')}`)).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: key('tabSettings') }));
  fireEvent.click(row('My name'));
  fireEvent.change(field('nickname'), { target: { value: 'Group name' } });
  fireEvent.click(screen.getByRole('button', { name: key('save') }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: { type: 'nickname', actorId: 'me', nickname: 'Group name' } }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).not.toContain('groupSettingsPage'));
});
it('lets a companion owner manage a group owned by their companion', async () => {
  const view = renderAt(group(true), 'companion:bot');
  const radios = screen.getAllByRole('radio') as HTMLButtonElement[];
  expect(radios.map(radio => [radio.getAttribute('aria-checked'), radio.disabled])).toEqual([['false', false], ['true', false], ['false', false]]);
  expect(row(`${key('capabilitiesRow')}:Partner`)).toBeTruthy();
  view.unmount();
  renderAt(group(true));
  expect(row(key('manage'))).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /bots\.groupChat\.settings\.members/ }));
  openMenu(screen.getByRole('button', { name: 'My name' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: key('transfer') }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: { type: 'transfer', actorId: 'me' } }));
});
// Unit: the real settings UI previously offered every non-owner as a recipient.
// Human-owner rule (2026-10-28): a bot member must have no transfer action;
// a human member must still be transferable through the confirmation and IPC.
it('offers ownership transfer only to human members', async () => {
  const value = group(true);
  value.members[0]!.role = 'owner';
  value.members[1]!.role = 'member';
  value.members.push({ ...value.members[0]!, actorId: 'peer', botId: 'peer', name: 'Peer', isSelf: false, isOwned: false, role: 'member' });
  renderAt(value);
  fireEvent.click(screen.getByRole('tab', { name: /bots\.groupChat\.settings\.members/ }));
  openMenu(screen.getByRole('button', { name: 'Partner' }));
  expect(await screen.findByRole('menuitem', { name: key('makeAdmin') })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: key('transfer') })).toBeNull();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  openMenu(screen.getByRole('button', { name: 'Peer' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: key('transfer') }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: { type: 'transfer', actorId: 'peer' } }));
});
it('labels reply and speaking modes with the same words as the local group settings', () => {
  renderAt({ ...group(true), replyMode: 'all', speakingMode: 'auto' }, 'manage');
  expect(screen.getByRole('combobox', { name: 'bots.groupChat.settings.replyMode' }).textContent).toContain('bots.groupChat.settings.replyModeAll');
  expect(screen.getByRole('combobox', { name: 'bots.groupChat.settings.speakingMode' }).textContent).toContain('bots.groupChat.settings.speakingModeAuto');
  expect(screen.queryByText(key('replyMode'))).toBeNull();
});

// bot-group-chat.md §4.0 (2026-10-23): single-speaker groups keep 「只有被 @ 的回答」 and the
// 分工 settings (organizer, project folder); only the speaking mode no longer applies.
// 群管理 applies a new reply mode at once with the live name and revision, not a separate save.
it('keeps reply mode and 分工 settings for single-speaker groups and saves mention-only replies', async () => {
  renderAt({ ...group(true), singleSpeaker: true, replyMode: 'all', speakingMode: 'auto', topic: 'Topic' }, 'manage');
  expect(screen.queryByRole('combobox', { name: 'bots.groupChat.settings.speakingMode' })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'bots.groupChat.organizer' })).toBeTruthy();
  expect(screen.getByText('bots.groupChat.settings.projectDir')).toBeTruthy();
  fireEvent.click(screen.getByRole('combobox', { name: 'bots.groupChat.settings.replyMode' }));
  fireEvent.click(screen.getByRole('option', { name: 'bots.groupChat.settings.replyModeMentioned' }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: {
    type: 'update', name: 'Team', topic: 'Topic', description: '', responseMode: 'mentioned', speakingMode: 'auto', expectedRevision: 1,
  } }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(screen.getByRole('combobox', { name: 'bots.groupChat.settings.replyMode' }).textContent).toContain('bots.groupChat.settings.replyModeMentioned');
});

it('does not offer leaving when this account owns every group owner, including its companion', () => {
  renderAt(group(true));
  expect(queryRow(LEAVE)).toBeNull();
  expect(screen.getByText(key('leaveBlocked'))).toBeTruthy();
  expect(row(key('manage'))).toBeTruthy();
});

it('uses the existing member leave action without changing the group archive state', async () => {
  renderAt(group());
  fireEvent.click(row(LEAVE));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: { type: 'member', actorId: 'me', action: 'leave' } }));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ presentation: 'standard', description: key('leaveHint'), confirmVariant: 'destructive' }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it('keeps membership untouched when the leave confirmation is cancelled', async () => {
  mocks.confirm.mockResolvedValue(false);
  renderAt(group());
  fireEvent.click(row(LEAVE));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(mocks.manage).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it('keeps the group visible and reports a server rejection of leaving', async () => {
  mocks.manage.mockResolvedValue({ ok: false, errorCode: 'LAST_OWNER' });
  renderAt(group());
  fireEvent.click(row(LEAVE));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(row(LEAVE)).toBeTruthy();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it('confirms irreversible dissolution separately from archive and refreshes after success', async () => {
  renderAt({ ...group(true), supportsDissolve: true, supportsListRemoval: true }, 'manage');
  fireEvent.click(row('bots.groupChat.lifecycle.dissolve'));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: { type: 'dissolve', expectedRevision: 1 } }));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: 'bots.groupChat.lifecycle.dissolveNote', confirmVariant: 'destructive' }));
});
it('disables unsupported lifecycle actions and terminal edits without offering unarchive', async () => {
  const view = renderAt(group(true), 'manage');
  expect((row('bots.groupChat.lifecycle.dissolve') as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  const settled = renderAt(group(true));
  expect((row('bots.groupChat.lifecycle.hide') as HTMLButtonElement).disabled).toBe(true);
  settled.update({ ...group(true), archived: true, dissolvedAt: '2026-10-15', supportsListRemoval: true });
  expect(queryRow(key('manage'))).toBeNull();
  expect(queryRow(key('unarchive'))).toBeNull();
  expect(queryRow('My name')).toBeNull();
  expect((row('bots.groupChat.lifecycle.hide') as HTMLButtonElement).disabled).toBe(false);
});
it('does not refresh or remove the list on failed personal removal', async () => {
  mocks.manage.mockResolvedValue({ ok: false, errorCode: 'REVISION_CONFLICT' });
  renderAt({ ...group(), supportsListRemoval: true });
  fireEvent.click(row('bots.groupChat.lifecycle.hide'));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(mocks.refresh).not.toHaveBeenCalled();
});

// 测试价值
// - 生产入口与可观察结果：群设置首页的「邀请」下拉（与群头同一个组件）。成员看到同样两项；
//   「邀请朋友」在没有 canInvite 时灰色并写明原因，「邀请伙伴」列出还没进群的自己的伙伴，
//   点一下用服务端 invite 动作加入并提示。
// - Bug／规则依据：2026-10-30 群设置重设计定稿——每个群一个通用、人人一样的邀请入口；
//   旧版只有群主/管理员在群头看到链接按钮，成员带伙伴进群藏在成员列表底部的下拉里。
// - 现有覆盖缺口：此前没有用例覆盖成员视角的邀请入口与带伙伴进群。
// - 最小失败输入：普通成员，账号有一位已在群里的伙伴和一位不在群里的伙伴。
// - tier：unit。真实组件加 Radix 菜单与虚拟列表，不启动 Electron。
it('gives every member the same invite menu: a friends link only with permission, own teammates one click away', async () => {
  mocks.ownedBots.mockResolvedValue({ ok: true, bots: [{ actorId: 'bot', botId: 'bot', name: 'Partner' }, { actorId: 'spare', botId: 'spare', name: 'Spare' }] });
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'chat-group-invite-bots' ? 296 : 0;
  });
  try {
    renderAt({ ...group(true), members: [{ ...group().members[0]! }, { ...group(true).members[1]!, role: 'member' }] });
    openMenu(screen.getByTestId('chat-group-invite'));
    const friends = await screen.findByRole('menuitem', { name: name => name.startsWith(key('inviteFriendsItem')) });
    expect([friends.getAttribute('aria-disabled'), friends.textContent?.includes(key('inviteFriendsLocked'))]).toEqual(['true', true]);
    fireEvent.click(screen.getByRole('menuitem', { name: name => name.startsWith(key('inviteBotsItem')) }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Spare' }));
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: { type: 'member', actorId: 'spare', action: 'invite' } }));
    expect(mocks.toastSuccess).toHaveBeenCalledWith(`${key('inviteBotsAdded')}:Spare`);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menuitem', { name: 'Partner' })).toBeNull();
  } finally { height.mockRestore(); }
});

// 测试价值
// - 生产入口与可观察结果：群设置里真实的「工具与授权设置」按钮，以及 BotSettingsDrawer 的关闭按钮。
//   打开后应看到所选伙伴的能力页，路由仍是原群；关闭后群聊页还在。
// - Bug／规则依据：#6809。修前该按钮会进入 /bots/<id> 私聊，关闭只去掉设置参数。
// - 现有覆盖缺口：本组用例只断言按钮是否出现；抽屉用例只覆盖私聊路由上的开关。
// - 最小失败输入：群里两位已拥有且在本机名单中的伙伴，从后者在本群的权限页打开。
// - tier：unit。真实组件加 React Router，不启动 Electron。
it('keeps the original group mounted when opening and closing another owned companion’s capability settings', async () => {
  profiles.list = [activeProfile('bot', 'Partner'), activeProfile('other', 'Other')];
  const room = group(true);
  room.members = [...room.members, {
    actorId: 'other', botId: 'other', actorKind: 'bot', name: 'Other', role: 'member', isOwned: true, guestAccess: 'chat', accessRevision: 1,
    avatar: 'bot', avatarColor: 'blue', status: 'active',
  }];
  renderGroupEntry(room, 'companion:other');
  fireEvent.click(row(`${key('capabilitiesRow')}:Other`));
  const opened = screen.getByTestId('location').textContent ?? '';
  const settings = screen.queryByTestId('bot-settings');
  const dialog = screen.queryByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect({
    opened,
    botId: settings?.getAttribute('data-bot-id'),
    page: settings?.getAttribute('data-initial-page'),
    scope: dialog?.textContent?.includes(`${key('capabilityScope')}:Other`) ?? false,
    closed: screen.getByTestId('location').textContent,
    groupMounted: screen.queryByTestId('group-chat') !== null,
  }).toEqual({
    opened: expect.stringContaining('/bots/groups/room?'),
    botId: 'other',
    page: 'capabilities',
    scope: true,
    closed: '/bots/groups/room',
    groupMounted: true,
  });
});

it('returns a paused companion’s capability settings to the original group instead of the teammate list', async () => {
  profiles.list = [activeProfile('bot', 'Partner', 'paused')];
  renderGroupEntry(group(true), 'companion:bot');
  fireEvent.click(row(`${key('capabilitiesRow')}:Partner`));
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByTestId('location').textContent).toBe('/bots/groups/room');
  expect(screen.getByTestId('group-chat')).toBeTruthy();
});

it('keeps the private chat settings entry on that companion', async () => {
  profiles.list = [activeProfile('bot', 'Partner'), activeProfile('other', 'Other')];
  render(<RouterProvider router={createMemoryRouter([
    { path: '/bots/:botId', element: <><LocationProbe /><BotSettingsDrawer /></> },
    { path: '/bots/groups/:groupId', element: <LocationProbe /> },
  ], { initialEntries: ['/bots/bot?settings=1&settingsPage=capabilities&settingsBot=other'] })} />);
  expect(screen.getByTestId('bot-settings').getAttribute('data-bot-id')).toBe('bot');
  expect(screen.getByTestId('bot-settings').getAttribute('data-initial-page')).toBe('capabilities');
  expect(screen.queryByText(`${key('capabilityScope')}:Other`)).toBeNull();
  expect(screen.queryByText(`${key('capabilityScope')}:Partner`)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const closed = new URL(screen.getByTestId('location').textContent ?? '', 'https://cindy.local');
  expect(closed.pathname).toBe('/bots/bot');
  expect(closed.searchParams.get('settings')).toBeNull();
});
