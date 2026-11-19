import { mountPage } from '../../ui-page/harness';
import { RunningTokenRatePopover } from '../../../src/renderer/features/cc-agent/RunningTokenRatePopover';
import { emptyRateHistory, type RateHistory } from '../../../src/renderer/features/cc-agent/lib/runningTokenRateHistory';

/** A speed history with `requests` finished model requests: mostly quick, a deep think now and then. */
function fixtureHistory(requests: number, unreported: boolean): RateHistory {
  const samples = Array.from({ length: 60 }, (_, i) => ({
    durationMs: (i + 1) * 2_000,
    outputTokens: (i + 1) * 90,
    rate: Math.round(46 + 22 * Math.sin(i / 3.1) + 12 * Math.sin(i / 1.3)),
  }));
  const thinkingOf = (i: number) => (i % 11 === 1 ? 4_096 : i % 4 === 0 || i === requests - 1 ? 516 : 0);
  const marks = Array.from({ length: requests }, (_, i) => ({
    durationMs: Math.round(((i + 1) / requests) * 120_000),
    thinkingTokens: unreported ? null : thinkingOf(i),
    requests: 1,
  }));
  return {
    ...emptyRateHistory(1), samples, peak: 78, latestRate: 52, latestSampleAt: Date.now(), marks,
    markStartedAt: 1,
    ...(unreported ? {} : {
      turnThinkingTokens: marks.reduce((sum, mark) => sum + (mark.thinkingTokens ?? 0), 0),
      // Each request also writes a few hundred tokens of answer or tool call.
      turnThinkingOutputTokens: marks.reduce((sum, _mark, i) => sum + thinkingOf(i) + 420 + 80 * (i % 5), 0),
    }),
  };
}

mountPage({
  render: (ctx) => (
    <main className="flex h-screen items-end justify-end bg-content-area p-5 text-foreground">
      <RunningTokenRatePopover
        elapsedText="2m 14s"
        rate="52"
        rateText="52 tok/s"
        averageRate="47"
        outputTokens={5_400}
        history={fixtureHistory(Number(ctx.data.requests ?? 3), ctx.data.unreported === true)}
      />
    </main>
  ),
});
