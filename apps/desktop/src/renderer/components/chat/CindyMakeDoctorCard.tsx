import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ExternalLink, Minus, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { cancelMakeDoctor } from '@/lib/cindyMakeDoctor';
import { toast } from '@/lib/toast';
import {
  isMakeEnvironmentReady,
  type MakeDoctorReport,
  type MakeUpstreamDecision,
} from '../../../shared/cindyMakeDoctor';

export function CindyMakeDoctorCard({
  data,
  sessionId,
}: {
  data?: Record<string, unknown>;
  sessionId?: string;
}) {
  const report = data?.report as MakeDoctorReport | undefined;
  const { t } = useTranslation();
  if (!report) return null;
  const recheck = (request?: string) => {
    if (!sessionId) return;
    const owner = getDataOwnerGeneration();
    void import('@/lib/cindyMakeDoctorStream')
      .then(({ startMakeDoctorInStream }) => {
        if (isDataOwnerGenerationCurrent(owner))
          startMakeDoctorInStream(sessionId, {
            retryRunId: report.runId,
            ...(request !== undefined ? { request } : {}),
          });
      })
      .catch(() => {
        if (isDataOwnerGenerationCurrent(owner)) toast.error(t('cindyMakeDoctor.failed'));
      });
  };
  return (
    <MakeDoctorReportCard
      report={report}
      request={typeof data?.request === 'string' ? data.request : undefined}
      decision={
        data?.decision === 'wait' || data?.decision === 'personal' ? data.decision : undefined
      }
      onSearch={recheck}
      onChoose={(choice) => {
        if (!sessionId) return;
        const owner = getDataOwnerGeneration();
        void import('@/lib/cindyMakeDoctorStream')
          .then(({ chooseMakeUpstream }) => {
            if (isDataOwnerGenerationCurrent(owner))
              chooseMakeUpstream(sessionId, report.runId, choice);
          })
          .catch(() => {
            if (isDataOwnerGenerationCurrent(owner)) toast.error(t('cindyMakeDoctor.failed'));
          });
      }}
      onRecheck={() => recheck()}
      onStop={() => {
        void cancelMakeDoctor(report.runId, report.mode).catch(() =>
          toast.error(t('cindyMakeDoctor.failed')),
        );
      }}
    />
  );
}

/** DESIGN.md §4/§5: flat 12px card, semantic surfaces, compact expandable detail. */
export function MakeDoctorReportCard({
  report,
  request,
  decision,
  onSearch,
  onChoose,
  onStop,
  onRecheck,
  onPrepare,
  onOpenToolsDir,
  alwaysAllowRecheck = false,
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
  alwaysAllowRecheck?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [details, setDetails] = useState(false);
  const [upstreamExpanded, setUpstreamExpanded] = useState(false);
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
  useEffect(() => {
    setUpstreamExpanded(false);
  }, [report.runId, upstream?.status]);
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
  return (
    <section
      className="w-full rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] text-14 text-[var(--text-primary)]"
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
      </div>
      <div className="px-4 pb-3 text-13 text-[var(--text-secondary)]" role="status">
        {t(
          decision
            ? `cindyMake.upstream.choice.${decision}`
            : upstream && ready
              ? `cindyMake.upstream.${upstream.status}`
              : preparing
                ? `cindyMake.prepare.${status}`
                : `cindyMakeDoctor.${status}`,
        )}
        {activeTool && ` · ${t(`cindyMakeDoctor.checks.${activeTool.id}`)}`}
        {' · '}
        {passed}/{report.checks.length}
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-[var(--border-default)] px-4 py-3">
          {request && (
            <div className="space-y-1 text-13">
              <p className="text-[var(--text-secondary)]">{t('cindyMake.request')}</p>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{request}</p>
            </div>
          )}
          {upstream && (
            <p className="text-13 font-medium">
              {t('cindyMake.stepEnvironment')}
              {ready && <Check size={14} className="ml-2 inline" aria-hidden />}
            </p>
          )}
          {(!upstream || !ready || details) && (
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
                    {(details ||
                      ['missing', 'incompatible', 'failed', 'warning'].includes(check.status)) && (
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
            className="text-13 text-[var(--text-secondary)] underline underline-offset-2"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            {t(details ? 'cindyMakeDoctor.hideDetails' : 'cindyMakeDoctor.details')}
          </button>
          {upstream && <p className="text-13 font-medium">{t('cindyMake.stepUpstream')}</p>}
          {upstream?.status === 'pending' && (
            <p className="text-13 text-[var(--text-secondary)]">
              {t('cindyMake.upstream.pending')}
            </p>
          )}
          {preparing && upstream && !decision && upstream.status === 'needsRequest' && !running && (
            <p className="text-13">{t('cindyMake.upstream.needRequest')}</p>
          )}
          {preparing &&
            upstream &&
            upstream.status !== 'pending' &&
            upstream.status !== 'needsRequest' && (
              <div className="space-y-2 text-13">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">
                    {t(
                      upstream.status === 'found'
                        ? 'cindyMake.upstream.count'
                        : `cindyMake.upstream.${searching ? 'searching' : upstream.status}`,
                      { count: upstream.items.length },
                    )}
                  </p>
                  {!searching && (
                    <button
                      type="button"
                      className="shrink-0 text-[var(--text-secondary)] underline underline-offset-2"
                      aria-expanded={upstreamExpanded}
                      onClick={() => setUpstreamExpanded(!upstreamExpanded)}
                    >
                      {t(
                        upstreamExpanded
                          ? 'cindyMake.upstream.collapse'
                          : 'cindyMake.upstream.expand',
                      )}
                    </button>
                  )}
                </div>
                {upstreamExpanded && (
                  <div className="space-y-2">
                    {upstream.terms?.length ? (
                      <p className="text-12 text-[var(--text-secondary)]">
                        {t('cindyMake.upstream.terms', { terms: upstream.terms.join(', ') })}
                      </p>
                    ) : null}
                    {upstream.items.map((item) => (
                      <div
                        key={`${item.kind}-${item.number}`}
                        className="space-y-1 border-t border-[var(--border-default)] pt-2"
                      >
                        <a
                          className="flex items-start gap-1 break-words [overflow-wrap:anywhere] font-medium underline"
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
                          <span className="min-w-0">
                            {t(`cindyMake.upstream.kind.${item.kind}`)} #{item.number} ·{' '}
                            {item.title}
                          </span>
                          <ExternalLink size={12} className="mt-1 shrink-0" aria-hidden />
                        </a>
                        <p className="text-[var(--text-secondary)]">
                          {t(`cindyMake.upstream.state.${item.state}`)}
                          {item.author
                            ? ` · ${t('cindyMake.upstream.author', { author: item.author })}`
                            : ''}
                          {item.updatedAt
                            ? ` · ${t('cindyMake.upstream.updated', { date: new Date(item.updatedAt).toLocaleDateString() })}`
                            : ''}
                        </p>
                        {item.summary && (
                          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--text-secondary)]">
                            {item.summary}
                          </p>
                        )}
                      </div>
                    ))}
                    {upstream.status === 'failed' && (
                      <p>{t(`cindyMake.upstream.failure.${upstream.failure ?? 'network'}`)}</p>
                    )}
                    {upstream.status === 'notFound' && (
                      <p>{t('cindyMake.upstream.notFoundHint')}</p>
                    )}
                    {upstream.status === 'found' && (
                      <p className="text-[var(--text-secondary)]">
                        {t('cindyMake.upstream.resultHint')}
                      </p>
                    )}
                    {(upstream.status === 'found' || upstream.status === 'notFound') &&
                      !decision &&
                      !searching && (
                        <div className="flex flex-wrap justify-end gap-2 pt-1">
                          <Button
                            variant="secondary"
                            disabled={!onChoose}
                            onClick={() => onChoose?.('wait')}
                          >
                            {t('cindyMake.upstream.wait')}
                          </Button>
                          <Button
                            variant="primary"
                            disabled={!onChoose}
                            onClick={() => onChoose?.('personal')}
                          >
                            {t('cindyMake.upstream.personal')}
                          </Button>
                        </div>
                      )}
                    {decision && (
                      <p className="text-[var(--text-secondary)]">
                        {t(`cindyMake.upstream.decisionHint.${decision}`)}
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
          {!decision &&
            (!allPassed ||
              queryFinished ||
              running ||
              alwaysAllowRecheck ||
              (onPrepare && hasInstallableMissing) ||
              onOpenToolsDir) && (
              <div className="flex justify-end">
                <div className="flex flex-wrap justify-end gap-2">
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
              </div>
            )}
        </div>
      )}
    </section>
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
