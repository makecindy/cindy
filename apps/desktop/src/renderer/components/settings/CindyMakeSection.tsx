import { useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, Download, Trash2, Wrench } from 'lucide-react';
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
import {
  CindyMakeMergeActions,
  CindyMakeMergeNotice,
} from '@/components/cindy-make/CindyMakeMergeNotice';
import { useCindyMakeMergeResolution } from '@/components/cindy-make/useCindyMakeMergeResolution';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';
import type { CindyMakeHistoryState } from '../../../shared/cindyMakeHistory';
import type { CindyVersionsState } from '../../../shared/cindyVersions';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import { cancelMakeDoctor, startMakeDoctor } from '@/lib/cindyMakeDoctor';
import { useCindyMakeSettings } from '@/lib/cindyMakeSettings';
import { isSelectableVendor } from '@/lib/agentVendors';
import { getDraft, getFastModeForModel } from '@/state/newMakerDraft';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import type { MakeDoctorReport, MakeSourceStatus } from '../../../shared/cindyMakeDoctor';

const CINDY_MAKE_SETTINGS_TABS = ['versions', 'environment'] as const;
type CindyMakeSettingsTab = (typeof CINDY_MAKE_SETTINGS_TABS)[number];

export function CindyMakeSection() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<CindyMakeSettingsTab>('versions');
  const tabId = useId();
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const { forceManagedTools, setForceManagedTools } = useCindyMakeSettings();
  const [syncLatestBeforeBuild, setSyncLatestBeforeBuild] = useState(false);
  const [syncLatestSettingLoaded, setSyncLatestSettingLoaded] = useState(false);
  const [syncLatestSettingPending, setSyncLatestSettingPending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [report, setReport] = useState<MakeDoctorReport>();
  const makeState = useCindyMakeState();
  const [historyState, setHistoryState] = useState<CindyMakeHistoryState>();
  const buildRunning =
    !!historyState?.build && !['ready', 'failed'].includes(historyState.build.status);
  const buildRunningRef = useRef(buildRunning);
  buildRunningRef.current = buildRunning;
  const [versionsState, setVersionsState] = useState<CindyVersionsState>();
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
  const { resolveMerge } = useCindyMakeMergeResolution();
  const mergeSubmitting = useRef(false);
  const previousMergeId = useRef<string | undefined>(undefined);
  const [mergePending, setMergePending] = useState(false);
  const operation = makeState.upstreamMerge;
  const merge = operation?.feature ? undefined : operation;
  const mergeActive = !!operation && ['fetching', 'merging', 'checking'].includes(operation.status);
  const mergeBlocked =
    mergePending ||
    mergeActive ||
    !!operation?.cancellationRequested ||
    (!!operation?.hasWorkspace && operation.status !== 'merged');
  const updateSource = async () => {
    if (mergeSubmitting.current || mergeBlocked || buildRunningRef.current) return;
    const owner = getDataOwnerGeneration();
    mergeSubmitting.current = true;
    try {
      const confirmed = await confirm({
        title: t('cindyMake.merge.confirmTitle'),
        description: t('cindyMake.merge.confirmDescription'),
        confirmText: t('cindyMake.merge.confirm'),
        cancelText: t('settings.cindyMake.source.resetConfirm.cancel'),
      });
      if (!confirmed || !isDataOwnerGenerationCurrent(owner) || buildRunningRef.current) return;
      previousMergeId.current = operation?.id;
      setMergePending(true);
      const draft = getDraft();
      const vendor = isSelectableVendor(draft.vendor) ? draft.vendor : 'cc';
      const prefs = draft.lastByVendor[vendor];
      const createOptions = {
        agentKind: vendor,
        model: prefs.model,
        effort: prefs.effort,
        providerId: prefs.providerId,
        permissionMode: prefs.permissionMode,
        fastMode: getFastModeForModel(prefs.model),
        planModeEnabled: false,
      };
      const result = await window.electronAPI.cindyMakeMerge({
        action: 'update',
        createOptions,
      });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (result?.status === 'conflict' && !result.sessionId && !result.feature)
        await resolveMerge(result, createOptions);
      if (result?.status === 'merged') toast.success(t('cindyMake.merge.status.merged'));
      else if (result?.status === 'failed')
        toast.error(
          t(
            result.error
              ? `cindyMake.merge.errors.${result.error}`
              : 'cindyMake.merge.status.failed',
          ),
        );
      // Refresh failure must not turn a completed update into a second, failure toast.
      await window.electronAPI.getCindyMakeSourceStatus().catch(() => undefined);
    } catch (error) {
      if (isDataOwnerGenerationCurrent(owner))
        toast.error(
          t(
            extractIpcError(error)?.message?.replace(/^\[PRECONDITION_FAILED\]\s*/, '') === 'busy'
              ? 'cindyMake.merge.errors.busy'
              : 'cindyMake.merge.errors.unavailable',
          ),
        );
    } finally {
      mergeSubmitting.current = false;
      setMergePending(false);
    }
  };
  useEffect(() => {
    void window.electronAPI.getCindyMakeSourceStatus?.().catch(() => undefined);
  }, []);
  useEffect(() => {
    const load = window.electronAPI.getCindyMakeSettings;
    if (!load) {
      setSyncLatestSettingLoaded(true);
      return;
    }
    let current = true;
    void load()
      .then((settings) => {
        if (current) setSyncLatestBeforeBuild(settings.syncLatestBeforeBuild);
      })
      .catch(() => undefined)
      .finally(() => {
        if (current) setSyncLatestSettingLoaded(true);
      });
    return () => {
      current = false;
    };
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
          {t(
            activeTab === 'versions'
              ? 'cindyMake.overview.description'
              : 'settings.cindyMake.description',
          )}
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
            {t('settings.cindyMake.create.title')}
          </Button>
          <div className="flex items-start justify-between gap-4 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5">
            <div className="min-w-0">
              <p id="settings-search-settings-cindyMake-syncBeforeBuild-title" className="text-13 font-medium text-[var(--settings-section-sublabel)]">
                {t('settings.cindyMake.syncBeforeBuild.title')}
              </p>
              <p className="mt-1 text-12 leading-[1.45] text-[var(--settings-section-desc)]">
                {t('settings.cindyMake.syncBeforeBuild.description')}
              </p>
            </div>
            <Switch
              checked={syncLatestBeforeBuild}
              disabled={!syncLatestSettingLoaded || syncLatestSettingPending}
              onCheckedChange={(checked) => {
                if (syncLatestSettingPending) return;
                const previous = syncLatestBeforeBuild;
                setSyncLatestBeforeBuild(checked);
                setSyncLatestSettingPending(true);
                void window.electronAPI
                  .setCindyMakeSyncLatestBeforeBuild(checked)
                  .then((settings) => {
                    setSyncLatestBeforeBuild(settings.syncLatestBeforeBuild);
                  })
                  .catch(() => {
                    setSyncLatestBeforeBuild(previous);
                    toast.error(t('settings.cindyMake.syncBeforeBuild.saveFailed'));
                  })
                  .finally(() => setSyncLatestSettingPending(false));
              }}
              aria-label={t('settings.cindyMake.syncBeforeBuild.ariaLabel')}
            />
          </div>
          <CindyMakeVersionsPanel
            active={activeTab === 'versions'}
            busy={historyState?.activeWork ?? historyState?.busy}
            buildRunning={buildRunning}
            onState={setVersionsState}
            refreshKey={
              historyState?.build?.status === 'ready'
                ? String(
                    historyState.build.generatedAt ??
                      historyState.build.versionId ??
                      historyState.build.commit,
                  )
                : undefined
            }
          >
            <CindyMakeSourceStatusCard
              status={sourceStatus}
              preparing={sourceBusy}
              merge={mergePending && merge?.id === previousMergeId.current ? undefined : merge}
              mergeBlocked={mergeBlocked}
              buildRunning={buildRunning}
              updating={mergePending || (mergeActive && !!merge)}
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
          </CindyMakeVersionsPanel>
          <CindyMakeHistoryPanel
            active={activeTab === 'versions'}
            hasPersonalVersion={versionsState?.versions.some(
              (version) => version.kind === 'personal',
            )}
            onState={setHistoryState}
          />
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
  buildRunning = false,
  updating = false,
}: {
  status?: MakeSourceStatus;
  preparing?: boolean;
  onPrepare?: () => void;
  onStop?: () => void;
  onClear?: () => void | Promise<void>;
  merge?: CindyMakeMergeState;
  mergeBlocked?: boolean;
  buildRunning?: boolean;
  updating?: boolean;
}) {
  const { t } = useTranslation();
  const displayStatus = preparing ? 'preparing' : status?.status;
  // A click is pending before Main publishes the new run. Never reuse the last
  // run's phase, counters or error in that window.
  const activeStatus = preparing && status?.status === 'preparing' ? status : undefined;
  const displayMerge =
    !preparing &&
    (updating ||
      !status ||
      status.status === 'ready' ||
      merge?.hasWorkspace ||
      merge?.cancellationRequested ||
      merge?.error === 'cancelFailed')
      ? merge?.status === 'merged' || merge?.status === 'cancelled'
        ? undefined
        : merge
      : undefined;
  const statusClass = updating
    ? 'text-[var(--text-secondary)]'
    : displayStatus === 'ready'
      ? 'text-[var(--status-success)]'
      : displayStatus === 'failed'
        ? 'text-[var(--error-fg)]'
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
    <section id="settings-search-settings-cindyMake-source-title"
      className="min-w-0 text-14 text-[var(--text-primary)]"
      aria-label={t('settings.cindyMake.source.title')}
    >
      <h4 className="sr-only">{t('cindyMake.overview.personalCode')}</h4>
      <p className="sr-only">{t('settings.cindyMake.source.description')}</p>
      <div className="space-y-3 px-4 pb-4 pt-1">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-[1_1_320px]">
            {status &&
              (status.branch || status.commit || status.status === 'ready') &&
              !preparing && (
                <CindyMakeSourceDetails
                  source={status}
                  latestVersion={status.latestVersion}
                  showComparison={!updating && !displayMerge && status.status === 'ready'}
                />
              )}
          </div>
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            <CindyMakeMergeActions state={displayMerge} busy={updating}>
              {status?.status === 'ready' && onPrepare && (
                <Tip
                  text={t(buildRunning ? 'cindyMake.merge.buildingHint' : 'cindyMake.merge.updateHint')}
                >
                  <Button
                    variant="secondary"
                    className="gap-2"
                    disabled={preparing || mergeBlocked || buildRunning}
                    loading={updating}
                    onClick={onPrepare}
                  >
                    {!updating && <Download size={14} aria-hidden />}
                    <span className="relative top-px">{t('cindyMake.merge.getLatest')}</span>
                  </Button>
                </Tip>
              )}
            </CindyMakeMergeActions>
          </div>
        </div>
        {status && (
          <div className="border-t border-[var(--border-default)] pt-3">
            <p className="text-12 text-[var(--text-secondary)]">
              {t('settings.cindyMake.source.path')}
            </p>
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 break-all font-mono text-12 text-[var(--text-secondary)]">
                {status.path}
              </p>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {status && status.status !== 'missing' && (
                  <Tip text={t('settings.cindyMake.source.openDir')}>
                    <Button
                      variant="secondary"
                      className="w-8 border-transparent bg-transparent px-0 text-[var(--text-tertiary)]"
                      aria-label={t('settings.cindyMake.source.openDir')}
                      onClick={openSourceDir}
                    >
                      <FolderOpen size={14} aria-hidden />
                    </Button>
                  </Tip>
                )}
                {onClear && status && !preparing && status.status !== 'missing' && (
                  <Tip text={t('settings.cindyMake.source.reset')}>
                    <Button
                      variant="secondary"
                      onClick={() => void onClear()}
                      disabled={mergeBlocked}
                      aria-label={t('settings.cindyMake.source.reset')}
                      className="w-8 border-transparent bg-transparent px-0 text-[var(--text-tertiary)]"
                    >
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  </Tip>
                )}
              </div>
            </div>
          </div>
        )}
        {activeStatus?.progress?.message && (
          <p className="break-all font-mono text-11 text-[var(--text-tertiary)]">
            {activeStatus.progress.message}
          </p>
        )}
      </div>
      {displayMerge ? (
        <CindyMakeMergeNotice state={displayMerge} showActions={false} />
      ) : status && (preparing || updating || status.status !== 'ready') ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-4 py-3">
          <div className={`min-w-0 flex-1 space-y-1 text-13 ${statusClass}`} role="status">
            <div>
              {t(
                updating
                  ? 'cindyMake.merge.status.fetching'
                  : `settings.cindyMake.source.status.${displayStatus}`,
              )}
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
            {!preparing && !updating && status.error && (
              <p>{t(`cindyMake.source.errors.${status.error}`)}</p>
            )}
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
      ) : null}
    </section>
  );
}
