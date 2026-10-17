// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatGroupSettings } from '../ChatGroupSettings';
import type { BotGroupSummary } from '../../../../shared/botGroupChat';
const mocks = vi.hoisted(() => ({ manage: vi.fn(), ownedBots: vi.fn(), refresh: vi.fn(), confirm: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/components/settings/ProfileEditDialog', () => ({ ProfileEditDialog: () => null }));
vi.mock('../botStore', () => ({ useBotProfiles: () => [{ id: 'bot' }] }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => null }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: mocks.refresh }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => true }));
const key = (name: string) => `bots.groupChat.server.settings.${name}`;
function group(owned = false): BotGroupSummary {
  return { id: 'room', name: 'Team', serverBacked: true, revision: 1, members: [
    { actorId: 'me', botId: 'me', actorKind: 'human', isSelf: true, isOwned: true, name: 'My name', displayName: 'My name', role: 'member' },
    { actorId: 'bot', botId: 'bot', actorKind: 'bot', name: 'Partner', role: 'owner', isOwned: owned, guestAccess: 'chat', accessRevision: 1 },
  ] } as BotGroupSummary;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.manage.mockResolvedValue({ ok: true }); mocks.ownedBots.mockResolvedValue({ ok: true, bots: [] });
  mocks.confirm.mockResolvedValue(true);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: mocks } } });
});

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
afterEach(cleanup);
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
