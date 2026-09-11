// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RunningTokenRatePopover } from '@/features/cc-agent/RunningTokenRatePopover';

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
        history={{ startedAt: 1, baseline: null, peak: 100, samples: [] }}
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
