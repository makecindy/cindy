import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip } from '@/components/ui/tooltip';
import { formatRunningTokenCount } from './lib/runningTokenUsage';
import {
  emptyRateHistory,
  recordRunningTokenRate,
  type RateHistory,
} from './lib/runningTokenRateHistory';

export function useRunningTokenRateHistory(input: {
  startedAt: number | null;
  outputTokens: number;
  generationDurationMs: number;
  generationReliable: boolean;
}) {
  const [history, setHistory] = useState<RateHistory>(() => emptyRateHistory(null));
  const { startedAt, outputTokens, generationDurationMs, generationReliable } = input;
  useEffect(() => {
    setHistory((previous) =>
      recordRunningTokenRate(previous, {
        startedAt,
        outputTokens,
        generationDurationMs,
        generationReliable,
      }),
    );
  }, [startedAt, outputTokens, generationDurationMs, generationReliable]);
  return history.startedAt === startedAt ? history : emptyRateHistory(startedAt);
}

export function RunningTokenRatePopover({
  rate,
  rateText,
  averageRate,
  outputTokens,
  history,
}: {
  rate: string | null;
  rateText: string;
  averageRate: string | null;
  outputTokens: number;
  history: RateHistory;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'idle' | 'hover' | 'pinned' | 'dismissed'>('idle');
  const open = mode === 'pinned';
  const samples = history.samples;
  const firstTime = samples[0]?.durationMs ?? 0;
  const span = (samples.at(-1)?.durationMs ?? 0) - firstTime;
  const ceiling = Math.max(1, ...samples.map((sample) => sample.rate));
  const points = samples.map((sample) => ({
    x: span > 0 ? 4 + ((sample.durationMs - firstTime) / span) * 132 : 136,
    y: 44 - (sample.rate / ceiling) * 36,
  }));
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
  const last = points.at(-1);
  const card = (
    <div
      aria-description={t('chat.runningStatus.tokenRateDescription')}
      className="grid grid-cols-[max-content_128px_minmax(0,1fr)] gap-x-4 gap-y-2 max-[460px]:grid-cols-[minmax(0,1fr)_128px]"
    >
      <div className="contents">
        <div className="col-start-1 row-start-1 min-w-0 self-center">
          <div className="mb-1 flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
            <Activity size={14} aria-hidden="true" />
            {t('chat.runningStatus.currentRate')}
          </div>
          <div className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-28 font-medium leading-none">{rate ?? '—'}</span>
            <span className="text-12 text-[var(--text-secondary)]">tok/s</span>
          </div>
        </div>
        <svg
          viewBox="0 0 140 48"
          className="col-start-2 row-start-1 h-12 w-32 self-center text-[var(--text-primary)]"
          role="img"
          aria-label={t('chat.runningStatus.rateHistory')}
        >
          <path d="M4 44H136" stroke="currentColor" opacity="0.12" />
          {points.length > 1 && (
            <>
              <path d={`${line} L136,44 L${points[0].x},44 Z`} fill="currentColor" opacity="0.08" />
              <path
                d={line}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </>
          )}
          {last && <circle cx={last.x} cy={last.y} r="2.5" fill="currentColor" />}
        </svg>
        <dl className="col-start-3 row-start-1 self-center space-y-1 text-12 tabular-nums max-[460px]:col-span-2 max-[460px]:col-start-1 max-[460px]:row-start-2 max-[460px]:justify-self-center">
          <div className="flex items-center gap-2">
            <dt className="text-[var(--text-secondary)]">{t('chat.runningStatus.averageRate')}</dt>
            <dd className="font-medium">
              {averageRate ? t('chat.runningStatus.tokenRate', { rate: averageRate }) : '—'}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-[var(--text-secondary)]">{t('chat.runningStatus.outputTotal')}</dt>
            <dd className="font-medium">
              {t('chat.runningStatus.tokenCount', {
                tokens: formatRunningTokenCount(outputTokens),
              })}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-[var(--text-secondary)]">{t('chat.runningStatus.observedPeak')}</dt>
            <dd className="font-medium">
              {history.peak > 0
                ? t('chat.runningStatus.tokenRate', { rate: history.peak.toFixed(1) })
                : '—'}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
  const surface =
    'w-[440px] max-w-[calc(100vw-32px)] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-[var(--text-primary)] shadow-[var(--shadow-menu)]';
  return (
    <Popover open={open} onOpenChange={(next) => setMode(next ? 'pinned' : 'dismissed')}>
      <Tooltip.Provider>
        <Tooltip.Root
          open={mode === 'hover'}
          onOpenChange={(next) =>
            setMode((current) =>
              current === 'pinned' || current === 'dismissed' ? current : next ? 'hover' : 'idle',
            )
          }
        >
          <PopoverTrigger asChild>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                onPointerEnter={() =>
                  setMode((current) => (current === 'dismissed' ? 'idle' : current))
                }
                onBlur={() => setMode((current) => (current === 'dismissed' ? 'idle' : current))}
                className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-1 text-13 font-medium tabular-nums text-[var(--status-bar-meta)] hover:bg-[var(--button-secondary-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-secondary)]"
                aria-label={`${t('chat.runningStatus.currentRate')}: ${rateText}`}
              >
                {rateText}
              </button>
            </Tooltip.Trigger>
          </PopoverTrigger>
          <Tooltip.Content side="top" className={`${surface} break-normal`}>
            {card}
          </Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className={surface}
        aria-label={t('chat.runningStatus.rateHistory')}
      >
        {card}
      </PopoverContent>
    </Popover>
  );
}
