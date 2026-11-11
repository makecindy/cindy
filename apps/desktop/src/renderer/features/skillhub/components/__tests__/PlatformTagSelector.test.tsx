// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlatformTagSelector } from '../PlatformTagSelector';

const categories = [
  { slug: 'automation', name: 'Automation', count: 2, myCount: 1, source: 'platform' as const },
  { slug: 'productivity', name: 'Productivity', count: 3, myCount: 0, source: 'platform' as const },
];

// Radix menus open on pointerdown (or Enter / Space / ArrowDown), not on click.
const openTags = () =>
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Tags' }), { button: 0, ctrlKey: false });
const tag = (name: string) => screen.getByRole('menuitemcheckbox', { name });

describe('PlatformTagSelector', () => {
  it('adds and removes existing Platform tag slugs', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PlatformTagSelector
        categories={categories}
        value={['automation']}
        onChange={onChange}
        ariaLabel="Tags"
        placeholder="Select tags (optional)"
      />,
    );

    openTags();
    expect(tag('Automation').getAttribute('aria-checked')).toBe('true');
    expect(tag('Productivity').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(tag('Productivity'));
    expect(onChange).toHaveBeenCalledWith(['automation', 'productivity']);
    // Multi-select: the menu stays open after a tick.
    expect(screen.getByRole('menu')).toBeTruthy();

    rerender(
      <PlatformTagSelector
        categories={categories}
        value={['automation', 'productivity']}
        onChange={onChange}
        ariaLabel="Tags"
        placeholder="Select tags (optional)"
      />,
    );
    expect(tag('Productivity').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(tag('Automation'));
    expect(onChange).toHaveBeenLastCalledWith(['productivity']);
  });

  it('toggles tags from the keyboard without closing', async () => {
    const onChange = vi.fn();
    render(
      <PlatformTagSelector
        categories={categories}
        value={[]}
        onChange={onChange}
        ariaLabel="Tags"
        placeholder="Select tags (optional)"
      />,
    );
    const press = async (key: string, target: Element = document.activeElement!) => {
      await act(async () => {
        fireEvent.keyDown(target, { key });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const trigger = screen.getByRole('button', { name: 'Tags' });
    trigger.focus();
    await press('Enter', trigger);
    await press('Home');
    await press('ArrowDown');
    expect(document.activeElement).toBe(tag('Productivity'));
    await press(' ');
    expect(onChange).toHaveBeenCalledWith(['productivity']);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('shows an optional placeholder when no tags are selected', () => {
    render(
      <PlatformTagSelector
        categories={categories}
        value={[]}
        onChange={vi.fn()}
        ariaLabel="Tags"
        placeholder="Select tags (optional)"
      />,
    );

    expect(screen.getByText('Select tags (optional)')).toBeTruthy();
  });

  it('keeps wheel events inside the portalled options list', () => {
    const onOuterWheel = vi.fn();
    render(
      <div onWheel={onOuterWheel}>
        <PlatformTagSelector
          categories={categories}
          value={[]}
          onChange={vi.fn()}
          ariaLabel="Tags"
          placeholder="Select tags (optional)"
        />
      </div>,
    );

    openTags();
    fireEvent.wheel(screen.getByTestId('platform-tag-options'), { deltaY: 120 });

    expect(onOuterWheel).not.toHaveBeenCalled();
  });
});
