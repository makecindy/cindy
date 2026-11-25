/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
import type { DownloadProgressPhase } from '../../../../shared/downloadProgress';
import { PluginRecommendationSlots } from '../lib/PluginRecommendationSlots';

const progress = vi.hoisted(() => new Map<string, { download: { phase: DownloadProgressPhase } }>());
vi.mock('../lib/pluginInstallProgress', () => ({ usePluginInstallProgressMap: () => progress }));

let intersection: (visible: boolean) => void;
let resize: () => void;
let hidden: boolean;
let reduced: boolean;
let motion: EventTarget;
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
const clocks: TestClock[] = [];
const pushes: Array<{ target: Element; frames: Keyframe[]; options: KeyframeAnimationOptions; clock: TestClock }> = [];
const decodeIcon = vi.fn(async () => {});

class TestClock {
  onfinish: (() => void) | null = null;
  playState: AnimationPlayState = 'idle';
  private finish = () => {};
  readonly finished = new Promise<void>(resolve => { this.finish = resolve; });
  private elapsed = 0;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly duration: number) { this.play(); }

  get currentTime() {
    return this.elapsed + (this.playState === 'running' ? Date.now() - this.startedAt : 0);
  }

  set currentTime(value: number) { this.elapsed = value; }

  play() {
    if (this.playState === 'running') return;
    this.playState = 'running';
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.elapsed = this.duration;
      this.playState = 'finished';
      this.onfinish?.();
      this.finish();
    }, this.duration - this.elapsed);
  }

  pause() {
    this.elapsed = this.currentTime;
    this.playState = 'paused';
    clearTimeout(this.timer);
  }

  cancel() {
    clearTimeout(this.timer);
    this.elapsed = 0;
    this.playState = 'idle';
    this.finish();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  reduced = false;
  progress.clear();
  clocks.length = 0;
  pushes.length = 0;
  decodeIcon.mockClear();
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: decodeIcon });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value(this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const clock = new TestClock(Number(options.duration));
      if (this.classList.contains('plugin-recommendation-progress-line')) clocks.push(clock);
      else pushes.push({ target: this, frames, options, clock });
      return clock;
    },
  });
  motion = new EventTarget();
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  Object.defineProperty(motion, 'matches', { get: () => reduced, configurable: true });
  vi.stubGlobal('matchMedia', () => motion);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      intersection = visible => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      resize = () => callback([], this as unknown as ResizeObserver);
    }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute(HIDDEN_ANIMATION_ATTR);
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(Element.prototype, 'animate');
  if (originalDecode) Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode);
  else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const items = (...ids: string[]) => ids.map(pluginId => ({ pluginId } as PluginMarketItem));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function fixture(initial = items('a', 'b', 'c'), shuffle?: React.ComponentProps<typeof PluginRecommendationSlots>['shuffle']) {
  const order = { ids: [] as string[] };
  const view = (plugins = initial, busy = false, active = true) => (
    <section className="plugin-catalog-recommendations" aria-label="Recommendations">
      <PluginRecommendationSlots loading={false} items={plugins} order={order} busy={busy} active={active} shuffle={shuffle}
        trackInstallProgress renderItem={(item, featured, deck) => (
          <article className="plugin-recommendation-card" data-featured={featured} data-recommendation-id={item.pluginId}>
            {deck.items.map(candidate => {
              const layer = candidate.pluginId === item.pluginId ? 'current'
                : candidate.pluginId === deck.outgoingId ? 'outgoing' : undefined;
              return <div key={candidate.pluginId} className="plugin-recommendation-face" hidden={!layer}
                data-recommendation-layer={layer} inert={Boolean(deck.outgoingId) || undefined} aria-hidden={layer !== 'current' || undefined}>
                <img alt="" src={`/${candidate.pluginId}.png`} />
                {layer && <button type="button">{candidate.pluginId}</button>}
              </div>;
            })}
          </article>
        )} />
    </section>
  );
  const mounted = render(view());
  const region = screen.getByRole('region', { name: 'Recommendations' });
  const grid = region.querySelector<HTMLElement>('.plugin-recommendation-slots')!;
  const show = (visible: boolean) => act(() => intersection(visible));
  const current = () => Array.from(grid.querySelectorAll('[data-recommendation-id]'), card => card.getAttribute('data-recommendation-id'));
  return { ...mounted, view, region, grid, show, current };
}

describe('recommendation rotation', () => {
  it('keeps rotating when the window loses focus while the recommendations stay visible', async () => {
    const { show, current } = fixture();
    show(true);
    await advance(2_000);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    fireEvent.blur(window);
    await advance(4_000);
    expect(current()).toEqual(['b', 'c', 'a']);
  });

  it('automatically refreshes the batch only after three completed pushes', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const onChange = vi.fn();
    const { show } = fixture(items('a', 'b', 'c'), {
      title: 'Today', label: 'Shuffle', candidates: items('a', 'b', 'c', 'd'), onChange,
    });
    show(true);
    await advance(3 * (6_000 + 960) - 1);
    expect(onChange).not.toHaveBeenCalled();
    await advance(1);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(['a', 'b', 'd']);
  });

  it('selects a different batch even if the random draw repeats the visible picks', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const onChange = vi.fn();
    fixture(items('a', 'b', 'c'), { title: 'Today', label: 'Shuffle', candidates: items('a', 'b', 'c', 'd'), onChange });
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }));
    expect(onChange).toHaveBeenCalledWith(['a', 'b', 'd']);
  });

  it.each([0, 1])('keeps shuffle focus only for keyboard activation (detail=%i)', detail => {
    fixture(items('a', 'b', 'c'), { title: 'Today', label: 'Shuffle', candidates: items('a', 'b', 'c', 'd'), onChange: vi.fn() });
    const button = screen.getByRole('button', { name: 'Shuffle' });
    button.focus();
    fireEvent.click(button, { detail });
    expect(document.activeElement === button).toBe(detail === 0);
  });

  it('pushes all three pairs of content layers counterclockwise and keeps decoded icons mounted', async () => {
    const { current, show, grid } = fixture();
    const card = grid.firstElementChild!;
    const oldButton = card.querySelector('button');
    const icons = Array.from(grid.querySelectorAll('img'));
    const layers = () => Array.from(card.querySelectorAll<HTMLElement>('[data-recommendation-layer]'));
    show(true);
    expect(clocks).toHaveLength(1);
    expect(decodeIcon).toHaveBeenCalledTimes(icons.length);
    expect(vi.getTimerCount()).toBe(1);
    await advance(5_999);
    expect(clocks[0]?.currentTime).toBe(5_999);
    expect(current()).toEqual(['a', 'b', 'c']);
    await advance(1);
    expect(current()).toEqual(['b', 'c', 'a']);
    expect(grid.firstElementChild).toBe(card);
    expect(grid.firstElementChild?.getAttribute('data-featured')).toBe('true');
    expect(card.querySelector('[data-recommendation-layer="outgoing"] button')).toBe(oldButton);
    expect(card.querySelector('[data-recommendation-layer="current"] button')?.textContent).toBe('b');
    expect(layers().every(layer => layer.hasAttribute('inert'))).toBe(true);
    expect(grid.querySelector<HTMLElement>('.plugin-recommendation-progress')?.hidden).toBe(true);
    expect(Array.from(grid.querySelectorAll('img'))).toEqual(icons);
    expect(layers().map(layer => [layer.textContent, layer.getAttribute('aria-hidden')])).toEqual([['a', 'true'], ['b', null]]);
    const motion = (layer: Element) => pushes.find(push => push.target === layer);
    const [outgoing, incoming] = layers().map(motion);
    Array.from(grid.querySelectorAll('article')).forEach((slot, index) => {
      const [axis, distance] = ([['X', 100], ['X', -100], ['Y', -100]] as const)[index]!;
      const oldLayer = slot.querySelector('[data-recommendation-layer="outgoing"]')!;
      const newLayer = slot.querySelector('[data-recommendation-layer="current"]')!;
      expect(motion(oldLayer)?.frames).toEqual([{ transform: `translate${axis}(0%)` }, { transform: `translate${axis}(${distance}%)` }]);
      expect(motion(newLayer)?.frames).toEqual([{ transform: `translate${axis}(${-distance}%)` }, { transform: `translate${axis}(0%)` }]);
    });
    expect(pushes).toHaveLength(6);
    expect(pushes.every(({ options }) => options.duration === 960 && options.easing === 'ease-in-out')).toBe(true);
    await advance(480);
    expect(layers()).toHaveLength(2);
    expect(outgoing?.clock.currentTime).toBe(480);
    expect(incoming?.clock.currentTime).toBe(480);
    expect(clocks[0]?.currentTime).toBe(6_000);
    await advance(480);
    expect(layers().map(layer => layer.textContent)).toEqual(['b']);
    expect(layers()[0]?.hasAttribute('inert')).toBe(false);
    expect(grid.querySelector<HTMLElement>('.plugin-recommendation-progress')?.hidden).toBe(false);
    expect(Array.from(grid.querySelectorAll('img'))).toEqual(icons);
    expect(clocks).toHaveLength(1);
    expect(clocks[0]?.currentTime).toBe(0);
    await advance(6_000);
    expect(current()).toEqual(['c', 'a', 'b']);
  });

  it('fills a vacated slot immediately during a push', async () => {
    const { show, current, grid, rerender, view } = fixture();
    show(true);
    await advance(6_200);
    expect(grid.querySelectorAll('[data-recommendation-layer="outgoing"]')).toHaveLength(3);
    rerender(view(items('a', 'c', 'd')));
    expect(current()).toEqual(['d', 'c', 'a']);
    expect(grid.querySelectorAll('[data-recommendation-layer="outgoing"]')).toHaveLength(0);
    expect(pushes.every(({ clock }) => clock.playState === 'idle')).toBe(true);
  });

  const pauses = [
    ['pointer', ({ region }: ReturnType<typeof fixture>) => {
      fireEvent.pointerEnter(region);
      return () => fireEvent.pointerLeave(region);
    }],
    ['focus', () => {
      const card = screen.getByRole('button', { name: 'b' });
      card.focus();
      return () => card.blur();
    }],
    ...['dialog', 'menu', 'listbox'].map(role => [role, () => {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', role);
      document.body.append(overlay);
      return () => overlay.remove();
    }] as const),
    ['hidden document', () => {
      hidden = true;
      fireEvent(document, new Event('visibilitychange'));
      return () => { hidden = false; fireEvent(document, new Event('visibilitychange')); };
    }],
    ['native window hidden while the document is visible', () => {
      document.documentElement.setAttribute(HIDDEN_ANIMATION_ATTR, 'true');
      return () => document.documentElement.removeAttribute(HIDDEN_ANIMATION_ATTR);
    }],
    ['offscreen', ({ show }: ReturnType<typeof fixture>) => {
      show(false);
      return () => show(true);
    }],
    ['installing', ({ rerender, view }: ReturnType<typeof fixture>) => {
      rerender(view(undefined, true));
      return () => rerender(view());
    }],
    ['install progress', ({ rerender, view }: ReturnType<typeof fixture>) => {
      progress.set('b', { download: { phase: 'downloading' } });
      rerender(view());
      return () => { progress.clear(); rerender(view()); };
    }],
  ] as const;

  it.each(pauses)('pauses for %s and resumes from the same progress', async (_label, pause) => {
    const harness = fixture();
    harness.show(true);
    await advance(3_000);
    const resume = pause(harness);
    await advance(12_000);
    expect(harness.current()).toEqual(['a', 'b', 'c']);
    expect(clocks[0]?.currentTime).toBe(3_000);
    expect(vi.getTimerCount()).toBe(0);
    resume();
    await advance(2_999);
    expect(harness.current()).toEqual(['a', 'b', 'c']);
    await advance(1);
    expect(harness.current()).toEqual(['b', 'c', 'a']);
  });

  it('stays still when reduced motion is preferred', async () => {
    reduced = true;
    const { current, show, grid } = fixture();
    show(true);
    await advance(18_000);
    expect(current()).toEqual(['a', 'b', 'c']);
    expect(clocks).toHaveLength(0);
    expect(grid.querySelector<HTMLElement>('.plugin-recommendation-progress')?.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels and hides the progress line when the recommendations collapse to one column', async () => {
    const { current, show, grid } = fixture();
    show(true);
    await advance(3_000);
    grid.style.setProperty('--plugin-recommendation-columns', '1');
    act(resize);
    await advance(12_000);
    expect(current()).toEqual(['a', 'b', 'c']);
    expect(clocks[0]?.playState).toBe('idle');
    expect(grid.querySelector<HTMLElement>('.plugin-recommendation-progress')?.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['failed', 'completed'] as const)('resumes with retained %s progress', async phase => {
    const { view, rerender, show, current } = fixture();
    show(true);
    progress.set('b', { download: { phase: 'downloading' } });
    rerender(view(undefined, true));
    await advance(6_000);
    expect(current()).toEqual(['a', 'b', 'c']);

    progress.set('b', { download: { phase } });
    rerender(view());
    await advance(5_999);
    expect(current()).toEqual(['a', 'b', 'c']);
    await advance(1);
    expect(progress.get('b')?.download.phase).toBe(phase);
    expect(current()).toEqual(['b', 'c', 'a']);
  });

  it('stays still with fewer than three recommendations', async () => {
    const { current, grid } = fixture(items('a', 'b'));
    await advance(18_000);
    expect(current()).toEqual(['a', 'b']);
    expect(grid.querySelector('.plugin-recommendation-progress')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up on unmount, keeps its order on return and fills only a vacated slot', async () => {
    const { show, view, unmount } = fixture();
    show(true);
    await advance(6_000);
    unmount();
    expect(clocks[0]?.playState).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
    await advance(6_000);
    const next = render(view());
    expect(screen.getAllByRole('button').map(card => card.textContent)).toEqual(['b', 'c', 'a']);
    next.rerender(view(items('a', 'c', 'd')));
    expect(screen.getAllByRole('button').map(card => card.textContent)).toEqual(['d', 'c', 'a']);
  });
});
