// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SkillCategoryFilterBar, skillCategoryScrollStep } from '../SkillCategoryFilterBar';

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
}

describe('SkillCategoryFilterBar', () => {
  it('renders a single-select category group', () => {
    const { onSelectCategory } = renderBar();

    expect(screen.getByRole('group', { name: 'Filter skills by category' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Automation' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Productivity' }));
    expect(onSelectCategory).toHaveBeenCalledWith('productivity');
  });

  it('shows edge controls only when the category row overflows', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: 'Scroll categories right' })).toBeNull();

    const scroller = screen.getByTestId('skill-category-filter-scroller');
    mockScroller(scroller, { scrollLeft: 0, clientWidth: 200, scrollWidth: 600 });
    fireEvent.scroll(scroller);

    expect(
      screen
        .getByRole('button', { name: 'Already at the first category' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Scroll categories right' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('scrolls by a bounded portion of the visible row', () => {
    renderBar();
    const scroller = screen.getByTestId('skill-category-filter-scroller');
    const scrollBy = vi.fn();
    mockScroller(scroller, { scrollLeft: 0, clientWidth: 200, scrollWidth: 600 });
    scroller.scrollBy = scrollBy;
    fireEvent.scroll(scroller);

    fireEvent.click(screen.getByRole('button', { name: 'Scroll categories right' }));
    expect(scrollBy).toHaveBeenCalledWith({
      left: skillCategoryScrollStep(200),
      behavior: 'smooth',
    });
  });
});
