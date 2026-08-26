// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Slider } from '../slider';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('Slider', () => {
  it('puts accessible names on the interactive thumb', () => {
    render(<Slider aria-label="UI font size" defaultValue={[14]} min={12} max={24} />);

    expect(screen.getByRole('slider', { name: 'UI font size' })).toBeTruthy();
  });
});
