// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
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
  // jsdom 没有指针捕获，cancel 路径要用到。
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

describe('Slider', () => {
  it('puts accessible names on the interactive thumb', () => {
    render(<Slider aria-label="UI font size" defaultValue={[14]} min={12} max={24} />);

    expect(screen.getByRole('slider', { name: 'UI font size' })).toBeTruthy();
  });

  // A canceled gesture must be reported explicitly: consumers cannot tell a
  // cancel replay from a normal move to the same value.
  it('reports a canceled gesture and replays the press-time value', () => {
    const onValueChange = vi.fn();
    const onValueCancel = vi.fn();
    render(
      <Slider
        aria-label="Font size"
        defaultValue={[14]}
        min={12}
        max={24}
        onValueChange={onValueChange}
        onValueCancel={onValueCancel}
      />,
    );
    const thumb = screen.getByRole('slider', { name: 'Font size' });

    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, isPrimary: true });
    fireEvent.pointerCancel(thumb, { pointerId: 1 });

    expect(onValueCancel).toHaveBeenCalledWith([14]);
    expect(onValueChange).toHaveBeenLastCalledWith([14]);
  });
});
