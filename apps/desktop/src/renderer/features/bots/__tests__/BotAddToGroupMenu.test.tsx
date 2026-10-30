// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  profiles: [] as unknown[], groups: [] as unknown[], navigate: vi.fn(), refresh: vi.fn(),
  ownedBots: vi.fn(), manage: vi.fn(), success: vi.fn(), error: vi.fn(), createDialog: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: object) => values ? `${key}:${JSON.stringify(values)}` : key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../botStore', () => ({ useBotProfiles: () => mocks.profiles }));
vi.mock('../botGroupStore', () => ({ useBotGroupList: () => ({ groups: mocks.groups, loaded: true }), refreshBotGroups: mocks.refresh }));
vi.mock('@/lib/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../BotGroupCreateDialog', async importOriginal => ({
  ...await importOriginal<typeof import('../BotGroupCreateDialog')>(),
  BotGroupCreateDialog: (props: { privateChatBotId?: string; onCreated: (id: string) => void }) => {
    mocks.createDialog(props.privateChatBotId);
    return <div role="dialog"><button type="button" onClick={() => props.onCreated('new-room')}>create</button></div>;
  },
}));

const { BotAddToGroupMenu } = await import('../BotAddToGroupMenu');
const k = (name: string) => `bots.groupChat.addFromChat.${name}`;
const teammate = (overrides = {}) => ({ id: 'bot-1', name: '小可', status: 'active', enabled: true, avatar: '', avatarColor: 'violet', createdAt: 1, sessions: [], ...overrides });
const group = (id: string, name: string, overrides = {}) => ({ id, name, serverBacked: true, archived: false, members: [], replyMode: 'all', speakingMode: 'auto', organizerBotId: null, ...overrides });
const trigger = `${k('triggerFor')}:${JSON.stringify({ name: '小可' })}`;
const openMenu = () => fireEvent.keyDown(screen.getByRole('button', { name: trigger }), { key: 'Enter' });
const openExisting = () => fireEvent.keyDown(screen.getByRole('menuitem', { name: k('existingGroup') }), { key: 'ArrowRight' });

beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner-a');
  mocks.profiles = [teammate()];
  mocks.groups = [
    group('room-a', '产品组'),
    group('room-member', '已在群', { members: [{ botId: 'bot-1', name: '小可', avatar: '', avatarColor: 'violet', status: 'active' }] }),
    group('room-archived', '已归档', { archived: true }),
    group('room-local', '旧本地群', { serverBacked: false }),
  ];
  mocks.ownedBots.mockResolvedValue({ ok: true, bots: [{ actorId: 'actor-1', botId: 'bot-1', name: '小可' }] });
  mocks.manage.mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: { ownedBots: mocks.ownedBots, manage: mocks.manage } } } });
});
afterEach(cleanup);

it.each([
  ['paused', { status: 'paused' }],
  ['turned off', { enabled: false }],
  ['archived', { status: 'archived' }],
])('offers no entry for a %s teammate', (_label, overrides) => {
  mocks.profiles = [teammate(overrides)];
  render(<BotAddToGroupMenu botId="bot-1" />);
  expect(screen.queryByRole('button', { name: /triggerFor/ })).toBeNull();
});

it('offers no entry for a teammate that is not on this computer', () => {
  render(<BotAddToGroupMenu botId="remote-bot" />);
  expect(screen.queryByRole('button', { name: /triggerFor/ })).toBeNull();
});

it('starts a new group with this teammate fixed and opens it', () => {
  render(<BotAddToGroupMenu botId="bot-1" />);
  openMenu();
  expect(mocks.refresh).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: k('newGroup') }));
  expect(mocks.createDialog).toHaveBeenCalledWith('bot-1');
  fireEvent.click(screen.getByRole('button', { name: 'create' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/new-room', { state: { createdGroupInvite: 'new-room' } });
  expect(mocks.manage).not.toHaveBeenCalled();
});

it('lists only shared groups the teammate can still join and adds it through the member invitation', async () => {
  render(<BotAddToGroupMenu botId="bot-1" />);
  openMenu(); openExisting();
  const items = (await screen.findAllByRole('menuitem')).map(item => item.textContent);
  expect(items).toContain('产品组');
  for (const hidden of ['已在群', '已归档', '旧本地群']) expect(items).not.toContain(hidden);
  // Before anything runs, the submenu names who is being added; each row names where.
  expect(screen.getByText(`${k('addTo')}:${JSON.stringify({ name: '小可' })}`)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '产品组' })); });
  expect(mocks.manage).toHaveBeenCalledExactlyOnceWith({ groupId: 'room-a', action: { type: 'member', actorId: 'actor-1', action: 'invite' } });
  expect(mocks.refresh).toHaveBeenCalled();
  expect(mocks.success).toHaveBeenCalledWith(`${k('added')}:${JSON.stringify({ name: '小可', group: '产品组' })}`, expect.objectContaining({ action: expect.any(Object) }));
  mocks.success.mock.calls[0][1].action.onClick();
  expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/room-a');
});

it('ignores the success toast’s open action once the account has changed', async () => {
  render(<BotAddToGroupMenu botId="bot-1" />);
  openMenu(); openExisting();
  await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: '产品组' })); });
  const { onClick } = mocks.success.mock.calls[0][1].action;
  setDataOwnerGeneration('owner-b');
  onClick();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('hides the existing-group choice when there is nowhere left to add the teammate', () => {
  mocks.groups = [mocks.groups[1]];
  render(<BotAddToGroupMenu botId="bot-1" />);
  openMenu();
  expect(screen.getByRole('menuitem', { name: k('newGroup') })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: k('existingGroup') })).toBeNull();
});

it.each([
  ['FORBIDDEN', 'bots.groupChat.server.notAllowed'],
  ['ROLE_REQUIRED', 'bots.groupChat.server.notAllowed'],
  ['REQUEST_TIMEOUT', 'bots.groupChat.server.requestFailed'],
])('explains a refused addition (%s) without claiming success', async (errorCode, message) => {
  mocks.manage.mockResolvedValue({ ok: false, errorCode });
  render(<BotAddToGroupMenu botId="bot-1" />);
  openMenu(); openExisting();
  await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: '产品组' })); });
  expect(mocks.error).toHaveBeenCalledWith(message);
  expect(mocks.success).not.toHaveBeenCalled();
});

it('says the teammate is unavailable when Chat Server has no identity for it, without inviting anyone else', async () => {
  mocks.ownedBots.mockResolvedValue({ ok: true, bots: [{ actorId: 'actor-2', botId: 'bot-2', name: 'Other' }] });
  render(<BotAddToGroupMenu botId="bot-1" />);
  openMenu(); openExisting();
  await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: '产品组' })); });
  expect(mocks.manage).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith(`${k('unavailable')}:${JSON.stringify({ name: '小可' })}`);
});

it('does not reopen the menu or add again while an addition is pending', async () => {
  let finish!: (value: unknown) => void;
  mocks.manage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<BotAddToGroupMenu botId="bot-1" />);
  openMenu(); openExisting();
  fireEvent.click(await screen.findByRole('menuitem', { name: '产品组' }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(1));
  openMenu();
  expect(screen.queryByRole('menuitem')).toBeNull();
  await act(async () => finish({ ok: true }));
  expect(mocks.manage).toHaveBeenCalledTimes(1);
  expect(mocks.success.mock.calls[0][1].duration).toBeGreaterThanOrEqual(5000);
  openMenu();
  expect(screen.getByRole('menuitem', { name: k('newGroup') })).toBeTruthy();
});

it('drops the result of an addition that finished after the account changed', async () => {
  let finish!: (value: unknown) => void;
  mocks.manage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<BotAddToGroupMenu botId="bot-1" />);
  openMenu(); openExisting();
  fireEvent.click(await screen.findByRole('menuitem', { name: '产品组' }));
  await waitFor(() => expect(mocks.manage).toHaveBeenCalled());
  setDataOwnerGeneration('owner-b');
  await act(async () => finish({ ok: true }));
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
});
