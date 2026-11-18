// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TASK_MESSAGE_MAX_WIDTH, useProportionalWidth } from '../useProportionalWidth';

const BREAKPOINTS = [560, 600, 700] as const;

describe('useProportionalWidth resize hot path', () => {
  let measuredWidth = 1_000;
  let notifyResize: ResizeObserverCallback | null = null;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: measuredWidth,
          height: 0,
          top: 0,
          right: measuredWidth,
          bottom: 0,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('updates inherited CSS widths continuously but rerenders only across discrete bands', () => {
    let renders = 0;
    let latestBand = -1;
    let latestCompact = false;

    function Harness() {
      const width = useProportionalWidth(914, { expandTo: TASK_MESSAGE_MAX_WIDTH, responsiveBreakpoints: BREAKPOINTS });
      renders += 1;
      latestBand = width.inputWidthBand;
      latestCompact = width.isCompact;
      return <div ref={width.containerRef} data-testid="container" />;
    }

    const view = render(<Harness />);
    const container = view.getByTestId('container');
    const initialRenderCount = renders;
    expect(container.style.getPropertyValue('--cindy-message-width')).toBe('900px');
    expect(container.style.getPropertyValue('--cindy-input-width')).toBe('920px');
    expect(container.style.getPropertyValue('--cindy-input-half-width')).toBe('452px');
    expect(latestBand).toBe(3);
    expect(latestCompact).toBe(false);

    // Feedback #12, unit tier, real hook. A fixed cap never covered the
    // laptop-to-large-pane transition: preserve914 through1200, interpolate,
    // then bound text and wide blocks together, without session rerenders.
    for (const [pane, message, input] of [[1200, 914, 934], [1400, 1017, 1037], [1600, 1120, 1140], [2400, 1120, 1140]]) {
      measuredWidth = pane;
      act(() => {
        notifyResize?.(
          [{ contentRect: { width: measuredWidth } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
      expect(container.style.getPropertyValue('--cindy-message-width')).toBe(`${message}px`);
      expect(container.style.getPropertyValue('--cindy-input-width')).toBe(`${input}px`);
      expect(renders).toBe(initialRenderCount);
    }

    measuredWidth = 900;
    act(() => {
      notifyResize?.(
        [{ contentRect: { width: measuredWidth } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(container.style.getPropertyValue('--cindy-message-width')).toBe('800px');
    expect(container.style.getPropertyValue('--cindy-input-width')).toBe('820px');
    expect(renders).toBe(initialRenderCount);

    measuredWidth = 650;
    act(() => {
      notifyResize?.(
        [{ contentRect: { width: measuredWidth } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(container.style.getPropertyValue('--cindy-message-width')).toBe('610px');
    expect(container.style.getPropertyValue('--cindy-input-width')).toBe('630px');
    expect(container.style.getPropertyValue('--cindy-input-pad')).toBe('10px');
    expect(latestBand).toBe(2);
    expect(latestCompact).toBe(true);
    expect(renders).toBeGreaterThan(initialRenderCount);
    const renderCountAfterBreakpoint = renders;

    measuredWidth = 640;
    act(() => {
      notifyResize?.(
        [{ contentRect: { width: measuredWidth } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(container.style.getPropertyValue('--cindy-input-width')).toBe('620px');
    expect(renders).toBe(renderCountAfterBreakpoint);
  });
});
