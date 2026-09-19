import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { cindyMakeState } from '@/lib/cindyMakeState';
import { formatCindyMakeTitle } from '@/lib/cindyMakeTitle';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type {
  MakeDoctorReport,
  CindyMakeGlobalState,
  CindyMakeTaskActionState,
} from '../../../shared/cindyMakeDoctor';
import { CindyMakeTaskCard } from './CindyMakeTaskCard';
import './cindyMakeTasks.css';

function statusOf(report: MakeDoctorReport, action?: CindyMakeTaskActionState): string {
  if (action?.status === 'running') return 'cleaning';
  if (action?.status === 'failed') return 'cleanupFailed';
  if (report.task?.sessionStatus === 'deleted' || report.task?.cleanupPending) return 'cleanup';
  if (report.task?.sessionStatus === 'archived') return report.task.integration ?? 'unknown';
  if (report.status === 'running') return 'preparing';
  if (report.status === 'failed') return 'failed';
  if (report.status === 'cancelled') return 'cancelled';
  return report.task?.executing ? 'running' : (report.task?.integration ?? 'unknown');
}

/** A bounded master/detail view: only the selected task mounts its preparation details. */
export function CindyMakeTasksPanel({
  reports,
  taskActions = {},
}: {
  reports: MakeDoctorReport[];
  taskActions?: CindyMakeGlobalState['taskActions'];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<{
    runId: string;
    action: 'open' | 'end';
  }>();
  const busy = useRef(false);
  const owner = getDataOwnerGeneration();
  const current = () => isDataOwnerGenerationCurrent(owner);
  const tasks = reports.filter((report) => report.task && !report.task.finished);
  const titleOf = (report: MakeDoctorReport) =>
    formatCindyMakeTitle(report.task?.title ?? t('cindyMake.code.taskName'), report.runId);
  const search = query.trim().toLocaleLowerCase();
  const visible = tasks.filter((report) =>
    [titleOf(report), report.task?.request].some((value) =>
      value?.toLocaleLowerCase().includes(search),
    ),
  );
  const selected = visible.find((report) => report.runId === selectedId) ?? visible[0];
  const taskAction = selected?.task ? taskActions[selected.task.sessionId] : undefined;
  const cleaning = taskAction?.status === 'running';
  const failureCode = taskAction?.status === 'failed' ? taskAction.error : undefined;
  const disabled = pending || cleaning;
  useEffect(() => {
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        await cindyMakeState.refresh();
      } catch {
        /* Keep the last known snapshot. */
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const open = async () => {
    if (!selected?.task || busy.current || cleaning || !current()) return;
    busy.current = true;
    setPending(true);
    setOperation({ runId: selected.runId, action: 'open' });
    try {
      const service = await import('@/lib/sessionService');
      if (!current()) return;
      let session = await service.get(selected.task.sessionId);
      if (!current() || session.status === 'deleted') throw new Error('unavailable');
      if (session.status === 'archived') {
        const restored = await service.restoreIfArchived(session.id, session);
        if (!current() || !restored) throw new Error('unavailable');
        session = restored;
      }
      const { sessionsStore } = await import('@/lib/sessionsStore');
      if (!current()) return;
      sessionsStore.prependCreated(session);
      navigate('/cc-agent/' + session.id);
    } catch {
      if (current()) toast.error(t('settings.cindyMake.tasks.errors.unavailable'));
    } finally {
      busy.current = false;
      setPending(false);
      setOperation(undefined);
    }
  };

  const manage = async () => {
    if (!selected?.task || busy.current || cleaning || !current()) return;
    busy.current = true;
    setPending(true);
    try {
      // Every deletion, including a retry, has the same explicit confirmation.
      // The base copy warns about unintegrated work even if the last cell snapshot is stale.
      const accepted = await confirm({
        title: t('settings.cindyMake.tasks.end'),
        description: [
          t(
            selected.task.sessionStatus === 'deleted'
              ? 'settings.cindyMake.tasks.cleanupDeletedConfirm'
              : 'settings.cindyMake.tasks.endConfirm',
            { title: titleOf(selected) },
          ),
          selected.task.integration !== 'integrated'
            ? t(
                selected.task.integration === 'unintegrated'
                  ? 'settings.cindyMake.tasks.endUnintegrated'
                  : 'settings.cindyMake.tasks.endUnknown',
              )
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        confirmText: t('settings.cindyMake.tasks.end'),
        cancelText: t('settings.cindyMake.create.cancel'),
        confirmVariant: 'destructive',
      });
      if (!accepted || !current()) return;
      setOperation({ runId: selected.runId, action: 'end' });
      await cindyMakeState.manageTask(selected.task.sessionId, 'end');
      if (current()) void cindyMakeState.refresh().catch(() => {});
    } catch (error) {
      if (!current()) return;
      const message = extractIpcError(error)?.message;
      const code = [
        'busy',
        'dirty',
        'conflict',
        'cleanupFailed',
        'unavailable',
        'directoryBusy',
      ].includes(message ?? '')
        ? message!
        : 'cleanupFailed';
      toast.error(t('settings.cindyMake.tasks.errors.' + code));
      await cindyMakeState.refresh().catch(() => {});
    } finally {
      busy.current = false;
      setPending(false);
      setOperation(undefined);
    }
  };

  return (
    <section
      aria-label={t('settings.cindyMake.tasks.title')}
      className="cindy-make-tasks rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-13 text-[var(--text-primary)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-default)] p-4">
        <h3 className="font-medium">
          {t('settings.cindyMake.tasks.title')} · {tasks.length}
        </h3>
        <Input
          size="sm"
          value={query}
          onChange={setQuery}
          aria-label={t('settings.cindyMake.tasks.search')}
          placeholder={t('settings.cindyMake.tasks.search')}
          className="cindy-make-tasks-search w-full"
        />
      </div>
      <div className="cindy-make-tasks-layout grid min-w-0">
        <ul
          aria-label={t('settings.cindyMake.tasks.title')}
          className="cindy-make-tasks-list max-h-60 space-y-1 overflow-y-auto overscroll-contain border-b border-[var(--border-default)] p-2"
        >
          {visible.map((report) => (
            <li key={report.runId}>
              <button
                type="button"
                aria-pressed={selected?.runId === report.runId}
                onClick={() => setSelectedId(report.runId)}
                className="flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-3 text-left hover:bg-[var(--surface-hover)] aria-pressed:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
              >
                <span className="line-clamp-2 break-words font-medium">{titleOf(report)}</span>
                <span className="text-12 text-[var(--text-secondary)]">
                  {t(
                    'settings.cindyMake.tasks.status.' +
                      statusOf(
                        report,
                        report.task ? taskActions[report.task.sessionId] : undefined,
                      ),
                  )}
                </span>
              </button>
            </li>
          ))}
          {!visible.length && (
            <li className="p-3 text-[var(--text-secondary)]">
              {t('settings.cindyMake.tasks.noResults')}
            </li>
          )}
        </ul>
        {selected?.task && (
          <div className="flex min-w-0 max-h-[420px] flex-col">
            <div className="shrink-0 p-4 pb-0">
              <h4 className="break-words font-medium">{titleOf(selected)}</h4>
              <p className="mt-1 text-12 text-[var(--text-secondary)]">
                {t('settings.cindyMake.tasks.status.' + statusOf(selected, taskAction))}
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
              <p className="whitespace-pre-wrap break-words">{selected.task.request}</p>
              {selected.status !== 'completed' && selected.task.sessionStatus !== 'deleted' && (
                <CindyMakeTaskCard
                  report={selected}
                  request={selected.task.request}
                  readOnly={selected.task.sessionStatus === 'archived'}
                />
              )}
              {selected.status === 'completed' && selected.task.sessionStatus !== 'deleted' && (
                <p className="text-12 text-[var(--text-secondary)]">
                  {t('settings.cindyMake.tasks.endHint')}
                </p>
              )}
            </div>
            <div className="shrink-0 space-y-3 border-t border-[var(--border-default)] p-4">
              {failureCode && (
                <p role="alert" className="text-12 text-[var(--error-fg)]">
                  {t('settings.cindyMake.tasks.errors.' + failureCode)}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {selected.task.sessionStatus !== 'deleted' && (
                  <Button
                    variant="secondary"
                    disabled={disabled}
                    loading={operation?.runId === selected.runId && operation.action === 'open'}
                    onClick={() => void open()}
                  >
                    {t(
                      selected.task.sessionStatus === 'archived'
                        ? 'settings.cindyMake.tasks.restore'
                        : 'cindyMake.code.open',
                    )}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={disabled}
                  loading={
                    cleaning || (operation?.runId === selected.runId && operation.action === 'end')
                  }
                  onClick={() => void manage()}
                >
                  {t(
                    selected.task.sessionStatus === 'deleted' ||
                      selected.task.cleanupPending ||
                      failureCode
                      ? 'settings.cindyMake.tasks.retryCleanup'
                      : 'settings.cindyMake.tasks.end',
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
