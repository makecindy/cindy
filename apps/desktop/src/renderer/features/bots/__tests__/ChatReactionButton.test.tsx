// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as renderUI, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageActions } from '../ChatServerControls';
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
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => mocks.ownerCurrent,
}));

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
const actions = (reactions: BotGroupMessageView['reactions']) =>
  <ChatMessageActions shareScope="group:room" groupId="room" message={message(reactions)} members={members} onChanged={vi.fn()} />;
// The message toolbar expects the app-level tooltip provider.
const render = (ui: ReactNode) => {
  const view = renderUI(<Tooltip.Provider>{ui}</Tooltip.Provider>);
  return { ...view, rerender: (next: ReactNode) => view.rerender(<Tooltip.Provider>{next}</Tooltip.Provider>) };
};
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
    render(actions([{ emoji: '👍', count: 3, me: true }]));
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
    render(actions([{ emoji: '👍', count: 1, me: false }]));
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
    render(actions([{ emoji: '👍', count: 4, me: false }]));
    expect(badge().textContent).toBe('👍4');
    expect(avatars()).toBeNull();
    expect(mocks.reactors).not.toHaveBeenCalled();
  });

  it('reserves one slot per reactor while loading and falls back to the count if the read fails', async () => {
    let resolve!: (value: unknown) => void;
    mocks.reactors.mockImplementation(() => new Promise(r => { resolve = r; }));
    render(actions([{ emoji: '👍', count: 2, me: false }]));
    expect(avatars()?.children).toHaveLength(2);
    await act(async () => { resolve({ ok: false, errorCode: 'REQUEST_FAILED' }); });
    expect(avatars()).toBeNull();
    expect(badge().textContent).toBe('👍2');
    expect(badge().getAttribute('aria-label')).toBe('👍 · 2');
  });

  it('keeps the count while the list disagrees with it, never showing a partial set of faces', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('z', 'Zoe')] });
    render(actions([{ emoji: '👍', count: 2, me: false }]));
    await waitFor(() => expect(badge().textContent).toBe('👍2'));
    expect(images()).toEqual([]);
  });

  it('degrades honestly for former and unresolved members', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('x', null), reactor('f', 'Ada', { formerMember: true }), reactor('z', 'Zoe')] });
    render(actions([{ emoji: '👍', count: 3, me: false }]));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 3: Zoe, Ada (left), and 1 unavailable'));
    // No member record: initials only, never a borrowed picture or invented name.
    expect(images()).toEqual([]);
    expect(avatars()?.textContent).toBe('ZA?');
  });

  it('re-reads after a live change and never shows reactors from an earlier state', async () => {
    let resolveFirst!: (value: unknown) => void;
    mocks.reactors.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ ok: true, reactors: [reactor('a', 'Dash', { isSelf: true }), reactor('z', 'Zoe')] });
    const view = render(actions([{ emoji: '👍', count: 1, me: false }]));
    // A remote add arrives before the first read settles.
    view.rerender(actions([{ emoji: '👍', count: 2, me: true }]));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 2: You and Zoe'));
    await act(async () => { resolveFirst({ ok: true, reactors: [reactor('z', 'Zoe')] }); });
    expect(badge().getAttribute('aria-label')).toBe('👍 · 2: You and Zoe');
    expect(mocks.reactors).toHaveBeenCalledTimes(2);
  });

  it('re-reads when who reacted changes but the count does not', async () => {
    mocks.reactors.mockResolvedValueOnce({ ok: true, reactors: [reactor('z', 'Zoe')] })
      .mockResolvedValueOnce({ ok: true, reactors: [reactor('c1', 'Cindy (Chris)')] });
    const view = render(<ChatMessageActions shareScope="group:room" groupId="room" members={members} onChanged={vi.fn()}
      reactionRevision={3} message={message([{ emoji: '👍', count: 1, me: false }])} />);
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoe'));
    // Zoe removed 👍 and Chris's companion added it: same count and `me`, a new room reaction revision.
    view.rerender(<ChatMessageActions shareScope="group:room" groupId="room" members={members} onChanged={vi.fn()}
      reactionRevision={4} message={message([{ emoji: '👍', count: 1, me: false }])} />);
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Cindy (Chris)'));
    expect(images()).toEqual(['https://example.test/cindy-chris.png']);
  });

  it('marks a reactor who left after the read, without another read', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('z', 'Zoe')] });
    const view = render(actions([{ emoji: '👍', count: 1, me: false }]));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoe'));
    // Zoe leaves; her reaction stays and the member list no longer has her.
    view.rerender(<ChatMessageActions shareScope="group:room" groupId="room" members={members.filter(m => m.actorId !== 'z')}
      onChanged={vi.fn()} message={message([{ emoji: '👍', count: 1, me: false }])} />);
    expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoe (left)');
    expect(mocks.reactors).toHaveBeenCalledTimes(1);
  });

  it('follows member renames without another read', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('z', 'Zoe')] });
    const view = render(actions([{ emoji: '👍', count: 1, me: false }]));
    await waitFor(() => expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoe'));
    const renamed = members.map(m => m.actorId === 'z' ? { ...m, name: 'Zoey' } : m);
    view.rerender(<ChatMessageActions shareScope="group:room" groupId="room" members={renamed} onChanged={vi.fn()}
      message={message([{ emoji: '👍', count: 1, me: false }])} />);
    expect(badge().getAttribute('aria-label')).toBe('👍 · 1: Zoey');
    expect(mocks.reactors).toHaveBeenCalledTimes(1);
  });

  it('keeps click as the toggle', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('a', 'Dash', { isSelf: true })] });
    render(actions([{ emoji: '👍', count: 1, me: true }]));
    await waitFor(() => expect(images()).toHaveLength(1));
    fireEvent.click(badge());
    await waitFor(() => expect(mocks.react).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '👍', present: false }));
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
