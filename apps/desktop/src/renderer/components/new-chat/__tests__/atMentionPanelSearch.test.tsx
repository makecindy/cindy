// @vitest-environment jsdom
/**
 * 「+」统一建议面板自带搜索框。
 *
 * 「+」面板浮在输入框上方、盖住了输入框本身,所以「输入关键字搜索文件和任务」
 * 不能再只是一行静态提示:用户点了必须有个能打字的地方。面板拿焦点后编辑器
 * 收不到按键,↑↓/Enter 的键盘导航也要由面板自己实现一份。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MENU_CURRENT_ROW_ATTR, MENU_ROW_ATTR } from '@/components/ui/dropdown-menu-highlight';
import { MORPH_CONTENT_RESIZE_EVENT, MorphPopover } from '@/components/ui/morph-popover';
import { AtMentionPanel } from '../AtMentionPanel';
import type { ComposerSuggestionEntry } from '@/lib/composerSuggestion';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ENTRIES: ComposerSuggestionEntry[] = [
  { kind: 'action', action: { id: 'attach-files', label: 'Add files', run: vi.fn() } },
  { kind: 'action', action: { id: 'new-goal', label: 'New goal', run: vi.fn() } },
];

function Harness({
  onSelect = vi.fn(),
  onClose = vi.fn(),
}: {
  onSelect?: (entry: ComposerSuggestionEntry) => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  return (
    <AtMentionPanel
      embedded
      query={query}
      state={{ kind: 'ready', items: [], truncated: false }}
      entries={ENTRIES}
      focusedIndex={focusedIndex}
      onFocusedIndexChange={setFocusedIndex}
      onSelect={onSelect}
      onClose={onClose}
      onRetry={() => {}}
      searchValue={query}
      onSearchChange={setQuery}
    />
  );
}

const searchBox = () =>
  screen.getByRole('textbox', { name: 'newChat.atMention.typeToSearchFiles' });

describe('「+」面板的搜索框', () => {
  it('打开即聚焦,输入即回报搜索词', () => {
    render(<Harness />);
    const box = searchBox();
    // 面板浮在编辑器上方、盖住了编辑器:焦点必须落在搜索框,否则用户是在对着
    // 看不见的输入框打字。
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'readme' } });
    expect((box as HTMLInputElement).value).toBe('readme');
  });

  it('回车选中当前焦点行', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(ENTRIES[0]);
  });

  it('↑↓ 在面板内移动焦点行', () => {
    render(<Harness />);
    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' });
    // 焦点行变化会反映到面板行的高亮标记上。
    const current = document.querySelectorAll(`[${MENU_ROW_ATTR}][${MENU_CURRENT_ROW_ATTR}]`);
    expect(current.length).toBe(1);
    expect(current[0].textContent).toContain('New goal');
  });

  it('输入法组字期间的回车不当作选中', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.keyDown(searchBox(), { key: 'Enter', isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('空框退格收面板(编辑器收不到按键,这里补一份)', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(searchBox(), { key: 'Backspace' });
    expect(onClose).toHaveBeenCalled();
  });

  // #9536 / #9573：内嵌长列表必须在真实外壳里只有一层能滚。
  // 生产入口：AtMentionPanel 嵌进 MorphPopover。旧断言只看 class 字面量，列表被裁掉也会过。
  // 最小输入：外壳上限 240，内容自然高 400。外壳 overflow 为 hidden，内滚根高度等于 240，
  // 资源行保持 44px 且不被 flex 压扁。搜索把内容收到 80 后，外壳和内滚根一起收到 80。
  // 独立 @ 浮层不走外壳，仍用自己的 maxHeight。Tier: unit。
  it('内嵌长列表只让外壳锁住的那一层滚动，独立 @ 浮层仍用自己的高度上限', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
    const heights = new WeakMap<HTMLElement, number>();
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'group') return heights.get(this) ?? 400;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'group') return 240;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 800, 120, 30));
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      })),
    });

    const resources: ComposerSuggestionEntry[] = Array.from({ length: 12 }, (_, index) => ({
      kind: 'resource' as const,
      item: { type: 'file' as const, name: `file-${index}.txt`, relPath: `dir/file-${index}.txt` },
    }));

    function Host() {
      const [open, setOpen] = useState(true);
      const [query, setQuery] = useState('');
      const shown = query ? resources.slice(0, 1) : resources;
      return (
        <>
          <button type="button" onClick={() => setQuery('file-0')}>
            Filter
          </button>
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            panelWidth={480}
            maxContentHeight={240}
            panelAriaLabel="Add menu"
            trigger={<span />}
          >
            <AtMentionPanel
              embedded
              query={query}
              state={{ kind: 'ready', items: [], truncated: false }}
              entries={shown}
              focusedIndex={0}
              onFocusedIndexChange={() => {}}
              onSelect={() => {}}
              onClose={() => setOpen(false)}
              onRetry={() => {}}
              searchValue={query}
              onSearchChange={setQuery}
              maxHeight={240}
            />
          </MorphPopover>
        </>
      );
    }

    render(<Host />);
    const panel = await screen.findByRole('group', { name: 'Add menu' });
    const shell = panel.firstElementChild as HTMLElement;
    await waitFor(() => {
      expect(panel.style.height).toBe('240px');
      expect(shell.style.overflowY).toBe('hidden');
    });
    const inner = shell.querySelector('[data-morph-scroll="inner"]') as HTMLElement;
    expect(inner.style.height).toBe('240px');
    const row = screen.getByText('file-0.txt').closest('button') as HTMLElement;
    expect(row.className).toContain('h-[44px]');
    expect(row.className).toContain('shrink-0');

    const group = panel;
    heights.set(group, 80);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /file-0\.txt/ })).toHaveLength(1);
    });
    act(() => {
      shell.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT, { bubbles: true }));
    });
    expect(panel.style.height).toBe('80px');
    expect(inner.style.height).toBe('80px');
    expect(shell.style.overflowY).toBe('hidden');

    cleanup();
    vi.restoreAllMocks();

    render(
      <AtMentionPanel
        query=""
        state={{ kind: 'ready', items: [], truncated: false }}
        entries={ENTRIES}
        focusedIndex={0}
        onFocusedIndexChange={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
        onRetry={() => {}}
        maxHeight={240}
      />,
    );
    const standaloneRoot = document.querySelector('[data-composer-suggestion-panel]') as HTMLElement;
    const standalone = standaloneRoot.firstElementChild as HTMLElement;
    expect(standaloneRoot.hasAttribute('data-morph-scroll')).toBe(false);
    expect(standalone.style.maxHeight).toBe('240px');
    expect(standalone.style.height).toBe('');
  });
});
