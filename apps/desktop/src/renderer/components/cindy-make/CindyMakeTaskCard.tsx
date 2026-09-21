import { useState } from 'react';
import { Check, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { CindyMakeDependencyProgress } from './CindyMakeDependencyProgress';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { formatCindyMakeTitle } from '@/lib/cindyMakeTitle';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import type { MakeDoctorReport } from '../../../shared/cindyMakeDoctor';

const phases = ['environment', 'source', 'workspace', 'dependencies', 'starting'] as const;

export function CindyMakeTaskCard({
  report,
  request,
  onOpenTask,
  readOnly = false,
  variant = 'default',
}: {
  report: MakeDoctorReport;
  request?: string;
  onOpenTask?: () => void;
  readOnly?: boolean;
  variant?: 'default' | 'composer';
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const task = report.task;
  if (!task) return null;
  const displayTitle = formatCindyMakeTitle(
    task.title ?? t('cindyMake.code.taskName'),
    report.runId,
  );
  const inComposer = variant === 'composer';
  const borderClass = inComposer
    ? 'border-[var(--chat-input-border)]'
    : 'border-[var(--border-default)]';
  const canOperate = () =>
    !readOnly &&
    !getStickySessionDeviceId(task.sessionId) &&
    !getStickySessionDeviceId(task.originSessionId);
  const interactive = canOperate();
  const running = report.status === 'running';
  const completed = report.status === 'completed';
  const failed = report.status === 'failed';
  const current =
    task.phase === 'completed' ? phases.length : phases.findIndex((phase) => phase === task.phase);
  const operate = async () => {
    if (pending || !canOperate()) return;
    setPending(true);
    try {
      if (running) {
        const result = await window.electronAPI.cancelCindyMakeTask(report.runId);
        if (!result.success) throw new Error('Preparation is already finishing');
      } else if (request) {
        await window.electronAPI.startCindyMakeTask({
          originSessionId: task.originSessionId,
          runId: report.runId,
          request,
          title: displayTitle,
        });
      }
    } catch {
      toast.error(t('cindyMake.code.failed'));
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      className={cn(
        'w-full rounded-xl border text-13 text-[var(--text-primary)]',
        borderClass,
        inComposer
          ? 'flex max-h-[min(420px,50vh)] flex-col overflow-hidden bg-[var(--chat-input-bg)]'
          : 'bg-[var(--surface-elevated)]',
      )}
      aria-label={t('cindyMake.code.taskName')}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        <span className="min-w-0 flex-1 break-words font-medium">{displayTitle}</span>
        {running && <Spinner size={14} />}
      </div>
      <div
        className={cn(
          'space-y-3 border-t px-4 py-3',
          borderClass,
          inComposer && 'min-h-0 overflow-y-auto overscroll-contain',
        )}
      >
        <ol className="space-y-2">
          {phases.map((phase, index) => (
            <li key={phase} className="flex items-center gap-2">
              {completed || index < current ? (
                <Check size={14} className="text-[var(--status-success)]" aria-hidden />
              ) : running && index === current ? (
                <Spinner size={14} />
              ) : (
                <Minus size={14} className="text-[var(--text-tertiary)]" aria-hidden />
              )}
              <span
                className={
                  index === current ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
                }
              >
                {t('cindyMake.code.phases.' + phase)}
              </span>
            </li>
          ))}
        </ol>
        <div
          role="status"
          aria-live="polite"
          className={failed ? 'text-[var(--error-fg)]' : 'text-[var(--text-secondary)]'}
        >
          {t(
            completed
              ? 'cindyMake.code.prepared'
              : failed
                ? 'cindyMake.code.preparationFailed'
                : !running
                  ? 'cindyMake.prepare.cancelled'
                  : 'cindyMake.code.phases.' + task.phase,
          )}
        </div>
        {(task.phase === 'dependencies' || task.dependencies) && (
          <CindyMakeDependencyProgress
            progress={task.dependencies}
            running={running && task.phase === 'dependencies'}
          />
        )}
        {task.phase === 'environment' &&
          report.checks.map((check) => (
            <p key={check.id} className="text-12 text-[var(--text-secondary)]">
              {t('cindyMakeDoctor.checks.' + check.id)} ·{' '}
              {t('cindyMakeDoctor.checkStatus.' + check.status)}
              {check.progress &&
                ' · ' +
                  t('cindyMake.prepare.downloadProgress', {
                    loaded: (check.progress.loaded / 1024 ** 2).toFixed(1),
                    total:
                      check.progress.total === null
                        ? '?'
                        : (check.progress.total / 1024 ** 2).toFixed(1),
                  })}
            </p>
          ))}
        {task.phase === 'source' && report.source?.phase && (
          <p className="text-12 text-[var(--text-secondary)]">
            {t('cindyMake.source.phase.' + report.source.phase)}
            {report.source.progress && ' · ' + report.source.progress.percent + '%'}
          </p>
        )}
        {report.source?.branch && (
          <p className="break-all text-12 text-[var(--text-tertiary)]">
            {t('cindyMake.code.workspace', { branch: report.source.branch })}
          </p>
        )}
        {failed && report.source?.error && (
          <p className="text-12 text-[var(--error-fg)]">
            {t('cindyMake.source.errors.' + report.source.error)}
          </p>
        )}
      </div>
      {interactive && onOpenTask && (
        <div className="flex shrink-0 justify-end px-4 pb-3">
          <Button variant="secondary" onClick={() => canOperate() && onOpenTask()}>
            {t('cindyMake.code.open')}
          </Button>
        </div>
      )}
      {interactive && !completed && task.phase !== 'starting' && (running || request) && (
        <div className={cn('flex shrink-0 justify-end border-t px-4 py-3', borderClass)}>
          <Button variant="secondary" disabled={pending} onClick={() => void operate()}>
            {t(running ? 'cindyMake.prepare.stop' : 'cindyMake.prepare.retry')}
          </Button>
        </div>
      )}
      {interactive && !running && task.phase === 'starting' && request && (
        <div className={cn('flex shrink-0 justify-end border-t px-4 py-3', borderClass)}>
          <Button variant="secondary" disabled={pending} onClick={() => void operate()}>
            {t('cindyMake.prepare.retry')}
          </Button>
        </div>
      )}
    </section>
  );
}
