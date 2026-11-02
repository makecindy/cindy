// @vitest-environment jsdom
/**
 * 「+」统一建议面板自带搜索框。
 *
 * 「+」面板浮在输入框上方、盖住了输入框本身,所以「输入关键字搜索文件和任务」
 * 不能再只是一行静态提示:用户点了必须有个能打字的地方。面板拿焦点后编辑器
 * 收不到按键,↑↓/Enter 的键盘导航也要由面板自己实现一份。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MENU_CURRENT_ROW_ATTR, MENU_ROW_ATTR } from '@/components/ui/dropdown-menu-highlight';
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
});
