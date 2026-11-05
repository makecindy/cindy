// @vitest-environment jsdom

/**
 * Private-chat topic panel resizing (#8751).
 *
 * 测试价值
 * - 生产入口与可观察结果：渲染真实的 `BotDmThreadHost` → `BotDmThreadPanel` → `ThreadPanel`，
 *   用 `useBotDmThreads().openThread` 打开话题（即「创建话题」按钮走的路径），再拖动
 *   `role="separator"` 手柄；可观察结果是面板 `<aside>` 的 inline width 与 maxWidth 变化、
 *   手柄的 aria 数值跟随，即宽表格不再被 28rem 上限裁切。
 * - Bug／规则依据：#8751；群聊话题在 #6721 已支持拖拽/方向键调宽，#7193 把两侧收敛到共享
 *   `ThreadPanel`，但私聊宿主从未传入 `resize`，因此手柄根本不渲染。
 * - 现有覆盖缺口：`BotGroupChatView.test.tsx` 只覆盖群聊分支；既有私聊用例
 *   （botSessionPresentation 等）把 `BotDmThreadHost` 整个 mock 掉了。
 * - 最小失败输入：修复前私聊面板没有 separator；已有话题 A 时打开 B，并延迟 B 的 URL 提交，不能回到 A。
 * - 新增覆盖缺口（#8531）：窄窗恢复、切换／重开保宽，以及真实 data router pending URL 时序；原假路由无法覆盖后者。
 * - 实测耗时：2026-11-05，3 项用例共 1.12 秒（单 worker）。
 * - tier：unit（jsdom + 与群聊用例同款 geometry stub；无真实窗口、无网络）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback } from 'react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensure: vi.fn(),
  t: (key: string) => key,
  profiles: [] as Array<{ id: string; sessions: Array<{ id: string; role: string; status: string; threadRoot: { rootSessionId: string; rootClientId: string } }> }>,
  snapshots: new Map<string, unknown>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: h.t, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getSnapshot: (sessionId: string) => h.snapshots.get(sessionId) ?? { messages: [] },
    subscribe: () => () => {},
  },
}));
vi.mock('../botStore', () => ({ useBotProfiles: () => h.profiles }));
vi.mock('../botReadState', () => ({ botDmThreadReadKey: () => 'dm-thread-read', markBotRead: vi.fn() }));
vi.mock('../botDmThreads', () => ({
  isBotDmThreadUnread: () => false,
  useBotDmThreadList: () => ({ threads: new Map(), reload: vi.fn(), readVersion: 0 }),
}));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ sessionIdProp }: { sessionIdProp: string }) => <div data-testid="topic-task">{sessionIdProp}</div>,
}));
vi.mock('../BotGroupTimelineItem', () => ({
  BotGroupTimelineItem: ({ content }: { content: string }) => <p>{content}</p>,
}));

import { BotDmThreadsValue, useBotDmThreads } from '../botDmThreadsContext';
import { BotDmThreadHost } from '../BotDmThreadHost';

/** The production entry the header's 创建话题 button uses. */
function OpenThreadButton({ rootClientId, label = 'open topic' }: { rootClientId: string; label?: string }) {
  const threads = useBotDmThreads() as BotDmThreadsValue;
  const open = useCallback(() => threads.openThread(rootClientId), [threads, rootClientId]);
  return <button type="button" onClick={open}>{label}</button>;
}

const bot = { id: 'bot', name: 'Cindy' };
function TopicHost() {
  return <BotDmThreadHost enabled bot={bot} rootSessionId="chat" mentions={[]}>
    <OpenThreadButton rootClientId="c1" />
    <OpenThreadButton rootClientId="c2" label="open other" />
  </BotDmThreadHost>;
}

let available = 1200;
const observed = new Map<Element, ResizeObserverCallback>();
let restoreGeometry: (() => void) | undefined;

beforeEach(() => {
  available = 1200;
  observed.clear();
  h.profiles = [];
  h.snapshots.clear();
  h.ensure.mockReset().mockImplementation(async ({ rootClientId }: { rootClientId: string }) =>
    ({ ok: true, sessionId: `topic-${rootClientId}`, created: true }));
  h.snapshots.set('chat', { messages: [{ clientId: 'c1', role: 'user', content: 'root message' }] });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { bots: { dmThread: { ensure: h.ensure } } },
  } });

  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { observed.set(element, this.callback); }
    disconnect() { observed.clear(); }
  });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  });
  const original = HTMLElement.prototype.getBoundingClientRect;
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.tagName === 'ASIDE') return new DOMRect(0, 0, Number.parseFloat(this.style.width) || 448, 800);
      if (this.querySelector(':scope > aside')) return new DOMRect(0, 0, available, 800);
      return original.call(this);
    },
  );
  restoreGeometry = () => geometry.mockRestore();
});

afterEach(() => {
  cleanup();
  restoreGeometry?.();
  vi.unstubAllGlobals();
});

describe('private topic panel resize', () => {
  it('renders a drag handle that widens the panel and preserves its width across narrow windows, switching and reopening', async () => {
    render(<MemoryRouter><TopicHost /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: 'open topic' }));
    await waitFor(() => expect(h.ensure).toHaveBeenCalled());
    const panel = await screen.findByRole('complementary');
    const handle = within(panel).getByRole('separator', { name: 'diffPanel.shell.resizeHandleAria' });
    Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    // Before the first drag the shared panel keeps its CSS default.
    expect(panel.style.width).toBe('');
    expect(panel.style.maxWidth).toBe('');

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 752 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 100 });
    expect(panel.style.width).toBe('');
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 552 });
    expect(panel.style.width).toBe('648px');
    expect(panel.style.maxWidth).toBe('none');
    expect(handle.getAttribute('aria-valuenow')).toBe('648');
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
    expect(panel.style.width).toBe('648px');

    available = 600;
    act(() => [...observed.values()].forEach(callback => callback([], {} as ResizeObserver)));
    expect(panel.style.width).toBe('360px');
    available = 1200;
    act(() => [...observed.values()].forEach(callback => callback([], {} as ResizeObserver)));
    expect(panel.style.width).toBe('648px');

    fireEvent.click(screen.getByRole('button', { name: 'open other' }));
    await waitFor(() => expect(screen.getByTestId('topic-task').textContent).toBe('topic-c2'));
    expect(screen.getByRole('complementary').style.width).toBe('648px');
    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'bots.close' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'open topic' }));
    await waitFor(() => expect(screen.getByTestId('topic-task').textContent).toBe('topic-c1'));
    expect(screen.getByRole('complementary').style.width).toBe('648px');
  });

  it('sizes the panel with the arrow keys on the same handle', async () => {
    render(<MemoryRouter><TopicHost /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: 'open topic' }));
    const panel = await screen.findByRole('complementary');
    const handle = within(panel).getByRole('separator', { name: 'diffPanel.shell.resizeHandleAria' });

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panel.style.width).toBe('464px');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panel.style.width).toBe('448px');
  });

  // Real Desktop reproduced B briefly opening and then reverting to A: the data router still
  // exposes A's URL while B's navigation loads. The width-only MemoryRouter case cannot cover it.
  it('keeps the selected topic while its URL navigation is pending, then follows a new link', async () => {
    h.profiles = [{ id: bot.id, sessions: ['c1', 'c2'].map(rootClientId => ({
      id: `topic-${rootClientId}`, role: 'thread', status: 'active',
      threadRoot: { rootSessionId: 'chat', rootClientId },
    })) }];
    let finishNavigation!: () => void;
    const pendingNavigation = new Promise<void>(resolve => { finishNavigation = resolve; });
    const router = createMemoryRouter([{
      path: '/',
      loader: ({ request }) => new URL(request.url).searchParams.get('thread') === 'topic-c2'
        ? pendingNavigation.then(() => null) : null,
      element: <TopicHost />,
    }], { initialEntries: ['/?thread=topic-c1'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId('topic-task').textContent).toBe('topic-c1'));
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    const width = screen.getByRole('complementary').style.width;

    fireEvent.click(screen.getByRole('button', { name: 'open other' }));
    await waitFor(() => expect(screen.getByTestId('topic-task').textContent).toBe('topic-c2'));
    expect(router.state.location.search).toBe('?thread=topic-c1');
    expect(screen.getByRole('complementary').getAttribute('data-dm-thread-panel')).toBe('c2');
    expect(screen.getByRole('complementary').style.width).toBe(width);

    await act(async () => { finishNavigation(); await pendingNavigation; });
    await waitFor(() => expect(router.state.location.search).toBe('?thread=topic-c2'));
    expect(screen.getByTestId('topic-task').textContent).toBe('topic-c2');
    await act(async () => { await router.navigate('/?thread=topic-c1'); });
    await waitFor(() => expect(screen.getByTestId('topic-task').textContent).toBe('topic-c1'));
    expect(screen.getByRole('complementary').style.width).toBe(width);
    router.dispose();
  });
});
