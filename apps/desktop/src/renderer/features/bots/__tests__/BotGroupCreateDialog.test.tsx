// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotGroupCreateDialog } from '../BotGroupCreateDialog';

const mocks = vi.hoisted(() => ({
  profiles: [] as unknown[],
  status: vi.fn(),
  ownedBots: vi.fn(),
  createBotGroup: vi.fn(),
  refreshBotGroups: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
}));
vi.mock('../botStore', () => ({ useBotProfiles: () => mocks.profiles }));
vi.mock('../botGroupStore', () => ({
  botGroupApi: () => ({ createBotGroup: mocks.createBotGroup, chatServer: { status: mocks.status, ownedBots: mocks.ownedBots } }),
  refreshBotGroups: mocks.refreshBotGroups,
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));

function bot(id: string, createdAt: number, status = 'active') {
  return { id, name: `Bot ${id}`, avatar: '', avatarColor: 'violet', enabled: true, status, createdAt, sessions: [] };
}

async function renderDialog() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  render(<BotGroupCreateDialog onOpenChange={onOpenChange} onCreated={onCreated} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'bots.groupChat.create.submit' })).toHaveProperty('disabled', false));
  return { onOpenChange, onCreated };
}

function checkbox(name: string): HTMLButtonElement {
  return screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLButtonElement;
}

beforeEach(() => {
  mocks.status.mockResolvedValue({ enabled: false });
  mocks.ownedBots.mockReset().mockResolvedValue({ ok: true, bots: [] });
  mocks.createBotGroup.mockReset().mockResolvedValue({ ok: true, groupId: 'g-new' });
  mocks.refreshBotGroups.mockReset();
  mocks.profiles = [
    bot('c', 3),
    bot('a', 1),
    bot('b', 2),
    bot('d', 4),
    bot('e', 5),
    bot('f', 6),
    bot('g', 7),
    bot('paused', 8, 'paused'),
    bot('gone', 9, 'archived'),
  ];
});

afterEach(cleanup);

describe('BotGroupCreateDialog', () => {
  it('retries a failed roster request without losing the group name', async () => {
    mocks.status.mockResolvedValue({ enabled: true });
    mocks.ownedBots.mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ ok: true, bots: [{ actorId: 'actor-linux', botId: 'linux', name: 'Linux' }] });
    render(<BotGroupCreateDialog onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my group name' } });
    fireEvent.click(await screen.findByRole('button', { name: 'commonUi.retry' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Linux' }));
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'Keep my group name');
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    await waitFor(() => expect(mocks.createBotGroup).toHaveBeenCalledWith({ name: 'Keep my group name', botIds: ['linux'] }));
  });
  it('creates with an owned companion that only exists on another computer', async () => {
    mocks.status.mockResolvedValue({ enabled: true });
    mocks.ownedBots.mockResolvedValue({ ok: true, bots: [{ actorId: 'actor-linux', botId: 'linux', name: 'Linux' }] });
    await renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Linux' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cross device' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    await waitFor(() => expect(mocks.createBotGroup).toHaveBeenCalledWith({ name: 'Cross device', botIds: ['linux'] }));
  });
  it('creates from a private chat with only its teammate and no member picker', async () => {
    mocks.status.mockResolvedValue({ enabled: true });
    const onCreated = vi.fn();
    render(<BotGroupCreateDialog privateChatBotId="c" onOpenChange={vi.fn()} onCreated={onCreated} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  项目讨论  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('g-new'));
    expect(mocks.createBotGroup).toHaveBeenCalledExactlyOnceWith({ name: '项目讨论', botIds: ['c'] });
  });

  it('does not silently create a local-only group from a private chat', async () => {
    render(<BotGroupCreateDialog privateChatBotId="c" onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '项目讨论' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bots.groupChat.errors.chatUnavailable');
    expect(screen.getByRole('textbox')).toHaveProperty('value', '项目讨论');
    expect(mocks.createBotGroup).not.toHaveBeenCalled();
  });

  it('focuses the name, lists local teammates and blocks paused or archived ones', async () => {
    await renderDialog();
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    expect(screen.queryByRole('checkbox', { name: /Bot gone/ })).toBeNull();
    expect(checkbox('Bot paused').disabled).toBe(true);
    // No × close control on a form dialog (DESIGN.md §4).
    expect(screen.queryByRole('button', { name: 'bots.close' })).toBeNull();
  });

  it('requires a name and at least two teammates before calling main', async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    expect(await screen.findByText('bots.groupChat.create.nameRequired')).toBeTruthy();
    expect(mocks.createBotGroup).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '周末出游' } });
    fireEvent.click(checkbox('Bot a'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    expect(await screen.findByText('bots.groupChat.create.minMembers')).toBeTruthy();
    expect(mocks.createBotGroup).not.toHaveBeenCalled();
  });

  it('caps the selection at six and creates in picker order', async () => {
    const { onCreated } = await renderDialog();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  周末出游 ' } });
    for (const id of ['f', 'a', 'c', 'b', 'e', 'd']) fireEvent.click(checkbox(`Bot ${id}`));
    expect(checkbox('Bot g').disabled).toBe(true);
    expect(checkbox('Bot a').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('g-new'));
    expect(mocks.createBotGroup).toHaveBeenCalledWith({
      name: '周末出游',
      botIds: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(mocks.refreshBotGroups).toHaveBeenCalled();
  });

  it('keeps the form open and explains a member-limit failure from main', async () => {
    mocks.createBotGroup.mockResolvedValue({ ok: false, errorCode: 'MEMBER_LIMIT', message: 'x' });
    const { onCreated } = await renderDialog();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '读书会' } });
    fireEvent.click(checkbox('Bot a'));
    fireEvent.click(checkbox('Bot b'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bots.groupChat.errors.memberLimit');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('closes from Cancel', async () => {
    const { onOpenChange } = await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'bots.cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});


it('lets a server group start without bots so people can join by invitation', async () => {
  mocks.status.mockResolvedValue({ enabled: true });
  mocks.profiles = [];
  await renderDialog();
  await screen.findByText('bots.groupChat.server.createDescription');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'People first' } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
  await waitFor(() => expect(mocks.createBotGroup).toHaveBeenCalledWith({ name: 'People first', botIds: [] }));
});
