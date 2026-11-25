// @vitest-environment jsdom
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from "@/cindy-brain/PluginUiContributions";
import { act, cleanup, fireEvent, render as renderUI, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ChatReactionReads } from '../useChatReactions';
import { GroupReactionFixture } from './GroupReactionFixture';
import type { BotGroupMemberView, BotGroupMessageView, ChatReactor } from '../../../../shared/botGroupChat';

const mocks = vi.hoisted(() => ({ react: vi.fn(), reactors: vi.fn(), ownerCurrent: true }));
// Interpolating stand-in so the assertions read the composed label, not bare keys.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' },
  t: (key: string, o?: Record<string, unknown>) => {
    const name = key.replace('bots.groupChat.server.', '');
    if (name === 'reactorSelf') return 'You';
    if (name === 'reactorFormer') return `${o?.name} (left)`;
    if (name === 'reactorsUnavailable') return `${o?.count} unavailable`;
    if (name === 'reactionCount') return `${o?.emoji} · ${o?.count}`;
    if (name === 'reactionWho') return `${o?.emoji} · ${o?.count}: ${o?.names}`;
    return name;
  } }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/contexts/dataOwnerGeneration', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/contexts/dataOwnerGeneration')>();
  return { ...original, isDataOwnerGenerationCurrent: (owner: ReturnType<typeof original.getDataOwnerGeneration>) =>
    mocks.ownerCurrent && original.isDataOwnerGenerationCurrent(owner) };
});

const reactor = (actorId: string, name: string | null, extra: Partial<ChatReactor> = {}): ChatReactor =>
  ({ actorId, name, isSelf: false, formerMember: false, ...extra });
const member = (actorId: string, name: string, avatarUrl: string | null = null) =>
  ({ actorId, botId: actorId, name, avatar: '', avatarUrl, avatarColor: 'violet', status: 'active' }) as BotGroupMemberView;
const members = [
  member('a', 'Dash', 'https://example.test/dash.png'),
  member('c1', 'Cindy (Chris)', 'https://example.test/cindy-chris.png'),
  member('c2', 'Cindy (Dana)', 'https://example.test/cindy-dana.png'),
  // A different actor with the same display name must never lend its picture.
  member('z2', 'Zoe', 'https://example.test/other-zoe.png'),
  member('z', 'Zoe'),
];
const message = (reactions: BotGroupMessageView['reactions']) =>
  ({ id: 'root', authorName: 'Human', content: 'Root', reactions }) as BotGroupMessageView;
const actions = (reactions: BotGroupMessageView['reactions'], props: {
  details?: boolean; reactionReads?: ChatReactionReads; onChanged?: () => void; groupId?: string;
} = {}) =>
  <GroupReactionFixture pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} shareScope="group:room" groupId="room" message={message(reactions)} members={members} onChanged={vi.fn()} {...props} />;
// The message toolbar expects the app-level tooltip provider.
const render = (ui: ReactNode) => {
  const view = renderUI(<Tooltip.Provider>{ui}</Tooltip.Provider>);
  return { ...view, rerender: (next: ReactNode) => view.rerender(<Tooltip.Provider>{next}</Tooltip.Provider>) };
};
const detailActions = (reactions: BotGroupMessageView['reactions']) => actions(reactions, { details: true });
const badge = () => screen.getByRole('button', { name: /^👍 · / });
const avatars = () => badge().querySelector('[data-testid="reaction-avatars"]');
const images = () => [...badge().querySelectorAll('img')].map(img => img.getAttribute('src'));

beforeEach(() => {
  vi.clearAllMocks(); mocks.ownerCurrent = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.react.mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: mocks } } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('reaction avatars', () => {
  it('shows a few reactors as avatars without hovering, matched to members by actor ID', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [
      reactor('c2', 'Cindy (Dana)'), reactor('a', 'Dash', { isSelf: true }), reactor('c1', 'Cindy (Chris)'),
    ] });
    render(detailActions([{ emoji: '👍', count: 3, me: true }]));
    expect(mocks.reactors).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '👍' });
    // The current actor first; same-name companions keep their own avatars.
    await waitFor(() => expect(images()).toEqual([
      'https://example.test/dash.png', 'https://example.test/cindy-chris.png', 'https://example.test/cindy-dana.png',
    ]));
    expect(badge().getAttribute('aria-label')).toBe('👍 · 3: You, Cindy (Chris), and Cindy (Dana)');
    expect(badge().textContent).not.toContain('3');
    expect(mocks.react).not.toHaveBeenCalled();
  });

  it('reads only once a badge is near the viewport, and not again for an unchanged reaction', async () => {
    const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(callback); }
      observe() {} disconnect() {}
    });
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('z', 'Zoe')] });
    render(detailActions([{ emoji: '👍', count: 1, me: false }]));
    // Off-screen history badges keep their slots without reading.
    expect(avatars()?.children).toHaveLength(1);
    expect(mocks.reactors).not.toHaveBeenCalled();
    act(() => observers.forEach(notify => notify([{ isIntersecting: true }])));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoe'));
    // Scrolling away and back does not re-read the same reaction state.
    act(() => observers.forEach(notify => notify([{ isIntersecting: false }])));
    act(() => observers.forEach(notify => notify([{ isIntersecting: true }])));
    expect(mocks.reactors).toHaveBeenCalledTimes(1);
  });

  it('keeps the count above the avatar limit and reads nothing', () => {
    render(detailActions([{ emoji: '👍', count: 4, me: false }]));
    expect(badge().textContent).toBe('👍4');
    expect(avatars()).toBeNull();
    expect(mocks.reactors).not.toHaveBeenCalled();
  });

  it('reserves one slot per reactor while loading and falls back to the count if the read fails', async () => {
    let resolve!: (value: unknown) => void;
    mocks.reactors.mockImplementation(() => new Promise(r => { resolve = r; }));
    render(detailActions([{ emoji: '👍', count: 2, me: false }]));
    expect(avatars()?.children).toHaveLength(2);
    await act(async () => { resolve({ ok: false, errorCode: 'REQUEST_FAILED' }); });
    expect(avatars()).toBeNull();
    expect(badge().textContent).toBe('👍2');
    expect(badge().getAttribute('aria-label')).toBe('👍 · 2');
  });

  it('keeps the count while the list disagrees with it, never showing a partial set of faces', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('z', 'Zoe')] });
    render(detailActions([{ emoji: '👍', count: 2, me: false }]));
    await waitFor(() => expect(badge().textContent).toBe('👍2'));
    expect(images()).toEqual([]);
  });

  it('degrades honestly for former and unresolved members', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('x', null), reactor('f', 'Ada', { formerMember: true }), reactor('z', 'Zoe')] });
    render(detailActions([{ emoji: '👍', count: 3, me: false }]));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 3: Zoe, Ada (left), and 1 unavailable'));
    // No member record: initials only, never a borrowed picture or invented name.
    expect(images()).toEqual([]);
    expect(avatars()?.textContent).toBe('ZA?');
  });

  it('re-reads after a live change and never shows reactors from an earlier state', async () => {
    let resolveFirst!: (value: unknown) => void;
    mocks.reactors.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ ok: true, reactors: [reactor('a', 'Dash', { isSelf: true }), reactor('z', 'Zoe')] });
    const view = render(detailActions([{ emoji: '👍', count: 1, me: false }]));
    // A remote add arrives before the first read settles.
    view.rerender(detailActions([{ emoji: '👍', count: 2, me: true }]));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 2: You and Zoe'));
    await act(async () => { resolveFirst({ ok: true, reactors: [reactor('z', 'Zoe')] }); });
    expect(badge().getAttribute('aria-label')).toBe('👍 · 2: You and Zoe');
    expect(mocks.reactors).toHaveBeenCalledTimes(2);
  });

  it('re-reads when who reacted changes but the count does not', async () => {
    mocks.reactors.mockResolvedValueOnce({ ok: true, reactors: [reactor('z', 'Zoe')] })
      .mockResolvedValueOnce({ ok: true, reactors: [reactor('c1', 'Cindy (Chris)')] });
    const view = render(<GroupReactionFixture details pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} shareScope="group:room" groupId="room" members={members} onChanged={vi.fn()}
      reactionRevision={3} message={message([{ emoji: '👍', count: 1, me: false }])} />);
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoe'));
    // Zoe removed 👍 and Chris's companion added it: same count and `me`, a new room reaction revision.
    view.rerender(<GroupReactionFixture details pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} shareScope="group:room" groupId="room" members={members} onChanged={vi.fn()}
      reactionRevision={4} message={message([{ emoji: '👍', count: 1, me: false }])} />);
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Cindy (Chris)'));
    expect(images()).toEqual(['https://example.test/cindy-chris.png']);
  });

  it('marks a reactor who left after the read, without another read', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('z', 'Zoe')] });
    const view = render(detailActions([{ emoji: '👍', count: 1, me: false }]));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoe'));
    // Zoe leaves; her reaction stays and the member list no longer has her.
    view.rerender(<GroupReactionFixture details pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} shareScope="group:room" groupId="room" members={members.filter(m => m.actorId !== 'z')}
      onChanged={vi.fn()} message={message([{ emoji: '👍', count: 1, me: false }])} />);
    expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoe (left)');
    expect(mocks.reactors).toHaveBeenCalledTimes(1);
  });

  it('follows member renames without another read', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('z', 'Zoe')] });
    const view = render(detailActions([{ emoji: '👍', count: 1, me: false }]));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoe'));
    const renamed = members.map(m => m.actorId === 'z' ? { ...m, name: 'Zoey' } : m);
    view.rerender(<GroupReactionFixture details pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} shareScope="group:room" groupId="room" members={renamed} onChanged={vi.fn()}
      message={message([{ emoji: '👍', count: 1, me: false }])} />);
    expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoey');
    expect(mocks.reactors).toHaveBeenCalledTimes(1);
  });

  it('keeps click as the toggle', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('a', 'Dash', { isSelf: true })] });
    render(detailActions([{ emoji: '👍', count: 1, me: true }]));
    await waitFor(() => expect(images()).toHaveLength(1));
    fireEvent.click(badge());
    await waitFor(() => expect(mocks.react).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '👍', present: false }));
  });

  it.each(['rejection', 'error response'])('keeps a failed choice until a later read of that message (%s)', async failure => {
    const reads = new ChatReactionReads();
    const props = { reactionReads: reads, onChanged: vi.fn() };
    let fail!: () => void;
    mocks.react.mockImplementationOnce(() => new Promise((resolve, reject) => {
      fail = failure === 'rejection' ? () => reject(new Error('offline')) : () => resolve({ ok: false, errorCode: 'SERVICE_ERROR' });
    }));
    const view = render(actions([{ emoji: '👍', count: 4, me: false }], props));
    fireEvent.click(badge());
    expect(badge().textContent).toBe('👍5');
    const olderRead = reads.beginRead();
    view.rerender(actions([{ emoji: '👍', count: 5, me: false }], props));
    await act(async () => fail());
    vi.useFakeTimers();
    try {
      act(() => {
        vi.advanceTimersByTime(60_000);
        olderRead([{ id: 'root' }]);
        reads.beginRead()([{ id: 'another-message' }]);
      });
      expect(badge().getAttribute('aria-pressed')).toBe('true');
      expect(badge().textContent).toBe('👍6');
      act(() => reads.beginRead()([{ id: 'root' }]));
      expect(badge().getAttribute('aria-pressed')).toBe('false');
      expect(badge().textContent).toBe('👍5');
      expect(mocks.react).toHaveBeenCalledTimes(1);
      expect(props.onChanged).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([2, 3])('sends only the latest distinct choice after %i quick taps during an outage', async taps => {
    let fail!: () => void;
    mocks.react.mockImplementationOnce(() => new Promise(resolve => { fail = () => resolve({ ok: false }); }))
      .mockResolvedValue({ ok: false });
    const props = { reactionReads: new ChatReactionReads(), onChanged: vi.fn() };
    render(actions([{ emoji: '👍', count: 4, me: false }], props));
    for (let tap = 0; tap < taps; tap++) fireEvent.click(badge());
    expect(mocks.react).toHaveBeenCalledTimes(1);
    await act(async () => fail());
    expect(mocks.react.mock.calls.map(([request]) => request.present)).toEqual(taps === 2 ? [true, false] : [true]);
    expect(badge().getAttribute('aria-pressed')).toBe(String(taps === 3));
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('discards queued writes when switching rooms before a receipt', async () => {
    let finish!: () => void;
    mocks.react.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: false }); }));
    const reactions = [{ emoji: '👍', count: 4, me: false }];
    const props = { reactionReads: new ChatReactionReads(), onChanged: vi.fn() };
    const view = render(actions(reactions, props));
    fireEvent.click(badge());
    fireEvent.click(badge());
    view.rerender(actions(reactions, { ...props, groupId: 'another-room' }));
    await act(async () => finish());
    expect(mocks.react).toHaveBeenCalledTimes(1);
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(badge().getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps my acknowledged choice through an older refresh and releases it once the server catches up', async () => {
    const view = render(actions([{ emoji: '👍', count: 4, me: false }]));
    await act(async () => fireEvent.click(badge()));
    view.rerender(actions([{ emoji: '👍', count: 5, me: false }]));
    expect(badge().textContent).toBe('👍6');
    view.rerender(actions([{ emoji: '👍', count: 6, me: true }]));
    expect(badge().textContent).toBe('👍6');
    view.rerender(actions([{ emoji: '👍', count: 5, me: false }]));
    expect(badge().getAttribute('aria-pressed')).toBe('false');
  });

  it('allows undo from the new badge while its picker write is pending and serializes the final choice', async () => {
    let acknowledge!: () => void;
    mocks.react.mockImplementationOnce(() => new Promise(resolve => { acknowledge = () => resolve({ ok: true }); }));
    render(actions([]));
    fireEvent.click(screen.getByRole('button', { name: 'addReaction' }));
    fireEvent.click(screen.getByRole('button', { name: '🎉' }));
    const selected = screen.getByRole('button', { name: '🎉 · 1' });
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(mocks.reactors).not.toHaveBeenCalled();
    fireEvent.click(selected);
    expect(screen.queryByRole('button', { name: '🎉 · 1' })).toBeNull();
    expect(mocks.react).toHaveBeenCalledTimes(1);
    await act(async () => acknowledge());
    expect(mocks.react.mock.calls.map(([request]) => request.present)).toEqual([true, false]);
  });

  it('reuses pending and completed reactor reads when the stacked badge reopens', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(r => { resolve = r; });
    mocks.reactors.mockReturnValue(pending);
    render(actions([{ emoji: '👍', count: 1, me: false }, { emoji: '❤️', count: 1, me: false }]));
    const toggle = screen.getByRole('button', { name: '👍 ❤️ · 2' });
    expect(mocks.reactors).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(mocks.reactors).toHaveBeenCalledTimes(2);
    fireEvent.click(toggle);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(toggle);
    await act(async () => resolve({ ok: true, reactors: [reactor('z', 'Zoe')] }));
    expect(badge().getAttribute('aria-label')).toContain('Zoe');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(badge().getAttribute('aria-label')).toContain('Zoe'));
    expect(mocks.reactors).toHaveBeenCalledTimes(2);
  });

  it('retries only the failed roster when the stacked badge is reopened', async () => {
    const zoe = { ok: true, reactors: [reactor('z', 'Zoe')] };
    mocks.reactors.mockResolvedValueOnce({ ok: false }).mockResolvedValue(zoe);
    render(actions([{ emoji: '👍', count: 1, me: false }, { emoji: '❤️', count: 1, me: false }]));
    const toggle = screen.getByRole('button', { name: '👍 ❤️ · 2' });
    await act(async () => fireEvent.click(toggle));
    expect(badge().getAttribute('aria-label')).toBe('👍 · 1');
    expect(mocks.reactors).toHaveBeenCalledTimes(2);
    fireEvent.click(toggle);
    await act(async () => fireEvent.click(toggle));
    expect(badge().getAttribute('aria-label')).toContain('Zoe');
    expect(mocks.reactors.mock.calls.map(([r]) => r.emoji)).toEqual(['👍', '❤️', '👍']);
  });

  it('shows the reactor name when the compact badge receives keyboard focus', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('z', 'Zoe')] });
    render(actions([{ emoji: '👍', count: 1, me: false }]));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toContain('Zoe'));
    act(() => badge().focus());
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Zoe');
    expect(badge().getAttribute('aria-pressed')).toBe('false');
  });

  it('holds an acknowledged undo until a read started after that write confirms it', async () => {
    const reads = new ChatReactionReads();
    const props = { reactionReads: reads };
    const initial = [{ emoji: '👍', count: 4, me: false }];
    const added = [{ emoji: '👍', count: 5, me: true }];
    let acknowledge!: () => void;
    mocks.react.mockImplementationOnce(() => new Promise(r => { acknowledge = () => r({ ok: true }); }));
    const view = render(actions(initial, props));
    fireEvent.click(badge());
    const stale = reads.beginRead();
    fireEvent.click(badge());
    await act(async () => acknowledge());
    act(() => stale([message(added)]));
    view.rerender(actions(added, props));
    expect(badge().getAttribute('aria-pressed')).toBe('false');
    act(() => reads.beginRead()([message(added)]));
    expect(badge().getAttribute('aria-pressed')).toBe('false');
    act(() => reads.beginRead()([message(initial)]));
    view.rerender(actions(initial, props));
    view.rerender(actions(added, props));
    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(mocks.react).toHaveBeenCalledTimes(2);
  });

  it('accepts a new click when the same owner advances generation with the row still mounted', async () => {
    setDataOwnerGeneration('owner', 1);
    render(actions([{ emoji: '👍', count: 4, me: false }]));
    act(() => setDataOwnerGeneration('owner', 2));
    await act(async () => fireEvent.click(badge()));
    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(mocks.react).toHaveBeenCalledTimes(1);
  });

  it('drops a read that settles after the account changed', async () => {
    let resolve!: (value: unknown) => void;
    mocks.reactors.mockImplementation(() => new Promise(r => { resolve = r; }));
    render(actions([{ emoji: '👍', count: 1, me: false }]));
    mocks.ownerCurrent = false;
    await act(async () => { resolve({ ok: true, reactors: [reactor('z', 'Zoe')] }); });
    expect(badge().getAttribute('aria-label')).toBe('👍 · 1');
  });
});
