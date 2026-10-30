// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：BotDmThreadHost 打开私聊话题后，面板左侧分隔线可拖拽调宽，切换、关闭重开话题保留宽度。
 * - Bug／规则依据：私聊话题面板固定为 min(50%, 448px) 且不可拖动（群聊话题已支持，见 bot-group-chat.md「Thread 预览与贴回主群」）。
 * - 现有覆盖缺口：BotGroupChatView.test 只覆盖群聊；私聊 Host 此前没有任何测试，其它测试把它整体 mock 掉。
 * - 最小失败输入：打开一个私聊话题，在面板里找分隔线并拖动。
 * - tier：unit（jsdom，几何与 ResizeObserver 用内存替身）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotDmThreadHost } from '../BotDmThreadHost';
import { useBotDmThreads } from '../botDmThreadsContext';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  ensure: vi.fn(),
}));

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en-US', resolvedLanguage: 'en' } }),
}));
vi.mock('../botDmThreads', () => ({
  useBotDmThreadList: () => ({ threads: new Map(), reload: () => {}, readVersion: 0 }),
  isBotDmThreadUnread: () => false,
}));
vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
// The topic's task runtime and root rendering are outside this layout check.
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: () => <div data-testid="topic-task" /> }));
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
});
