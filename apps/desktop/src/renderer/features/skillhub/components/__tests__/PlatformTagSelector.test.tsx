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
      />,
    );

    expect(screen.getByRole('button', { name: 'Automation' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Productivity' }));
    expect(onChange).toHaveBeenCalledWith(['automation', 'productivity']);

    rerender(
      <PlatformTagSelector
        categories={categories}
        value={['automation', 'productivity']}
        onChange={onChange}
        ariaLabel="Tags"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Automation' }));
    expect(onChange).toHaveBeenLastCalledWith(['productivity']);
  });
});
