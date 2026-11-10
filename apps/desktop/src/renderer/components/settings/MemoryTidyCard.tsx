/**
 * MemoryTidyCard — 「查看记忆」子页里一份记忆的整理：「现在整理」与整理记录
 * （docs/product-rules/cindy-memory.md §3）。
 *
 * 整理把这一份里重复和互相矛盾的记忆合并。它平时在记忆变多后由宿主自己做，这里是手动入口和
 * 每次整理的记录；记录可以撤销。一次整理是一次辅助模型调用，可能要一两分钟：状态放在
 * `useMemoryTidy`（由子页持有），进详情、换范围都不打断它，也不挡住列表。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { useDateLabels } from '@/components/memory/MemoryEntriesView';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type {
  MakerMemoryScopeSummary,
  MakerMemoryTidyChange,
  MakerMemoryTidyRun,
} from '../../../shared/makerMemoryEntries';

const api = () => window.electronAPI.maker.memoryEntries;

/** 整理可能要一两分钟，结果出来时人多半在看别处；带两个数字的撤销结果也要读得完。 */
const RESULT_TOAST_MS = 5000;

const CHEVRON_MOTION =
  'transition-transform duration-[var(--motion-base)] ease-[var(--motion-ease-move)] motion-reduce:duration-0';
const ROW_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]';

const toggled = (set: ReadonlySet<string>, key: string, on = !set.has(key)) => {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
};

/**
 * 一个范围的整理状态。`onChanged` 在一次整理或撤销结束后调用（条数可能变了）；`revision`
 * 随之加一，交给 `MemoryEntriesView` 重新读取列表和正在看的那条记忆。
 */
export function useMemoryTidy(scopeKey: string | null, onChanged: () => void) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [runs, setRuns] = useState<MakerMemoryTidyRun[]>([]);
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const [undoing, setUndoing] = useState<string | null>(null);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());
  const [revision, setRevision] = useState(0);
  const selected = useRef(scopeKey);
  selected.current = scopeKey;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  // 同步判重：连点两下不发两次请求。
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadRuns = useCallback(async (key: string) => {
    // 读不到（这份记忆刚被删空、账号已切换）就保持现状：记录只是辅助信息，不为它报错。
    const next = await api()
      .tidyRuns(key)
      .catch(() => null);
    if (next && mounted.current && selected.current === key) setRuns(next);
  }, []);
  useEffect(() => {
    setRuns([]);
    setRecordsOpen(false);
    setOpenRuns(new Set());
    if (scopeKey) void loadRuns(scopeKey);
  }, [scopeKey, loadRuns]);

  const settle = useCallback(
    (key: string) => {
      // 子页已关：结果的提示照常给，页面不用再刷新。
      if (!mounted.current) return;
      changed.current();
      if (selected.current !== key) return;
      setRevision((value) => value + 1);
      void loadRuns(key);
    },
    [loadRuns],
  );

  const tidy = useCallback(
    async (key: string) => {
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setRunning((current) => toggled(current, key, true));
      try {
        const result = await api().tidy(key);
        if (result.status === 'done') {
          if (result.run) {
            toast.success(t('settings.memory.entries.tidy.merged', { count: result.run.count }), {
              duration: RESULT_TOAST_MS,
            });
          } else {
            toast.info(t('settings.memory.entries.tidy.nothing'), { duration: RESULT_TOAST_MS });
          }
        } else if (result.status === 'busy') {
          toast.info(t('settings.memory.entries.tidy.busy'));
        } else {
          toast.error(
            t(
              result.status === 'unavailable'
                ? 'settings.memory.entries.tidy.unavailable'
                : 'settings.memory.entries.tidy.failed',
            ),
          );
        }
      } catch {
        toast.error(t('settings.memory.entries.tidy.failed'));
      } finally {
        inFlight.current.delete(key);
        setRunning((current) => toggled(current, key, false));
        settle(key);
      }
    },
    [settle, t],
  );

  const undo = useCallback(
    async (key: string, run: MakerMemoryTidyRun) => {
      const ok = await confirm({
        presentation: 'standard',
        title: t('settings.memory.entries.tidy.undoConfirm.heading'),
        description: t('settings.memory.entries.tidy.undoConfirm.body', { count: run.count }),
        confirmText: t('settings.memory.entries.tidy.undoConfirm.confirm'),
        cancelText: t('settings.memory.entries.tidy.undoConfirm.cancel'),
      });
      if (!ok) return;
      setUndoing(run.id);
      try {
        const { restored, skipped } = await api().tidyUndo({ scopeKey: key, runId: run.id });
        if (skipped > 0) {
          toast.success(
            t('settings.memory.entries.tidy.restoredSkipped', { restored, count: skipped }),
            { duration: RESULT_TOAST_MS },
          );
        } else {
          toast.success(t('settings.memory.entries.tidy.restored', { count: restored }));
        }
      } catch {
        toast.error(t('settings.memory.entries.tidy.undoFailed'));
      } finally {
        setUndoing(null);
        settle(key);
      }
    },
    [confirm, settle, t],
  );

  return {
    runs,
    running,
    undoing,
    revision,
    recordsOpen,
    openRuns,
    tidy,
    undo,
    toggleRecords: useCallback(() => setRecordsOpen((open) => !open), []),
    toggleRun: useCallback((id: string) => setOpenRuns((current) => toggled(current, id)), []),
  };
}

export type MemoryTidy = ReturnType<typeof useMemoryTidy>;

export function MemoryTidyCard({
  scope,
  enabled,
  tidy,
}: {
  scope: MakerMemoryScopeSummary;
  /** Cindy 记忆的总开关：关着不能整理，记录仍可看、可撤销。 */
  enabled: boolean;
  tidy: MemoryTidy;
}) {
  const { t, i18n } = useTranslation();
  const { stamp } = useDateLabels();
  const recordsId = useId();
  const key = scope.scopeKey;
  const running = tidy.running.has(key);
  const blocked = !enabled
    ? t('settings.memory.entries.tidy.offReason')
    : scope.count < 2
      ? t('settings.memory.entries.tidy.tooFewReason')
      : null;

  const language = i18n?.language;
  const describe = useMemo(() => {
    const list = new Intl.ListFormat(language, { style: 'long', type: 'conjunction' });
    const quoted = (title: string) => t('settings.memory.entries.tidy.quoted', { title });
    return (change: MakerMemoryTidyChange) =>
      change.kind === 'merged'
        ? t('settings.memory.entries.tidy.mergedInto', {
            sources: list.format(change.mergedTitles.map(quoted)),
            title: quoted(change.title),
          })
        : t('settings.memory.entries.tidy.removed', { title: quoted(change.title) });
  }, [language, t]);

  return (
    <SettingsCard>
      <SettingsRow
        title={t('settings.memory.entries.tidy.name')}
        hint={t('settings.memory.entries.tidy.about')}
        trailing={
          <Tip text={running ? null : blocked}>
            {/* 不可用时仍能聚焦，键盘和读屏用户才读得到原因；所以用 aria-disabled，不用 disabled。 */}
            <Button
              data-settings-search-action="Tidy the saved memories of the selected scope now"
              variant="secondary"
              size="sm"
              className={cn('aria-disabled:cursor-default', blocked && !running && 'opacity-60')}
              aria-disabled={running || blocked ? true : undefined}
              aria-busy={running || undefined}
              onClick={() => {
                if (!running && !blocked) void tidy.tidy(key);
              }}
            >
              {running ? (
                <>
                  <Spinner size={12} />
                  {t('settings.memory.entries.tidy.running')}
                </>
              ) : (
                t('settings.memory.entries.tidy.run')
              )}
            </Button>
          </Tip>
        }
      />
      {tidy.runs.length ? (
        <>
          <SettingsRow
            title={t('settings.memory.entries.tidy.records')}
            aria-expanded={tidy.recordsOpen}
            aria-controls={tidy.recordsOpen ? recordsId : undefined}
            onClick={tidy.toggleRecords}
            trailing={
              <span className="flex shrink-0 items-center gap-1.5 text-13 tabular-nums text-[var(--text-secondary)]">
                {tidy.runs.length}
                <ChevronDown
                  size={14}
                  aria-hidden
                  className={cn(
                    'text-[var(--text-tertiary)]',
                    CHEVRON_MOTION,
                    tidy.recordsOpen && 'rotate-180',
                  )}
                />
              </span>
            }
          />
          <Collapse open={tidy.recordsOpen}>
            <ul id={recordsId} aria-label={t('settings.memory.entries.tidy.records')}>
              {tidy.runs.map((run) => {
                const open = tidy.openRuns.has(run.id);
                const when = stamp(run.at);
                return (
                  <li
                    key={run.id}
                    className="relative before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-[var(--settings-theme-card-border)]"
                  >
                    <div className="flex items-center transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-hover)]">
                      <button
                        data-settings-search-action="Show or hide what one memory tidy-up changed"
                        type="button"
                        aria-expanded={open}
                        onClick={() => tidy.toggleRun(run.id)}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2 py-3 pl-4 pr-3 text-left',
                          ROW_FOCUS,
                        )}
                      >
                        <ChevronRight
                          size={14}
                          aria-hidden
                          className={cn(
                            'shrink-0 text-[var(--text-tertiary)]',
                            CHEVRON_MOTION,
                            open && 'rotate-90',
                          )}
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="text-13 font-medium leading-[1.5] tabular-nums text-[var(--settings-section-sublabel)]">
                            {when}
                          </span>
                          <span className="text-12 leading-[1.4] text-[var(--text-secondary)]">
                            {t(
                              run.trigger === 'auto'
                                ? 'settings.memory.entries.tidy.auto'
                                : 'settings.memory.entries.tidy.manual',
                            )}
                            {' · '}
                            {t('settings.memory.entries.tidy.touched', { count: run.count })}
                          </span>
                        </span>
                      </button>
                      <span className="flex shrink-0 items-center pr-4">
                        {run.undone ? (
                          <span className="px-3 text-12 text-[var(--text-tertiary)]">
                            {t('settings.memory.entries.tidy.undone')}
                          </span>
                        ) : (
                          <Button
                            data-settings-search-action="Undo one memory tidy-up and restore the memories it changed"
                            variant="secondary"
                            size="sm"
                            compact
                            aria-label={t('settings.memory.entries.tidy.undoAria', { time: when })}
                            disabled={running || (tidy.undoing !== null && tidy.undoing !== run.id)}
                            loading={tidy.undoing === run.id}
                            onClick={() => void tidy.undo(key, run)}
                          >
                            {t('settings.memory.entries.tidy.undo')}
                          </Button>
                        )}
                      </span>
                    </div>
                    <Collapse open={open}>
                      <ul className="flex flex-col gap-2.5 pb-3.5 pl-[38px] pr-4 pt-0.5">
                        {run.changes.map((change, index) => (
                          <li
                            key={index}
                            className="text-12 leading-[1.5] [overflow-wrap:anywhere]"
                          >
                            <p className="text-[var(--text-primary)]">{describe(change)}</p>
                            {change.reason ? (
                              <p className="mt-0.5 text-[var(--text-secondary)]">{change.reason}</p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </Collapse>
                  </li>
                );
              })}
            </ul>
          </Collapse>
        </>
      ) : null}
    </SettingsCard>
  );
}
