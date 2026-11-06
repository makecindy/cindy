// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useComposerOverlayMetrics } from '../useComposerOverlayMetrics';

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let resizeCallbacks: Array<() => void> = [];
let mutationCallback: (() => void) | undefined;
let resizeObserved: Element[] = [];
let overlayHeight = 236;
let renders = 0;
let latest: ReturnType<typeof useComposerOverlayMetrics> | null = null;
let previousActEnvironment: boolean | undefined;

function makeOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  Object.defineProperty(overlay, 'offsetHeight', { configurable: true, get: () => overlayHeight });
  document.body.append(overlay);
  return overlay;
}

function Probe({ overlay }: { overlay: HTMLElement }) {
  renders += 1;
  latest = useComposerOverlayMetrics(overlay);
  return null;
}

beforeEach(() => {
  resizeCallbacks = [];
  resizeObserved = [];
  overlayHeight = 236;
  renders = 0;
  latest = null;
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: () => void) { mutationCallback = callback; }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe(target: Element) { resizeObserved.push(target); }
      unobserve() {}
      disconnect() {}
    },
  );
  // Observer callbacks run outside act in the app; model the real runtime scheduling.
  previousActEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
});

afterEach(() => {
  (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('useComposerOverlayMetrics', () => {
  // Unit: a mutation burst must not force synchronous layout per React commit.
  // Previous tests covered resize alone; one child insertion with unchanged size
  // needs a resize observation, then the resulting metrics still commit pre-paint.
  it('defers mutation measurements to the browser resize phase instead of forcing layout', () => {
    const overlay = makeOverlay();
    const height = vi.spyOn(overlay, 'offsetHeight', 'get');
    render(<Probe overlay={overlay} />);
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false;
    height.mockClear();
    resizeObserved = [];
    for (let i = 0; i < 4; i++) mutationCallback!();
    expect(height).not.toHaveBeenCalled();
    // Re-observing is what yields the deferred notification for equal-size moves.
    expect(resizeObserved.filter(target => target === overlay)).toHaveLength(4);
    overlayHeight = 272;
    for (const callback of resizeCallbacks) callback();
    expect(height).toHaveBeenCalledTimes(1);
    expect(latest?.overlayHeight).toBe(272);
  });
  it('uses the measured overlay height on the first commit', () => {
    render(<Probe overlay={makeOverlay()} />);
    expect(latest?.overlayHeight).toBe(236);
  });

  it('commits a resized overlay inside the observer callback, before the next paint', () => {
    render(<Probe overlay={makeOverlay()} />);
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false;
    // The running-status row appears: the overlay grows by one row.
    overlayHeight = 272;
    for (const callback of resizeCallbacks) callback();
    expect(latest?.overlayHeight).toBe(272);
  });

  it('does not re-render when the observed size is unchanged', () => {
    render(<Probe overlay={makeOverlay()} />);
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false;
    const before = renders;
    for (const callback of resizeCallbacks) callback();
    expect(renders).toBe(before);
  });
});
