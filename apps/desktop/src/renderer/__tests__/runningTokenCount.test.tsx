// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunningTokenCount } from '@/features/cc-agent/RunningTokenCount';
import { RunningTokenRatePopover } from '@/features/cc-agent/RunningTokenRatePopover';
import { emptyRateHistory } from '@/features/cc-agent/lib/runningTokenRateHistory';
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber';

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => preference.reduced }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { tokens?: string }) =>
      key === 'chat.runningStatus.tokenCount' ? `${values?.tokens} tokens` : key,
  }),
}));

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  preference.reduced = false;
  frames = new Map();
  nextFrame = 0;
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function advance(now: number) {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(now));
  });
}

it('keeps per-frame renders in the text leaf rather than the surrounding status UI', () => {
  const oldParent = vi.fn();
  const newParent = vi.fn();
  function Before({ tokens }: { tokens: number }) {
    oldParent();
    const displayed = useAnimatedNumber(tokens, 400);
    return <div data-testid="before">{displayed} tokens</div>;
  }
  function After({ tokens }: { tokens: number }) {
    newParent();
    return <div data-testid="after"><RunningTokenCount tokenUsage={tokens} /></div>;
  }
  const view = render(<><Before tokens={100} /><After tokens={100} /></>);
  view.rerender(<><Before tokens={500} /><After tokens={500} /></>);
  for (let frame = 1; frame <= 24; frame++) advance(frame * 400 / 24);
  expect(screen.getByTestId('before').textContent).toBe('500 tokens');
  expect(screen.getByTestId('after').textContent).toBe('500 tokens');
  expect(oldParent.mock.calls.length).toBeGreaterThan(20);
  expect(newParent).toHaveBeenCalledTimes(2);
  expect(frames.size).toBe(0);
});

it('schedules no unused token interpolation in the rate-only popover and cancels on mode change', () => {
  const props = { elapsedText: '2s', rate: '50', averageRate: '50', outputTokens: 100,
    history: emptyRateHistory(null) };
  const view = render(<RunningTokenRatePopover {...props} rateText="50 tok/s" tokenUsage={100} />);
  view.rerender(<RunningTokenRatePopover {...props} rateText="50 tok/s" tokenUsage={500} />);
  expect(frames.size).toBe(0);
  view.rerender(<RunningTokenRatePopover {...props} rateText="500 tokens" isTokenCount tokenUsage={500} />);
  view.rerender(<RunningTokenRatePopover {...props} rateText="900 tokens" isTokenCount tokenUsage={900} />);
  expect(frames.size).toBe(1);
  expect(screen.getByRole('button').getAttribute('aria-label')).toBe('2s · 900 tokens');
  advance(200);
  expect(screen.getByText('800 tokens')).toBeTruthy();
  view.rerender(<RunningTokenRatePopover {...props} rateText="50 tok/s" tokenUsage={900} />);
  expect(frames.size).toBe(0);
  view.rerender(<RunningTokenRatePopover {...props} rateText="900 tokens" isTokenCount tokenUsage={900} />);
  expect(screen.getByText('900 tokens')).toBeTruthy();
  expect(frames.size).toBe(0);
});

describe('counter lifecycle', () => {
  it('cancels on unmount and snaps decreases at the next turn', () => {
    const view = render(<RunningTokenCount tokenUsage={100} />);
    view.rerender(<RunningTokenCount tokenUsage={500} />);
    advance(200);
    expect(screen.getByText('400 tokens')).toBeTruthy();
    view.rerender(<RunningTokenCount tokenUsage={0} />);
    expect(screen.getByText('0 tokens')).toBeTruthy();
    expect(frames.size).toBe(0);
    view.rerender(<RunningTokenCount tokenUsage={500} />);
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
  });

  it('stops an in-flight animation when reduced motion is enabled and preserves compact formatting', () => {
    const view = render(<RunningTokenCount tokenUsage={100} />);
    view.rerender(<RunningTokenCount tokenUsage={500} />);
    advance(200);
    preference.reduced = true;
    view.rerender(<RunningTokenCount tokenUsage={500} />);
    expect(screen.getByText('500 tokens')).toBeTruthy();
    expect(frames.size).toBe(0);
    view.rerender(<RunningTokenCount tokenUsage={1250} />);
    expect(screen.getByText('1.3k tokens')).toBeTruthy();
    expect(frames.size).toBe(0);
  });
});
