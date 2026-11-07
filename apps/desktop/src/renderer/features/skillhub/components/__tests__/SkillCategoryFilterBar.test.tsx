// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
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

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });

Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value: vi.fn(),
});

function pointer(target: HTMLElement | Window, type: string, values: Record<string, number> = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 100, ...values });
  fireEvent(target, event);
}

describe('SkillCategoryFilterBar', () => {
  // PR #6032: exercise the real component's pointer/resize boundaries. jsdom only
  // supplies events and dimensions; the production component owns all scrolling.
  it.each(['pointerup', 'pointercancel', 'missed-release'])('stops dragging after %s outside the bar', (release) => {
    const { onSelectCategory } = renderBar();
    const scroller = screen.getByTestId('skill-category-filter-scroller');
    mockScroller(scroller, { scrollLeft: 100, clientWidth: 200, scrollWidth: 600 });
    scroller.setPointerCapture = vi.fn();
    pointer(scroller, 'pointerdown');
    if (release !== 'missed-release') pointer(window, release, { buttons: 0 });
    pointer(scroller, 'pointermove', { clientX: 60, buttons: release === 'missed-release' ? 0 : 1 });
    expect(scroller.scrollLeft).toBe(100);
    expect(onSelectCategory).not.toHaveBeenCalled();
  });

  it('keeps held-button dragging and suppresses its click, then allows a fresh click', () => {
    const { onSelectCategory } = renderBar();
    const scroller = screen.getByTestId('skill-category-filter-scroller');
    mockScroller(scroller, { scrollLeft: 100, clientWidth: 200, scrollWidth: 600 });
    scroller.setPointerCapture = vi.fn();
    pointer(scroller, 'pointerdown');
    pointer(scroller, 'pointermove', { clientX: 60 });
    expect(scroller.scrollLeft).toBe(140);
    pointer(scroller, 'pointerup', { buttons: 0 });
    fireEvent.click(screen.getByRole('radio', { name: 'Productivity' }));
    expect(onSelectCategory).not.toHaveBeenCalled();
    pointer(scroller, 'pointerdown');
    pointer(scroller, 'pointerup', { buttons: 0 });
    fireEvent.click(screen.getByRole('radio', { name: 'Productivity' }));
    expect(onSelectCategory).toHaveBeenCalledExactlyOnceWith('productivity');
  });

  it('recenters on width changes, ignores unchanged width, and disconnects on unmount', () => {
    const observers = new Map<Element, { notify: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      disconnect = vi.fn();
      observe = (element: Element) => { observers.set(element, { notify: this.callback, disconnect: this.disconnect }); };
    });
    try {
      const { unmount, onSelectCategory } = renderBar();
      const scroller = screen.getByTestId('skill-category-filter-scroller');
      expect(observers.has(scroller)).toBe(true);
      const { notify, disconnect } = observers.get(scroller)!;
      mockScroller(scroller, { scrollLeft: 0, clientWidth: 200, scrollWidth: 600 });
      const selected = screen.getByRole('radio', { name: 'Automation' });
      Object.defineProperty(selected, 'offsetLeft', { configurable: true, value: 260 });
      Object.defineProperty(selected, 'offsetWidth', { configurable: true, value: 96 });
      act(() => notify([], {} as ResizeObserver));
      expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 208, behavior: 'auto' });
      vi.mocked(scroller.scrollTo).mockClear();
      act(() => notify([], {} as ResizeObserver));
      expect(scroller.scrollTo).not.toHaveBeenCalled();
      Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 120 });
      act(() => notify([], {} as ResizeObserver));
      expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 248, behavior: 'auto' });
      Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 400 });
      act(() => notify([], {} as ResizeObserver));
      expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 108, behavior: 'auto' });
      // A loaded font can widen the row while the capsule keeps the same width.
      Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 800 });
      Object.defineProperty(selected, 'offsetLeft', { configurable: true, value: 320 });
      act(() => notify([], {} as ResizeObserver));
      expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 168, behavior: 'auto' });
      expect(onSelectCategory).not.toHaveBeenCalled();
      unmount();
      expect(disconnect).toHaveBeenCalledOnce();
      vi.mocked(scroller.scrollTo).mockClear();
      Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 100 });
      act(() => notify([], {} as ResizeObserver));
      expect(scroller.scrollTo).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
        onSelectCategory={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Productivity' }));
    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 208, behavior: 'auto' });
  });

  it('ignores clicking the already selected category', () => {
    const { onSelectCategory } = renderBar();
    const scroller = screen.getByTestId('skill-category-filter-scroller');
    vi.mocked(scroller.scrollTo).mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'Automation' }));
    expect(onSelectCategory).not.toHaveBeenCalled();
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls internally with Shift + wheel without changing category', () => {
    const { onSelectCategory } = renderBar();
    const scroller = screen.getByTestId('skill-category-filter-scroller');
    mockScroller(scroller, { scrollLeft: 20, clientWidth: 200, scrollWidth: 600 });
    fireEvent.wheel(scroller, { shiftKey: true, deltaY: 40 });
    expect(scroller.scrollLeft).toBe(60);
    expect(onSelectCategory).not.toHaveBeenCalled();
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
