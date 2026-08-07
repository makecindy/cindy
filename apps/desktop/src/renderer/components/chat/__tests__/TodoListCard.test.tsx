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
  it('uses a compact 28px pill inside the 32px plan slot', () => {
    render(<TodoListCard todos={TODOS} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });
    expect(trigger.classList.contains('py-[6px]')).toBe(true);
    expect(trigger.classList.contains('py-[8px]')).toBe(false);
  });

  it('shrinks to the plan pill width when it shares the centered row', () => {
    const { container } = render(<TodoListCard todos={TODOS} />);

    expect(container.firstElementChild?.classList.contains('w-auto')).toBe(true);
    expect(container.firstElementChild?.classList.contains('shrink-0')).toBe(true);
    expect(container.firstElementChild?.classList.contains('w-full')).toBe(false);
  });

  it('uses a static grayscale progress ring without spin or pulse', () => {
    const { container } = render(
      <TodoListCard todos={[{ content: 'Queued step', status: 'pending' }]} animated />,
    );

    const trigger = screen.getByRole('button', { name: 'Step 1 / 1' });

    expect(container.firstElementChild?.classList.contains('pointer-events-none')).toBe(true);
    expect(trigger.parentElement?.classList.contains('pointer-events-auto')).toBe(true);
    expect(trigger.querySelector('svg[data-plan-progress-ring="true"]')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('keeps the active row static when the flyout is open', () => {
    const { container } = render(<TodoListCard todos={TODOS} animated />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });
    fireEvent.mouseEnter(trigger.parentElement as HTMLElement);

    expect(container.querySelector('svg.lucide-circle-dashed')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
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

  it('positions the flyout outside the shifted plan pill anchor', () => {
    render(<TodoListCard todos={TODOS} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 1 / 2' });
    const pillAnchor = trigger.closest('[data-plan-pill-anchor="true"]') as HTMLElement;
    fireEvent.mouseEnter(pillAnchor);

    const flyoutId = trigger.getAttribute('aria-controls') as string;
    const positioner = document.getElementById(flyoutId) as HTMLElement;

    expect(positioner.dataset.planFlyoutPositioner).toBe('composer');
    expect(positioner.parentElement).toBe(pillAnchor.parentElement);
    expect(positioner.parentElement).not.toBe(pillAnchor);
    expect(pillAnchor.querySelector('.h-3')).not.toBeNull();
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
