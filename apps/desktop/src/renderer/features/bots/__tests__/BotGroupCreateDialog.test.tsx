// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotGroupCreateDialog } from '../BotGroupCreateDialog';

const mocks = vi.hoisted(() => ({
  profiles: [] as unknown[],
  status: vi.fn(),
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
  botGroupApi: () => ({ createBotGroup: mocks.createBotGroup, chatServer: { status: mocks.status } }),
  refreshBotGroups: mocks.refreshBotGroups,
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));

function bot(id: string, createdAt: number, status = 'active') {
  return { id, name: `Bot ${id}`, avatar: '', avatarColor: 'violet', enabled: true, status, createdAt, sessions: [] };
}

function renderDialog() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  render(<BotGroupCreateDialog onOpenChange={onOpenChange} onCreated={onCreated} />);
  return { onOpenChange, onCreated };
}

function checkbox(name: string): HTMLButtonElement {
  return screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLButtonElement;
}

beforeEach(() => {
  mocks.status.mockResolvedValue({ enabled: false });
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
  it('focuses the name, lists local teammates and blocks paused or archived ones', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    expect(screen.queryByRole('checkbox', { name: /Bot gone/ })).toBeNull();
    expect(checkbox('Bot paused').disabled).toBe(true);
    // No × close control on a form dialog (DESIGN.md §4).
    expect(screen.queryByRole('button', { name: 'bots.close' })).toBeNull();
  });

  it('requires a name and at least two teammates before calling main', async () => {
    renderDialog();
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
    const { onCreated } = renderDialog();
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
    const { onCreated } = renderDialog();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '读书会' } });
    fireEvent.click(checkbox('Bot a'));
    fireEvent.click(checkbox('Bot b'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bots.groupChat.errors.memberLimit');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('closes from Cancel', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'bots.cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});


it('lets a server group start without bots so people can join by invitation', async () => {
  mocks.status.mockResolvedValue({ enabled: true });
  mocks.profiles = [];
  renderDialog();
  await screen.findByText('bots.groupChat.server.createDescription');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'People first' } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
  await waitFor(() => expect(mocks.createBotGroup).toHaveBeenCalledWith({ name: 'People first', botIds: [] }));
});
