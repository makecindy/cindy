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
      rate="100"
      rateText="100 tok/s"
      averageRate="110"
      outputTokens={1000}
      history={{
        startedAt: 1,
        baseline: { durationMs: 10000, outputTokens: 1000 },
        lastReport: { durationMs: 10000, outputTokens: 1000 },
        peak: 120,
        samples: [
          { durationMs: 1000, outputTokens: 120, rate: 120 },
          { durationMs: 10000, outputTokens: 1000, rate: 100 },
        ],
      }}
    />,
  );
  const trigger = screen.getByRole('button');
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(3);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it.each(['Escape', 'outside', 'trigger'] as const)(
  'clears hover after pinned dismissal via %s and allows a fresh hover',
  async (dismissal) => {
    render(
      <RunningTokenRatePopover
        rate="100"
        rateText="100 tok/s"
        averageRate="110"
        outputTokens={1000}
        history={{ startedAt: 1, baseline: null, lastReport: null, peak: 100, samples: [] }}
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
    } else if (dismissal === 'outside') {
      fireEvent.pointerDown(document.body);
      fireEvent.pointerUp(document.body);
      fireEvent.click(document.body);
    } else {
      fireEvent.click(trigger);
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

it('keeps a pinned card and final samples through completion, resetting for a new turn', async () => {
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
        key={history.startedAt}
        rate={String(history.samples.at(-1)?.rate ?? '')}
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
  expect(screen.getByRole('button')).toBe(trigger);
  expect(dialog.textContent).toContain('50');
  expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(3);
  rerender(<Harness startedAt={2} outputTokens={0} generationDurationMs={0} />);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
