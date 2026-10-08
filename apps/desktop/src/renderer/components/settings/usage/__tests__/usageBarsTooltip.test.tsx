// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageTokenBars } from '../UsageTokenBars';
import { tooltipRows } from '../UsageBarsTooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number; tokens?: string }) =>
      opts?.count !== undefined
        ? `${key}:${opts.count}`
        : opts?.tokens !== undefined
          ? `${opts.tokens} tokens`
          : key,
    i18n: { language: 'en' },
  }),
}));

const money = {
  amount: 0,
  currency: 'USD' as const,
  approximate: false,
  kind: 'actual-cost' as const,
};
const row = (model: string, tokens: number, day = '2026-09-26') => ({
  day,
  agentKind: 'codex' as const,
  model,
  tokens,
  money,
  apiMoney: money,
  subscriptionEstimateMoney: money,
});

// jsdom 没有布局:按元素身份给出可控的视口坐标。
const rects = new Map<string, Partial<DOMRect>>();
function rectFor(el: Element): DOMRect {
  const key =
    el.getAttribute('data-testid') === 'usage-bars-tooltip'
      ? 'tooltip'
      : el.classList.contains('usage-token-plot')
        ? 'plot'
        : (el.getAttribute('data-day') ?? '');
  const r = { left: 0, top: 0, width: 0, height: 0, ...(rects.get(key) ?? {}) };
  return {
    ...r,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON: () => r,
  } as DOMRect;
}

beforeEach(() => {
  rects.clear();
  rects.set('tooltip', { width: 240, height: 150 });
  rects.set('plot', { left: 100, top: 400, width: 800, height: 96 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return rectFor(this);
  });
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 800,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderBars(modelDaily = [row('small', 100), row('big', 900)]) {
  return render(
    <UsageTokenBars
      modelDaily={modelDaily}
      colorOrder={['codex big', 'codex small']}
      todayKey="2026-09-26"
      onDayClick={vi.fn()}
    />,
  );
}
const bar = (view: ReturnType<typeof render>, day = '2026-09-26') =>
  view.container.querySelector<HTMLButtonElement>(`button[data-day="${day}"]`)!;
const tooltipTransform = () => screen.getByTestId('usage-bars-tooltip').style.transform;

describe('usage bars tooltip', () => {
  it('orders rows by tokens and folds the tail beyond six models', () => {
    const segments = [1, 9, 3, 7, 5, 2, 8, 4].map((tokens) => ({
      key: tokens,
      label: `m${tokens}`,
      tokens,
      color: 'red',
    }));
    const { rows, hiddenCount, hiddenTokens } = tooltipRows(segments);
    expect(rows.map((r) => r.tokens)).toEqual([9, 8, 7, 5, 4, 3]);
    expect(hiddenCount).toBe(2);
    expect(hiddenTokens).toBe(3);
  });

  it('replaces the native title with one shared tooltip and keeps model detail accessible', () => {
    const view = renderBars();
    const target = bar(view);
    expect(target.hasAttribute('title')).toBe(false);
    const description = document.getElementById(target.getAttribute('aria-describedby')!);
    expect(description?.textContent).toBe('big: 900 tokens; small: 100 tokens');

    fireEvent.pointerOver(target);
    const tooltip = screen.getByTestId('usage-bars-tooltip');
    expect(tooltip.getAttribute('aria-hidden')).toBe('true');
    const text = tooltip.textContent ?? '';
    expect(text.indexOf('big')).toBeLessThan(text.indexOf('small'));
    expect(text).toContain('90%');
    expect(text).toContain('10%');
  });

  it('keeps the tooltip while either hover or focus is still active', () => {
    const view = renderBars();
    const target = bar(view);
    const plot = target.parentElement!;

    fireEvent.focus(target);
    fireEvent.pointerOver(target);
    fireEvent.pointerOut(plot, { relatedTarget: document.body });
    expect(screen.getByTestId('usage-bars-tooltip')).toBeTruthy();
    fireEvent.blur(target);
    expect(screen.queryByTestId('usage-bars-tooltip')).toBeNull();

    fireEvent.pointerOver(target);
    fireEvent.focus(target);
    fireEvent.blur(target);
    expect(screen.getByTestId('usage-bars-tooltip')).toBeTruthy();
    fireEvent.pointerOut(plot, { relatedTarget: document.body });
    expect(screen.queryByTestId('usage-bars-tooltip')).toBeNull();
  });

  it('centres above the plot, clamps to the viewport and flips below without room', () => {
    const view = renderBars([row('big', 900), row('big', 300, '2026-09-25')]);
    rects.set('2026-09-26', { left: 500, top: 470, width: 10, height: 26 });
    rects.set('2026-09-25', { left: 990, top: 470, width: 10, height: 26 });

    fireEvent.pointerOver(bar(view));
    // centre 505 - 240 / 2 = 385; 400 - 8 - 150 = 242
    expect(tooltipTransform()).toBe('translate3d(385px, 242px, 0)');
    expect(screen.getByTestId('usage-bars-tooltip').dataset.glide).toBeUndefined();

    fireEvent.pointerOver(bar(view, '2026-09-25'));
    // clamped to 1000 - 240 - 8
    expect(tooltipTransform()).toBe('translate3d(752px, 242px, 0)');
    expect(screen.getByTestId('usage-bars-tooltip').dataset.glide).toBe('true');

    rects.set('plot', { left: 100, top: 100, width: 800, height: 96 });
    fireEvent.scroll(window);
    // 100 - 8 - 150 < 8 → below the plot: 196 + 8
    expect(tooltipTransform()).toBe('translate3d(752px, 204px, 0)');
  });

  it('stays inside a short viewport when neither side of the plot has room (3× zoom)', () => {
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: 200,
    });
    rects.set('plot', { left: 100, top: 60, width: 800, height: 96 });
    const view = renderBars();
    rects.set('2026-09-26', { left: 500, top: 130, width: 10, height: 26 });

    fireEvent.pointerOver(bar(view));
    // above: 60 - 8 - 150 < 8; below: 164 + 150 > 192 → clamp to 192 - 150
    expect(tooltipTransform()).toBe('translate3d(385px, 42px, 0)');

    rects.set('tooltip', { width: 240, height: 300 });
    fireEvent.scroll(window);
    // taller than the viewport: pinned to the top margin, max-height clips the rest
    expect(tooltipTransform()).toBe('translate3d(385px, 8px, 0)');
    expect(screen.getByTestId('usage-bars-tooltip').className).toContain('max-h-');
  });

  it('stays inside a narrow viewport instead of spilling past the left edge (3× zoom)', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 267,
    });
    rects.set('plot', { left: 10, top: 400, width: 250, height: 96 });
    rects.set('tooltip', { width: 320, height: 150 });
    const view = renderBars();
    rects.set('2026-09-26', { left: 200, top: 470, width: 6, height: 26 });

    fireEvent.pointerOver(bar(view));
    // 267 - 320 - 8 < 8 → left margin wins; width itself is capped by CSS to the viewport
    expect(tooltipTransform()).toBe('translate3d(8px, 242px, 0)');
    expect(screen.getByTestId('usage-bars-tooltip').className).toContain(
      'max-w-[min(320px,calc(100vw-16px))]',
    );
  });

  it('caps the share bar at six model segments plus one merged remainder', () => {
    const models = Array.from({ length: 10 }, (_, i) => row(`m${i}`, (i + 1) * 10));
    const view = render(
      <UsageTokenBars
        modelDaily={models}
        colorOrder={models.map((m) => `codex ${m.model}`)}
        todayKey="2026-09-26"
        onDayClick={vi.fn()}
      />,
    );
    fireEvent.pointerOver(bar(view));
    const shareBar = screen.getByTestId('usage-bars-tooltip').querySelector('.h-1')!;
    expect(shareBar.children).toHaveLength(7);
    expect(screen.getByTestId('usage-bars-tooltip').textContent).toContain(
      'usageHistory.daily.tooltip.more:4',
    );
  });

  it('shows the empty-day message for a day without usage', () => {
    const view = renderBars([]);
    fireEvent.pointerOver(bar(view, '2026-09-20'));
    expect(screen.getByTestId('usage-bars-tooltip').textContent).toContain(
      'usageHistory.heatmap.emptyCell',
    );
  });
});
