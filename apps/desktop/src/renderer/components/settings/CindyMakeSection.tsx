import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { MakeDoctorReportCard } from '@/components/chat/CindyMakeDoctorCard';
import { cancelMakeDoctor, startMakeDoctor } from '@/lib/cindyMakeDoctor';
import { useCindyMakeSettings } from '@/lib/cindyMakeSettings';
import { toast } from '@/lib/toast';
import type { MakeDoctorReport, MakeSourceStatus } from '../../../shared/cindyMakeDoctor';

export function CindyMakeSection() {
  const { t } = useTranslation();
  const { forceManagedTools, setForceManagedTools } = useCindyMakeSettings();
  const [report, setReport] = useState<MakeDoctorReport>();
  const [sourceReport, setSourceReport] = useState<MakeDoctorReport>();
  const [checkVersion, setCheckVersion] = useState(0);
  const [runMode, setRunMode] = useState<'check' | 'prepare'>('check');
  const [runVersion, setRunVersion] = useState(0);
  const [sourceRun, setSourceRun] = useState<{
    makeAction: 'prepare-source' | 'clear-source';
    forceManagedTools: boolean;
  }>();
  const [sourceStatus, setSourceStatus] = useState<MakeSourceStatus>();
  const [sourceRunPending, setSourceRunPending] = useState(false);
  const { confirm } = useConfirmDialog();
  useEffect(() => {
    let active = true;
    Promise.resolve(window.electronAPI.getCindyMakeSourceStatus?.())
      .then((status) => {
        if (active) setSourceStatus((current) => current ?? status);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const source = sourceReport?.source;
    if (source) {
      setSourceStatus({
        status: source.status === 'pending' ? 'preparing' : source.status,
        path: source.path,
        channel: source.channel,
        version: source.version,
        ref: source.ref,
        commit: source.commit,
        error: source.error,
        phase: source.phase,
        progress: source.progress,
      });
    }
    if (sourceReport && sourceReport.status !== 'running') {
      setSourceRunPending(false);
      if (!source && (sourceReport.status === 'failed' || sourceReport.status === 'cancelled')) {
        const status = sourceReport.status;
        setSourceStatus(
          (current) =>
            current && {
              ...current,
              status,
              error: status === 'cancelled' ? 'cancelled' : 'gitFailed',
              phase: undefined,
              progress: undefined,
            },
        );
      }
    }
  }, [sourceReport]);
  useEffect(() => {
    if (!sourceRun) return;
    const controller = new AbortController();
    startMakeDoctor(setSourceReport, undefined, 'cindy-make', {
      ...sourceRun,
      signal: controller.signal,
    });
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
      </div>

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

      {report ? (
        <MakeDoctorReportCard
          report={report}
          showSource={false}
          alwaysAllowRecheck
          onPrepare={() => {
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
            void cancelMakeDoctor(report.runId, report.mode).catch(() =>
              toast.error(t('cindyMakeDoctor.failed')),
            );
          }}
          onRecheck={() => {
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
          preparing={sourceRunPending || sourceReport?.status === 'running'}
          onPrepare={() => {
            if (sourceRunPending || sourceReport?.status === 'running') return;
            setSourceRunPending(true);
            setSourceRun({ makeAction: 'prepare-source', forceManagedTools });
          }}
          onClear={async () => {
            if (sourceRunPending || sourceReport?.status === 'running') return;
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
    </div>
  );
}

function CindyMakeSourceStatusCard({
  status,
  preparing = false,
  onPrepare,
  onClear,
}: {
  status: MakeSourceStatus;
  preparing?: boolean;
  onPrepare?: () => void;
  onClear?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const displayStatus = preparing ? 'preparing' : status.status;
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
          <dl className="grid gap-1 text-12 text-[var(--text-secondary)]">
            <div>
              <dt className="inline font-medium">{t('settings.cindyMake.source.path')}: </dt>
              <dd className="inline break-all font-mono">{status.path}</dd>
            </div>
            {status.channel && (
              <div>
                <dt className="inline font-medium">{t('settings.cindyMake.source.channel')}: </dt>
                <dd className="inline">{status.channel}</dd>
              </div>
            )}
            {status.version && (
              <div>
                <dt className="inline font-medium">{t('settings.cindyMake.source.version')}: </dt>
                <dd className="inline">{status.version}</dd>
              </div>
            )}
            {status.ref && (
              <div>
                <dt className="inline font-medium">{t('settings.cindyMake.source.ref')}: </dt>
                <dd className="inline">{status.ref}</dd>
              </div>
            )}
            {status.commit && (
              <div>
                <dt className="inline font-medium">{t('settings.cindyMake.source.commit')}: </dt>
                <dd className="inline break-all font-mono">{status.commit}</dd>
              </div>
            )}
            {status.error && (
              <div className="text-[var(--status-danger)]">
                {t(`cindyMake.source.errors.${status.error}`)}
              </div>
            )}
          </dl>
          {preparing && status.progress && (
            <div
              className="flex items-center gap-2 text-12 text-[var(--text-secondary)]"
              aria-live="polite"
            >
              <Spinner size={14} />
              <span>{t(`cindyMake.source.gitProgress.${status.progress.stage}`)}</span>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-4 py-3">
        <div className={`min-w-0 flex-1 text-13 ${statusClass}`} role="status">
          {t(`settings.cindyMake.source.status.${displayStatus}`)}
          {preparing && status.phase ? ` · ${t(`cindyMake.source.phase.${status.phase}`)}` : ''}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={openSourceDir}>
            {t('settings.cindyMake.source.openDir')}
          </Button>
          {onPrepare && (
            <Button variant="secondary" disabled={preparing} onClick={onPrepare}>
              {t(
                preparing
                  ? 'settings.cindyMake.source.preparingAction'
                  : status.status === 'ready'
                    ? 'settings.cindyMake.source.update'
                    : 'settings.cindyMake.source.prepare',
              )}
            </Button>
          )}
          {onClear && status.status === 'ready' && (
            <Button variant="secondary" disabled={preparing} onClick={() => void onClear()}>
              {t('settings.cindyMake.source.reset')}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
