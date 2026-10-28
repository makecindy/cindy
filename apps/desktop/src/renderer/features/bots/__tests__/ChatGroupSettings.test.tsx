// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import { transferableAbortController } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatGroupSettings } from '../ChatGroupSettings';
import { BotSettingsDrawer } from '../BotSettingsDrawer';
import type { BotGroupSummary } from '../../../../shared/botGroupChat';
const mocks = vi.hoisted(() => ({ manage: vi.fn(), ownedBots: vi.fn(), refresh: vi.fn(), confirm: vi.fn() }));
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
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/components/settings/ProfileEditDialog', () => ({ ProfileEditDialog: ({ open, avatarEditor }: {
  open: boolean; avatarEditor?: { hint: string; save(avatar: { type: 'reset' }): Promise<void> };
}) => open && avatarEditor ? <button onClick={() => void avatarEditor.save({ type: 'reset' })}>{avatarEditor.hint}</button> : null }));
vi.mock('../botStore', () => ({ useBotProfiles: () => profiles.list }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => null }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: mocks.refresh }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => true }));
const key = (name: string) => `bots.groupChat.server.settings.${name}`;
it('keeps saved fields until a newer snapshot arrives and retries the read without repeating the write', async () => {
  const initial = { ...group(true), topic: 'Old topic', description: 'Old description' };
  const { rerender } = render(<MemoryRouter><ChatGroupSettings group={initial} /></MemoryRouter>);
  const name = screen.getByRole('textbox', { name: key('name') }) as HTMLInputElement;
  const topic = screen.getByRole('textbox', { name: key('topic') }) as HTMLInputElement;
  const description = screen.getByRole('textbox', { name: key('description') }) as HTMLInputElement;
  fireEvent.change(name, { target: { value: 'Saved name' } });
  fireEvent.change(topic, { target: { value: 'Saved topic' } });
  fireEvent.change(description, { target: { value: 'Saved description' } });
  fireEvent.submit(name.closest('form')!);
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect([name.value, topic.value, description.value]).toEqual(['Saved name', 'Saved topic', 'Saved description']);
  expect(name.disabled).toBe(true);
  // A delayed/failed list read leaves the old projection; retry must not write with its stale CAS.
  rerender(<MemoryRouter><ChatGroupSettings group={{ ...initial }} /></MemoryRouter>);
  fireEvent.submit(name.closest('form')!);
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  expect(mocks.manage).toHaveBeenCalledOnce();
  expect(name.value).toBe('Saved name');
  rerender(<MemoryRouter><ChatGroupSettings group={{ ...initial, name: 'Saved name', topic: 'Saved topic', description: 'Saved description', revision: 2 }} /></MemoryRouter>);
  expect(name.disabled).toBe(false);
  fireEvent.change(topic, { target: { value: 'Next draft' } });
  fireEvent.submit(name.closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(2));
  expect(mocks.manage.mock.calls[1]![0].action).toMatchObject({ name: 'Saved name', topic: 'Next draft', description: 'Saved description', expectedRevision: 2 });
});
it.each([false, true])('keeps fields paired with their revision when a remote update precedes the save response, edit again=%s', async editAgain => {
  let completeSave!: (result: { ok: true }) => void;
  mocks.manage.mockImplementationOnce(() => new Promise(resolve => { completeSave = resolve; }));
  const initial = { ...group(true), topic: 'Initial topic', description: 'Initial description', replyMode: 'all' as const, speakingMode: 'auto' as const };
  const { rerender } = render(<MemoryRouter><ChatGroupSettings group={initial} /></MemoryRouter>);
  const name = screen.getByRole('textbox', { name: key('name') });
  fireEvent.change(name, { target: { value: 'My saved name' } });
  fireEvent.submit(name.closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
  const remote = { ...initial, revision: 3, name: 'Remote name', topic: 'Remote topic', description: 'Remote description', replyMode: 'mentioned' as const, speakingMode: 'sequential' as const };
  rerender(<MemoryRouter><ChatGroupSettings group={remote} /></MemoryRouter>);
  expect((name as HTMLInputElement).value).toBe('My saved name');
  await act(async () => { completeSave({ ok: true }); });
  expect((name as HTMLInputElement).value).toBe(remote.name);
  expect((screen.getByRole('textbox', { name: key('topic') }) as HTMLInputElement).value).toBe(remote.topic);
  expect((screen.getByRole('textbox', { name: key('description') }) as HTMLInputElement).value).toBe(remote.description);
  if (editAgain) fireEvent.change(name, { target: { value: 'My next draft' } });
  fireEvent.submit(name.closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(2));
  expect(mocks.manage.mock.calls[1]![0].action).toEqual({ type: 'update', name: editAgain ? 'My next draft' : remote.name, topic: remote.topic, description: remote.description, responseMode: remote.replyMode, speakingMode: remote.speakingMode, expectedRevision: remote.revision });
});
// #6806: the update payload must follow refreshed data only when no draft is pending.
it('uses the latest group revision when saving again after a successful save', async () => {
  const initial = { ...group(true), replyMode: 'mentioned' as const, speakingMode: 'sequential' as const };
  const { rerender } = render(<MemoryRouter><ChatGroupSettings group={initial} /></MemoryRouter>);
  fireEvent.change(screen.getByRole('textbox', { name: key('name') }), { target: { value: 'Renamed' } });
  fireEvent.submit(screen.getByRole('textbox', { name: key('name') }).closest('form')!);
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  rerender(<MemoryRouter><ChatGroupSettings group={{ ...initial, name: 'Renamed', revision: 2 }} /></MemoryRouter>);
  fireEvent.submit(screen.getByRole('textbox', { name: key('name') }).closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(2));
  expect(mocks.manage.mock.calls[1]![0].action.expectedRevision).toBe(2);
});
it.each([false, true])('preserves optimistic conflict detection after a remote refresh, pending draft=%s', async dirty => {
  const initial = { ...group(true), replyMode: 'all' as const, speakingMode: 'auto' as const };
  const { rerender } = render(<MemoryRouter><ChatGroupSettings group={initial} /></MemoryRouter>);
  if (dirty) fireEvent.change(screen.getByRole('textbox', { name: key('name') }), { target: { value: 'My draft' } });
  rerender(<MemoryRouter><ChatGroupSettings group={{ ...initial, name: 'Remote name', revision: 2 }} /></MemoryRouter>);
  expect((screen.getByRole('textbox', { name: key('name') }) as HTMLInputElement).value).toBe(dirty ? 'My draft' : 'Remote name');
  if (dirty) mocks.manage.mockResolvedValue({ ok: false, errorCode: 'REVISION_CONFLICT' });
  fireEvent.submit(screen.getByRole('textbox', { name: key('name') }).closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledOnce());
  expect(mocks.manage.mock.calls[0]![0].action).toMatchObject({ name: dirty ? 'My draft' : 'Remote name', expectedRevision: dirty ? 1 : 2 });
  if (dirty) {
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect((screen.getByRole('textbox', { name: key('name') }) as HTMLInputElement).value).toBe('My draft');
    fireEvent.submit(screen.getByRole('textbox', { name: key('name') }).closest('form')!);
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
function renderGroupEntry(groupValue: BotGroupSummary) {
  return render(<RouterProvider router={createMemoryRouter([
    { path: '/bots/groups/:groupId', element: <><div data-testid="group-chat" /><LocationProbe /><ChatGroupSettings group={groupValue} /><BotSettingsDrawer /></> },
    { path: '/bots/list', element: <LocationProbe /> },
    { path: '/bots/:botId', element: <><LocationProbe /><BotSettingsDrawer /></> },
    { path: '*', element: <LocationProbe /> },
  ], { initialEntries: ['/bots/groups/room?groupSettings=1'] })} />);
}

it('guides a sole owner to archive instead of offering an impossible leave', async () => {
  const alone = group();
  alone.members = [{ ...alone.members[0]!, role: 'owner' }];
  render(<MemoryRouter><ChatGroupSettings group={alone} /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: key('leave') })).toBeNull();
  expect(screen.getByText(key('soleOwnerHint'))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: key('archive') }));
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
  render(<MemoryRouter><ChatGroupSettings group={alone} /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: key('leave') })).toBeNull();
  expect(screen.queryByText(key('soleOwnerHint'))).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: key('unarchive') }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room',
    action: { type: 'archive', archived: false, expectedRevision: 1 },
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// The actual dialog is covered by ProfileEditDialog.avatarCrop.test.tsx.
// Here the real group settings must supply a group destination, never account editing.
it('edits only this member avatar and hides editing on older servers', async () => {
  const view = render(<MemoryRouter><ChatGroupSettings group={group()} /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: key('editProfile') })).toBeNull();
  expect(screen.queryByRole('button', { name: key('groupAvatar') })).toBeNull();
  view.rerender(<MemoryRouter><ChatGroupSettings group={{ ...group(), supportsMemberAvatar: true }} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: key('groupAvatar') }));
  fireEvent.click(screen.getByRole('button', { name: key('groupAvatarHint') }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({
    groupId: 'room', action: { type: 'avatar', actorId: 'me', avatar: { type: 'reset' } },
  }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
it('lets a member change their own nickname while keeping another owner’s grant read-only', async () => {
  render(<MemoryRouter><ChatGroupSettings group={group()} /></MemoryRouter>);
  expect((screen.getByRole('textbox', { name: key('name') }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('combobox', { name: key('guestAccess') }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: key('configureCapabilities') })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: key('nickname') }), { target: { value: 'Group name' } });
  fireEvent.click(screen.getByRole('button', { name: key('save') }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: { type: 'nickname', actorId: 'me', nickname: 'Group name' } }));
});
it('lets a companion owner manage a group owned by their companion', async () => {
  render(<MemoryRouter><ChatGroupSettings group={group(true)} /></MemoryRouter>);
  expect((screen.getByRole('textbox', { name: key('name') }) as HTMLInputElement).disabled).toBe(false);
  expect((screen.getByRole('combobox', { name: key('guestAccess') }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('button', { name: key('configureCapabilities') })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /My name/ }));
  expect(screen.getByRole('button', { name: key('transfer') })).toBeTruthy();
  await waitFor(() => expect(mocks.ownedBots).toHaveBeenCalled());
});
it('labels reply and speaking modes with the same words as the local group settings', () => {
  render(<MemoryRouter><ChatGroupSettings group={{ ...group(true), replyMode: 'all', speakingMode: 'auto' }} /></MemoryRouter>);
  expect(screen.getByRole('combobox', { name: 'bots.groupChat.settings.replyMode' }).textContent).toContain('bots.groupChat.settings.replyModeAll');
  expect(screen.getByRole('combobox', { name: 'bots.groupChat.settings.speakingMode' }).textContent).toContain('bots.groupChat.settings.speakingModeAuto');
  expect(screen.queryByText(key('replyMode'))).toBeNull();
});

// bot-group-chat.md §4.0 (2026-10-23): single-speaker groups keep 「只有被 @ 的回答」 and the
// 分工 settings (organizer, project folder); only the speaking mode no longer applies.
it('keeps reply mode and 分工 settings for single-speaker groups and saves mention-only replies', async () => {
  render(<MemoryRouter><ChatGroupSettings group={{ ...group(true), singleSpeaker: true, replyMode: 'all', speakingMode: 'auto' }} /></MemoryRouter>);
  expect(screen.queryByRole('combobox', { name: 'bots.groupChat.settings.speakingMode' })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'bots.groupChat.organizer' })).toBeTruthy();
  expect(screen.getByText('bots.groupChat.settings.projectDir')).toBeTruthy();
  fireEvent.click(screen.getByRole('combobox', { name: 'bots.groupChat.settings.replyMode' }));
  fireEvent.click(screen.getByRole('option', { name: 'bots.groupChat.settings.replyModeMentioned' }));
  fireEvent.submit(screen.getByRole('textbox', { name: key('name') }).closest('form')!);
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: expect.objectContaining({
    type: 'update', responseMode: 'mentioned', expectedRevision: 1,
  }) }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it('does not offer leaving when this account owns every group owner, including its companion', async () => {
  render(<MemoryRouter><ChatGroupSettings group={group(true)} /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: key('leave') })).toBeNull();
  expect(screen.getByRole('button', { name: key('archive') })).toBeTruthy();
  await waitFor(() => expect(mocks.ownedBots).toHaveBeenCalled());
});

it('uses the existing member leave action without changing the group archive state', async () => {
  render(<MemoryRouter><ChatGroupSettings group={group()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: key('leave') }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: { type: 'member', actorId: 'me', action: 'leave' } }));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ presentation: 'standard', description: key('leaveHint'), confirmVariant: 'destructive' }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it('keeps membership untouched when the leave confirmation is cancelled', async () => {
  mocks.confirm.mockResolvedValue(false);
  render(<MemoryRouter><ChatGroupSettings group={group()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: key('leave') }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(mocks.manage).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it('keeps the group visible and reports a server rejection of leaving', async () => {
  mocks.manage.mockResolvedValue({ ok: false, errorCode: 'LAST_OWNER' });
  render(<MemoryRouter><ChatGroupSettings group={group()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: key('leave') }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(screen.getByRole('button', { name: key('leave') })).toBeTruthy();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it('confirms irreversible dissolution separately from archive and refreshes after success', async () => {
  render(<MemoryRouter><ChatGroupSettings group={{ ...group(true), supportsDissolve: true, supportsListRemoval: true }} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.lifecycle.dissolve' }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ groupId: 'room', action: { type: 'dissolve', expectedRevision: 1 } }));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: 'bots.groupChat.lifecycle.dissolveNote', confirmVariant: 'destructive' }));
});
it('disables unsupported lifecycle actions and terminal edits without offering unarchive', async () => {
  const rendered = render(<MemoryRouter><ChatGroupSettings group={group(true)} /></MemoryRouter>);
  expect((screen.getByRole('button', { name: 'bots.groupChat.lifecycle.dissolve' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'bots.groupChat.lifecycle.hide' }) as HTMLButtonElement).disabled).toBe(true);
  rendered.rerender(<MemoryRouter><ChatGroupSettings group={{ ...group(true), archived: true, dissolvedAt: '2026-10-15', supportsListRemoval: true }} /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: key('unarchive') })).toBeNull();
  expect((screen.getByRole('textbox', { name: key('nickname') }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'bots.groupChat.lifecycle.hide' }) as HTMLButtonElement).disabled).toBe(false);
  await waitFor(() => expect(mocks.ownedBots).toHaveBeenCalled());
});
it('does not refresh or remove the list on failed personal removal', async () => {
  mocks.manage.mockResolvedValue({ ok: false, errorCode: 'REVISION_CONFLICT' });
  render(<MemoryRouter><ChatGroupSettings group={{ ...group(), supportsListRemoval: true }} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.lifecycle.hide' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(mocks.refresh).not.toHaveBeenCalled();
});

// 测试价值
// - 生产入口与可观察结果：群设置里真实的「工具与授权设置」按钮，以及 BotSettingsDrawer 的关闭按钮。
//   打开后应看到所选伙伴的能力页，路由仍是原群；关闭后群聊页还在。
// - Bug／规则依据：#6809。修前该按钮会进入 /bots/<id> 私聊，关闭只去掉设置参数。
// - 现有覆盖缺口：本组用例只断言按钮是否出现；抽屉用例只覆盖私聊路由上的开关。
// - 最小失败输入：群里两位已拥有且在本机名单中的伙伴，从 /bots/groups/room?groupSettings=1 打开后者。
// - tier：unit。真实组件加 React Router，不启动 Electron。
it('keeps the original group mounted when opening and closing another owned companion’s capability settings', async () => {
  profiles.list = [activeProfile('bot', 'Partner'), activeProfile('other', 'Other')];
  const room = group(true);
  room.members = [...room.members, {
    actorId: 'other', botId: 'other', actorKind: 'bot', name: 'Other', role: 'member', isOwned: true, guestAccess: 'chat', accessRevision: 1,
    avatar: 'bot', avatarColor: 'blue', status: 'active',
  }];
  renderGroupEntry(room);
  const buttons = screen.getAllByRole('button', { name: key('configureCapabilities') });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]!);
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
  renderGroupEntry(group(true));
  fireEvent.click(screen.getByRole('button', { name: key('configureCapabilities') }));
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
