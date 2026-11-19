// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnGenerationTrace } from '@/components/status/TurnGenerationTrace';
import {
  RunningTokenRatePopover,
  useRunningTokenRateHistory,
} from '@/features/cc-agent/RunningTokenRatePopover';
import {
  clearRateHistoryCache,
  emptyRateHistory,
} from '@/features/cc-agent/lib/runningTokenRateHistory';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { rate?: string }) =>
      key === 'chat.runningStatus.tokenRate' ? `${options?.rate} tok/s` : key,
  }),
}));
afterEach(cleanup);

it('expires the displayed rate without losing history, including after remount', () => {
  vi.useFakeTimers();
  try {
    clearRateHistoryCache();
    function Probe({ tokens }: { tokens: number }) {
      const history = useRunningTokenRateHistory({ sessionKey: 'freshness', startedAt: 1,
        outputTokens: tokens, generationDurationMs: tokens * 10, generationReliable: true });
      return <div data-testid="rate">{history.latestRate ?? 'waiting'}:{history.samples.length}</div>;
    }
    const view = render(<Probe tokens={0} />);
    view.rerender(<Probe tokens={100} />);
    expect(screen.getByTestId('rate').textContent).toBe('100:1');
    act(() => vi.advanceTimersByTime(59_999));
    expect(screen.getByTestId('rate').textContent).toBe('100:1');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('rate').textContent).toBe('waiting:1');
    view.unmount();
    const again = render(<Probe tokens={100} />);
    expect(screen.getByTestId('rate').textContent).toBe('waiting:1');
    again.rerender(<Probe tokens={200} />);
    expect(screen.getByTestId('rate').textContent).toBe('100:2');
    again.unmount();
  } finally { clearRateHistoryCache(); vi.useRealTimers(); }
});

it('shows the observed peak as soon as one exists, without waiting for a chart sample', () => {
  const props = {
    elapsedText: '1s',
    rate: null,
    rateText: null,
    averageRate: null,
    outputTokens: 0,
  };
  const peak = () => screen.getByText('chat.runningStatus.observedPeak').nextElementSibling;
  // No measurement yet: nothing observed, so no peak to report.
  const { rerender } = render(
    <RunningTokenRatePopover {...props} history={emptyRateHistory(1)} />,
  );
  fireEvent.click(screen.getByRole('button'));
  expect(peak()?.textContent).toBe('—');

  // A short turn measured 120 tok/s but is still too short to produce a chart point.
  rerender(
    <RunningTokenRatePopover
      {...props}
      history={{ ...emptyRateHistory(1), peak: 120 }}
    />,
  );
  expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(1);
  expect(peak()?.textContent).toBe('120 tok/s');
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
      lastReport: null,
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
        lastReport: { durationMs: 10000, outputTokens: 1000 },
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
        history={{
          startedAt: 1,
          baseline: null,
          lastReport: null,
          peak: 100,
          latestRate: null,
          samples: [],
        }}
      />,
    );
    const trigger = screen.getByRole('button');
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    await screen.findByRole('tooltip');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    // real-wait: the popover dismissal uses the production 550ms hover grace period.
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
  expect(chart.querySelectorAll('path')[2].getAttribute('d')).toBe(previousLine);
  expect(screen.getByRole('dialog').textContent).toContain('—');
  rerender(<Harness startedAt={2} outputTokens={40} generationDurationMs={1000} />);
  expect(screen.getByRole('dialog').textContent).toContain('40');
  const nextLine = screen.getByRole('img').querySelectorAll('path')[2].getAttribute('d');
  expect(nextLine).not.toBe(previousLine);
  expect(nextLine?.match(/[ML]/g)).toHaveLength(3);
});

it('keeps a clicked panel open through outside clicks and focus changes, and closes from the trigger', async () => {
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
        history={{
          startedAt: 1,
          baseline: null,
          lastReport: null,
          peak: 0,
          latestRate: null,
          samples: [],
        }}
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
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByRole('tooltip')).toBeNull();
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
  render(<Harness sessionKey="cache-b" startedAt={1} outputTokens={0} generationDurationMs={0} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(1);
  expect(screen.getByRole('dialog').textContent).toContain('—');
});

it.each([
  [500, 10000],
  [50, 500],
  [50, 10000],
  [500, 500],
])(
  'preserves the last measured rate on idle restore with %i tokens / %i ms',
  (outputTokens, generationDurationMs) => {
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
    render(
      <Harness
        sessionKey="idle-a"
        startedAt={null}
        outputTokens={outputTokens}
        generationDurationMs={generationDurationMs}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    // 无论新轮计数增大还是减小，都不能与旧轮比较或追加伪造区间；
    // 图表仍只有缓存里的 1 个采样点（仅轴线），最新速度保持最后的真实测量。
    expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(1);
    expect(screen.getByRole('dialog').textContent).not.toContain('44.4');
    expect(screen.getByText('100', { selector: 'span' })).toBeTruthy();
  },
);

// 生产入口：RunningTokenRatePopover（状态栏速度浮窗）。规则依据：每次模型请求的推理量画在速度曲线
// 下方，并给出最近一次的数值；宿主没上报推理拆分（旧宿主、不报的供应商）时浮窗必须和以前一样，
// 不能出现一排假的「0 推理」。unit。
it('draws reasoning per finished request under the speed curve, and nothing when none was reported', () => {
  const props = { elapsedText: '10s', rate: '100', rateText: '100 tok/s', averageRate: '100', outputTokens: 1000 };
  const history = {
    ...emptyRateHistory(1),
    peak: 100,
    latestRate: 100,
    samples: [
      { durationMs: 1000, outputTokens: 100, rate: 100 },
      { durationMs: 9000, outputTokens: 900, rate: 100 },
    ],
  };
  const strokes = () => screen.getByRole('img').querySelectorAll('[data-testid="thinking-stroke"]');
  const view = render(<RunningTokenRatePopover {...props} history={{ ...history, marks: [
    { durationMs: 2000, thinkingTokens: null, requests: 1 },
    { durationMs: 5000, thinkingTokens: null, requests: 1 },
  ], markStartedAt: 1 }} />);
  fireEvent.click(screen.getByRole('button'));
  expect(strokes()).toHaveLength(0);
  expect(screen.queryByText('chat.runningStatus.thinkingShare')).toBeNull();

  view.rerender(<RunningTokenRatePopover {...props} history={{ ...history, marks: [
    { durationMs: 2000, thinkingTokens: 4096, requests: 1 },
    { durationMs: 5000, thinkingTokens: 0, requests: 1 },
    // Finished after the last reading: still on the chart, at its right edge.
    { durationMs: 9400, thinkingTokens: 516, requests: 1 },
  ], markStartedAt: 1, turnThinkingTokens: 4612, turnThinkingOutputTokens: 10_000 }} />);
  expect(strokes()).toHaveLength(3);
  const lengths = [...strokes()].map((stroke) => {
    const [, from, to] = /M[\d.]+ ([\d.]+)V([\d.]+)/.exec(stroke.getAttribute('d') ?? '') ?? [];
    return Number(to) - Number(from);
  });
  // The longest think is the longest stroke; the request that did not think still leaves a mark.
  expect(lengths[0]).toBeGreaterThan(lengths[2]);
  expect(lengths[2]).toBeGreaterThan(lengths[1]);
  expect(lengths[1]).toBeGreaterThan(0);
  // 4,612 of 10,000 output tokens this turn.
  expect(screen.getByText('chat.runningStatus.thinkingShare').nextElementSibling?.textContent).toBe('46%');
});

// 生产入口：TurnGenerationTrace（完成后用量明细浮窗顶部）。规则依据：结束后只给这一轮的小结
// （推理占输出的比例），不逐次请求展开；没有上报推理拆分时小结只说请求次数，不能写成「推理 0%」。unit。
it('sums a finished turn up in one line, with or without a reported reasoning split', () => {
  const trace = {
    durationMs: 28_000,
    requests: 5,
    speed: [[1000, 40], [14_000, 60], [27_000, 50]] as Array<[number, number]>,
    // Two requests share the first slice of the axis; one reported no split.
    marks: [[200, 300, 1], [600, 216, 1], [14_000, -1, 1], [20_000, 0, 1], [28_000, 4096, 1]] as Array<[number, number, number]>,
    reportedOutputTokens: 9_000,
  };
  const caption = () => [...(screen.getByTestId('turn-generation-trace').lastElementChild?.children ?? [])]
    .map((part) => part.textContent);
  const view = render(<TurnGenerationTrace trace={trace} />);
  expect(screen.getByRole('img').querySelectorAll('[data-testid="thinking-stroke"]')).toHaveLength(3);
  expect(caption()).toEqual(['usageDetails.traceThinkingShare', 'usageDetails.traceRequests']);
  view.rerender(<TurnGenerationTrace trace={{
    ...trace, marks: trace.marks.map(([at, , requests]) => [at, -1, requests]), reportedOutputTokens: 0,
  }} />);
  expect(screen.getByRole('img').querySelectorAll('[data-testid="thinking-stroke"]')).toHaveLength(0);
  expect(caption()).toEqual(['usageDetails.traceRequests']);
});

// 生产入口：TurnGenerationTrace 里的图（两个浮窗共用）。规则依据：图上不加文字标签，靠指针说明——
// 选中一段后显示那一刻的速度；只有那一段确有推理量才多一行，没有请求结束、没上报或为 0 都不显示
// 这一行；指针离开后提示消失。unit。
it('says what is at the picked moment, and mentions reasoning only where there was some', () => {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ left: 0, top: 100, width: 288, height: 74, right: 288, bottom: 174, x: 0, y: 100, toJSON: () => ({}) });
  try {
    render(<TurnGenerationTrace trace={{
      durationMs: 28_000,
      requests: 3,
      speed: [[1000, 40], [14_000, 60], [27_000, 50]],
      // A request that thought at the start, one that reported zero in the middle, one at the end.
      marks: [[200, 300, 1], [14_200, 0, 1], [28_000, 4096, 1]],
      reportedOutputTokens: 9_000,
    }} />);
    const chart = screen.getByRole('img').parentElement!;
    const readout = () => screen.queryByTestId('trace-readout');
    const lines = () => [...(readout()?.children ?? [])].map((line) => line.textContent);
    expect(readout()).toBeNull();
    // First slice: the request there reasoned.
    fireEvent.pointerMove(chart, { clientX: 6, clientY: 120 });
    expect(lines()).toEqual(['usageDetails.performanceRateLine0:01', 'usageDetails.traceThinkingTokens']);
    expect(screen.getByTestId('trace-pick')).toBeTruthy();
    // Middle: a request finished there but reported no reasoning. A quarter in: no request finished at all.
    fireEvent.pointerMove(chart, { clientX: 144, clientY: 120 });
    expect(lines()).toHaveLength(1);
    fireEvent.pointerMove(chart, { clientX: 72, clientY: 120 });
    expect(lines()).toHaveLength(1);
    // Regression #11543: portal coordinates cannot survive scrolling, resizing or window blur.
    for (const event of ['scroll', 'resize', 'blur']) {
      fireEvent.pointerMove(chart, { clientX: 72, clientY: 120 });
      expect(readout()).not.toBeNull();
      fireEvent(window, new Event(event));
      expect(readout()).toBeNull();
    }
    fireEvent.pointerMove(chart, { clientX: 72, clientY: 120 });
    fireEvent.pointerLeave(chart);
    expect(readout()).toBeNull();
    expect(screen.queryByTestId('trace-pick')).toBeNull();
  } finally { rect.mockRestore(); }
});

