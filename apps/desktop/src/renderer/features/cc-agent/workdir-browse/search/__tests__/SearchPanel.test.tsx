// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { SearchPanel } from '../SearchPanel';

/*
 * 测试价值
 * - 生产入口与可观察结果：文件侧栏内容搜索 SearchPanel 并入共享 SearchInput（panel 档）后，
 *   读屏能找到的输入框与按钮、Esc / 清空按钮后的输入值、「Aa」开关的 aria-pressed，
 *   以及 doc 模式 Ctrl+Shift+F 依赖的 data-workdir-search-input 钩子。
 * - 规则依据：主人裁决 2026-11-27（所有搜索框都要有清空）；DESIGN.md §4 Search fields
 *   （文件内容搜索不再是保留模式，Aa 放 trailing，保留原有 Esc 清空）。
 * - 现有覆盖缺口：这个面板之前没有任何单测。
 * - 最小失败输入：输入 "foo" 后按 Esc 输入框仍是 "foo"；或找不到「commonUi.clearSearch」按钮；
 *   或点「Aa」后 aria-pressed 不变；或 input 上没有 data-workdir-search-input。
 * - tier：unit（jsdom 渲染真实组件）。
 */
function Harness() {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  return (
    <SearchPanel
      query={query}
      onQueryChange={setQuery}
      caseSensitive={caseSensitive}
      onCaseSensitiveChange={setCaseSensitive}
      results={[]}
      totalMatches={0}
      totalFiles={0}
      status="idle"
      errorMessage={null}
      maxMatches={1000}
      onOpenMatch={() => {}}
    />
  );
}

describe('SearchPanel content search box', () => {
  afterEach(cleanup);

  it('keeps Escape-to-clear, gains the clear button and keeps the match-case toggle and focus hook', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox', {
      name: 'ccAgent.workdirBrowse.searchPanel.placeholderSearch',
    }) as HTMLInputElement;
    expect(box.hasAttribute('data-workdir-search-input')).toBe(true);

    fireEvent.change(box, { target: { value: 'foo' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');

    fireEvent.change(box, { target: { value: 'bar' } });
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.clearSearch' }));
    expect(box.value).toBe('');
    expect(document.activeElement).toBe(box);

    const toggle = screen.getByRole('button', { name: 'ccAgent.workdirBrowse.searchPanel.matchCaseAria' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });
});
