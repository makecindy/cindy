import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import type { PluginUsageSummary } from '../../../shared/pluginUsage';

export function PluginUsageCard({
  ghostId,
  confirmClear,
}: {
  ghostId: string;
  confirmClear?: () => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const [summary, setSummary] = useState<PluginUsageSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(clearing);
  clearingRef.current = clearing;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const load = useCallback(async () => {
    const next = await window.electronAPI.ghosts.usageSummary(ghostId);
    if (!next) throw new Error('Usage unavailable');
    return next;
  }, [ghostId]);
  useEffect(() => {
    let live = true;
    let inFlight = false;
    setSummary(null);
    setState('loading');
    const read = async () => {
      if (!live || inFlight) return;
      inFlight = true;
      try {
        const value = await load();
        if (live) {
          setSummary(value);
          setState('ready');
        }
      } catch {
        if (live) {
          setSummary(null);
          setState('failed');
        }
      } finally {
        inFlight = false;
      }
    };
    const readWhenVisible = () => {
      if (document.visibilityState === 'visible' && !clearingRef.current) void read();
    };
    void read();
    const timer = window.setInterval(readWhenVisible, 5_000);
    document.addEventListener('visibilitychange', readWhenVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', readWhenVisible);
    };
  }, [load, refreshVersion]);
  const refresh = () => setRefreshVersion((value) => value + 1);
  const clear = async () => {
    if (!summary || clearing || !confirmClear) return;
    setClearing(true);
    try {
      if (!(await confirmClear())) return;
      await window.electronAPI.ghosts.clearUsage(summary.subjectId);
      refresh();
    } catch {
      setSummary(null);
      setState('failed');
    } finally {
      setClearing(false);
    }
  };
  const time = (value: number) =>
    new Date(value).toLocaleString(i18n.language, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...(new Date(value).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
    });
  return (
    <section
      className="mt-6 min-w-0 w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4"
      aria-labelledby={titleId}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="min-w-0 text-14 font-medium leading-[var(--text-sm-line-height)] text-[var(--text-primary)]">
          <Tip text={t('settings.ghosts.usage.explanation')}>
            <button
              type="button"
              aria-label={`${t('settings.ghosts.usage.title')} · ${t('settings.ghosts.usage.explanationLabel')}`}
              className="-ml-2 min-h-7 rounded-full px-2 hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              {t('settings.ghosts.usage.title')}
            </button>
          </Tip>
        </h2>
        {confirmClear ? (
          <Button
            variant="secondary"
            tone="quiet"
            size="sm"
            compact
            type="button"
            disabled={!summary || state !== 'ready' || clearing}
            loading={clearing}
            onClick={() => void clear()}
            aria-label={t('settings.ghosts.usage.clear')}
            className="shrink-0"
          >
            {t('settings.ghosts.usage.clearAction')}
          </Button>
        ) : null}
      </div>
      {state === 'loading' ? (
        <p aria-live="polite" className="mt-3 text-14 leading-[var(--text-sm-line-height)] text-[var(--text-secondary)]">
          {t('settings.ghosts.usage.loading')}
        </p>
      ) : state === 'failed' ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="min-w-0 text-14 leading-[var(--text-sm-line-height)] text-[var(--text-secondary)]">
            {t('settings.ghosts.usage.unavailable')}
          </p>
          <Button variant="secondary" tone="quiet" size="sm" onClick={() => void refresh()}>
            {t('settings.ghosts.usage.retry')}
          </Button>
        </div>
      ) : summary ? (
        <dl className="mt-3 grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4">
          <div className="min-w-0">
            <dt className="text-12 leading-[var(--text-xs-line-height)] text-[var(--text-secondary)]">
              {t('settings.ghosts.usage.lastUsed')}
            </dt>
            <dd className="mt-1 break-words text-14 font-normal leading-[var(--text-sm-line-height)] tabular-nums text-[var(--text-primary)]">
              {summary.lastUsedAt === null
                ? t('settings.ghosts.usage.never')
                : time(summary.lastUsedAt)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-12 leading-[var(--text-xs-line-height)] text-[var(--text-secondary)]">
              {t('settings.ghosts.usage.last7Days')}
            </dt>
            <dd className="mt-1 break-words text-14 font-normal leading-[var(--text-sm-line-height)] tabular-nums text-[var(--text-primary)]">
              {summary.callsLast7Days.toLocaleString(i18n.language)}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
