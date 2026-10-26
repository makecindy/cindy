/**
 * 伙伴设置「例行任务 → 夜间学习」：开关、频率、待整理与现在整理、按次分组的整理记录（逐条撤销 / 恢复）、
 * 观察中的做法。状态正本在主进程，这里只读投影并调用固定 IPC。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Brain, ChevronDown, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_DIVIDER_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from '@/components/settings/settingsRowClasses';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type {
  NightlyLearningFrequency,
  NightlyLearningItem,
  NightlyLearningRun,
  NightlyLearningView,
} from '../../../shared/botNightlyLearning';

const ACTION_BUTTON_CLASS =
  'shrink-0 rounded-full px-2 min-h-6 text-12 text-[var(--text-secondary)] outline-none transition-colors duration-[var(--motion-instant)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40';

/** `enabled: false` (a teammate on another computer) reads nothing: the review lives on that computer. */
export function useNightlyLearningView(botId: string, enabled = true) {
  const [view, setView] = useState<NightlyLearningView | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    const owner = getDataOwnerGeneration();
    try {
      const next = await window.electronAPI.routines.nightlyLearning.get(botId);
      if (isDataOwnerGenerationCurrent(owner)) setView(next);
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) setView(null);
    }
  }, [botId, enabled]);
  useEffect(() => {
    if (!enabled) return undefined;
    void load();
    return window.electronAPI.routines.onChanged(() => void load());
  }, [enabled, load]);
  return { view, setView, reload: load };
}

function itemText(t: ReturnType<typeof useTranslation>['t'], item: NightlyLearningItem): string {
  const values = { title: item.title, into: item.mergedInto ?? '' };
  if (item.kind === 'memory') {
    if (item.action === 'created') return t('routines.nightly.item.memoryCreated', values);
    if (item.action === 'updated') return t('routines.nightly.item.memoryUpdated', values);
    return t(item.mergedInto ? 'routines.nightly.item.memoryMerged' : 'routines.nightly.item.memoryDeleted', values);
  }
  if (item.action === 'created') return t('routines.nightly.item.skillCreated', values);
  if (item.action === 'updated') return t('routines.nightly.item.skillUpdated', values);
  return t(item.mergedInto ? 'routines.nightly.item.skillMerged' : 'routines.nightly.item.skillDisabled', values);
}

export function BotNightlyLearning({ botId }: { botId: string }) {
  const { t, i18n } = useTranslation();
  const { view, setView } = useNightlyLearningView(botId);
  const [busy, setBusy] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);

  const act = async (operation: () => Promise<NightlyLearningView>) => {
    if (busy) return;
    setBusy(true);
    const owner = getDataOwnerGeneration();
    try {
      const next = await operation();
      if (isDataOwnerGenerationCurrent(owner)) setView(next);
    } catch (error) {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      toast.error(t(extractIpcError(error)?.code === 'PRECONDITION_FAILED' ? 'routines.nightly.changedSince' : 'routines.nightly.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (!view) return <Spinner size={18} />;
  const api = window.electronAPI.routines.nightlyLearning;
  const when = (at: number) => new Intl.DateTimeFormat(i18n.language, {
    month: 'short', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit',
  }).format(at);
  const pendingHint = view.running
    ? t('routines.nightly.running')
    : view.pendingTurns > 0
      ? t('routines.nightly.pendingTurns', { count: view.pendingTurns })
      : t('routines.nightly.pendingNone');
  const frequencyOptions = [
    { value: 'daily' as const, label: t('routines.nightly.daily') },
    { value: 'weekly' as const, label: t('routines.nightly.weekly') },
  ];
  const runMeta = (run: NightlyLearningRun) => (run.manual && run.turns === 0
    ? t('routines.nightly.manual')
    : t('routines.nightly.readTurns', { count: run.turns }));

  return (
    <div className="space-y-3">
      {view.enabled === null ? (
        <div className={SETTINGS_CARD_CLASS}>
          <p className={cn(SETTINGS_ROW_CLASS, SETTINGS_ROW_HINT_CLASS)}>{t('routines.nightly.notHere')}</p>
        </div>
      ) : (
        <div className={SETTINGS_CARD_CLASS}>
          <div className={SETTINGS_ROW_CLASS}>
            <div className="min-w-0">
              <p className={SETTINGS_ROW_LABEL_CLASS}>{t('routines.nightly.switchLabel')}</p>
              <p className={cn(SETTINGS_ROW_HINT_CLASS, 'mt-0.5')}>
                {view.memoryEnabled ? t('routines.nightly.switchHint') : t('routines.nightly.memoryOff')}
              </p>
            </div>
            <Switch
              aria-label={t('routines.nightly.switchLabel')}
              checked={view.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => void act(() => api.setEnabled(botId, enabled === true))}
            />
          </div>
          <div className={SETTINGS_ROW_DIVIDER_CLASS} />
          <div className={cn(SETTINGS_ROW_CLASS, 'flex-wrap')}>
            <div className="min-w-0">
              <p className={SETTINGS_ROW_LABEL_CLASS}>{t('routines.nightly.frequency')}</p>
              <p className={cn(SETTINGS_ROW_HINT_CLASS, 'mt-0.5')}>
                {t(view.frequency === 'weekly' ? 'routines.nightly.weeklyHint' : 'routines.nightly.dailyHint')}
              </p>
            </div>
            <SegmentedControl<NightlyLearningFrequency>
              aria-label={t('routines.nightly.frequency')}
              value={view.frequency}
              options={frequencyOptions}
              disabled={busy}
              onValueChange={(frequency) => void act(() => api.setFrequency(botId, frequency))}
            />
          </div>
          <div className={SETTINGS_ROW_DIVIDER_CLASS} />
          <div className={SETTINGS_ROW_CLASS}>
            <div className="min-w-0">
              <p className={SETTINGS_ROW_LABEL_CLASS}>{t('routines.nightly.pending')}</p>
              <p className={cn(SETTINGS_ROW_HINT_CLASS, 'mt-0.5 tabular-nums')}>{pendingHint}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              loading={view.running}
              onClick={() => void act(() => api.runNow(botId))}
            >
              {t('routines.nightly.runNow')}
            </Button>
          </div>
        </div>
      )}

      <h3 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'pt-4')}>{t('routines.nightly.history')}</h3>
      <div className={SETTINGS_CARD_CLASS}>
        {view.runs.length === 0 ? (
          <p className={cn(SETTINGS_ROW_CLASS, SETTINGS_ROW_HINT_CLASS)}>{t('routines.nightly.empty')}</p>
        ) : view.runs.map((run, index) => (
          <div key={run.id} className={cn('py-1', index > 0 && 'border-t border-[var(--settings-theme-card-border)]')}>
            {run.items.length > 0 ? (
              <>
                <div className="flex items-baseline justify-between gap-3 px-4 pb-1 pt-3">
                  <span className="whitespace-nowrap text-13 font-medium tabular-nums text-[var(--text-primary)]">{when(run.at)}</span>
                  <span className="text-right text-12 tabular-nums text-[var(--text-tertiary)]">{runMeta(run)}</span>
                </div>
                {run.items.map((item) => (
                  <div key={item.id} className="flex items-start gap-2.5 px-4 py-2">
                    <span className="mt-0.5 text-[var(--text-secondary)]" aria-hidden="true">
                      {item.kind === 'skill' ? <BookOpen size={14} /> : <Brain size={14} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-13 leading-5', item.undone
                        ? 'text-[var(--text-tertiary)] line-through decoration-[var(--text-placeholder)]'
                        : 'text-[var(--text-primary)]')}>
                        {itemText(t, item)}
                      </p>
                      <p className={cn('mt-px text-12 leading-[1.5]', item.undone ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]')}>
                        {item.undone ? t('routines.nightly.undone') : item.reason}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={ACTION_BUTTON_CLASS}
                      disabled={busy}
                      onClick={() => void act(() => api.revert(botId, run.id, item.id, !!item.undone))}
                    >
                      {t(item.undone ? 'routines.nightly.redo' : 'routines.nightly.undo')}
                    </button>
                  </div>
                ))}
                <div className="h-2" />
              </>
            ) : (
              <div className="flex items-baseline justify-between gap-3 px-4 py-3">
                <span className="whitespace-nowrap text-13 tabular-nums text-[var(--text-secondary)]">{when(run.at)}</span>
                <span className="text-right text-12 text-[var(--text-tertiary)]">
                  {run.outcome === 'failed' ? t('routines.nightly.lastFailed') : `${runMeta(run)} · ${t('routines.nightly.nothing')}`}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {view.candidates.length > 0 ? (
        <div className={SETTINGS_CARD_CLASS}>
          <button
            type="button"
            aria-expanded={watchOpen}
            className="flex w-full items-center gap-1.5 rounded-xl px-4 py-3.5 text-left text-13 font-medium text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            onClick={() => setWatchOpen((open) => !open)}
          >
            <Eye size={14} className="text-[var(--text-secondary)]" aria-hidden="true" />
            <span>{t('routines.nightly.watching')}</span>
            <span className="font-normal tabular-nums text-[var(--text-tertiary)]">{view.candidates.length}</span>
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={cn('ml-auto text-[var(--text-tertiary)] transition-transform duration-[var(--motion-base)]', watchOpen && 'rotate-180')}
            />
          </button>
          <div className={cn('grid transition-[grid-template-rows] duration-[var(--motion-base)]', watchOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
            <div className="overflow-hidden">
              <p className="px-4 pb-2 text-12 leading-[1.5] text-[var(--text-secondary)]">{t('routines.nightly.watchingHint')}</p>
              {view.candidates.map((candidate) => (
                <div key={candidate.id} className="flex items-start gap-2.5 px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-13 leading-5 text-[var(--text-primary)]">{candidate.title}</p>
                    <p className="mt-px text-12 leading-[1.5] text-[var(--text-secondary)]">{candidate.summary}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-0.5">
                    <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                      onClick={() => void act(() => api.candidate(botId, candidate.id, 'promote'))}>
                      {t('routines.nightly.promote')}
                    </button>
                    <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                      onClick={() => void act(() => api.candidate(botId, candidate.id, 'decline'))}>
                      {t('routines.nightly.decline')}
                    </button>
                  </div>
                </div>
              ))}
              <div className="h-2" />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
