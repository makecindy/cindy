import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, Plus, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { MakeDoctorReportCard } from '@/components/chat/CindyMakeDoctorCard';
import { CindyMakeSourceDetails } from '@/components/cindy-make/CindyMakeSourceDetails';
import { CindyMakeCreateDialog } from '@/components/cindy-make/CindyMakeCreateDialog';
import { CindyMakeDependencyProgress } from '@/components/cindy-make/CindyMakeDependencyProgress';
import { CindyMakeTasksPanel } from '@/components/cindy-make/CindyMakeTasksPanel';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import { cancelMakeDoctor, startMakeDoctor } from '@/lib/cindyMakeDoctor';
import { useCindyMakeSettings } from '@/lib/cindyMakeSettings';
import { toast } from '@/lib/toast';
import type { MakeDoctorReport, MakeSourceStatus } from '../../../shared/cindyMakeDoctor';

export function CindyMakeSection() {
  const { t } = useTranslation();
  const { forceManagedTools, setForceManagedTools } = useCindyMakeSettings();
  const [createOpen, setCreateOpen] = useState(false);
  const [report, setReport] = useState<MakeDoctorReport>();
  const makeState = useCindyMakeState();
  const [dismissedPreparationId, setDismissedPreparationId] = useState<string>();
  const [trackedPreparationId, setTrackedPreparationId] = useState<string>();
  const [checkVersion, setCheckVersion] = useState(0);
  const [runMode, setRunMode] = useState<'check' | 'prepare'>('check');
  const [runVersion, setRunVersion] = useState(0);
  const [sourceRun, setSourceRun] = useState<{
    makeAction: 'prepare-source' | 'clear-source';
    forceManagedTools: boolean;
  }>();
  const sourceStatus = makeState.source;
  const [sourceRunPending, setSourceRunPending] = useState(false);
  const { confirm } = useConfirmDialog();
  useEffect(() => {
    void window.electronAPI.getCindyMakeSourceStatus?.().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (sourceStatus?.status !== 'preparing') setSourceRunPending(false);
  }, [sourceStatus]);
  useEffect(() => {
    if (!sourceRun) return;
    const controller = new AbortController();
    startMakeDoctor(
      (sourceReport) => {
        // Progress arrives through the global broadcast. This callback only
        // catches a start that never reached Main (e.g. the IPC itself failed).
        if (sourceReport.status === 'running' || sourceReport.source) return;
        setSourceRunPending(false);
        toast.error(t('cindyMakeDoctor.failed'));
      },
      undefined,
      'cindy-make',
      { ...sourceRun, signal: controller.signal },
    );
    return () => controller.abort();
  }, [sourceRun]);
  useEffect(() => {
    const controller = new AbortController();
    startMakeDoctor(
      setReport,
      undefined,
      runMode === 'check' ? 'cindy-make-doctor' : 'cindy-make',
      {
        forceManagedTools,
        signal: controller.signal,
      },
    );
    return () => controller.abort();
  }, [forceManagedTools, checkVersion, runMode, runVersion]);
  const sourceBusy = sourceRunPending || sourceStatus?.status === 'preparing';
  const preparation = makeState.environmentPrepare;
  const check = makeState.environmentCheck;
  useEffect(() => {
    if (
      preparation?.active &&
      (preparation.report.forceManagedTools === true) === forceManagedTools &&
      preparation.report.runId !== dismissedPreparationId
    )
      setTrackedPreparationId(preparation.report.runId);
  }, [
    preparation?.active,
    preparation?.report.runId,
    preparation?.report.forceManagedTools,
    forceManagedTools,
    dismissedPreparationId,
  ]);
  const displayReport =
    preparation &&
    (preparation.active || preparation.report.runId === trackedPreparationId) &&
    (preparation.report.forceManagedTools === true) === forceManagedTools &&
    preparation.report.runId !== dismissedPreparationId
      ? preparation.report
      : check && (check.report.forceManagedTools === true) === forceManagedTools
        ? check.report
        : report;

  return (
    <div className="flex flex-col gap-[18px]">
      <div>
        <h2 className="flex items-center gap-2 text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          <Wrench size={17} aria-hidden="true" />
          {t('settings.cindyMake.title')}
        </h2>
        <p className="mt-2 text-13 leading-[1.45] text-[var(--settings-section-desc)]">
          {t('settings.cindyMake.description')}
        </p>
        <Button className="mt-3" onClick={() => setCreateOpen(true)}>
          <Plus size={14} aria-hidden="true" />
          {t('settings.cindyMake.create.title')}
        </Button>
      </div>
      {createOpen && <CindyMakeCreateDialog onOpenChange={setCreateOpen} />}

      {import.meta.env.DEV && (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                {t('settings.cindyMake.forceManaged.title')}
              </p>
              <p className="mt-1 text-12 leading-[1.45] text-[var(--settings-section-desc)]">
                {t('settings.cindyMake.forceManaged.description')}
              </p>
            </div>
            <Switch
              checked={forceManagedTools}
              onCheckedChange={(checked) => {
                // Toggling the developer switch is a diagnostic recheck. Never
                // let it restart an in-progress preparation run implicitly.
                setRunMode('check');
                setTrackedPreparationId(undefined);
                setForceManagedTools(checked);
              }}
              aria-label={t('settings.cindyMake.forceManaged.ariaLabel')}
            />
          </div>
          {forceManagedTools ? (
            <div className="space-y-2">
              <p className="text-12 leading-[1.45] text-[var(--settings-section-desc)]">
                {t('settings.cindyMake.forceManaged.enabledHint')}
              </p>
            </div>
          ) : null}
        </div>
      )}

      {displayReport ? (
        <MakeDoctorReportCard
          report={displayReport}
          showSource={false}
          showSteps={false}
          alwaysAllowRecheck
          onPrepare={() => {
            setDismissedPreparationId(undefined);
            setRunMode('prepare');
            setRunVersion((version) => version + 1);
          }}
          onOpenToolsDir={() => {
            void window.electronAPI
              .openCindyMakeToolsDir()
              .then((result) => {
                if (!result.success) toast.error(t('cindyMakeDoctor.failed'));
              })
              .catch(() => toast.error(t('cindyMakeDoctor.failed')));
          }}
          onStop={() => {
            void cancelMakeDoctor(displayReport.runId, displayReport.mode).catch(() =>
              toast.error(t('cindyMakeDoctor.failed')),
            );
          }}
          onRecheck={() => {
            setDismissedPreparationId(preparation?.report.runId);
            setTrackedPreparationId(undefined);
            setRunMode('check');
            setCheckVersion((version) => version + 1);
          }}
        />
      ) : (
        <div className="flex items-center gap-2 text-13 text-[var(--settings-section-desc)]">
          <Spinner size={15} />
          {t('settings.cindyMake.checking')}
        </div>
      )}
      {sourceStatus && (
        <CindyMakeSourceStatusCard
          status={sourceStatus}
          preparing={sourceBusy}
          onPrepare={() => {
            if (sourceBusy) return;
            setSourceRunPending(true);
            setSourceRun({ makeAction: 'prepare-source', forceManagedTools });
          }}
          onStop={() => {
            void Promise.resolve(window.electronAPI.cancelCindyMakeSource?.())
              .then((result) => {
                if (result && !result.success) setSourceRunPending(false);
              })
              .catch(() => toast.error(t('cindyMakeDoctor.failed')));
          }}
          onClear={async () => {
            if (sourceBusy) return;
            const confirmed = await confirm({
              title: t('settings.cindyMake.source.resetConfirm.title'),
              description: t('settings.cindyMake.source.resetConfirm.description'),
              confirmText: t('settings.cindyMake.source.resetConfirm.confirm'),
              cancelText: t('settings.cindyMake.source.resetConfirm.cancel'),
              confirmVariant: 'destructive',
            });
            if (!confirmed) return;
            setSourceRunPending(true);
            setSourceRun({ makeAction: 'clear-source', forceManagedTools });
          }}
        />
      )}
      {Object.keys(makeState.tasks ?? {}).length > 0 && (
        <CindyMakeTasksPanel
          reports={Object.values(makeState.tasks ?? {})}
          taskActions={makeState.taskActions}
        />
      )}
    </div>
  );
}

function CindyMakeSourceStatusCard({
  status,
  preparing = false,
  onPrepare,
  onStop,
  onClear,
}: {
  status: MakeSourceStatus;
  preparing?: boolean;
  onPrepare?: () => void;
  onStop?: () => void;
  onClear?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const displayStatus = preparing ? 'preparing' : status.status;
  // A click is pending before Main publishes the new run. Never reuse the last
  // run's phase, counters or error in that window.
  const activeStatus = preparing && status.status === 'preparing' ? status : undefined;
  const statusClass =
    displayStatus === 'ready'
      ? 'text-[var(--status-success)]'
      : displayStatus === 'failed'
        ? 'text-[var(--status-danger)]'
        : 'text-[var(--text-secondary)]';
  const openSourceDir = () => {
    void Promise.resolve(window.electronAPI.openCindyMakeSourceDir?.())
      .then((result) => {
        if (!result) return;
        if (!result.success) toast.error(t('cindyMakeDoctor.failed'));
      })
      .catch(() => toast.error(t('cindyMakeDoctor.failed')));
  };
  return (
    <section
      className="rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] text-14 text-[var(--text-primary)]"
      aria-label={t('settings.cindyMake.source.title')}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <GitBranch size={16} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span className="flex-1 font-medium">{t('settings.cindyMake.source.title')}</span>
          {preparing && <Spinner size={14} />}
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-[var(--border-default)] px-4 py-3">
          <p className="text-13 text-[var(--text-secondary)]">
            {t('settings.cindyMake.source.description')}
          </p>
          {(status.branch || status.commit || status.status === 'ready') && (
            <CindyMakeSourceDetails source={status} />
          )}
          <dl className="grid gap-1 text-12 text-[var(--text-tertiary)]">
            <div>
              <dt className="inline font-medium">{t('settings.cindyMake.source.path')}: </dt>
              <dd className="inline break-all font-mono">{status.path}</dd>
            </div>
          </dl>
          {activeStatus?.progress?.message && (
            <p className="break-all font-mono text-11 text-[var(--text-tertiary)]">
              {activeStatus.progress.message}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-4 py-3">
        <div className={`min-w-0 flex-1 space-y-1 text-13 ${statusClass}`} role="status">
          <div>
            {t(`settings.cindyMake.source.status.${displayStatus}`)}
            {activeStatus?.phase ? ` · ${t(`cindyMake.source.phase.${activeStatus.phase}`)}` : ''}
            {activeStatus?.progress && (
              <>
                {' · '}
                <span>{t(`cindyMake.source.gitProgress.${activeStatus.progress.stage}`)}</span>{' '}
                <span>({activeStatus.progress.percent}%)</span>
              </>
            )}
          </div>
          {!preparing && status.error && <p>{t(`cindyMake.source.errors.${status.error}`)}</p>}
          {(activeStatus?.phase === 'installing' || activeStatus?.phase === 'caching') && (
            <CindyMakeDependencyProgress
              progress={activeStatus.dependencies}
              running={activeStatus.phase === 'installing'}
              cacheOnly={activeStatus.phase === 'caching'}
            />
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={openSourceDir}>
            {t('settings.cindyMake.source.openDir')}
          </Button>
          {preparing && onStop && (
            <Button variant="secondary" onClick={onStop}>
              {t('settings.cindyMake.source.stop')}
            </Button>
          )}
          {onPrepare && !preparing && (
            <Button variant="secondary" onClick={onPrepare}>
              {t(
                status.status === 'ready'
                  ? 'settings.cindyMake.source.update'
                  : status.status === 'failed' || status.status === 'cancelled'
                    ? 'settings.cindyMake.source.retry'
                    : 'settings.cindyMake.source.prepare',
              )}
            </Button>
          )}
          {/* A failed or cancelled preparation still leaves a checkout behind; clearing
              it is the documented way out of a dirty tree, so the button must stay. */}
          {onClear && !preparing && status.status !== 'missing' && (
            <Button variant="secondary" disabled={preparing} onClick={() => void onClear()}>
              {t('settings.cindyMake.source.reset')}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
