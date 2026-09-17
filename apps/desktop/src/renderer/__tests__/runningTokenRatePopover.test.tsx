// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  RunningTokenRatePopover,
  useRunningTokenRateHistory,
} from '@/features/cc-agent/RunningTokenRatePopover';
import {
  clearRateHistoryCache,
  emptyRateHistory,
  recordRunningTokenRate,
} from '@/features/cc-agent/lib/runningTokenRateHistory';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { rate?: string }) =>
      key === 'chat.runningStatus.tokenRate' ? `${options?.rate} tok/s` : key,
  }),
}));
afterEach(cleanup);

it('distinguishes an unobserved peak from measured zero throughput', () => {
  const props = {
    elapsedText: '1s',
    rate: null,
    rateText: null,
    averageRate: null,
    outputTokens: 0,
  };
  let history = emptyRateHistory(1);
  const { rerender } = render(<RunningTokenRatePopover {...props} history={history} />);
  fireEvent.click(screen.getByRole('button'));
  const peak = () => screen.getByText('chat.runningStatus.observedPeak').nextElementSibling;
  expect(peak()?.textContent).toBe('—');
  for (const generationDurationMs of [0, 1000]) {
    history = recordRunningTokenRate(history, {
      startedAt: 1,
      outputTokens: 0,
      generationDurationMs,
      generationReliable: true,
    });
  }
  rerender(<RunningTokenRatePopover {...props} history={history} />);
  expect(peak()?.textContent).toBe('0 tok/s');
});

it('keeps pinned history while its trigger falls back to tokens or elapsed-only', () => {
  const props = {
    elapsedText: '10s',
    rate: '100',
    rateText: '100 tok/s',
    averageRate: '100',
    outputTokens: 1000,
    history: {
      startedAt: 1,
      baseline: null,
      peak: 100,
      latestRate: 100,
      samples: [{ durationMs: 1000, outputTokens: 100, rate: 100 }],
    },
  };
  const { rerender } = render(<RunningTokenRatePopover {...props} />);
  const trigger = screen.getByRole('button');
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  rerender(
    <RunningTokenRatePopover
      {...props}
      rate={null}
      averageRate={null}
      rateText="1.2k tok"
      isTokenCount
    />,
  );
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(trigger.textContent).toContain('1.2k tok');
  expect(trigger.getAttribute('aria-label')).not.toContain('currentRate');
  expect(screen.getByRole('img').querySelector('circle')).toBeTruthy();
  rerender(<RunningTokenRatePopover {...props} rateText={null} />);
  expect(trigger.textContent).toBe('10s');
  expect(screen.getByRole('dialog')).toBe(dialog);
  rerender(<RunningTokenRatePopover {...props} />);
  expect(trigger.textContent).toContain('100 tok/s');
  expect(screen.getByRole('dialog')).toBe(dialog);
});

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
      sessionKey: null,
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

it('restores speed history from the per-session cache after remounting', () => {
  clearRateHistoryCache();
  function Harness({
    sessionKey,
    startedAt,
    outputTokens,
    generationDurationMs,
  }: {
    sessionKey: string | null;
    startedAt: number | null;
    outputTokens: number;
    generationDurationMs: number;
  }) {
    const history = useRunningTokenRateHistory({
      sessionKey,
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
        averageRate={null}
        outputTokens={outputTokens}
        history={history}
      />
    );
  }
  const first = render(
    <Harness sessionKey="cache-a" startedAt={1} outputTokens={0} generationDurationMs={0} />,
  );
  first.rerender(
    <Harness sessionKey="cache-a" startedAt={1} outputTokens={100} generationDurationMs={1000} />,
  );
  first.rerender(
    <Harness sessionKey="cache-a" startedAt={1} outputTokens={150} generationDurationMs={2000} />,
  );
  first.unmount();

  // 切回同一会话：图表从缓存恢复，且恢复的 baseline 能继续算出新的配对速度。
  const second = render(
    <Harness sessionKey="cache-a" startedAt={1} outputTokens={200} generationDurationMs={3000} />,
  );
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(3);
  expect(screen.getByRole('dialog').textContent).toContain('50');
  second.unmount();

  // 另一个会话没有历史：从零等待，不串会话。
  const third = render(
    <Harness sessionKey="cache-b" startedAt={1} outputTokens={0} generationDurationMs={0} />,
  );
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(1);
  expect(screen.getByRole('dialog').textContent).toContain('—');
});

it('does not fabricate a rate when restoring an idle session whose next turn finished while away', () => {
  clearRateHistoryCache();
  function Harness({
    sessionKey,
    startedAt,
    outputTokens,
    generationDurationMs,
  }: {
    sessionKey: string | null;
    startedAt: number | null;
    outputTokens: number;
    generationDurationMs: number;
  }) {
    const history = useRunningTokenRateHistory({
      sessionKey,
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
        averageRate={null}
        outputTokens={outputTokens}
        history={history}
      />
    );
  }
  const first = render(
    <Harness sessionKey="idle-a" startedAt={1} outputTokens={0} generationDurationMs={0} />,
  );
  first.rerender(
    <Harness sessionKey="idle-a" startedAt={1} outputTokens={100} generationDurationMs={1000} />,
  );
  first.unmount();

  // 切离期间会话在后台跑完新一轮；切回时已空闲，store 里是新轮的累计计数。
  const second = render(
    <Harness sessionKey="idle-a" startedAt={null} outputTokens={500} generationDurationMs={10000} />,
  );
  fireEvent.click(screen.getByRole('button'));
  // 新轮计数减旧轮 baseline 得出的 44.4 tok/s 是伪造区间，不得追加；
  // 图表仍只有缓存里的 1 个采样点（仅轴线），最新速度保持最后的真实测量。
  expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(1);
  expect(screen.getByRole('dialog').textContent).not.toContain('44.4');
  expect(screen.getByRole('dialog').textContent).toContain('100');
});
