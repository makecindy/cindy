// @vitest-environment jsdom

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FadeSwitcher } from '../FadeSwitcher';

describe('FadeSwitcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reveals content when requestAnimationFrame is throttled before first paint', () => {
    const view = render(
      <FadeSwitcher>
        <div>Route content</div>
      </FadeSwitcher>,
    );
    const container = view.container.firstElementChild;
    expect(container).toBeInstanceOf(HTMLElement);
    expect((container as HTMLElement).style.opacity).toBe('0');

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect((container as HTMLElement).style.opacity).toBe('1');
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
  });
});
