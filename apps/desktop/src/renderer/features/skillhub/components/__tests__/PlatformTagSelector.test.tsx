// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlatformTagSelector } from '../PlatformTagSelector';

const categories = [
  { slug: 'automation', name: 'Automation', count: 2, myCount: 1, source: 'platform' as const },
  { slug: 'productivity', name: 'Productivity', count: 3, myCount: 0, source: 'platform' as const },
];

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

    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    expect((screen.getByRole('checkbox', { name: 'Automation' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Productivity' }));
    expect(onChange).toHaveBeenCalledWith(['automation', 'productivity']);

    rerender(
      <PlatformTagSelector
        categories={categories}
        value={['automation', 'productivity']}
        onChange={onChange}
        ariaLabel="Tags"
        placeholder="Select tags (optional)"
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Automation' }));
    expect(onChange).toHaveBeenLastCalledWith(['productivity']);
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

    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    fireEvent.wheel(screen.getByTestId('platform-tag-options'), { deltaY: 120 });

    expect(onOuterWheel).not.toHaveBeenCalled();
  });
});
