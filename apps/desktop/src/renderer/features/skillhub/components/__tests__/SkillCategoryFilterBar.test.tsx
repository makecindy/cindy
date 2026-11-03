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
        onSelectCategory={onSelectCategory}
      />,
    ),
  };
}

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

  it('keeps the overflowing category row free of arrow controls', () => {
    renderBar();
    const scroller = screen.getByTestId('skill-category-filter-scroller');
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 600 });
    fireEvent.scroll(scroller);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('reveals the focused category without centering the page', () => {
    renderBar();
    const category = screen.getByRole('radio', { name: 'Productivity' });
    category.scrollIntoView = vi.fn();

    fireEvent.focus(category);
    expect(category.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
  });

  it('preserves arrow-key selection and follows focus at both ends', () => {
    const { onSelectCategory } = renderBar();
    const all = screen.getByRole('radio', { name: 'All' });
    const automation = screen.getByRole('radio', { name: 'Automation' });
    const productivity = screen.getByRole('radio', { name: 'Productivity' });
    for (const category of [all, automation, productivity]) {
      category.scrollIntoView = vi.fn();
    }

    fireEvent.keyDown(automation, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(productivity);
    expect(onSelectCategory).toHaveBeenLastCalledWith('productivity');
    expect(productivity.scrollIntoView).toHaveBeenCalled();

    fireEvent.keyDown(productivity, { key: 'Home' });
    expect(document.activeElement).toBe(all);
    expect(all.scrollIntoView).toHaveBeenCalled();

    fireEvent.keyDown(all, { key: 'End' });
    expect(document.activeElement).toBe(productivity);
    expect(onSelectCategory).toHaveBeenLastCalledWith('productivity');
  });
});
