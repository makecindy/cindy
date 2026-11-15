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
 * - 最小失败输入：修复前私聊面板没有 separator，`getByRole('separator')` 直接抛错。
 * - tier：unit（jsdom + 与群聊用例同款 geometry stub；无真实窗口、无网络）。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensure: vi.fn(),
  params: new URLSearchParams(),
  snapshots: new Map<string, unknown>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [h.params, vi.fn()],
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
vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('../botReadState', () => ({ botDmThreadReadKey: () => 'dm-thread-read', markBotRead: vi.fn() }));
vi.mock('../botDmThreads', () => ({
  isBotDmThreadUnread: () => false,
  useBotDmThreadList: () => ({ threads: new Map(), reload: vi.fn(), readVersion: 0 }),
}));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: () => <div data-thread-session="rendered" />,
}));
vi.mock('../BotGroupTimelineItem', () => ({
  BotGroupTimelineItem: ({ content }: { content: string }) => <p>{content}</p>,
}));

import { BotDmThreadsValue, useBotDmThreads } from '../botDmThreadsContext';
import { BotDmThreadHost } from '../BotDmThreadHost';

/** The production entry the header's 创建话题 button uses. */
function OpenThreadButton({ rootClientId }: { rootClientId: string }) {
  const threads = useBotDmThreads() as BotDmThreadsValue;
  const open = useCallback(() => threads.openThread(rootClientId), [threads, rootClientId]);
  return <button type="button" onClick={open}>open topic</button>;
}

const AVAILABLE = 1200;
let restoreGeometry: (() => void) | undefined;

beforeEach(() => {
  h.ensure.mockReset().mockResolvedValue({ ok: true, sessionId: 'thread-1', created: true });
  h.snapshots.set('chat', { messages: [{ clientId: 'c1', role: 'user', content: 'root message' }] });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { bots: { dmThread: { ensure: h.ensure } } },
  } });

  const observed = new Map<Element, ResizeObserverCallback>();
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
      if (this.querySelector(':scope > aside')) return new DOMRect(0, 0, AVAILABLE, 800);
      return original.call(this);
    },
  );
  restoreGeometry = () => geometry.mockRestore();
});

afterEach(() => {
  restoreGeometry?.();
  vi.unstubAllGlobals();
});

describe('private topic panel resize', () => {
  it('renders a drag handle that widens the panel past its CSS cap', async () => {
    render(
      <BotDmThreadHost enabled bot={{ id: 'bot', name: 'Cindy' } as never} rootSessionId="chat"
        mentions={[]}>
        <OpenThreadButton rootClientId="c1" />
      </BotDmThreadHost>,
    );

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
  });

  it('sizes the panel with the arrow keys on the same handle', async () => {
    render(
      <BotDmThreadHost enabled bot={{ id: 'bot', name: 'Cindy' } as never} rootSessionId="chat"
        mentions={[]}>
        <OpenThreadButton rootClientId="c1" />
      </BotDmThreadHost>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'open topic' }));
    const panel = await screen.findByRole('complementary');
    const handle = within(panel).getByRole('separator', { name: 'diffPanel.shell.resizeHandleAria' });

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panel.style.width).toBe('464px');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panel.style.width).toBe('448px');
  });
});
