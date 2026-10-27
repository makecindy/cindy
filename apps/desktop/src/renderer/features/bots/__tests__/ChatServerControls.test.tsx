// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, createEvent, fireEvent, render as renderUI, screen, waitFor, within } from '@testing-library/react';
import { Tooltip } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ChatInviteButton, ChatMessageActions } from '../ChatServerControls';
import { ChatInviteDialog } from '../ChatInviteDialog';
import { ChatThreadPanel } from '../ChatThreadPanel';
import { botGroupThreadDraftKey } from '../botGroupAttachments';
import { clearDraft } from '@/lib/composerDraftStore';
import { flashThreadTarget } from '../BotGroupThreadViews';
import { chatErrorKey } from '../chatError';
import type { BotGroupDetail, BotGroupMessageView } from '../../../../shared/botGroupChat';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { queryShareableMessageIds, stripInteractiveElements } from '@/lib/shareConversationImage';

const mocks = vi.hoisted(() => ({
  status: vi.fn(), react: vi.fn(), reactors: vi.fn(), thread: vi.fn(), followThread: vi.fn(), reply: vi.fn(), createInvite: vi.fn(), previewInvite: vi.fn(), acceptInvite: vi.fn(),
  refresh: vi.fn(), shareToMain: vi.fn(), ownerCurrent: true,
}));
// Partial: the 话题 reply box shares the group composer, whose attachment pieces pull in the app i18n instance.
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => null }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: mocks.refresh }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => mocks.ownerCurrent, isDataOwnerPushCurrent: () => true,
}));
const k = (name: string) => `bots.groupChat.server.${name}`;
const message = { id: 'root', kind: 'message', authorKind: 'user', isSelf: false, authorName: 'Human', content: 'Root message', reactions: [{ emoji: '👍', count: 2, me: true }], attachments: [] } as unknown as BotGroupMessageView;
const group = { id: 'room', members: [], messages: [message] } as unknown as BotGroupDetail;
const render = (ui: ReactNode) => renderUI(<Tooltip.Provider>{ui}</Tooltip.Provider>);
beforeEach(() => {
  vi.clearAllMocks(); mocks.ownerCurrent = true;
  shareSelectionStore.reset();
  // The thread reply keeps a draft per thread; one test's unsent text must not start the next.
  clearDraft(botGroupThreadDraftKey(group.id, 'root'));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.status.mockResolvedValue({ enabled: true, connected: true });
  mocks.react.mockResolvedValue({ ok: true });
  mocks.reactors.mockResolvedValue({ ok: true, reactors: [] });
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
  it.each([{ archived: true }, { archived: false, dissolvedAt: '2026-10-15T00:00:00.000Z' }])('keeps terminal thread replies read-only and focuses close (%j)', async state => {
    render(<ChatThreadPanel group={{ ...group, ...state }} rootId="root" onClose={vi.fn()} />);
    await screen.findByText('Root message');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: k('thread.alsoSend') }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'bots.close' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsent reply' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect((screen.getByRole('button', { name: k('sendReply') }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it.each(['GROUP_DISSOLVED', 'CONVERSATION_DISSOLVED'])('maps dissolution error %s to its explanation', code => {
    expect(chatErrorKey(code)).toBe('bots.groupChat.lifecycle.dissolved');
  });

  it.each([{ archived: true }, { dissolvedAt: '2026-10-15T00:00:00.000Z' }])('stops sharing and retrying thread copies after the group becomes read-only (%j)', async state => {
    const room = { ...group, id: `terminal-${JSON.stringify(state)}` };
    mocks.thread.mockResolvedValue({ ok: true, root: message, replies: [{ ...message, id: 'reply', kind: 'message', content: 'Existing reply' }], hasMore: false });
    mocks.reply.mockResolvedValue({ ok: true, messageId: 'reply' });
    mocks.shareToMain.mockResolvedValue({ ok: false, errorCode: 'SERVICE_ERROR' });
    const view = render(<ChatThreadPanel group={room} rootId="root" onClose={vi.fn()} />);
    await screen.findByText('Existing reply');
    fireEvent.click(screen.getByRole('checkbox', { name: k('thread.alsoSend') }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Send to both' } });
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    await screen.findByRole('button', { name: k('thread.retryPost') });
    view.rerender(<Tooltip.Provider><ChatThreadPanel group={{ ...room, ...state }} rootId="root" onClose={vi.fn()} /></Tooltip.Provider>);
    const retry = screen.getByRole('button', { name: k('thread.retryPost') }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    const reply = screen.getByText('Existing reply').closest('article')!;
    const more = within(reply).queryByRole('button', { name: 'chat.messageActionBar.moreActions' });
    if (more) fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    expect(screen.queryByRole('menuitem', { name: k('thread.postToMain') })).toBeNull();
    expect(mocks.shareToMain).toHaveBeenCalledOnce();
  });

  // bot-group-chat.md §10「关注开关」: the server keeps the reader's last click.
  it('still sends the last follow click when an earlier save failed but may have been kept', async () => {
    mocks.thread.mockResolvedValue({ ok: true, root: message, replies: [], hasMore: false, following: false });
    let failFirst: (error: Error) => void = () => {};
    mocks.followThread.mockReturnValueOnce(new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValueOnce({ ok: true, following: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const follow = await waitFor(() => {
      const button = document.querySelector('[data-thread-follow]') as HTMLButtonElement | null;
      if (!button) throw new Error('follow switch not shown');
      return button;
    });
    fireEvent.click(follow);
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(follow);
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    // The first save times out after the server may already have kept it.
    await act(async () => { failFirst(new Error('timeout')); });
    await waitFor(() => expect(mocks.followThread).toHaveBeenCalledTimes(2));
    expect(mocks.followThread.mock.calls.map(([input]) => input.following)).toEqual([true, false]);
    expect(follow.getAttribute('aria-pressed')).toBe('false');
  });

  it('saves the last follow click even after the Thread panel closes', async () => {
    mocks.thread.mockResolvedValue({ ok: true, root: message, replies: [], hasMore: false, following: false });
    let finishFirst: (value: { ok: true; following: boolean }) => void = () => {};
    mocks.followThread.mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ ok: true, following: false });
    const view = render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const follow = await waitFor(() => {
      const button = document.querySelector('[data-thread-follow]') as HTMLButtonElement | null;
      if (!button) throw new Error('follow switch not shown');
      return button;
    });
    fireEvent.click(follow);
    fireEvent.click(follow);
    view.unmount();
    await act(async () => { finishFirst({ ok: true, following: true }); });
    await waitFor(() => expect(mocks.followThread).toHaveBeenCalledTimes(2));
    expect(mocks.followThread.mock.calls.map(([input]) => input.following)).toEqual([true, false]);
  });

  it('joins the running follow save when the same Thread reopens, so the last click is saved last', async () => {
    mocks.thread.mockResolvedValue({ ok: true, root: message, replies: [], hasMore: false, following: false });
    let active = 0, most = 0;
    const pending: Array<() => void> = [];
    mocks.followThread.mockImplementation((input: { following: boolean }) => {
      active += 1; most = Math.max(most, active);
      return new Promise(resolve => pending.push(() => { active -= 1; resolve({ ok: true, following: input.following }); }));
    });
    const followSwitch = () => waitFor(() => {
      const button = document.querySelector('[data-thread-follow]') as HTMLButtonElement | null;
      if (!button) throw new Error('follow switch not shown');
      return button;
    });
    const first = render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    fireEvent.click(await followSwitch());
    fireEvent.click(await followSwitch());
    first.unmount();
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    // The reopened panel shows the reader's last click while the earlier save runs.
    await waitFor(async () => expect((await followSwitch()).getAttribute('aria-pressed')).toBe('false'));
    fireEvent.click(await followSwitch());
    while (pending.length) await act(async () => { pending.shift()!(); });
    await waitFor(() => expect((document.querySelector('[data-thread-follow]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true'));
    expect(most).toBe(1);
    expect(mocks.followThread.mock.calls.at(-1)![0].following).toBe(true);
  });

  it('refits a typed thread reply when the panel width changes, not when only its height does', () => {
    const observed: Array<{ target: Element; callback: () => void }> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe(target: Element) { observed.push({ target, callback: this.callback }); }
      disconnect() {}
    });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
    let width = 400, contentHeight = 48;
    Object.defineProperty(input, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => contentHeight });
    fireEvent.change(input, { target: { value: 'A long reply that wraps onto several lines' } });
    expect(input.style.height).toBe('48px');
    const refit = observed.find(entry => entry.target === input)!.callback;
    width = 200; contentHeight = 96;
    refit();
    expect(input.style.height).toBe('96px');
    contentHeight = 120;
    refit();
    expect(input.style.height).toBe('96px');
  });

  it('keeps the focus in a sending thread reply, shows it in the thread at once, and sends it only once', async () => {
    let settle: (value: { ok: true; messageId: string }) => void = () => {};
    mocks.reply.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
    const sendButton = screen.getByRole('button', { name: k('sendReply') }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    input.focus();
    fireEvent.change(input, { target: { value: 'In flight' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Optimistic: the reply moves into the thread while main answers; the input is free again but
    // nothing else goes out until this reply settles.
    await waitFor(() => expect(input.value).toBe(''));
    expect(document.activeElement).toBe(input);
    expect(sendButton.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(sendButton);
    expect(mocks.reply).toHaveBeenCalledOnce();
    settle({ ok: true, messageId: 'reply' });
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
    expect(input.readOnly).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('keeps the caret in the reply when the send button is pressed with the mouse', () => {
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
    const sendButton = screen.getByRole('button', { name: k('sendReply') });
    fireEvent.change(input, { target: { value: 'Clicked send' } });
    input.focus();
    // A cancelled mousedown is what stops Chromium moving focus onto the button.
    expect(fireEvent.mouseDown(sendButton)).toBe(false);
    input.blur();
    expect(fireEvent.mouseDown(sendButton)).toBe(true);
  });

  it('closes from the square button surface outside the icon and retains the standard focus treatment', () => {
    const onClose = vi.fn();
    render(<ChatThreadPanel group={group} rootId="root" onClose={onClose} />);
    const close = screen.getByRole('button', { name: 'bots.close' });
    expect(close.className).toContain('w-8 rounded-none px-0');
    expect(close.className).toContain('[&::before]:rounded-full');
    expect(close.className).toContain('focus-visible:ring-2');
    expect(close.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(close, { clientX: 1, clientY: 1 });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'private-diagnostic'])('keeps existing thread notices visible without a valid runtime code: %s', async runtimeFailureCode => {
    mocks.thread.mockResolvedValue({ ok: true, root: message, replies: [{ ...message, id: 'old-notice', kind: 'notice',
      content: 'Existing system notice', runtimeFailureCode }], hasMore: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    expect(await screen.findByText('Existing system notice')).toBeTruthy();
    expect(screen.queryByText('private-diagnostic')).toBeNull();
  });

  it('renders the current root failure beside the root and removes it when a refreshed page clears the failure', async () => {
    const failure = { executionId: 'root-run', epoch: 1, sourceMessageId: message.id, botId: 'bot', botName: 'Bot', code: 'QUOTA_EXCEEDED', planId: null };
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, executionFailures: [failure], replies: [], hasMore: true })
      .mockResolvedValue({ ok: true, root: message, executionFailures: [], replies: [], hasMore: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const text = 'bots.groupChat.notice.runtimeFailure.QUOTA_EXCEEDED';
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText('Root message')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
    expect(screen.getByText('Root message')).toBeTruthy();
  });

  it('retains the loaded Thread when a full adjacent page of replies arrives', async () => {
    const replies = (start: number) => Array.from({ length: 50 }, (_, i) => ({
      ...message, id: `reply-${start + i}`, sequence: start + i, content: `Reply ${start + i}`, reactions: [],
    }));
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, replies: replies(2), hasMore: false })
      .mockResolvedValue({ ok: true, root: message, replies: replies(52), hasMore: true });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const oldRow = (await screen.findByText('Reply 2')).closest('article');
    const root = screen.getByText('Root message').closest('article')!;
    fireEvent.click(within(root).getByRole('button', { name: k('reactionCount') }));
    await screen.findByText('Reply 101');
    expect(screen.getByText('Reply 2').closest('article')).toBe(oldRow);
    expect(screen.getByText('Reply 51')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' })).toBeNull();
  });

  it('starts the Thread over from a latest page that no longer reaches the replies on screen', async () => {
    const early = { ...message, id: 'early', sequence: 5, content: 'Early reply' };
    const far = { ...message, id: 'far', sequence: 200, content: 'Far reply' };
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, replies: [early], hasMore: false })
      .mockResolvedValue({ ok: true, root: message, replies: [far], hasMore: true });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    await screen.findByText('Early reply');
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' })).toBeNull();
    // More than a page arrived at once: replies may sit between 5 and 200.
    const root = screen.getByText('Root message').closest('article')!;
    fireEvent.click(within(root).getByRole('button', { name: k('reactionCount') }));
    await screen.findByText('Far reply');
    expect(screen.queryByText('Early reply')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await waitFor(() => expect(mocks.thread.mock.calls.at(-1)?.[0]).toMatchObject({ before: 200 }));
  });

  it('drops an older Thread page that answers after the latest page started over', async () => {
    const latest = { ...message, id: 'latest', sequence: 100, content: 'Latest reply' };
    const older = { ...message, id: 'older', sequence: 4, content: 'Earlier reply' };
    const far = { ...message, id: 'far', sequence: 300, content: 'Far reply' };
    let finish!: (value: unknown) => void;
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, replies: [latest], hasMore: true })
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ ok: true, root: message, replies: [far], hasMore: true });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    // More than a page arrives while the older page is still on its way.
    const root = screen.getByText('Root message').closest('article')!;
    fireEvent.click(within(root).getByRole('button', { name: k('reactionCount') }));
    await screen.findByText('Far reply');
    await act(async () => finish({ ok: true, root: message, replies: [older], hasMore: false }));
    expect(screen.queryByText('Earlier reply')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await waitFor(() => expect(mocks.thread.mock.calls.at(-1)?.[0]).toMatchObject({ before: 300 }));
  });

  it('clears a retried failure on an older loaded Thread page without dropping its reply', async () => {
    const latest = { ...message, id: 'latest', sequence: 100, content: 'Latest reply' };
    const older = { ...message, id: 'older', sequence: 4, content: 'Earlier reply' };
    const failure = { executionId: 'older-run', epoch: 1, sourceMessageId: older.id, botId: 'bot', botName: 'Bot', code: 'AUTH_REQUIRED', planId: null };
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, replies: [latest], hasMore: true, executionFailures: [failure] })
      .mockResolvedValueOnce({ ok: true, root: message, replies: [older], hasMore: false, executionFailures: [failure] })
      .mockResolvedValue({ ok: true, root: message, replies: [latest], hasMore: true, executionFailures: [] });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await screen.findByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED');
    const root = screen.getByText('Root message').closest('article')!;
    fireEvent.click(within(root).getByRole('button', { name: k('reactionCount') }));
    await waitFor(() => expect(screen.queryByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED')).toBeNull());
    expect(screen.getByText('Earlier reply')).toBeTruthy();
    expect(screen.getByText('Latest reply')).toBeTruthy();
    expect(mocks.thread.mock.calls.at(-1)?.[0]).toMatchObject({ sourceMessageIds: [older.id, latest.id] });
  });

  it('stops a bulk retry of main-chat copies once the account is switched', async () => {
    mocks.reply.mockResolvedValueOnce({ ok: true, messageId: 'first' }).mockResolvedValueOnce({ ok: true, messageId: 'second' });
    mocks.shareToMain.mockResolvedValue({ ok: false, errorCode: 'SERVICE_ERROR' });
    render(<ChatThreadPanel group={group} rootId="retry-root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') });
    for (const [count, text] of [[1, 'one'], [2, 'two']] as const) {
      fireEvent.click(screen.getByRole('checkbox', { name: k('thread.alsoSend') }));
      fireEvent.change(input, { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
      await waitFor(() => expect(mocks.shareToMain).toHaveBeenCalledTimes(count));
    }
    const retry = await screen.findByRole('button', { name: k('thread.retryPost') });
    let finish!: (value: unknown) => void;
    mocks.shareToMain.mockClear().mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ ok: true, messageId: 'share', alreadyShared: false });
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.shareToMain).toHaveBeenCalledTimes(1));
    // The account changes while the first copy is in flight: the second must not go out.
    mocks.ownerCurrent = false;
    finish({ ok: true, messageId: 'share', alreadyShared: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.shareToMain).toHaveBeenCalledTimes(1);
  });

  it('names an unavailable share only for posting; a missing message elsewhere stays generic', () => {
    expect(chatErrorKey('SHARE_UNAVAILABLE')).toBe(k('thread.shareUnavailable'));
    expect(chatErrorKey('MESSAGE_NOT_FOUND')).toBe(k('requestFailed'));
  });

  it.each([[true, 'auto'], [false, 'smooth']] as const)('jumps to a shared reply without smooth scrolling when reduced motion is %s', (reduced, behavior) => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query === '(prefers-reduced-motion: reduce)' }));
    const target = document.createElement('article');
    target.scrollIntoView = vi.fn();
    flashThreadTarget(target);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior });
  });

  it('keeps looking for a shared reply when group pushes overtake its older-page reads', async () => {
    let latest = { ...message, id: 'latest', sequence: 100, content: 'Latest reply' };
    const target = { ...message, id: 'target', sequence: 4, content: 'Target reply' };
    const olderReads: Array<(value: unknown) => void> = [];
    mocks.thread.mockImplementation(({ before }: { before?: number }) => before
      ? new Promise(resolve => { olderReads.push(resolve); })
      : Promise.resolve({ ok: true, root: message, replies: [latest], hasMore: true }));
    let push!: (event: { groupId: string }, stamp: unknown) => void;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: {
      chatServer: mocks, onBotGroupChanged: (listener: typeof push) => { push = listener; return () => {}; },
    } } });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });
    render(<ChatThreadPanel group={group} rootId="root" focus={{ messageId: target.id, nonce: 1 }} onClose={vi.fn()} />);
    await waitFor(() => expect(olderReads).toHaveLength(1));
    // Each push refresh lands while an older page is in flight, so that page is discarded.
    for (let overtaken = 1; overtaken <= 6; overtaken += 1) {
      latest = { ...latest, id: `latest-${overtaken}`, sequence: latest.sequence + 100 };
      push({ groupId: 'room' }, null);
      await waitFor(() => expect(olderReads).toHaveLength(overtaken + 1));
      olderReads[overtaken - 1]!({ ok: true, root: message, replies: [], hasMore: true });
    }
    olderReads.at(-1)!({ ok: true, root: message, replies: [target], hasMore: false });
    expect(await screen.findByText('Target reply')).toBeTruthy();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it('preserves copy and image sharing beside thread replies and reactions in one toolbar', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined), reply = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ChatMessageActions shareScope="group:room" groupId="room" message={{ ...message, replyCount: 2 }} onReply={reply} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.messageActionBar.copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Root message'));
    fireEvent.click(screen.getByRole('button', { name: k('openTopic') }));
    expect(reply).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'chat.shareImage.entry' }));
    expect(shareSelectionStore.isActive('group:room')).toBe(true);
    expect(shareSelectionStore.getSelectedIds()).toEqual(['root']);
    fireEvent.click(screen.getByRole('button', { name: k('addReaction') }));
    fireEvent.click(screen.getByRole('button', { name: '🎉' }));
    await waitFor(() => expect(mocks.react).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '🎉', present: true }));
  });

  it('shows the Thread root and reply attachments as pictures, chips and honest states, never as body text', async () => {
    const image = { id: 'img', name: 'clipboard-1791877522388.png', category: 'image', mimeType: 'image/png', size: 1, url: 'cindy-media://blobs/img.png', path: null };
    const loading = { id: 'late', name: 'late.png', category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'loading' };
    const lost = { id: 'lost', name: 'spec.pdf', category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'unavailable' };
    const file = { id: 'doc', name: 'notes.md', category: 'text', mimeType: 'text/markdown', size: 1, url: null, path: '/tmp/notes.md' };
    mocks.thread.mockResolvedValue({ ok: true, root: { ...message, content: '只要伙伴能管理session', attachments: [image, loading] },
      replies: [{ ...message, id: 'reply', sequence: 2, content: '', attachments: [file, lost] }], hasMore: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const root = (await screen.findByText('只要伙伴能管理session')).closest('article')!;
    expect(within(root).getByAltText('clipboard-1791877522388.png')).toBeTruthy();
    expect(within(root).getByText('chat.imageMissing.loading')).toBeTruthy();
    expect(within(root).getByText('late.png')).toBeTruthy();
    const reply = screen.getByText('notes.md').closest('article')!;
    expect(within(reply).getByRole('button', { name: 'notes.md' })).toBeTruthy();
    expect(within(reply).getByRole('status', { name: 'spec.pdf, bots.groupChat.files.unavailable' })).toBeTruthy();
    expect(within(reply).queryByRole('button', { name: /spec\.pdf/ })).toBeNull();
    expect(document.body.textContent).not.toContain('[附件:');
  });

  it('updates an attachment on an earlier Thread page when its download finishes', async () => {
    let push: ((event: { groupId: string }, stamp?: unknown) => void) | undefined;
    (window.electronAPI.maker as unknown as { onBotGroupChanged: unknown }).onBotGroupChanged = (callback: typeof push) => { push = callback; return () => {}; };
    let arrived = false;
    const latest = { ...message, id: 'latest', sequence: 60, content: 'Latest reply' };
    const older = (ready: boolean) => ({ ...message, id: 'older', sequence: 5, content: 'Earlier reply', attachments: [ready
      ? { id: 'old', name: 'old.png', category: 'image', mimeType: 'image/png', size: 1, url: 'cindy-media://blobs/old.png', path: null }
      : { id: 'old', name: 'old.png', category: 'file', mimeType: '', size: 0, url: null, path: null, state: 'loading' }] });
    mocks.thread.mockImplementation(async ({ before }: { before?: number }) => before === undefined
      ? { ok: true, root: message, replies: [latest], hasMore: true }
      : { ok: true, root: message, replies: [older(arrived)], hasMore: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    expect(await screen.findByText('chat.imageMissing.loading')).toBeTruthy();
    arrived = true;
    push?.({ groupId: 'room' });
    expect(await screen.findByAltText('old.png')).toBeTruthy();
    expect(screen.queryByText('chat.imageMissing.loading')).toBeNull();
    expect(mocks.thread.mock.calls.map(([input]) => (input as { before?: number }).before)).toEqual([undefined, 60, undefined, 6]);
  });

  it('shares thread messages separately from the main timeline and excludes controls from the image', async () => {
    const view = render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const article = (await screen.findByText('Root message')).closest('article')!;
    // Share lives in the bubble toolbar's more menu.
    fireEvent.pointerDown(within(article).getByRole('button', { name: 'chat.messageActionBar.moreActions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'chat.shareImage.entry' }));
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

  // Unit, PR #7396: a latest refresh must not invalidate the reaction recheck for
  // an opened older reply. The projection path must avoid that extra page read.
  it.each([false, true])('refreshes an opened older Thread reaction (projection: %s)', async projection => {
    const latest = { ...message, id: 'latest', sequence: 100, content: 'Latest reply', reactions: [] };
    const older = { ...message, id: 'older', sequence: 4, content: 'Earlier reply', reactions: [{ emoji: '👍', count: 1, me: false }] };
    const updated = { ...older, reactions: [{ emoji: '👍', count: 2, me: true }] };
    let reacted = false;
    mocks.thread.mockImplementation(async (input: { before?: number }) => input.before
      // The re-read page's hasMore is not about the oldest loaded page, so it must be ignored.
      ? { ok: true, root: message, replies: [reacted ? updated : older], hasMore: input.before === 5 }
      : { ok: true, root: message, replies: [latest], hasMore: true, ...(projection && reacted ? { messageUpdates: [updated] } : {}) });
    mocks.react.mockImplementation(async () => { reacted = true; return { ok: true }; });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    const earlier = (await screen.findByText('Earlier reply')).closest('article')!;
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' })).toBeNull();
    const chip = within(earlier).getByRole('button', { name: k('reactionCount') });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    const earlierChip = () => within(screen.getByText('Earlier reply').closest('article')!).getByRole('button', { name: k('reactionCount') });
    await waitFor(() => expect(earlierChip().getAttribute('aria-pressed')).toBe('true'));
    // The message refresh sets `me` before the separate reactors read settles
    // from avatar placeholders back to the authoritative count.
    await waitFor(() => expect(earlierChip().textContent).toContain('2'));
    expect(mocks.react).toHaveBeenCalledWith({ groupId: 'room', messageId: 'older', emoji: '👍', present: true });
    expect(mocks.thread.mock.calls.map(([input]) => input.before)).toEqual(projection
      ? [undefined, 100, undefined] : [undefined, 100, undefined, 5]);
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' })).toBeNull();
    expect(screen.getByText('Latest reply')).toBeTruthy();
  });

  // Unit, PR #7396: two warm topics share a room, but losing one root must not
  // erase the other. Room revocation must still remove both cached previews.
  it.each(['MESSAGE_NOT_FOUND', 'CONVERSATION_NOT_FOUND'])('scopes warm topic eviction to the error (%s)', async errorCode => {
    const room = { ...group, id: `scope-${errorCode}`, historyRevision: `scope-${errorCode}` };
    mocks.thread.mockImplementation(async ({ rootId }: { rootId: string }) => ({ ok: true,
      historyRevision: room.historyRevision, root: { ...message, id: rootId, reactions: [] },
      replies: [{ ...message, id: `${rootId}-reply`, sequence: 2, content: `${rootId} cached reply`, reactions: [] }], hasMore: false }));
    const open = (rootId: string) => render(<ChatThreadPanel group={room} rootId={rootId} onClose={vi.fn()} />);
    for (const rootId of ['other', 'root']) {
      const view = open(rootId);
      await screen.findByText(`${rootId} cached reply`);
      view.unmount();
    }
    let finish!: (value: unknown) => void;
    mocks.thread.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const missing = open('root');
    expect(screen.getByText('root cached reply')).toBeTruthy();
    await act(async () => finish({ ok: false, errorCode }));
    expect(screen.queryByText('root cached reply')).toBeNull();
    missing.unmount();
    const retry = open('root');
    expect(screen.queryByText('root cached reply')).toBeNull();
    retry.unmount();
    open('other');
    expect(Boolean(screen.queryByText('other cached reply'))).toBe(errorCode === 'MESSAGE_NOT_FOUND');
  });

  it('re-reads Thread reactors only when this message or the whole room changed, even if the page is not reloaded', async () => {
    const thread = (revisions: Pick<BotGroupDetail, 'reactionRevision' | 'reactionRevisions'>) =>
      <ChatThreadPanel group={{ ...group, ...revisions }} rootId="root" onClose={vi.fn()} />;
    const view = render(thread({ reactionRevision: 0, reactionRevisions: { root: 1 } }));
    const rerender = (revisions: Pick<BotGroupDetail, 'reactionRevision' | 'reactionRevisions'>) =>
      view.rerender(<Tooltip.Provider>{thread(revisions)}</Tooltip.Provider>);
    await screen.findByRole('button', { name: k('reactionCount') });
    await waitFor(() => expect(mocks.reactors).toHaveBeenCalledTimes(1));
    // Someone reacted to another message: this badge keeps its reactors.
    rerender({ reactionRevision: 0, reactionRevisions: { root: 1, other: 1 } });
    await act(async () => {});
    expect(mocks.reactors).toHaveBeenCalledTimes(1);
    // Who reacted to this message changed.
    rerender({ reactionRevision: 0, reactionRevisions: { root: 2, other: 1 } });
    await waitFor(() => expect(mocks.reactors).toHaveBeenCalledTimes(2));
    // A reset counts every message as changed.
    rerender({ reactionRevision: 1, reactionRevisions: {} });
    await waitFor(() => expect(mocks.reactors).toHaveBeenCalledTimes(3));
  });

  it('uses the refreshed Thread root reaction state while the main timeline remains stale', async () => {
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, replies: [], hasMore: false })
      .mockResolvedValue({ ok: true, root: { ...message, reactions: [{ emoji: '👍', count: 1, me: false }] }, replies: [], hasMore: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const reaction = await screen.findByRole('button', { name: k('reactionCount') });
    expect(reaction.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(reaction);
    await waitFor(() => expect(screen.getByRole('button', { name: k('reactionCount') }).getAttribute('aria-pressed')).toBe('false'));
    // One reactor: the badge settles on its count once the reactor read disagrees (mock returns none).
    await waitFor(() => expect(screen.getByRole('button', { name: k('reactionCount') }).textContent).toContain('1'));
    expect(group.messages[0].reactions?.[0].me).toBe(true);
  });

  it('shows a pasted invitation preview first; only explicit acceptance joins', async () => {
    const joined = vi.fn();
    render(<StrictMode><ChatInviteDialog onClose={vi.fn()} onJoined={joined} /></StrictMode>);
    expect(mocks.previewInvite).not.toHaveBeenCalled();
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

  describe('thread @ picker', () => {
    const namesakes = [
      { botId: 'ann-chris', name: 'Ann', status: 'active' },
      { botId: 'ann-dana', name: 'Ann', status: 'active' },
      { botId: 'bo', name: 'Bo', status: 'active' },
      { botId: 'gone', name: 'Annie', status: 'left' },
    ];
    const renderThread = () => {
      mocks.reply.mockResolvedValue({ ok: true, messageId: 'reply' });
      render(<ChatThreadPanel group={{ ...group, members: namesakes } as unknown as BotGroupDetail} rootId="root" onClose={vi.fn()} />);
      const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
      expect(document.activeElement).toBe(input);
      return input;
    };
    const type = (input: HTMLTextAreaElement, value: string, caret = value.length) =>
      fireEvent.change(input, { target: { value, selectionStart: caret, selectionEnd: caret } });
    const labels = () => screen.queryAllByRole('option').map(option => option.textContent);

    it('opens on @ with the main composer candidates, filters, and picks a namesake by keyboard', async () => {
      const input = renderThread();
      type(input, '@');
      const listbox = screen.getByRole('listbox', { name: 'bots.groupChat.mention.label' });
      // Everyone first, then active teammates only (the departed one is not offered).
      expect(labels()).toEqual(['bots.groupChat.mention.allbots.groupChat.mention.allHint', 'Ann', 'Ann', 'Bo']);
      expect(input.getAttribute('aria-controls')).toBe(listbox.id);
      expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]!.id);
      type(input, '@an');
      expect(labels()).toEqual(['Ann', 'Ann']);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
      // Enter picks while the list is open; it never sends.
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(input.value).toBe('@Ann ');
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(mocks.reply).not.toHaveBeenCalled();
      type(input, '@Ann 看一下');
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      expect(mocks.reply.mock.calls[0]![0]).toMatchObject({ groupId: 'room', rootId: 'root', text: '@Ann 看一下', mentions: { all: false, botIds: ['ann-dana'] } });
      await waitFor(() => expect(input.value).toBe(''));
    });

    it('picks by mouse in the middle of a draft, supports several @ and Everyone', async () => {
      const input = renderThread();
      type(input, '请  帮忙', 1);
      type(input, '请 @ 帮忙', 3);
      const bo = screen.getAllByRole('option')[3]!;
      // Pressing the option keeps focus in the input.
      expect(fireEvent.mouseDown(bo)).toBe(false);
      fireEvent.click(bo);
      expect(input.value).toBe('请 @Bo 帮忙');
      expect(input.selectionStart).toBe(6);
      type(input, '请 @Bo @ 帮忙', 7);
      fireEvent.click(screen.getAllByRole('option')[0]!);
      expect(input.value).toBe('请 @Bo @bots.groupChat.mention.all 帮忙');
      fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      expect(mocks.reply.mock.calls[0]![0].mentions).toEqual({ all: true, botIds: ['bo'] });
    });

    it('Escape closes only the list for that @; IME keys neither pick nor send', () => {
      const input = renderThread();
      type(input, '@');
      const composing = createEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
      fireEvent(input, composing);
      expect(input.value).toBe('@');
      expect(screen.getByRole('listbox')).toBeTruthy();
      const escape = createEvent.keyDown(input, { key: 'Escape' });
      fireEvent(input, escape);
      // The thread panel's own Esc-to-close sees a handled key and stays open.
      expect(escape.defaultPrevented).toBe(true);
      expect(screen.queryByRole('listbox')).toBeNull();
      type(input, '@A');
      expect(screen.queryByRole('listbox')).toBeNull();
      // Enter with the list closed sends as usual; a fresh @ opens it again.
      type(input, '@A @');
      expect(labels()).toHaveLength(4);
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(mocks.reply).toHaveBeenCalledOnce();
    });

    it('closes the list once a reply is sent, so a late pick cannot rewrite what went out', async () => {
      const input = renderThread();
      let settle: (value: { ok: true; messageId: string }) => void = () => {};
      mocks.reply.mockReturnValue(new Promise(resolve => { settle = resolve; }));
      type(input, '@B');
      expect(labels()).toContain('Bo');
      fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
      // The reply left the input the moment it was sent; the picker has nothing to complete.
      await waitFor(() => expect(input.value).toBe(''));
      expect(screen.queryByRole('listbox')).toBeNull();
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Tab' });
      expect(input.value).toBe('');
      settle({ ok: true, messageId: 'reply' });
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('treats an e-mail address as text and forgets a pick once its name is edited', async () => {
      const input = renderThread();
      type(input, 'mail a@');
      expect(screen.queryByRole('listbox')).toBeNull();
      type(input, '@');
      fireEvent.click(screen.getAllByRole('option')[1]!);
      expect(input.value).toBe('@Ann ');
      type(input, '@An ', 3);
      type(input, '@Ann ', 4);
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      // A retyped name is a manual @: both namesakes, as in the main composer.
      expect(mocks.reply.mock.calls[0]![0].mentions).toEqual({ all: false, botIds: ['ann-chris', 'ann-dana'] });
    });

    it('moves the caret past the space when a re-pick leaves the text unchanged, and does not pull it back later', () => {
      const input = renderThread();
      type(input, '@');
      fireEvent.click(screen.getAllByRole('option')[1]!);
      expect(input.selectionStart).toBe(5);
      act(() => { input.blur(); input.setSelectionRange(4, 4); input.focus(); });
      fireEvent.click(screen.getAllByRole('option')[1]!);
      expect(input.value).toBe('@Ann ');
      expect(input.selectionStart).toBe(5);
      type(input, '@Ann ok', 7);
      expect(input.selectionStart).toBe(7);
    });

    it('does not let a pick push the reply past its 8000-character limit', () => {
      const input = renderThread();
      const near = `${'x'.repeat(7996)} @`;
      type(input, near);
      fireEvent.click(screen.getAllByRole('option')[3]!);
      // `@Bo ` would make 8000 + 1 characters: the pick is refused, as typing past maxLength is.
      expect(input.value).toBe(near);
      type(input, `${'x'.repeat(7995)} @`);
      fireEvent.click(screen.getAllByRole('option')[3]!);
      expect(input.value).toBe(`${'x'.repeat(7995)} @Bo `);
      expect(input.value).toHaveLength(8000);
    });

    it('names only the picked companion whose name is a Thread 「所有人」 alias', async () => {
      mocks.reply.mockResolvedValue({ ok: true, messageId: 'reply' });
      const members = [{ botId: 'all-bot', name: 'all', status: 'active' }, { botId: 'bo', name: 'Bo', status: 'active' }];
      render(<ChatThreadPanel group={{ ...group, members } as unknown as BotGroupDetail} rootId="root" onClose={vi.fn()} />);
      const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
      type(input, '@al');
      fireEvent.click(screen.getAllByRole('option').find(option => option.textContent === 'all')!);
      expect(input.value).toBe('@all ');
      // Typing after the pick keeps it.
      type(input, '@all 看下');
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      expect(mocks.reply.mock.calls[0]![0].mentions).toEqual({ all: false, botIds: ['all-bot'] });
    });

    it('never offers or resolves the current user, as on mobile', async () => {
      mocks.reply.mockResolvedValue({ ok: true, messageId: 'reply' });
      const members = [{ botId: 'me', name: 'Dash', status: 'active', isSelf: true }, { botId: 'bo', name: 'Bo', status: 'active' }];
      render(<ChatThreadPanel group={{ ...group, members } as unknown as BotGroupDetail} rootId="root" onClose={vi.fn()} />);
      const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
      type(input, '@');
      expect(labels()).toEqual(['bots.groupChat.mention.allbots.groupChat.mention.allHint', 'Bo']);
      type(input, '@Da');
      expect(screen.queryByRole('listbox')).toBeNull();
      // A typed own name is plain text, not a target the host would drop to nothing.
      type(input, '@Dash @Bo 看下');
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      expect(mocks.reply.mock.calls[0]![0].mentions).toEqual({ all: false, botIds: ['bo'] });
    });

    // One retry rule (bot-group-chat.md): a failed reply is retried with the same clientId only when the
    // text and its targets are unchanged. Each row edits the draft between attempts without changing the text.
    // Comparing only the text fails rows 1 and 4; comparing the pick records fails row 3; re-resolving
    // against the live roster fails the roster-refresh test above.
    const pickAt = (input: HTMLTextAreaElement, caret: number, option: number) => {
      // As a user would: click back into the box with the caret after the name, then pick.
      act(() => { input.blur(); input.setSelectionRange(caret, caret); input.focus(); });
      fireEvent.click(screen.getAllByRole('option')[option]!);
    };
    it.each([
      { row: 're-pick the other namesake', draft: (input: HTMLTextAreaElement) => { type(input, '@'); fireEvent.click(screen.getAllByRole('option')[1]!); },
        edit: (input: HTMLTextAreaElement) => pickAt(input, 4, 1), text: '@Ann ', first: ['ann-chris'], second: ['ann-dana'], reused: false },
      { row: 're-pick the same teammate for an earlier mention', draft: (input: HTMLTextAreaElement) => {
        type(input, '@'); fireEvent.click(screen.getAllByRole('option')[1]!); type(input, '@Ann @', 6); fireEvent.click(screen.getAllByRole('option')[3]!);
      }, edit: (input: HTMLTextAreaElement) => pickAt(input, 4, 0), text: '@Ann @Bo ', first: ['ann-chris', 'bo'], second: ['ann-chris', 'bo'], reused: true },
      { row: 'pick the same teammate for a typed mention', draft: (input: HTMLTextAreaElement) => type(input, '@Bo '),
        // The typed query `Bo` also matches the untranslated 所有人 key here, so Bo is the second option.
        edit: (input: HTMLTextAreaElement) => pickAt(input, 3, 1), text: '@Bo ', first: ['bo'], second: ['bo'], reused: true },
      { row: 'pick one namesake for a typed mention', draft: (input: HTMLTextAreaElement) => type(input, '@Ann '),
        edit: (input: HTMLTextAreaElement) => pickAt(input, 4, 1), text: '@Ann ', first: ['ann-chris', 'ann-dana'], second: ['ann-dana'], reused: false },
    ])('retries a failed reply after "$row" with reused clientId = $reused', async ({ draft, edit, text, first, second, reused }) => {
      const input = renderThread();
      mocks.reply.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT' });
      draft(input);
      expect(input.value).toBe(text);
      fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
      await screen.findByRole('alert');
      edit(input);
      expect(input.value).toBe(text);
      fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(2));
      const [one, two] = mocks.reply.mock.calls.map(call => call[0]);
      expect(one.mentions).toEqual({ all: false, botIds: first });
      expect(two.mentions).toEqual({ all: false, botIds: second });
      expect(two.clientId === one.clientId).toBe(reused);
    });
  });
});
