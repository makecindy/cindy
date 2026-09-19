import { useEffect, useId, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  GitBranch,
  Download,
  Plus,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { MakeDoctorReportCard } from '@/components/chat/CindyMakeDoctorCard';
import { CindyMakeSourceDetails } from '@/components/cindy-make/CindyMakeSourceDetails';
import { CindyMakeCreateDialog } from '@/components/cindy-make/CindyMakeCreateDialog';
import { CindyMakeDependencyProgress } from '@/components/cindy-make/CindyMakeDependencyProgress';
import { CindyMakeHistoryPanel } from '@/components/cindy-make/CindyMakeHistoryPanel';
import { CindyMakeVersionsPanel } from '@/components/cindy-make/CindyMakeVersionsPanel';
import { CindyMakeMergeNotice } from '@/components/cindy-make/CindyMakeMergeNotice';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';
import type { CindyMakeHistoryState } from '../../../shared/cindyMakeHistory';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import { cancelMakeDoctor, startMakeDoctor } from '@/lib/cindyMakeDoctor';
import { useCindyMakeSettings } from '@/lib/cindyMakeSettings';
import { isSelectableVendor } from '@/lib/agentVendors';
import { getDraft, getFastModeForModel } from '@/state/newMakerDraft';
import { toast } from '@/lib/toast';
import type { MakeDoctorReport, MakeSourceStatus } from '../../../shared/cindyMakeDoctor';

const CINDY_MAKE_SETTINGS_TABS = ['versions', 'environment'] as const;
type CindyMakeSettingsTab = (typeof CINDY_MAKE_SETTINGS_TABS)[number];

export function CindyMakeSection() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<CindyMakeSettingsTab>('versions');
  const tabId = useId();
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const { forceManagedTools, setForceManagedTools } = useCindyMakeSettings();
  const [createOpen, setCreateOpen] = useState(false);
  const [report, setReport] = useState<MakeDoctorReport>();
  const makeState = useCindyMakeState();
  const [historyState, setHistoryState] = useState<CindyMakeHistoryState>();
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
  const mergeSubmitting = useRef(false);
  const [mergePending, setMergePending] = useState(false);
  const operation = makeState.upstreamMerge;
  const merge = operation?.feature ? undefined : operation;
  const mergeActive = !!operation && ['fetching', 'merging', 'checking'].includes(operation.status);
  const mergeBlocked =
    mergePending || mergeActive || (!!operation?.hasWorkspace && operation.status !== 'merged');
  const updateSource = async () => {
    if (mergeSubmitting.current || mergeBlocked) return;
    const owner = getDataOwnerGeneration();
    mergeSubmitting.current = true;
    try {
      const confirmed = await confirm({
        title: t('cindyMake.merge.confirmTitle'),
        description: t('cindyMake.merge.confirmDescription'),
        confirmText: t('cindyMake.merge.confirm'),
        cancelText: t('settings.cindyMake.source.resetConfirm.cancel'),
      });
      if (!confirmed || !isDataOwnerGenerationCurrent(owner)) return;
      setMergePending(true);
      const draft = getDraft();
      const vendor = isSelectableVendor(draft.vendor) ? draft.vendor : 'cc';
      const prefs = draft.lastByVendor[vendor];
      await window.electronAPI.cindyMakeMerge({
        action: 'update',
        createOptions: {
          agentKind: vendor,
          model: prefs.model,
          effort: prefs.effort,
          providerId: prefs.providerId,
          permissionMode: prefs.permissionMode,
          fastMode: getFastModeForModel(prefs.model),
          planModeEnabled: false,
        },
      });
      if (isDataOwnerGenerationCurrent(owner)) await window.electronAPI.getCindyMakeSourceStatus();
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) toast.error(t('cindyMake.merge.errors.unavailable'));
    } finally {
      mergeSubmitting.current = false;
      setMergePending(false);
    }
  };
  useEffect(() => {
    void window.electronAPI.getCindyMakeSourceStatus?.().catch(() => undefined);
  }, []);
  const previousSourceStatus = useRef(sourceStatus?.status);
  useEffect(() => {
    const previous = previousSourceStatus.current;
    previousSourceStatus.current = sourceStatus?.status;
    if (previous === 'preparing' && sourceStatus?.status === 'ready') {
      void window.electronAPI.getCindyMakeSourceStatus?.().catch(() => undefined);
    }
  }, [sourceStatus?.status]);
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
      </div>
      {createOpen && <CindyMakeCreateDialog onOpenChange={setCreateOpen} />}
      <div
        role="tablist"
        aria-label={t('settings.cindyMake.title')}
        className="flex flex-wrap gap-1"
      >
        {CINDY_MAKE_SETTINGS_TABS.map((tab, index) => (
          <Button
            key={tab}
            ref={(button) => {
              tabButtons.current[index] = button;
            }}
            id={tabId + '-' + tab + '-tab'}
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={tabId + '-' + tab + '-panel'}
            tabIndex={activeTab === tab ? 0 : -1}
            className={
              activeTab === tab
                ? undefined
                : 'border-transparent bg-transparent text-[var(--text-secondary)] enabled:hover:border-[var(--surface-hover)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)]'
            }
            onClick={() => setActiveTab(tab)}
            onKeyDown={(event) => {
              const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
              let next: number;
              switch (event.key) {
                case 'ArrowRight':
                  next = index + (rtl ? -1 : 1);
                  break;
                case 'ArrowLeft':
                  next = index + (rtl ? 1 : -1);
                  break;
                case 'Home':
                  next = 0;
                  break;
                case 'End':
                  next = CINDY_MAKE_SETTINGS_TABS.length - 1;
                  break;
                default:
                  return;
              }
              event.preventDefault();
              next = (next + CINDY_MAKE_SETTINGS_TABS.length) % CINDY_MAKE_SETTINGS_TABS.length;
              tabButtons.current[next]?.focus();
              setActiveTab(CINDY_MAKE_SETTINGS_TABS[next]);
            }}
          >
            {t('settings.cindyMake.tabs.' + tab)}
          </Button>
        ))}
      </div>

      {/* Keep both panels mounted so tab navigation preserves checks and local UI state. */}
      <div
        role="tabpanel"
        id={tabId + '-environment-panel'}
        aria-labelledby={tabId + '-environment-tab'}
        hidden={activeTab !== 'environment'}
      >
        <div className="flex flex-col gap-[18px]">
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
          <CindyMakeSourceStatusCard
            status={sourceStatus}
            preparing={sourceBusy}
            merge={merge}
            mergeBlocked={mergeBlocked}
            onPrepare={() => {
              if (!sourceStatus || sourceBusy) return;
              if (sourceStatus.status === 'ready') {
                void updateSource();
                return;
              }
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
              if (!sourceStatus || sourceBusy || mergeBlocked) return;
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
        </div>
      </div>
      <div
        role="tabpanel"
        id={tabId + '-versions-panel'}
        aria-labelledby={tabId + '-versions-tab'}
        hidden={activeTab !== 'versions'}
      >
        <div className="flex flex-col gap-[18px]">
          <Button className="self-start" onClick={() => setCreateOpen(true)}>
            <Plus size={14} aria-hidden="true" />
            {t('settings.cindyMake.create.title')}
          </Button>
          <CindyMakeVersionsPanel
            active={activeTab === 'versions'}
            busy={historyState?.busy}
            refreshKey={
              historyState?.build?.status === 'ready'
                ? String(
                    historyState.build.generatedAt ??
                      historyState.build.versionId ??
                      historyState.build.commit,
                  )
                : undefined
            }
          />
          <CindyMakeHistoryPanel active={activeTab === 'versions'} onState={setHistoryState} />
        </div>
      </div>
    </div>
  );
}

function CindyMakeSourceStatusCard({
  status,
  preparing = false,
  onPrepare,
  onStop,
  onClear,
  merge,
  mergeBlocked = false,
}: {
  status?: MakeSourceStatus;
  preparing?: boolean;
  onPrepare?: () => void;
  onStop?: () => void;
  onClear?: () => void | Promise<void>;
  merge?: CindyMakeMergeState;
  mergeBlocked?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const displayStatus = preparing ? 'preparing' : status?.status;
  // A click is pending before Main publishes the new run. Never reuse the last
  // run's phase, counters or error in that window.
  const activeStatus = preparing && status?.status === 'preparing' ? status : undefined;
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
          {status && (
            <>
              {(status.branch || status.commit || status.status === 'ready') && (
                <CindyMakeSourceDetails
                  source={status}
                  latestVersion={status.latestVersion}
                  updateAction={
                    status.status === 'ready' && onPrepare ? (
                      <Tip text={t('cindyMake.merge.updateHint')}>
                        <button
                          type="button"
                          aria-label={t('cindyMake.merge.getLatest')}
                          disabled={preparing || mergeBlocked}
                          onClick={onPrepare}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] active:bg-[var(--surface-chip)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Download size={14} aria-hidden />
                        </button>
                      </Tip>
                    ) : undefined
                  }
                />
              )}
              <dl className="grid gap-1 text-12 text-[var(--text-tertiary)]">
                <div className="flex min-w-0 items-center gap-1">
                  <dt className="shrink-0 font-medium">{t('settings.cindyMake.source.path')}:</dt>
                  <dd className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="min-w-0 flex-1 break-all font-mono">{status.path}</span>
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <Tip text={t('settings.cindyMake.source.openDir')}>
                        <button
                          type="button"
                          onClick={openSourceDir}
                          aria-label={t('settings.cindyMake.source.openDir')}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] active:bg-[var(--surface-chip)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                        >
                          <FolderOpen size={14} aria-hidden />
                        </button>
                      </Tip>
                      {/* Failed or cancelled preparation can leave a checkout to clear. */}
                      {onClear && !preparing && status.status !== 'missing' && (
                        <Tip text={t('settings.cindyMake.source.reset')}>
                          <button
                            type="button"
                            onClick={() => void onClear()}
                            disabled={mergeBlocked}
                            aria-label={t('settings.cindyMake.source.reset')}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] active:bg-[var(--surface-chip)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </Tip>
                      )}
                    </span>
                  </dd>
                </div>
              </dl>
              {activeStatus?.progress?.message && (
                <p className="break-all font-mono text-11 text-[var(--text-tertiary)]">
                  {activeStatus.progress.message}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {merge && <CindyMakeMergeNotice state={merge} />}
      {status && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-4 py-3">
          <div className={`min-w-0 flex-1 space-y-1 text-13 ${statusClass}`} role="status">
            <div>
              {t(`settings.cindyMake.source.status.${displayStatus}`)}
              {activeStatus?.phase ? ` · ${t(`cindyMake.source.phase.${activeStatus.phase}`)}` : ''}
              {activeStatus?.progress && (
                <>
                  {' · '}
                  <span>
                    {t(`cindyMake.source.gitProgress.${activeStatus.progress.stage}`)}
                  </span>{' '}
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
            {preparing && onStop && (
              <Button variant="secondary" onClick={onStop}>
                {t('settings.cindyMake.source.stop')}
              </Button>
            )}
            {onPrepare && !preparing && status.status !== 'ready' && (
              <Tip text={t('settings.cindyMake.source.description')}>
                <Button variant="secondary" onClick={onPrepare} disabled={mergeBlocked}>
                  {t(
                    status.status === 'failed' || status.status === 'cancelled'
                      ? 'settings.cindyMake.source.retry'
                      : 'settings.cindyMake.source.prepare',
                  )}
                </Button>
              </Tip>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
