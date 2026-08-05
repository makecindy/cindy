// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Switch } from '../switch';

describe('Switch', () => {
  afterEach(cleanup);

  it('uses dedicated semantic tokens for the unchecked track and thumb', () => {
    render(<Switch aria-label="Background updates" />);

    const track = screen.getByRole('switch', { name: 'Background updates' });
    const thumb = track.firstElementChild as HTMLElement;
    expect(track.className).toContain('data-[state=unchecked]:bg-[var(--switch-track-off)]');
    expect(thumb.className).toContain('data-[state=unchecked]:bg-[var(--switch-thumb-off)]');
  });
});
