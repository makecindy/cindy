// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  RunningTokenRatePopover,
  useRunningTokenRateHistory,
} from '@/features/cc-agent/RunningTokenRatePopover';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('pins the card on click and dismisses with Escape, returning focus to the speed', async () => {
  render(
    <RunningTokenRatePopover
      elapsedText="10s"
      rate="100"
      rateText="100 tok/s"
      averageRate="110"
      outputTokens={1000}
      history={{
        startedAt: 1,
        baseline: { durationMs: 10000, outputTokens: 1000 },
        peak: 120,
        latestRate: 100,
        samples: [
          { durationMs: 1000, outputTokens: 120, rate: 120 },
          { durationMs: 10000, outputTokens: 1000, rate: 100 },
        ],
      }}
    />,
  );
  const trigger = screen.getByRole('button');
  const elapsed = screen.getByText('10s');
  expect(elapsed.closest('button')).toBe(trigger);
  fireEvent.pointerMove(elapsed, { pointerType: 'mouse' });
  await screen.findByRole('tooltip');
  fireEvent.click(elapsed);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(3);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it.each(['Escape', 'close'] as const)(
  'clears hover after pinned dismissal via %s and allows a fresh hover',
  async (dismissal) => {
    render(
      <RunningTokenRatePopover
        elapsedText="10s"
        rate="100"
        rateText="100 tok/s"
        averageRate="110"
        outputTokens={1000}
        history={{ startedAt: 1, baseline: null, peak: 100, latestRate: null, samples: [] }}
      />,
    );
    const trigger = screen.getByRole('button');
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    await screen.findByRole('tooltip');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 550)));
    expect(screen.queryByRole('tooltip')).toBeNull();
    if (dismissal === 'Escape') {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.getByRole('button')).toBe(trigger);
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    await screen.findByRole('tooltip');
  },
);

it('keeps the pinned card across turns while awaiting a fresh rate', async () => {
  function Harness({
    startedAt,
    outputTokens,
    generationDurationMs,
  }: {
    startedAt: number | null;
    outputTokens: number;
    generationDurationMs: number;
  }) {
    const history = useRunningTokenRateHistory({
      startedAt,
      outputTokens,
      generationDurationMs,
      generationReliable: true,
    });
    return (
      <RunningTokenRatePopover
        elapsedText="10s"
        rate={history.latestRate === null ? null : String(history.latestRate)}
        rateText="speed"
        averageRate="75"
        outputTokens={outputTokens}
        history={history}
      />
    );
  }
  const { rerender } = render(<Harness startedAt={1} outputTokens={0} generationDurationMs={0} />);
  rerender(<Harness startedAt={1} outputTokens={100} generationDurationMs={1000} />);
  const trigger = screen.getByRole('button');
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  rerender(<Harness startedAt={null} outputTokens={150} generationDurationMs={2000} />);
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(screen.getByRole('button', { name: /speed/ })).toBe(trigger);
  expect(dialog.textContent).toContain('50');
  expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(3);
  rerender(<Harness startedAt={2} outputTokens={0} generationDurationMs={0} />);
  expect(screen.getByRole('dialog')).toBe(dialog);
  const chart = screen.getByRole('img');
  expect(chart.querySelectorAll('path')).toHaveLength(3);
  expect(screen.getByRole('dialog').textContent).toContain('—');
  const previousLine = chart.querySelectorAll('path')[2].getAttribute('d');
  rerender(<Harness startedAt={2} outputTokens={20} generationDurationMs={500} />);
  expect(screen.getByRole('dialog').textContent).toContain('40');
  const nextLine = screen.getByRole('img').querySelectorAll('path')[2].getAttribute('d');
  expect(nextLine).not.toBe(previousLine);
  expect(nextLine?.match(/[ML]/g)).toHaveLength(3);
});

it('keeps a clicked panel open through outside clicks, focus changes and repeated trigger clicks', async () => {
  const onPinnedChange = vi.fn();
  render(
    <>
      <input aria-label="composer" />
      <RunningTokenRatePopover
        elapsedText="10s"
        rate="100"
        rateText="100 tok/s"
        averageRate="110"
        outputTokens={1000}
        history={{ startedAt: 1, baseline: null, peak: 0, latestRate: null, samples: [] }}
        onPinnedChange={onPinnedChange}
      />
    </>,
  );
  const trigger = screen.getByRole('button');
  fireEvent.click(trigger);
  expect(onPinnedChange).toHaveBeenLastCalledWith(true);
  const dialog = screen.getByRole('dialog');
  const composer = screen.getByRole('textbox');
  fireEvent.pointerDown(composer);
  fireEvent.pointerUp(composer);
  fireEvent.click(composer);
  act(() => composer.focus());
  expect(document.activeElement).toBe(composer);
  expect(screen.getByRole('dialog')).toBe(dialog);
  fireEvent.click(trigger);
  fireEvent.pointerLeave(trigger);
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onPinnedChange).toHaveBeenLastCalledWith(false);
});
