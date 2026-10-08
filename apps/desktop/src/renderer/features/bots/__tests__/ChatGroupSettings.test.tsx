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
  return { id: 'room', name: 'Team', revision: 1, members: [
    { actorId: 'me', botId: 'me', actorKind: 'human', isSelf: true, isOwned: true, name: 'My name', displayName: 'My name', role: 'member' },
    { actorId: 'bot', botId: 'bot', actorKind: 'bot', name: 'Partner', role: 'owner', isOwned: owned, guestAccess: 'chat', accessRevision: 1 },
  ] } as BotGroupSummary;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.manage.mockResolvedValue({ ok: true }); mocks.ownedBots.mockResolvedValue({ ok: true, bots: [] });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: mocks } } });
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
