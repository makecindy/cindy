// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：UnderlineTabs 组件；读屏看到的 tablist / tab / aria-selected /
 *   aria-controls，键盘 Tab 进入点，方向键 / Home / End 移动焦点并切换，禁用项被跳过。
 * - 规则依据：主人裁决 #9（2026-11-23）把下划线标签条入库，替换插件详情和共享任务两处手写
 *   实现；DESIGN.md §4 Tabs 要求 tablist 语义和方向键完整。手写版本之一（插件详情）没有方向键。
 * - 现有覆盖缺口：GhostPluginCard / JoinSharedTaskDialog 的用例只点选标签，不覆盖键盘、
 *   RTL、禁用和读屏关联。
 * - 最小失败输入：三项其中中间一项禁用，在第一项按 ArrowRight 应落到第三项。
 * - tier：unit（jsdom 渲染真实组件）。
 */

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnderlineTabs, type UnderlineTabItem } from '../underline-tabs';

afterEach(cleanup);

type Key = 'a' | 'b' | 'c';

const items: readonly UnderlineTabItem<Key>[] = [
  { value: 'a', label: 'Alpha', id: 'tab-a', 'aria-controls': 'panel-a', count: 3 },
  { value: 'b', label: 'Beta', id: 'tab-b', 'aria-controls': 'panel-b', disabled: true },
  { value: 'c', label: 'Gamma', id: 'tab-c', 'aria-controls': 'panel-c' },
];

function Example({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<Key>('a');
  return (
    <UnderlineTabs
      aria-label="Sections"
      value={value}
      items={items}
      onValueChange={setValue}
      disabled={disabled}
    />
  );
}

describe('UnderlineTabs', () => {
  it('exposes tab semantics with one Tab entry and panel relationships', () => {
    render(<Example />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeTruthy();
    const [alpha, beta, gamma] = screen.getAllByRole('tab');
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(alpha.getAttribute('aria-controls')).toBe('panel-a');
    expect(alpha.id).toBe('tab-a');
    expect(alpha.textContent).toBe('Alpha3');
    expect([alpha.tabIndex, beta.tabIndex, gamma.tabIndex]).toEqual([0, -1, -1]);
    expect((beta as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves focus and selection with arrows, Home and End, skipping disabled tabs', () => {
    render(<Example />);
    const [alpha, , gamma] = screen.getAllByRole('tab');
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(gamma);
    expect(gamma.getAttribute('aria-selected')).toBe('true');
    expect(gamma.tabIndex).toBe(0);
    fireEvent.keyDown(gamma, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(alpha);
    fireEvent.keyDown(alpha, { key: 'End' });
    expect(document.activeElement).toBe(gamma);
    fireEvent.keyDown(gamma, { key: 'Home' });
    expect(document.activeElement).toBe(alpha);
    expect(alpha.getAttribute('aria-selected')).toBe('true');
  });

  it('reverses horizontal arrows in RTL', () => {
    const change = vi.fn();
    render(<UnderlineTabs aria-label="Sections" value="a" items={items} onValueChange={change} />);
    const [alpha, , gamma] = screen.getAllByRole('tab');
    alpha.style.direction = 'rtl';
    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(gamma);
    expect(change).toHaveBeenLastCalledWith('c');
  });

  it('keeps the selection but blocks activation while the whole strip is disabled', () => {
    const change = vi.fn();
    render(
      <UnderlineTabs
        aria-label="Sections"
        value="a"
        items={items}
        onValueChange={change}
        disabled
      />,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs.every((tab) => (tab as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(tabs[2]);
    expect(change).not.toHaveBeenCalled();
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });
});
