// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotGroupSummary } from '../../../../shared/botGroupChat';
import { BotGroupSettingsDrawer } from '../BotGroupSettingsDrawer';

const mocks = vi.hoisted(() => ({
  groups: [] as BotGroupSummary[],
  updateBotGroup: vi.fn(),
  setBotGroupMembers: vi.fn(),
  deleteBotGroup: vi.fn(),
  refreshBotGroups: vi.fn(),
  showOpenDirectory: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'name' in options ? `${key}:${String(options.name)}` : key,
  }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));
vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('../botGroupStore', () => ({
  useBotGroupList: () => ({ groups: mocks.groups, loaded: true }),
  botGroupApi: () => ({
    updateBotGroup: mocks.updateBotGroup,
    setBotGroupMembers: mocks.setBotGroupMembers,
    deleteBotGroup: mocks.deleteBotGroup,
  }),
  refreshBotGroups: mocks.refreshBotGroups,
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));

function group(overrides: Partial<BotGroupSummary> = {}): BotGroupSummary {
  return {
    id: 'g1',
    name: '官网介绍页',
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '', avatarColor: 'red', status: 'active' },
      { botId: 'xiaoman', name: '小满', avatar: '', avatarColor: 'blue', status: 'active' },
      { botId: 'abu', name: '阿布', avatar: '', avatarColor: 'amber', status: 'paused' },
    ],
    organizerBotId: 'mimi',
    projectDir: null,
    lastMessage: null,
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function renderDrawer() {
  return render(
    <MemoryRouter initialEntries={['/bots/groups/g1?groupSettings=1']}>
      <BotGroupSettingsDrawer />
    </MemoryRouter>,
  );
}

function memberRow(name: string): HTMLElement {
  const avatar = screen.getAllByText(name).find((node) => node.closest('.min-h-11'));
  return avatar!.closest('.min-h-11') as HTMLElement;
}

beforeEach(() => {
  mocks.groups = [group()];
  mocks.updateBotGroup.mockReset().mockResolvedValue({ ok: true });
  mocks.setBotGroupMembers.mockReset().mockResolvedValue({ ok: true });
  mocks.deleteBotGroup.mockReset().mockResolvedValue({ ok: true });
  mocks.refreshBotGroups.mockReset();
  mocks.showOpenDirectory.mockReset().mockResolvedValue({ success: true, path: '/Users/me/cindy-site' });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: { dialog: { showOpenDirectory: (...args: unknown[]) => mocks.showOpenDirectory(...args) } },
  });
});

afterEach(cleanup);

describe('BotGroupSettingsDrawer 分工 settings', () => {
  it('tags the organizer and lets another active member take over', async () => {
    renderDrawer();
    expect(within(memberRow('咪咪')).getByText('bots.groupChat.organizer')).toBeTruthy();
    expect(within(memberRow('咪咪')).queryByRole('button', { name: /setOrganizerNamed/ })).toBeNull();
    // A paused member cannot organize.
    expect(within(memberRow('阿布')).queryByRole('button', { name: /setOrganizerNamed/ })).toBeNull();
    expect(screen.getByText('bots.groupChat.settings.organizerNote')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.settings.setOrganizerNamed:小满' }));
    await waitFor(() =>
      expect(mocks.updateBotGroup).toHaveBeenCalledWith({ groupId: 'g1', organizerBotId: 'xiaoman' }),
    );
    expect(mocks.refreshBotGroups).toHaveBeenCalled();
  });

  it('shows the organizer error in place', async () => {
    mocks.updateBotGroup.mockResolvedValue({ ok: false, errorCode: 'INVALID_PARAMS', message: '' });
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.settings.setOrganizerNamed:小满' }));
    expect((await screen.findByRole('alert')).textContent).toBe('bots.groupChat.settings.organizerSaveFailed');
  });

  it('chooses a project folder through the system picker', async () => {
    renderDrawer();
    const row = screen.getByTestId('bot-group-project-dir');
    expect(row.textContent).toContain('bots.groupChat.settings.projectDirNone');
    expect(screen.getByText('bots.groupChat.settings.projectDirNote')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'bots.groupChat.settings.projectDirClear' })).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: 'bots.groupChat.settings.projectDirChoose' }));
    await waitFor(() =>
      expect(mocks.updateBotGroup).toHaveBeenCalledWith({ groupId: 'g1', projectDir: '/Users/me/cindy-site' }),
    );
    expect(mocks.showOpenDirectory).toHaveBeenCalledWith(undefined);
  });

  it('does nothing when the picker is cancelled', async () => {
    mocks.showOpenDirectory.mockResolvedValue({ success: false, path: null });
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.settings.projectDirChoose' }));
    await waitFor(() => expect(mocks.showOpenDirectory).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'bots.groupChat.settings.projectDirChoose' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(mocks.updateBotGroup).not.toHaveBeenCalled();
  });

  it('changes or clears a chosen folder and reports a folder main rejects', async () => {
    mocks.groups = [group({ projectDir: '/Users/me/old-site' })];
    renderDrawer();
    const row = screen.getByTestId('bot-group-project-dir');
    expect(row.textContent).toContain('old-site');
    expect(row.textContent).not.toContain('/Users/me');

    fireEvent.click(within(row).getByRole('button', { name: 'bots.groupChat.settings.projectDirClear' }));
    await waitFor(() => expect(mocks.updateBotGroup).toHaveBeenCalledWith({ groupId: 'g1', projectDir: null }));

    mocks.updateBotGroup.mockResolvedValue({ ok: false, errorCode: 'INVALID_PARAMS', message: '' });
    await waitFor(() =>
      expect(
        (within(row).getByRole('button', { name: 'bots.groupChat.settings.projectDirChange' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(within(row).getByRole('button', { name: 'bots.groupChat.settings.projectDirChange' }));
    expect((await screen.findByRole('alert')).textContent).toBe('bots.groupChat.settings.projectDirSaveFailed');
    expect(mocks.showOpenDirectory).toHaveBeenCalledWith({ defaultPath: '/Users/me/old-site' });
  });
});
