// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { cleanup, fireEvent, render as renderUI, screen, waitFor, within } from '@testing-library/react';
import { Tooltip } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInviteButton, ChatJoinButton, ChatMessageActions } from '../ChatServerControls';
import { ChatThreadPanel } from '../ChatThreadPanel';
import type { BotGroupDetail, BotGroupMessageView } from '../../../../shared/botGroupChat';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { queryShareableMessageIds, stripInteractiveElements } from '@/lib/shareConversationImage';

const mocks = vi.hoisted(() => ({
  status: vi.fn(), react: vi.fn(), thread: vi.fn(), reply: vi.fn(), createInvite: vi.fn(), previewInvite: vi.fn(), acceptInvite: vi.fn(),
  refresh: vi.fn(), ownerCurrent: true,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => null }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: mocks.refresh }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => mocks.ownerCurrent, isDataOwnerPushCurrent: () => true,
}));
const k = (name: string) => `bots.groupChat.server.${name}`;
const message = { id: 'root', authorName: 'Human', content: 'Root message', reactions: [{ emoji: '👍', count: 2, me: true }] } as BotGroupMessageView;
const group = { id: 'room', members: [], messages: [message] } as unknown as BotGroupDetail;
const render = (ui: ReactNode) => renderUI(<Tooltip.Provider>{ui}</Tooltip.Provider>);
beforeEach(() => {
  vi.clearAllMocks(); mocks.ownerCurrent = true;
  shareSelectionStore.reset();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.status.mockResolvedValue({ enabled: true, connected: true });
  mocks.react.mockResolvedValue({ ok: true });
  mocks.thread.mockResolvedValue({ ok: true, root: message, replies: [], hasMore: false });
  mocks.createInvite.mockResolvedValue({ ok: true, link: 'cindy://chat-invite/test', expiresAt: '' });
  mocks.previewInvite.mockResolvedValue({ ok: true, groupId: 'room', name: 'Invited group', inviterName: 'Host' });
  mocks.acceptInvite.mockResolvedValue({ ok: true, groupId: 'room' });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: {
    chatServer: mocks, onBotGroupChanged: () => () => {},
  } } });
});
afterEach(() => { cleanup(); shareSelectionStore.reset(); vi.unstubAllGlobals(); });

describe('chat interaction controls', () => {
  it('preserves copy and image sharing beside thread replies and reactions in one toolbar', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined), reply = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ChatMessageActions shareScope="group:room" groupId="room" message={{ ...message, replyCount: 2 }} onReply={reply} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.messageActionBar.copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Root message'));
    fireEvent.click(screen.getByRole('button', { name: k('replyCount') }));
    expect(reply).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'chat.shareImage.entry' }));
    expect(shareSelectionStore.isActive('group:room')).toBe(true);
    expect(shareSelectionStore.getSelectedIds()).toEqual(['root']);
    fireEvent.click(screen.getByRole('button', { name: k('addReaction') }));
    fireEvent.click(screen.getByRole('button', { name: '🎉' }));
    await waitFor(() => expect(mocks.react).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '🎉', present: true }));
  });

  it('shares thread messages separately from the main timeline and excludes controls from the image', async () => {
    const view = render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const article = (await screen.findByText('Root message')).closest('article')!;
    fireEvent.click(within(article).getByRole('button', { name: 'chat.shareImage.entry' }));
    const scope = 'bot-group:room:thread:root';
    expect(shareSelectionStore.isActive(scope)).toBe(true);
    expect(queryShareableMessageIds(scope)).toEqual(['root']);
    expect(queryShareableMessageIds('bot-group:room')).toEqual([]);
    expect(screen.queryByRole('textbox', { name: k('replyPlaceholder') })).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.shareImage.copy' })).toBeTruthy();
    const clone = article.cloneNode(true) as HTMLElement;
    stripInteractiveElements(clone);
    expect(clone.textContent).toContain('Human');
    expect(clone.textContent).toContain('Root message');
    expect(clone.querySelector('button')).toBeNull();
    view.unmount();
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
  });

  it('removes only the current actor reaction and refreshes the authoritative message', async () => {
    const changed = vi.fn();
    render(<ChatMessageActions shareScope="group:room" groupId="room" message={message} onChanged={changed} />);
    const reaction = screen.getByRole('button', { name: k('reactionCount') });
    expect(reaction.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(reaction);
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(mocks.react).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '👍', present: false });
  });

  it('uses the refreshed Thread root reaction state while the main timeline remains stale', async () => {
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, replies: [], hasMore: false })
      .mockResolvedValue({ ok: true, root: { ...message, reactions: [{ emoji: '👍', count: 1, me: false }] }, replies: [], hasMore: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const reaction = await screen.findByRole('button', { name: k('reactionCount') });
    expect(reaction.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(reaction);
    await waitFor(() => expect(screen.getByRole('button', { name: k('reactionCount') }).getAttribute('aria-pressed')).toBe('false'));
    expect(screen.getByRole('button', { name: k('reactionCount') }).textContent).toContain('1');
    expect(group.messages[0].reactions?.[0].me).toBe(true);
  });

  it('shows invitation preview first; only explicit acceptance joins', async () => {
    const joined = vi.fn();
    render(<StrictMode><ChatJoinButton onJoined={joined} /></StrictMode>);
    fireEvent.click(await screen.findByRole('button', { name: k('join') }));
    fireEvent.change(screen.getByRole('textbox', { name: k('inviteLink') }), { target: { value: 'cindy://chat-invite/test' } });
    fireEvent.click(screen.getByRole('button', { name: k('previewInvite') }));
    await screen.findByText('Invited group');
    expect(mocks.acceptInvite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: k('accept') }));
    await waitFor(() => expect(joined).toHaveBeenCalledWith('room'));
  });

  it('creates and displays a copyable link in Strict Mode', async () => {
    render(<StrictMode><ChatInviteButton groupId="room" /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: k('invite') }));
    fireEvent.click(screen.getByRole('button', { name: k('createLink') }));
    expect((await screen.findByRole('textbox', { name: k('inviteLink') }) as HTMLInputElement).value).toBe('cindy://chat-invite/test');
  });

  it.each([{ members: [] }, { members: [{ botId: 'namesake', name: 'Ann', status: 'active' as const }] }])('keeps a refused directed thread reply after the roster changes to %j', async ({ members }) => {
    mocks.reply.mockResolvedValue({ ok: false, errorCode: 'MENTION_UNAVAILABLE' });
    const view = render(<ChatThreadPanel group={{ ...group, members: [{ botId: 'bot', name: 'Ann', status: 'active' }] } as BotGroupDetail} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@Ann hello' } });
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    expect((await screen.findByRole('alert')).textContent).toBe('bots.groupChat.errors.mentionUnavailable');
    expect(input.value).toBe('@Ann hello');
    expect(mocks.reply).toHaveBeenCalledWith(expect.objectContaining({ mentions: { all: false, botIds: ['bot'] } }));
    const original = mocks.reply.mock.calls[0]![0];
    view.rerender(<Tooltip.Provider><ChatThreadPanel group={{ ...group, members } as BotGroupDetail} rootId="root" onClose={vi.fn()} /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(2));
    expect(mocks.reply.mock.calls[1]![0]).toEqual(original);
    expect(input.value).toBe('@Ann hello');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.change(input, { target: { value: '@Ann hello' } });
    mocks.reply.mockResolvedValue({ ok: true, messageId: 'accepted' });
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(3));
    expect(mocks.reply.mock.calls[2]![0].mentions).toEqual({ all: false, botIds: members.map(member => member.botId) });
    expect(mocks.reply.mock.calls[2]![0].clientId).not.toBe(original.clientId);
  });

  it('keeps a failed reply draft and reuses its operation id; IME confirmation does not send', async () => {
    mocks.reply.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT' }).mockResolvedValueOnce({ ok: true, messageId: 'reply' });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') });
    fireEvent.change(input, { target: { value: 'A thread reply' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(mocks.reply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    await screen.findByRole('alert');
    expect((input as HTMLTextAreaElement).value).toBe('A thread reply');
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    expect(mocks.reply.mock.calls[0][0].clientId).toBe(mocks.reply.mock.calls[1][0].clientId);
    expect(mocks.reply.mock.calls[0][0].rootId).toBe('root');
  });
});
