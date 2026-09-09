// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../hooks/useWorkers';
import { WorkerListToolbar, workerTabsScrollStep } from '../RolePillDropdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcutDisplay: () => '',
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-a',
    sessionId: 'session-a',
    role: 'developer',
    agent: 'codex',
    model: 'gpt-5.4',
    effort: null,
    label: null,
    status: 'idle',
    focused: true,
    idleSince: null,
    ...overrides,
  };
}

function manyWorkers(count: number): WorkerInfo[] {
  return Array.from({ length: count }, (_, index) =>
    worker({
      workerId: `worker-${index}`,
      sessionId: `session-${index}`,
      focused: index === 0,
      label: `w${index}`,
    }),
  );
}

function renderOverflowToolbar(workers = manyWorkers(6)) {
  return render(
    <WorkerListToolbar
      worker={workers[0]}
      workers={workers}
      selectedWorkerId={workers[0].workerId}
      activeWorkerCount={workers.length}
      softLimit={5}
      hardLimit={8}
      onSwitchFocus={vi.fn()}
      onOpenCreate={vi.fn()}
      onOpenSettings={vi.fn()}
      onArchiveWorker={vi.fn()}
    />,
  );
}

function mockScrollerOverflow(scroller: HTMLElement, { scrollLeft = 0, clientWidth = 200, scrollWidth = 800 } = {}) {
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(scroller, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = value;
    },
  });
}

function setReducedMotion(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: reduced,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('WorkerTabsList overflow scrolling', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('uses a bounded step that fits the visible tab strip', () => {
    expect(workerTabsScrollStep(200)).toBe(140);
    expect(workerTabsScrollStep(40)).toBe(80);
  });

  it('keeps edge scroll buttons mounted but disabled', () => {
    renderOverflowToolbar(manyWorkers(2));
    const scroller = screen.getByTestId('worker-tabs-scroller');
    mockScrollerOverflow(scroller, { clientWidth: 400, scrollWidth: 200 });
    fireEvent.scroll(scroller);
    const left = screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersLeftEdge' });
    const right = screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersRightEdge' });
    expect(left.getAttribute('aria-disabled')).toBe('true');
    expect(right.getAttribute('aria-disabled')).toBe('true');
    expect(left.getAttribute('tabindex')).toBe('-1');
    expect(right.getAttribute('tabindex')).toBe('-1');
  });

  it('shows a right arrow when tabs overflow and scrolls one step', () => {
    renderOverflowToolbar();
    const scroller = screen.getByTestId('worker-tabs-scroller');
    const scrollBy = vi.fn();
    mockScrollerOverflow(scroller, { scrollLeft: 0, clientWidth: 200, scrollWidth: 800 });
    scroller.scrollBy = scrollBy;
    fireEvent.scroll(scroller);

    const left = screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersLeftEdge' });
    const right = screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersRight' });
    expect(left.getAttribute('aria-disabled')).toBe('true');
    expect(right.getAttribute('aria-disabled')).toBeNull();
    expect(left.getAttribute('tabindex')).toBe('-1');
    expect(right.getAttribute('tabindex')).toBe('0');
    expect(left.className).toContain('focus-visible:ring-[var(--focus-ring)]');
    expect(right.className).toContain('focus-visible:ring-[var(--focus-ring)]');
    fireEvent.click(right);
    expect(scrollBy).toHaveBeenCalledWith({ left: workerTabsScrollStep(200), behavior: 'smooth' });
  });

  it('shows a left arrow after scrolling and can scroll back', () => {
    renderOverflowToolbar();
    const scroller = screen.getByTestId('worker-tabs-scroller');
    const scrollBy = vi.fn();
    mockScrollerOverflow(scroller, { scrollLeft: 240, clientWidth: 200, scrollWidth: 800 });
    scroller.scrollBy = scrollBy;
    fireEvent.scroll(scroller);

    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersLeft' }));
    expect(scrollBy).toHaveBeenCalledWith({ left: -workerTabsScrollStep(200), behavior: 'smooth' });
  });

  it('keeps keyboard focus on an arrow that reaches the edge', async () => {
    vi.useFakeTimers();
    renderOverflowToolbar();
    const scroller = screen.getByTestId('worker-tabs-scroller');
    mockScrollerOverflow(scroller, { scrollLeft: 0, clientWidth: 200, scrollWidth: 800 });
    fireEvent.scroll(scroller);

    const right = screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersRight' });
    await act(async () => {
      right.focus();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    mockScrollerOverflow(scroller, { scrollLeft: 600, clientWidth: 200, scrollWidth: 800 });
    fireEvent.scroll(scroller);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(right.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(right);
    expect(right.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersRightEdge' })).toBe(right);
    expect(right.className).toContain('focus-visible:ring-[var(--focus-ring)]');
  });

  it('keeps keyboard focus on the left arrow after it reaches the start', async () => {
    vi.useFakeTimers();
    renderOverflowToolbar();
    const scroller = screen.getByTestId('worker-tabs-scroller');
    mockScrollerOverflow(scroller, { scrollLeft: 240, clientWidth: 200, scrollWidth: 800 });
    fireEvent.scroll(scroller);

    const left = screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersLeft' });
    await act(async () => {
      left.focus();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    mockScrollerOverflow(scroller, { scrollLeft: 0, clientWidth: 200, scrollWidth: 800 });
    fireEvent.scroll(scroller);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(left.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(left);
    expect(left.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersLeftEdge' })).toBe(left);
  });

  it('scrolls instantly for reduced motion users', () => {
    setReducedMotion(true);
    renderOverflowToolbar();
    const scroller = screen.getByTestId('worker-tabs-scroller');
    const scrollBy = vi.fn();
    mockScrollerOverflow(scroller, { scrollLeft: 0, clientWidth: 200, scrollWidth: 800 });
    scroller.scrollBy = scrollBy;
    fireEvent.scroll(scroller);

    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersRight' }));
    expect(scrollBy).toHaveBeenCalledWith({ left: workerTabsScrollStep(200), behavior: 'auto' });

    mockScrollerOverflow(scroller, { scrollLeft: 240, clientWidth: 200, scrollWidth: 800 });
    fireEvent.scroll(scroller);
    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.scrollWorkersLeft' }));
    expect(scrollBy).toHaveBeenCalledWith({ left: -workerTabsScrollStep(200), behavior: 'auto' });
  });
});
