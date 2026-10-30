/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { animateFocusScroll } from '../components/chat/animateFocusScroll';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture({ start = 22962, absolute = 14370, reduced = false, clockStart = 0 } = {}) {
  let now = clockStart;
  let nextFrame = 0;
  let exists = true;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++nextFrame, cb); return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  const root = document.createElement('div');
  const target = document.createElement('div');
  root.scrollTop = start;
  Object.defineProperty(root, 'clientHeight', { value: 1000 });
  root.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  root.scrollTo = ((options: ScrollToOptions) => {
    root.scrollTop = Math.max(0, Math.min(26000, options.top ?? root.scrollTop));
  }) as typeof root.scrollTo;
  target.style.scrollMarginTop = '80px';
  target.getBoundingClientRect = () => ({ top: absolute - root.scrollTop,
    bottom: absolute - root.scrollTop + 330 } as DOMRect);
  const onFinish = vi.fn();
  const reconcile = vi.fn();
  const cancel = animateFocusScroll({ root, getTarget: () => exists ? target : null,
    reconcile, onFinish });
  return { root, target, reconcile, onFinish, cancel,
    move: (delta: number) => { absolute += delta; },
    remove: () => { exists = false; },
    frame: (elapsed: number) => {
      now = elapsed;
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(now));
      return target.getBoundingClientRect().top;
    },
  };
}

it.each([
  { absolute: 1000, firstFrame: 99.8 },
  { absolute: 1000, firstFrame: 92 },
  { absolute: 18000, firstFrame: 99.8 },
  { absolute: 18000, firstFrame: 92 },
])('does not reverse on an early first frame ($firstFrame, target $absolute)', ({ absolute, firstFrame }) => {
  // Start away from both scroll boundaries so native clamping cannot hide a
  // reverse movement. rAF's frame timestamp can precede performance.now().
  const f = fixture({ start: 10000, absolute, clockStart: 100 });
  f.frame(firstFrame);
  expect(f.root.scrollTop).toBe(10000);
  expect(f.reconcile).not.toHaveBeenCalled();
  expect(f.onFinish).not.toHaveBeenCalled();
  f.frame(100);
  expect(f.root.scrollTop).toBe(10000);
  f.frame(200);
  expect(Math.sign(f.root.scrollTop - 10000)).toBe(Math.sign(absolute - 10000));
  f.frame(1000);
  expect(f.target.getBoundingClientRect().top).toBeCloseTo(375);
  expect(f.onFinish).toHaveBeenCalledOnce();
});

it.each([416, -416])('keeps the visible trajectory when virtual heights change by %spx', shift => {
  const f = fixture();
  const positions: number[] = [];
  for (let t = 0; t <= 850; t += 17) {
    // Reproduce a height correction inside the mount caused by this scroll.
    if (t === 510) f.reconcile.mockImplementationOnce(() => f.move(shift));
    positions.push(f.frame(t));
  }
  expect(f.reconcile).toHaveBeenCalled();
  expect(Math.abs(positions.at(-1)! - 375)).toBeLessThanOrEqual(0.5);
  expect(positions.every((top, i) => i === 0 || top >= positions[i - 1] - 0.5)).toBe(true);
  expect(f.onFinish).toHaveBeenCalledOnce();
});

it('tracks a target below the viewport when preceding rows shrink between frames', () => {
  const f = fixture({ start: 2000, absolute: 18000 });
  const positions = [f.frame(100), f.frame(300)];
  f.move(-416);
  positions.push(f.frame(500), f.frame(700), f.frame(850));
  expect(positions.at(-1)).toBeCloseTo(375);
  expect(positions.every((top, i) => i === 0 || top <= positions[i - 1] + 0.5)).toBe(true);
  expect(f.onFinish).toHaveBeenCalledOnce();
});

it('does not recenter or finish after the caller cancels for user input/replacement/unmount', () => {
  const f = fixture();
  f.frame(200); f.cancel();
  f.root.scrollTop = 7000;
  f.move(416); f.frame(1000);
  expect(f.root.scrollTop).toBe(7000);
  expect(f.onFinish).not.toHaveBeenCalled();
});

it('hands a removed target back to the existing deletion settlement', () => {
  const f = fixture();
  f.frame(200); f.remove(); f.frame(220); f.frame(1000);
  expect(f.onFinish).toHaveBeenCalledOnce();
});

it('honors reduced motion while still measuring the final mounted target', () => {
  const f = fixture({ reduced: true });
  f.reconcile.mockImplementationOnce(() => f.move(416));
  expect(f.frame(17)).toBeCloseTo(375);
  expect(f.onFinish).toHaveBeenCalledOnce();
});

it('finishes a target at the scroll boundary without oscillation', () => {
  const f = fixture({ absolute: 0 });
  f.frame(900);
  expect(f.root.scrollTop).toBe(0);
  expect(f.onFinish).toHaveBeenCalledOnce();
});
