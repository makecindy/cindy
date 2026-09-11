// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RunningTokenRatePopover } from '@/features/cc-agent/RunningTokenRatePopover';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('pins the card on click and dismisses with Escape, returning focus to the speed', async () => {
  render(
    <RunningTokenRatePopover
      activityStatus="正在执行工具"
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

it('updates actual activity while retaining the latest speed in a pinned card', () => {
  const props = {
    rate: '100',
    rateText: '100 tok/s',
    averageRate: '110',
    outputTokens: 1000,
    history: { startedAt: 1, baseline: null, peak: 100, samples: [] },
  };
  const { rerender } = render(<RunningTokenRatePopover {...props} activityStatus="正在执行工具" />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('dialog').textContent).toContain('正在执行工具');
  rerender(<RunningTokenRatePopover {...props} activityStatus="等待授权" />);
  expect(screen.getByRole('dialog').textContent).toContain('等待授权');
  expect(screen.getByRole('dialog').textContent).not.toContain('正在执行工具');
  expect(screen.getByRole('button').textContent).toBe('100 tok/s');
});
