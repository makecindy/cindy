import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Minus,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/spinner';
import { CindyMakeTaskCard } from '@/components/cindy-make/CindyMakeTaskCard';
import { CindyMakeDependencyProgress } from '@/components/cindy-make/CindyMakeDependencyProgress';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { cancelMakeDoctor } from '@/lib/cindyMakeDoctor';
import { toast } from '@/lib/toast';
import {
  isMakeEnvironmentReady,
  type MakeDoctorReport,
  type MakeRuntimeVersion,
  type MakeUpstreamDecision,
  type MakeUpstreamItem,
} from '../../../shared/cindyMakeDoctor';

export function CindyMakeDoctorCard({
  data,
  sessionId,
  onDismiss,
}: {
  data?: Record<string, unknown>;
  sessionId?: string;
  onDismiss?: () => void;
}) {
  const persistedReport = data?.report as MakeDoctorReport | undefined;
  const makeState = useCindyMakeState();
  const remote = Boolean(getStickySessionDeviceId(sessionId));
  const liveReport =
    !remote && persistedReport ? makeState.reports?.[persistedReport.runId] : undefined;
  const report = liveReport ?? persistedReport;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [startingCode, setStartingCode] = useState(false);
  const activeSession = useRef(sessionId);
  const openingTask = useRef(false);
  useEffect(() => {
    activeSession.current = sessionId;
    return () => {
      activeSession.current = undefined;
    };
  }, [sessionId]);
  const openTask = async (targetSessionId: string) => {
    const owner = getDataOwnerGeneration();
    const current = () =>
      activeSession.current === sessionId &&
      isDataOwnerGenerationCurrent(owner) &&
      !getStickySessionDeviceId(sessionId) &&
      !getStickySessionDeviceId(targetSessionId);
    if (openingTask.current || !current()) return;
    openingTask.current = true;
    try {
      const [service, { sessionsStore }] = await Promise.all([
        import('@/lib/sessionService'),
        import('@/lib/sessionsStore'),
      ]);
      if (!current()) return;
      let target = await service.get(targetSessionId);
      if (!current()) return;
      if (!target || target.status === 'deleted') throw new Error('unavailable');
      if (target.status === 'archived') {
        const restored = await service.restoreIfArchived(target.id, target);
        if (!current()) return;
        if (!restored) throw new Error('unavailable');
        target = restored;
      }
      sessionsStore.prependCreated(target);
      onDismiss?.();
      navigate('/cc-agent/' + target.id);
    } catch {
      if (current()) toast.error(t('settings.cindyMake.tasks.errors.unavailable'));
    } finally {
      openingTask.current = false;
    }
  };
  if (!report) return null;
  if (report.task || (!remote && makeState.tasks?.[report.runId]?.task)) {
    const live = !remote ? makeState.tasks?.[report.runId] : undefined;
    const snapshot = live ?? report;
    return (
      <CindyMakeTaskCard
        report={snapshot}
        readOnly={remote}
        request={typeof data?.request === 'string' ? data.request : undefined}
        onOpenTask={
          !remote && snapshot.task?.sessionId !== sessionId
            ? () => void openTask(snapshot.task!.sessionId)
            : undefined
        }
      />
    );
  }
  const codeSessionId = typeof data?.codeSessionId === 'string' ? data.codeSessionId : undefined;
  const compactPrepare = report.mode === 'prepare' && codeSessionId === sessionId;
  const syncLiveReport = async () => {
    if (!sessionId || !liveReport || getStickySessionDeviceId(sessionId)) return;
    const owner = getDataOwnerGeneration();
    const { makerChatStore } = await import('@/lib/makerChatStore');
    if (!isDataOwnerGenerationCurrent(owner) || getStickySessionDeviceId(sessionId)) return;
    const message = makerChatStore
      .getSnapshot(sessionId)
      .messages.find(
        (row) =>
          (row.systemCardType === 'cindy-make' || row.systemCardType === 'cindy-make-doctor') &&
          (row.systemCardData?.report as MakeDoctorReport | undefined)?.runId === liveReport.runId,
      );
    if (message)
      makerChatStore.updateSystemCardData(sessionId, message.clientId, { report: liveReport });
  };
  const start = (choice?: MakeUpstreamDecision) => {
    if (!sessionId || startingCode || getStickySessionDeviceId(sessionId)) return;
    const owner = getDataOwnerGeneration();
    setStartingCode(true);
    void import('@/lib/cindyMakeDoctorStream')
      .then(async ({ chooseMakeUpstream, startMakeCodeSession }) => {
        if (!isDataOwnerGenerationCurrent(owner) || getStickySessionDeviceId(sessionId))
          return null;
        await syncLiveReport();
        if (!isDataOwnerGenerationCurrent(owner) || getStickySessionDeviceId(sessionId))
          return null;
        return choice
          ? chooseMakeUpstream(sessionId, report.runId, choice)
          : startMakeCodeSession(sessionId, report.runId);
      })
      .then((createdId) => {
        if (choice === 'wait') {
          onDismiss?.();
          return;
        }
        if (
          createdId &&
          activeSession.current === sessionId &&
          isDataOwnerGenerationCurrent(owner) &&
          !getStickySessionDeviceId(sessionId) &&
          !getStickySessionDeviceId(createdId)
        ) {
          onDismiss?.();
          navigate(`/cc-agent/${createdId}`);
        }
      })
      .catch(() => {
        if (isDataOwnerGenerationCurrent(owner)) toast.error(t('cindyMake.code.failed'));
      })
      .finally(() => {
        if (activeSession.current === sessionId) setStartingCode(false);
      });
  };
  const recheck = (request?: string) => {
    if (!sessionId || getStickySessionDeviceId(sessionId)) return;
    const owner = getDataOwnerGeneration();
    void import('@/lib/cindyMakeDoctorStream')
      .then(async ({ startMakeDoctorInStream }) => {
        if (isDataOwnerGenerationCurrent(owner) && !getStickySessionDeviceId(sessionId)) {
          await syncLiveReport();
          if (!isDataOwnerGenerationCurrent(owner) || getStickySessionDeviceId(sessionId)) return;
          startMakeDoctorInStream(sessionId, {
            retryRunId: report.runId,
            ...(request !== undefined ? { request } : {}),
          });
        }
      })
      .catch(() => {
        if (isDataOwnerGenerationCurrent(owner)) toast.error(t('cindyMakeDoctor.failed'));
      });
  };
  return (
    <MakeDoctorReportCard
      report={report}
      readOnly={remote}
      request={typeof data?.request === 'string' ? data.request : undefined}
      decision={
        data?.decision === 'wait' || data?.decision === 'personal' ? data.decision : undefined
      }
      onSearch={recheck}
      onChoose={start}
      onStartCode={sessionId ? () => start() : undefined}
      onOpenCode={codeSessionId && !remote ? () => void openTask(codeSessionId) : undefined}
      startingCode={startingCode}
      startingPhase={
        data?.codeStartPhase === 'workspace'
          ? 'workspace'
          : data?.codeStartPhase === 'dependencies'
            ? 'dependencies'
            : 'session'
      }
      codeSessionError={data?.codeSessionError === true}
      compactPrepare={compactPrepare}
      onRecheck={() => recheck()}
      onStop={() => {
        if (getStickySessionDeviceId(sessionId)) return;
        const stop = cancelMakeDoctor(report.runId, report.mode);
        void stop.catch(() => toast.error(t('cindyMakeDoctor.failed')));
      }}
    />
  );
}

type StepState = 'pending' | 'running' | 'passed' | 'failed' | 'cancelled';

function StepStatusIcon({ state }: { state: StepState }) {
  if (state === 'running') {
    return <Spinner size={14} className="shrink-0" aria-hidden />;
  }
  if (state === 'passed') {
    return <Check size={14} className="shrink-0 text-[var(--status-success)]" aria-hidden />;
  }
  return (
    <Minus
      size={14}
      className={`shrink-0 ${state === 'failed' ? 'text-[var(--status-danger)]' : 'text-[var(--text-secondary)]'}`}
      aria-hidden
    />
  );
}

/** DESIGN.md §4/§5: flat 12px card, semantic surfaces, compact expandable detail. */
export function MakeDoctorReportCard({
  report,
  request,
  decision,
  onChoose,
  onStop,
  onRecheck,
  onPrepare,
  onOpenToolsDir,
  onStartCode,
  onOpenCode,
  startingCode = false,
  startingPhase = 'session',
  showSteps = true,
  codeSessionError = false,
  alwaysAllowRecheck = false,
  showSource = true,
  compactPrepare = false,
  readOnly = false,
}: {
  report: MakeDoctorReport;
  request?: string;
  decision?: MakeUpstreamDecision;
  onSearch?: (request: string) => void;
  onChoose?: (choice: MakeUpstreamDecision) => void;
  onStop: () => void;
  onRecheck: () => void;
  onPrepare?: () => void;
  onOpenToolsDir?: () => void;
  onStartCode?: () => void;
  onOpenCode?: () => void;
  startingCode?: boolean;
  /** Settings shows the environment on its own; the numbered step row belongs to the workflow. */
  showSteps?: boolean;
  /** Creating the task worktree (branch + dependency install) precedes creating the task. */
  startingPhase?: 'workspace' | 'dependencies' | 'session';
  codeSessionError?: boolean;
  alwaysAllowRecheck?: boolean;
  showSource?: boolean;
  compactPrepare?: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [details, setDetails] = useState(false);
  const running = report.status === 'running';
  const preparing = report.mode === 'prepare';
  const activeTool = report.checks.find((check) =>
    ['downloading', 'installing'].includes(check.status),
  );
  const passed = report.checks.filter((check) => check.status === 'passed').length;
  const allPassed = report.status === 'completed' && passed === report.checks.length;
  const upstream = report.upstream;
  const searching = upstream?.status === 'searching';
  const ready = isMakeEnvironmentReady(report);
  const queryFinished =
    upstream && !['pending', 'needsRequest', 'searching'].includes(upstream.status);
  const title = upstream ? 'cindyMake.title' : 'cindyMakeDoctor.title';
  const installableIds =
    report.platform === 'win32'
      ? ['git', 'gitLfs', 'node', 'pnpm', 'python']
      : report.platform === 'darwin'
        ? ['node', 'pnpm', 'python', 'gitLfs']
        : [];
  const hasInstallableMissing = report.checks.some(
    (check) =>
      installableIds.includes(check.id) &&
      ['missing', 'incompatible', 'failed'].includes(check.status),
  );
  const status = running
    ? 'running'
    : report.status === 'cancelled'
      ? 'cancelled'
      : report.status === 'failed'
        ? 'failed'
        : allPassed
          ? 'passed'
          : 'needsAttention';
  const source = showSource ? report.source : undefined;
  const environmentStepState: StepState = ready
    ? 'passed'
    : running
      ? 'running'
      : report.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  const upstreamStepState: StepState | null = upstream
    ? upstream.status === 'found' || upstream.status === 'notFound'
      ? 'passed'
      : searching && running
        ? 'running'
        : upstream.status === 'failed' || upstream.status === 'cancelled'
          ? upstream.status
          : 'pending'
    : null;
  const sourceStepState: StepState | null = source
    ? source.status === 'ready'
      ? 'passed'
      : source.status === 'preparing'
        ? 'running'
        : source.status === 'failed' || source.status === 'cancelled'
          ? source.status
          : 'pending'
    : null;
  const sourceStatusKey =
    source?.status === 'preparing'
      ? 'cindyMake.source.preparing'
      : source?.status === 'pending'
        ? 'cindyMake.source.pending'
        : source?.status === 'missing'
          ? 'cindyMake.source.missing'
          : source?.status === 'ready'
            ? upstream && !decision
              ? `cindyMake.upstream.${upstream.status}`
              : 'cindyMake.source.ready'
            : source?.status === 'failed'
              ? 'cindyMake.source.failed'
              : source?.status === 'cancelled'
                ? 'cindyMake.source.cancelled'
                : decision
                  ? `cindyMake.upstream.choice.${decision}`
                  : upstream && ready
                    ? `cindyMake.upstream.${upstream.status}`
                    : preparing
                      ? `cindyMake.prepare.${status}`
                      : `cindyMakeDoctor.${status}`;
  const currentStatusKey =
    source?.status === 'ready' && decision === 'personal'
      ? startingPhase === 'dependencies'
        ? 'cindyMake.code.preparingDependencies'
        : startingCode
          ? startingPhase === 'workspace'
            ? 'cindyMake.code.preparingWorkspace'
            : 'cindyMake.code.starting'
          : codeSessionError
            ? onOpenCode
              ? 'cindyMake.code.sendFailed'
              : 'cindyMake.code.failed'
            : onOpenCode
              ? 'cindyMake.code.started'
              : sourceStatusKey
      : sourceStatusKey;
  const currentStatusClass =
    (codeSessionError && source?.status === 'ready') ||
    source?.status === 'failed' ||
    upstream?.status === 'failed' ||
    status === 'failed'
      ? 'text-[var(--status-danger)]'
      : running ||
          startingCode ||
          report.status === 'cancelled' ||
          source?.status === 'cancelled' ||
          upstream?.status === 'cancelled'
        ? 'text-[var(--text-secondary)]'
        : source?.status === 'ready' || allPassed
          ? 'text-[var(--status-success)]'
          : 'text-[var(--text-secondary)]';
  if (compactPrepare) {
    return (
      <CompactMakePreparationCard
        report={report}
        onStop={onStop}
        onRecheck={onRecheck}
        readOnly={readOnly}
      />
    );
  }
  return (
    <section
      className="min-w-0 w-full rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] text-14 text-[var(--text-primary)]"
      aria-label={t(title)}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <Wrench size={16} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          <span className="flex-1 font-medium">{t(title)}</span>
          {running && <Spinner size={14} />}
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {!readOnly && upstream && queryFinished && !running && !startingCode && (
          <Button
            variant="secondary"
            size="md"
            className="h-8 w-8 px-0"
            aria-label={t('cindyMake.upstream.retry')}
            title={t('cindyMake.upstream.retry')}
            onClick={onRecheck}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-[var(--border-default)] px-4 py-3">
          {request && (
            <div className="space-y-1 text-13">
              <p className="text-[var(--text-secondary)]">{t('cindyMake.request')}</p>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{request}</p>
            </div>
          )}
          {showSteps && (
            <p className="flex items-center gap-2 text-13 font-medium">
              <StepStatusIcon state={environmentStepState} />
              <span>{t('cindyMake.stepEnvironment')}</span>
            </p>
          )}
          {details && (
            <>
              <p className="text-13 text-[var(--text-secondary)]">
                {t(preparing ? 'cindyMake.prepare.scope' : 'cindyMakeDoctor.scope')}
                {report.platform &&
                  ` · ${report.platform === 'win32' ? 'Windows' : report.platform === 'darwin' ? 'macOS' : report.platform === 'linux' ? 'Linux' : report.platform} ${report.arch}`}
              </p>
              {report.forceManagedTools && (
                <p className="text-13 text-[var(--text-secondary)]">
                  {t('settings.cindyMake.forceManaged.reportHint')}
                </p>
              )}
              <ul className="space-y-2">
                {report.checks.map((check) => (
                  <li key={check.id} className="text-13">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0" aria-hidden>
                        {['checking', 'downloading', 'installing'].includes(check.status) ? (
                          <Spinner size={14} />
                        ) : check.status === 'passed' ? (
                          <Check size={14} />
                        ) : (
                          <Minus size={14} />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        {t(`cindyMakeDoctor.checks.${check.id}`)}
                      </span>
                      <span className="text-right text-[var(--text-secondary)]">
                        {check.version}
                        {check.version && check.status !== 'passed' ? ' · ' : ''}
                        {!check.version || check.status !== 'passed'
                          ? t(`cindyMakeDoctor.checkStatus.${check.status}`)
                          : ''}
                        {check.status === 'passed' &&
                          check.source &&
                          ` · ${t(`cindyMake.prepare.source.${check.source}`)}`}
                      </span>
                    </div>
                    {check.status === 'downloading' && check.progress && (
                      <div className="ml-5 mt-1 space-y-1 text-12 text-[var(--text-secondary)]">
                        <p>
                          {t('cindyMake.prepare.downloadProgress', {
                            loaded: (check.progress.loaded / 1024 ** 2).toFixed(1),
                            total:
                              check.progress.total === null
                                ? '?'
                                : (check.progress.total / 1024 ** 2).toFixed(1),
                          })}
                        </p>
                        <div
                          role="progressbar"
                          aria-label={t(`cindyMakeDoctor.checks.${check.id}`)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={check.progress.percent ?? undefined}
                          className="h-1 overflow-hidden rounded-full bg-[var(--surface-chip)]"
                        >
                          <div
                            className="h-full bg-[var(--text-secondary)]"
                            style={{ width: `${check.progress.percent ?? 0}%` }}
                          />
                        </div>
                      </div>
                    )}
                    {details && (
                      <div className="ml-5 mt-1 space-y-1 break-words text-[var(--text-secondary)]">
                        <p>
                          {t(
                            `cindyMakeDoctor.requirements.${check.id === 'native' ? (report.platform === 'win32' ? 'nativeWin' : report.platform === 'darwin' ? 'nativeMac' : report.platform === 'linux' ? 'nativeLinux' : 'native') : check.id}`,
                            {
                              freeGiB: check.freeGiB ?? '?',
                              pythonMinor: report.platform === 'darwin' ? 10 : 9,
                            },
                          )}
                        </p>
                        {check.reason === 'timeout' && <p>{t('cindyMakeDoctor.timeout')}</p>}
                        {check.reason &&
                          ['downloadFailed', 'checksum', 'installFailed', 'busy'].includes(
                            check.reason,
                          ) && <p>{t(`cindyMake.prepare.errors.${check.reason}`)}</p>}
                        {check.status !== 'passed' &&
                          (check.id === 'native' ||
                            (check.id === 'git' &&
                              report.checks.find((row) => row.id === 'native')?.status ===
                                'passed')) && (
                            <MakeSystemGuidance platform={report.platform} tool={check.id} />
                          )}
                        {check.path && <p className="break-all font-mono text-12">{check.path}</p>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            className="text-left text-13 text-[var(--text-secondary)] underline underline-offset-2"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            {t(details ? 'cindyMakeDoctor.hideDetails' : 'cindyMakeDoctor.details')}
          </button>
          {(source || (upstream && showSource)) && (
            <div className="space-y-1 text-13">
              <p className="flex items-center gap-2 font-medium">
                <StepStatusIcon state={sourceStepState ?? 'pending'} />
                <span>{t('cindyMake.stepSource')}</span>
              </p>
              {source && (
                <>
                  {source.status !== 'preparing' && (
                    <p className="text-[var(--text-secondary)]">
                      {t(`cindyMake.source.${source.status}`)}
                    </p>
                  )}
                  {source.status === 'preparing' && source.phase === 'caching' && (
                    <CindyMakeDependencyProgress progress={source.dependencies} running cacheOnly />
                  )}
                  {source.status === 'preparing' &&
                    source.phase &&
                    source.phase !== 'caching' &&
                    !source.progress && (
                      <p className="text-[var(--text-secondary)]">
                        {t(`cindyMake.source.phase.${source.phase}`)}
                      </p>
                    )}
                  {source.status === 'preparing' && source.progress && (
                    <div
                      className="space-y-1 text-12 text-[var(--text-secondary)]"
                      aria-live="polite"
                    >
                      <div className="flex items-center gap-2">
                        <Spinner size={14} />
                        <span>{t(`cindyMake.source.gitProgress.${source.progress.stage}`)}</span>
                        <span className="text-[var(--text-tertiary)]">
                          ({source.progress.percent}%)
                        </span>
                      </div>
                      {source.progress.message && (
                        <p
                          className="truncate pl-5 font-mono text-11 text-[var(--text-tertiary)]"
                          title={source.progress.message}
                        >
                          {source.progress.message}
                        </p>
                      )}
                    </div>
                  )}
                  {source.error && (
                    <p className="text-[var(--status-danger)]">
                      {t(`cindyMake.source.errors.${source.error}`)}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {upstream && (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-13 font-medium">
                <StepStatusIcon state={upstreamStepState ?? 'pending'} />
                <span>{t('cindyMake.stepUpstream')}</span>
              </p>
              {upstream.status === 'pending' && (
                <p className="text-13 text-[var(--text-secondary)]">
                  {t('cindyMake.upstream.pending')}
                </p>
              )}
              {preparing && !decision && upstream.status === 'needsRequest' && !running && (
                <p className="text-13">{t('cindyMake.upstream.needRequest')}</p>
              )}
              {preparing && upstream.status !== 'pending' && upstream.status !== 'needsRequest' && (
                <div className="space-y-2 text-13">
                  {upstream.status === 'found' && (
                    <MakeUpstreamResults
                      key={report.runId}
                      items={upstream.items}
                      terms={upstream.terms}
                      runtime={upstream.runtime}
                    />
                  )}
                  {upstream.status === 'failed' && (
                    <p>{t(`cindyMake.upstream.failure.${upstream.failure ?? 'network'}`)}</p>
                  )}
                  {upstream.status === 'notFound' && <p>{t('cindyMake.upstream.notFoundHint')}</p>}
                  {upstream.runtime?.confidence === 'unknown' && (
                    <p className="text-[var(--text-secondary)]">
                      {t('cindyMake.upstream.runtimeUnknown')}
                    </p>
                  )}
                  {!!upstream.excludedIncluded && (
                    <p className="text-[var(--text-secondary)]">
                      {t('cindyMake.upstream.excludedIncluded', {
                        count: upstream.excludedIncluded,
                      })}
                    </p>
                  )}
                  {upstream.hasMore && (
                    <p className="text-[var(--text-secondary)]">
                      {t('cindyMake.upstream.limitedHint')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          {details && (
            <p className="text-12 text-[var(--text-secondary)]">
              {t(preparing ? 'cindyMake.prepare.limits' : 'cindyMakeDoctor.limits')}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] px-4 py-3">
        <div className={`min-w-0 flex-1 text-13 ${currentStatusClass}`} role="status">
          {startingCode && source?.status === 'ready' && (
            <Spinner size={14} className="mr-2 inline-flex" />
          )}
          {t(currentStatusKey)}
          {activeTool && ` · ${t(`cindyMakeDoctor.checks.${activeTool.id}`)}`}
          {!source && (!upstream || upstream.status === 'pending') && (
            <>
              {' · '}
              {passed}/{report.checks.length}
            </>
          )}
        </div>
        {!readOnly &&
          !decision &&
          (!queryFinished || !upstream) &&
          (!allPassed ||
            running ||
            alwaysAllowRecheck ||
            (onPrepare && hasInstallableMissing) ||
            onOpenToolsDir) && (
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              {onOpenToolsDir && (
                <Button variant="secondary" onClick={onOpenToolsDir}>
                  {t('settings.cindyMake.openToolsDir')}
                </Button>
              )}
              {!running && onPrepare && hasInstallableMissing && (
                <Button variant="secondary" onClick={onPrepare}>
                  {t('cindyMake.prepare.install')}
                </Button>
              )}
              <Button variant="secondary" onClick={running ? onStop : onRecheck}>
                {t(
                  queryFinished
                    ? 'cindyMake.upstream.retry'
                    : preparing
                      ? running
                        ? 'cindyMake.prepare.stop'
                        : 'cindyMake.prepare.retry'
                      : running
                        ? 'cindyMakeDoctor.stop'
                        : 'cindyMakeDoctor.recheck',
                )}
              </Button>
            </div>
          )}
        {!readOnly &&
          source?.status === 'ready' &&
          decision === 'personal' &&
          (onStartCode || onOpenCode) && (
            <Button variant="secondary" disabled={startingCode} onClick={onOpenCode ?? onStartCode}>
              {t(onOpenCode ? 'cindyMake.code.open' : 'cindyMake.code.start')}
            </Button>
          )}
        {!readOnly &&
          (upstream?.status === 'found' || upstream?.status === 'notFound') &&
          !decision &&
          !searching && (
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                disabled={!onChoose || startingCode}
                onClick={() => onChoose?.('wait')}
              >
                {t('cindyMake.upstream.wait')}
              </Button>
              <Button
                variant="primary"
                className="border-[var(--border-default)] enabled:hover:border-[var(--button-primary-hover)] enabled:active:border-[var(--button-primary-pressed)]"
                disabled={!onChoose || startingCode}
                loading={startingCode}
                onClick={() => onChoose?.('personal')}
              >
                {t('cindyMake.upstream.personal')}
              </Button>
            </div>
          )}
      </div>
    </section>
  );
}

function MakeUpstreamResults({
  items,
  terms,
  runtime,
}: {
  items: MakeUpstreamItem[];
  terms?: string[];
  runtime?: MakeRuntimeVersion;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>{t('cindyMake.upstream.count', { count: items.length })}</p>
        <Button
          variant="secondary"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )}
          {t(expanded ? 'cindyMake.upstream.collapse' : 'cindyMake.upstream.expand')}
        </Button>
      </div>
      <Collapse open={expanded} id={detailsId} inert={!expanded}>
        <div className="space-y-2">
          {runtime && (
            <p className="text-12 text-[var(--text-secondary)]">
              {t('cindyMake.upstream.runtimeVersion', {
                channel: t(`cindyMake.upstream.channel.${runtime.channel}`),
                version: runtime.version,
                commit: runtime.commit?.slice(0, 12) ?? t('cindyMake.upstream.unknownCommit'),
              })}
            </p>
          )}
          {terms?.length ? (
            <p className="text-12 text-[var(--text-secondary)]">
              {t('cindyMake.upstream.terms', { terms: terms.join(', ') })}
            </p>
          ) : null}
          <ul className="divide-y divide-[var(--border-default)]">
            {items.map((item) => (
              <MakeUpstreamResult key={item.kind + '-' + item.number} item={item} />
            ))}
          </ul>
          <p className="text-[var(--text-secondary)]">{t('cindyMake.upstream.resultHint')}</p>
        </div>
      </Collapse>
    </div>
  );
}

/** Compact handoff status shown inside the newly-created Cindy Make task. */
function CompactMakePreparationCard({
  report,
  onStop,
  onRecheck,
  readOnly,
}: {
  report: MakeDoctorReport;
  onStop: () => void;
  onRecheck: () => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const running = report.status === 'running';
  const failed = report.status === 'failed';
  const cancelled = report.status === 'cancelled';
  const statusKey = running
    ? 'cindyMake.code.preparingNpmDependencies'
    : failed
      ? 'cindyMake.prepare.failed'
      : cancelled
        ? 'cindyMake.prepare.cancelled'
        : 'cindyMake.prepare.passed';
  const source = report.source;
  return (
    <section
      className="w-full rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] text-14 text-[var(--text-primary)]"
      aria-label={t('cindyMake.code.taskName')}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <Wrench size={16} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
        <span className="font-medium">{t('cindyMake.code.taskName')}</span>
        {running && <Spinner size={14} className="ml-auto" />}
      </div>
      <div className="space-y-2 border-t border-[var(--border-default)] px-4 py-3">
        {source?.branch && (
          <p className="text-13">{t('cindyMake.code.workspace', { branch: source.branch })}</p>
        )}
        {source?.path && (
          <p className="break-all font-mono text-12 text-[var(--text-secondary)]">{source.path}</p>
        )}
        <p
          className={`flex items-center gap-2 text-13 ${failed ? 'text-[var(--status-danger)]' : cancelled ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}
          role="status"
        >
          {running ? <Spinner size={14} /> : failed ? <Minus size={14} /> : <Check size={14} />}
          <span>{t(statusKey)}</span>
        </p>
        {failed && source?.error && (
          <p className="text-12 text-[var(--status-danger)]">
            {t(`cindyMake.source.errors.${source.error}`)}
          </p>
        )}
      </div>
      {!readOnly && (running || failed || cancelled) && (
        <div className="flex justify-end gap-2 border-t border-[var(--border-default)] px-4 py-3">
          <Button variant="secondary" onClick={running ? onStop : onRecheck}>
            {t(running ? 'cindyMake.prepare.stop' : 'cindyMake.prepare.retry')}
          </Button>
        </div>
      )}
    </section>
  );
}

/** Each result keeps its own disclosure state; titles remain visible for scanning. */
function MakeUpstreamResult({ item }: { item: MakeUpstreamItem }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  return (
    <li className="py-1">
      <button
        type="button"
        className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDown size={14} className="mt-0.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight size={14} className="mt-0.5 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">
          {t(`cindyMake.upstream.kind.${item.kind}`)} #{item.number} · {item.title}
          {item.inclusion && (
            <span className="mt-1 block text-12 font-normal text-[var(--text-secondary)]">
              {t(
                item.draft ? 'cindyMake.upstream.draft' : `cindyMake.upstream.state.${item.state}`,
              )}
              {' · '}
              {t(`cindyMake.upstream.inclusion.${item.inclusion}`)}
            </span>
          )}
        </span>
      </button>
      <Collapse open={expanded} id={detailId} inert={!expanded}>
        <div className="space-y-2 px-2 pb-2 pl-8 text-[var(--text-secondary)]">
          <p>
            {t(`cindyMake.upstream.state.${item.state}`)}
            {item.author ? ` · ${t('cindyMake.upstream.author', { author: item.author })}` : ''}
            {item.updatedAt
              ? ` · ${t('cindyMake.upstream.updated', { date: new Date(item.updatedAt).toLocaleDateString() })}`
              : ''}
          </p>
          {item.summary && (
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {item.summary}
            </p>
          )}
          <a
            className="flex items-start gap-1 underline underline-offset-2"
            href={item.htmlUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              void window.electronAPI
                .openExternal(item.htmlUrl)
                .then((result) => {
                  if (!result.success) toast.error(t('cindyMakeDoctor.failed'));
                })
                .catch(() => toast.error(t('cindyMakeDoctor.failed')));
            }}
          >
            <span className="min-w-0 break-all">{item.htmlUrl}</span>
            <ExternalLink size={12} className="mt-1 shrink-0" aria-hidden />
          </a>
        </div>
      </Collapse>
    </li>
  );
}

/** Fixed OS installation instructions; clicks open documentation, never execute shell text. */
function MakeSystemGuidance({ platform, tool }: { platform: string; tool: 'native' | 'git' }) {
  const { t } = useTranslation();
  const kind =
    platform === 'darwin'
      ? 'mac'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32' && tool === 'native'
          ? 'windows'
          : null;
  if (!kind) return null;
  const url =
    kind === 'mac'
      ? 'https://developer.apple.com/xcode/resources/'
      : kind === 'linux'
        ? 'https://github.com/nodejs/node-gyp#on-unix'
        : 'https://visualstudio.microsoft.com/visual-cpp-build-tools/';
  return (
    <div className="space-y-1">
      <p>{t(`cindyMake.prepare.guidance.${kind}`)}</p>
      {kind === 'mac' && (
        <code className="block select-text whitespace-pre-wrap break-all text-12">
          xcode-select --install
        </code>
      )}
      {kind === 'linux' && (
        <code className="block select-text whitespace-pre-wrap break-all text-12">
          {
            'Debian / Ubuntu: sudo apt install git build-essential\nFedora: sudo dnf install git gcc-c++ make\nArch: sudo pacman -S git base-devel'
          }
        </code>
      )}
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          void window.electronAPI
            .openExternal(url)
            .then((result) => {
              if (!result.success) toast.error(t('cindyMakeDoctor.failed'));
            })
            .catch(() => toast.error(t('cindyMakeDoctor.failed')));
        }}
      >
        {t('cindyMake.prepare.installGuide')}
      </Button>
    </div>
  );
}
