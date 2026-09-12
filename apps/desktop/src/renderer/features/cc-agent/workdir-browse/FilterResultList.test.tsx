// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FilterResultList } from './FilterResultList';

afterEach(() => cleanup());

describe('FilterResultList', () => {
  it('expands and collapses matching directories without changing the results', () => {
    render(
      <FilterResultList
        files={['src/index.ts', 'src/lib/readme.md']}
        truncated={false}
        isLoading={false}
        selectedPath={null}
        onSelectFile={vi.fn()}
      />,
    );

    const src = screen.getByRole('button', { name: 'src' });
    expect(src.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'lib' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'readme.md' })).not.toBeNull();

    fireEvent.click(src);

    expect(src.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'lib' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'readme.md' })).toBeNull();

    fireEvent.click(src);

    expect(src.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'lib' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'readme.md' })).not.toBeNull();
  });
});
