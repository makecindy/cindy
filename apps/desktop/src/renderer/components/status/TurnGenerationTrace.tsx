import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatThinkingShare,
  traceRateMarks,
  type GenerationTrace,
} from '@cindy/maker-shared/usage-format';
import { formatCompactTokens } from '@/lib/usageFormat';
import { GenerationTraceChart } from './GenerationTraceChart';

/**
 * A finished turn's speed chart, as it looked while the turn ran, at the top of
 * its usage details, with one line that sums the turn up: how much of its
 * output was reasoning, and how many requests it took.
 */
export function TurnGenerationTrace({ trace }: { trace: GenerationTrace }) {
  const { t } = useTranslation();
  const marks = useMemo(() => traceRateMarks(trace), [trace]);
  const toMs = Math.max(trace.durationMs, marks.at(-1)?.durationMs ?? 0, trace.speed.at(-1)?.[0] ?? 0);
  const reported = marks.filter((mark) => mark.thinkingTokens !== null);
  const thinking = reported.reduce((sum, mark) => sum + (mark.thinkingTokens ?? 0), 0);
  // The share leads: it reads the same for a short turn and a long one. Without output to divide by, tokens alone.
  const share = formatThinkingShare(thinking, trace.reportedOutputTokens);
  const amount = share === null
    ? t('usageDetails.traceThinkingTokens', { thinking: formatCompactTokens(thinking) })
    : t('usageDetails.traceThinkingShare', { share });
  return (
    <div className="space-y-1.5" data-testid="turn-generation-trace">
      <GenerationTraceChart
        points={trace.speed.map(([at, rate]) => ({ at, rate }))}
        marks={marks}
        fromMs={0}
        toMs={toMs}
        width={288}
        speedHeight={48}
        strokeHeight={22}
        label={t('usageDetails.traceChartLabel')}
        className="w-full"
      />
      {/* Two facts that wrap as wholes: a long translation moves the count down a line, never half a phrase. */}
      <div className="flex flex-wrap justify-between gap-x-3 text-12 tabular-nums text-[var(--text-secondary)]">
        {reported.length > 0 && <span className="whitespace-nowrap" data-testid="turn-thinking-share">{amount}</span>}
        <span className="whitespace-nowrap">{t('usageDetails.traceRequests', { requests: trace.requests })}</span>
      </div>
    </div>
  );
}
