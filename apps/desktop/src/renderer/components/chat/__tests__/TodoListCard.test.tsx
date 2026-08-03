// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TodoListCard } from '../TodoListCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, values: { current: number; total: number }) =>
      `Step ${values.current} / ${values.total}`,
  }),
}));

const TODOS = [
  { content: 'Inspect interaction state', status: 'in_progress' as const },
  { content: 'Verify toggle behavior', status: 'pending' as const },
];

afterEach(cleanup);

describe('TodoListCard flyout interaction', () => {
  it('uses the pending icon when no step is currently in progress', () => {
    const { container } = render(
      <TodoListCard todos={[{ content: 'Queued step', status: 'pending' }]} animated />,
    );

    const trigger = screen.getByRole('button', { name: 'Step 1 / 1' });

    expect(trigger.querySelector('svg.lucide-circle')).not.toBeNull();
    expect(trigger.querySelector('svg.lucide-circle-dashed')).toBeNull();
    expect(container.querySelector('svg.lucide-circle-dashed')).toBeNull();
  });

  it('opens transiently on hover and closes when the pointer leaves', () => {
    render(<TodoListCard todos={TODOS} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });
    const hoverRegion = trigger.parentElement as HTMLElement;

    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.mouseEnter(hoverRegion);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.mouseLeave(hoverRegion);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('pins the hover flyout on click and closes it immediately on the second click', () => {
    render(<TodoListCard todos={TODOS} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });
    const hoverRegion = trigger.parentElement as HTMLElement;

    fireEvent.mouseEnter(hoverRegion);
    fireEvent.click(trigger);
    fireEvent.mouseLeave(hoverRegion);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.mouseEnter(hoverRegion);
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.mouseLeave(hoverRegion);
    fireEvent.mouseEnter(hoverRegion);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes a pinned flyout when the pointer goes outside the card', () => {
    render(<TodoListCard todos={TODOS} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.pointerDown(document.body);

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes a pinned flyout with Escape', () => {
    render(<TodoListCard todos={TODOS} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('toggles the pinned flyout for keyboard-generated clicks', () => {
    render(<TodoListCard todos={TODOS} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });

    fireEvent.click(trigger, { detail: 0 });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(trigger, { detail: 0 });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps centering and entrance animation transforms on separate elements', () => {
    render(<TodoListCard todos={TODOS} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });
    const hoverRegion = trigger.parentElement as HTMLElement;

    fireEvent.mouseEnter(hoverRegion);

    const flyoutId = trigger.getAttribute('aria-controls') as string;
    const positioner = document.getElementById(flyoutId) as HTMLElement;
    const animatedContent = positioner.firstElementChild as HTMLElement;

    expect(positioner.classList.contains('-translate-x-1/2')).toBe(true);
    expect(positioner.className).not.toContain('animate-float-');
    expect(animatedContent.classList.contains('animate-float-in')).toBe(true);
    expect(animatedContent.classList.contains('-translate-x-1/2')).toBe(false);
  });

  it('hides the flyout from assistive technology while its exit animation remains mounted', () => {
    render(<TodoListCard todos={TODOS} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });
    const hoverRegion = trigger.parentElement as HTMLElement;

    fireEvent.mouseEnter(hoverRegion);

    const flyoutId = trigger.getAttribute('aria-controls') as string;
    const positioner = document.getElementById(flyoutId) as HTMLElement;
    const animatedContent = positioner.firstElementChild as HTMLElement;

    expect(animatedContent.getAttribute('aria-hidden')).toBe('false');

    fireEvent.mouseLeave(hoverRegion);

    expect(document.getElementById(flyoutId)).toBe(positioner);
    expect(animatedContent.getAttribute('aria-hidden')).toBe('true');
  });
});
