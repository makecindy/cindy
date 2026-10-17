// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SkillCategoryFilterBar } from '../SkillCategoryFilterBar';

const categories = [
  { slug: 'automation', name: 'Automation', count: 10, myCount: 1 },
  { slug: 'productivity', name: 'Productivity', count: 8, myCount: 0 },
];

function renderBar(onSelectCategory = vi.fn()) {
  return {
    onSelectCategory,
    ...render(
      <SkillCategoryFilterBar
        categories={categories}
        selectedCategory="automation"
        allLabel="All"
        ariaLabel="Filter skills by category"
        scrollLeftLabel="Scroll categories left"
        scrollRightLabel="Scroll categories right"
        scrollStartLabel="Already at the first category"
        scrollEndLabel="Already at the last category"
        onSelectCategory={onSelectCategory}
      />,
    ),
  };
}

function mockScroller(
  scroller: HTMLElement,
  values: { scrollLeft: number; clientWidth: number; scrollWidth: number },
) {
  let scrollLeft = values.scrollLeft;
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: values.clientWidth });
  Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: values.scrollWidth });
  Object.defineProperty(scroller, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = value;
    },
  });
  Object.defineProperty(scroller, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
}

Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value: vi.fn(),
});

describe('SkillCategoryFilterBar', () => {
  it('renders a single-select category group', () => {
    const { onSelectCategory } = renderBar();

    expect(screen.getByRole('radiogroup', { name: 'Filter skills by category' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Automation' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('radio', { name: 'Productivity' }));
    expect(onSelectCategory).toHaveBeenCalledWith('productivity');
  });

  it('keeps the category capsule free of arrow controls', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: 'Scroll categories left' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scroll categories right' })).toBeNull();
  });

  it('centers the selected category immediately after selection changes', () => {
    const { rerender } = renderBar();
    const scroller = screen.getByTestId('skill-category-filter-scroller');
    mockScroller(scroller, { scrollLeft: 0, clientWidth: 200, scrollWidth: 600 });
    const nextSelected = screen.getByRole('radio', { name: 'Productivity' });
    Object.defineProperty(nextSelected, 'offsetLeft', { configurable: true, value: 260 });
    Object.defineProperty(nextSelected, 'offsetWidth', { configurable: true, value: 96 });
    vi.mocked(scroller.scrollTo).mockClear();
    rerender(
      <SkillCategoryFilterBar
        categories={categories}
        selectedCategory="productivity"
        allLabel="All"
        ariaLabel="Filter skills by category"
        scrollLeftLabel="Scroll categories left"
        scrollRightLabel="Scroll categories right"
        scrollStartLabel="Already at the first category"
        scrollEndLabel="Already at the last category"
        onSelectCategory={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Productivity' }));
    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 208, behavior: 'auto' });
  });

  it('ignores clicking the already selected category', () => {
    const { onSelectCategory } = renderBar();
    fireEvent.click(screen.getByRole('radio', { name: 'Automation' }));
    expect(onSelectCategory).not.toHaveBeenCalled();
  });

  it('scrolls internally with Shift + wheel without changing category', () => {
    const { onSelectCategory } = renderBar();
    const scroller = screen.getByTestId('skill-category-filter-scroller');
    mockScroller(scroller, { scrollLeft: 20, clientWidth: 200, scrollWidth: 600 });
    fireEvent.wheel(scroller, { shiftKey: true, deltaY: 40 });
    expect(scroller.scrollLeft).toBe(60);
    expect(onSelectCategory).not.toHaveBeenCalled();
  });
});
