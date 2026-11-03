// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：BotDmThreadHost 打开私聊话题后，面板左侧分隔线可拖拽调宽，切换、关闭重开话题保留宽度。
 * - Bug／规则依据：私聊话题面板固定为 min(50%, 448px) 且不可拖动（群聊话题已支持，见 bot-group-chat.md「Thread 预览与贴回主群」）。
 * - 现有覆盖缺口：群聊测试不覆盖私聊；同步 MemoryRouter 不覆盖真实数据路由尚未提交新话题 URL 的时序。
 * - 最小失败输入：打开私聊话题并拖动；已有话题 A 时打开 B，让 B 的 URL 导航保持 pending，不能自动返回 A。
 * - tier：unit（jsdom，几何与 ResizeObserver 用内存替身）。
 * - 实测耗时：单 worker 独立运行 2.91 秒（2 tests，2026-11-02）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotDmThreadHost } from '../BotDmThreadHost';
import { useBotDmThreads } from '../botDmThreadsContext';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  ensure: vi.fn(),
  profiles: [] as Array<{ id: string; sessions: Array<{ id: string; role: string; status: string; threadRoot: { rootSessionId: string; rootClientId: string } }> }>,
}));

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en-US', resolvedLanguage: 'en' } }),
}));
vi.mock('../botDmThreads', () => ({
  useBotDmThreadList: () => ({ threads: new Map(), reload: () => {}, readVersion: 0 }),
  isBotDmThreadUnread: () => false,
}));
vi.mock('../botStore', () => ({ useBotProfiles: () => mocks.profiles }));
// The topic's task runtime and root rendering are outside this layout check.
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: ({ sessionIdProp }: { sessionIdProp: string }) => <div data-testid="topic-task">{sessionIdProp}</div> }));
vi.mock('../BotGroupTimelineItem', () => ({ BotGroupTimelineItem: () => null }));

const bot = { id: 'bot-1', name: 'Aster' };
let available = 1200;
let observed: ResizeObserverCallback | null = null;

function Opener() {
  const topics = useBotDmThreads();
  return <main>
    <button type="button" onClick={() => topics?.openThread('root-a')}>open a</button>
    <button type="button" onClick={() => topics?.openThread('root-b')}>open b</button>
  </main>;
}

describe('BotDmThreadHost topic width', () => {
  beforeEach(() => {
    available = 1200;
    observed = null;
    mocks.profiles = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() { observed = this.callback; }
      disconnect() {}
    });
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
      }
    });
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'ASIDE') return new DOMRect(0, 0, Number.parseFloat(this.style.width) || 448, 800);
      if (this.querySelector(':scope > div > main')) return new DOMRect(0, 0, available, 800);
      return original.call(this);
    });
    mocks.ensure.mockImplementation(async ({ rootClientId }: { rootClientId: string }) =>
      ({ ok: true, sessionId: `topic-${rootClientId}` }));
    Object.assign(window, { electronAPI: { localDb: { bots: { dmThread: { ensure: mocks.ensure } } } } });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('drags the divider like group topics and keeps the width across topics', async () => {
    render(<MemoryRouter><BotDmThreadHost enabled bot={bot} rootSessionId="main" mentions={[]}><Opener /></BotDmThreadHost></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'open a' }));
    await screen.findByTestId('topic-task');
    const panel = screen.getByRole('complementary');
    const handle = within(panel).getByRole('separator', { name: 'diffPanel.shell.resizeHandleAria' });
    Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    expect(panel.style.width).toBe('');

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 752 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 552 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(panel.style.width).toBe('648px');
    expect(panel.style.maxWidth).toBe('none');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panel.style.width).toBe('632px');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panel.style.width).toBe('648px');

    // A narrower window still leaves room for the private chat.
    available = 600;
    act(() => observed?.([], {} as ResizeObserver));
    expect(panel.style.width).toBe('360px');
    available = 1200;
    act(() => observed?.([], {} as ResizeObserver));

    fireEvent.click(screen.getByRole('button', { name: 'open b' }));
    await waitFor(() => expect(mocks.ensure).toHaveBeenLastCalledWith(expect.objectContaining({ rootClientId: 'root-b' })));
    expect(screen.getByRole('complementary').style.width).toBe('648px');

    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'bots.close' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'open a' }));
    await screen.findByTestId('topic-task');
    expect(screen.getByRole('complementary').style.width).toBe('648px');
  });

  // Real Desktop reproduced B briefly opening and then reverting to A: the data router still
  // exposes A's URL while B's navigation loads. The width-only MemoryRouter case cannot cover it.
  it('keeps the selected topic while its URL navigation is pending, then follows a new link', async () => {
    mocks.profiles = [{ id: bot.id, sessions: ['root-a', 'root-b'].map(rootClientId => ({
      id: `topic-${rootClientId}`, role: 'thread', status: 'active',
      threadRoot: { rootSessionId: 'main', rootClientId },
    })) }];
    let finishNavigation!: () => void;
    const pendingNavigation = new Promise<void>(resolve => { finishNavigation = resolve; });
    const router = createMemoryRouter([{
      path: '/',
      loader: ({ request }) => new URL(request.url).searchParams.get('thread') === 'topic-root-b'
        ? pendingNavigation.then(() => null) : null,
      element: <BotDmThreadHost enabled bot={bot} rootSessionId="main" mentions={[]}><Opener /></BotDmThreadHost>,
    }], { initialEntries: ['/?thread=topic-root-a'] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByTestId('topic-task').textContent).toBe('topic-root-a'));
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    const width = screen.getByRole('complementary').style.width;

    fireEvent.click(screen.getByRole('button', { name: 'open b' }));
    await waitFor(() => expect(screen.getByTestId('topic-task').textContent).toBe('topic-root-b'));
    expect(router.state.location.search).toBe('?thread=topic-root-a');
    expect(screen.getByRole('complementary').getAttribute('data-dm-thread-panel')).toBe('root-b');
    expect(screen.getByRole('complementary').style.width).toBe(width);

    await act(async () => { finishNavigation(); await pendingNavigation; });
    await waitFor(() => expect(router.state.location.search).toBe('?thread=topic-root-b'));
    expect(screen.getByTestId('topic-task').textContent).toBe('topic-root-b');
    await act(async () => { await router.navigate('/?thread=topic-root-a'); });
    await waitFor(() => expect(screen.getByTestId('topic-task').textContent).toBe('topic-root-a'));
    expect(screen.getByRole('complementary').style.width).toBe(width);
    router.dispose();
  });
});
