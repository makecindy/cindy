// @vitest-environment jsdom

import { transferableAbortController } from 'node:util';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotGroupSummary } from '../../../../shared/botGroupChat';
import { BotGroupSettingsDrawer } from '../BotGroupSettingsDrawer';

const nativeAbortController = transferableAbortController();

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
  // React Router uses Node Request; jsdom's signal fails its Node 25 realm check.
  vi.stubGlobal('AbortController', nativeAbortController.constructor);
  vi.stubGlobal('AbortSignal', nativeAbortController.signal.constructor);
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

afterEach(() => {
  try {
    cleanup();
  } finally {
    vi.unstubAllGlobals();
  }
});

// Unit regression: the reported inert group-settings scrim (DESIGN.md §4, Dialog & Modal).
// Existing tests cover mutations, not dismissal through the real drawer and Radix events.
// Minimal failure: open the drawer, then pointer-down/click its scrim; the dialog must disappear
// and clear only settings queries, just like ×. Reopening must not restore the old subpage.
// Standalone run: 10.69s (7.45s importing real drawer dependencies, 0.79s executing all 9 tests).
it.each(['scrim', 'close button'] as const)('closes from the %s and clears settings routes', async (target) => {
  const router = createMemoryRouter([{ path: '*', element: <BotGroupSettingsDrawer /> }], {
    initialEntries: ['/bots/groups/g1?groupSettings=1&groupSettingsPage=manage&groupMask=1&keep=1'],
  });
  render(<RouterProvider router={router} />);
  // Radix installs the document pointer listener on the next task.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const dialog = screen.getByRole('dialog');
  fireEvent.pointerDown(dialog, { pointerType: 'mouse', button: 0 });
  fireEvent.click(dialog);
  expect(screen.getByRole('dialog')).toBe(dialog);

  if (target === 'scrim') {
    const scrim = dialog.parentElement!;
    fireEvent.pointerDown(scrim, { pointerType: 'mouse', button: 0 });
    fireEvent.click(scrim);
  } else {
    fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  }
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(router.state.location.pathname).toBe('/bots/groups/g1');
  expect(router.state.location.search).toBe('?keep=1');
  await act(async () => { await router.navigate('/bots/groups/g1?keep=1&groupSettings=1'); });
  expect(screen.getByRole('dialog', { name: 'bots.groupChat.settings.title' })).toBeTruthy();
});

it('keeps IME Escape in the drawer and closes on ordinary Escape', () => {
  renderDrawer();
  const dialog = screen.getByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
  expect(screen.getByRole('dialog')).toBe(dialog);
  fireEvent.keyDown(dialog, { key: 'Escape', keyCode: 229 });
  expect(screen.getByRole('dialog')).toBe(dialog);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps the drawer out of the window drag region so its close button stays clickable', () => {
  renderDrawer();
  // Portaled after the page's title-bar drag strip, so this no-drag wins under the close button.
  const dialog = screen.getByRole('dialog');
  expect((dialog.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion).toBe('no-drag');
});

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
