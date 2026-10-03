import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  TASK_MIGRATION_MAX_FILES,
  type TaskMigrationRequest,
  type TaskMigrationView,
} from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import type { TaskMoveDestination } from './TaskMoveSubmenu';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Select } from '@/components/ui/select';
import { FormField } from '@/components/ui/form-field';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';

export function TaskMigrationDialog({
  session,
  onDismiss,
  destination,
  initialStatus,
}: {
  session: Session;
  onDismiss(): void;
  destination?: TaskMoveDestination;
  /**
   * The caller's latest status when reopening an existing copy (no `destination`). Without it the
   * dialog would show the start form until its first poll returns.
   */
  initialStatus?: TaskMigrationView | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [devices, setDevices] = useState<DeviceLinkDeviceView[]>([]);
  const [target, setTarget] = useState(destination?.deviceId ?? '');
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState(destination?.project ?? '');
  const [status, setStatus] = useState<TaskMigrationView | null>(
    destination ? null : (initialStatus ?? null),
  );
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [readyTarget, setReadyTarget] = useState('');
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [self, setSelf] = useState('');
  const [estimate, setEstimate] = useState<TaskMigrationView['estimate']>();
  const [estimateError, setEstimateError] = useState('');
  const pending = useRef(false);
  const observingCopy = useRef(!destination);
  const previousCopy = useRef<string | undefined>(undefined);
  const mutationEpoch = useRef(0);
  const owner = useRef(getDataOwnerGeneration()).current;
  const live = useRef(true);
  const current = () => live.current && isDataOwnerGenerationCurrent(owner);
  const request = (command: TaskMigrationRequest) =>
    window.electronAPI.deviceLink.taskMigration(session.deviceLinkDeviceId ?? null, command);
  const errorCode = (e: unknown) =>
    /\bMIGRATION_[A-Z_]+\b/.exec(e instanceof Error ? e.message : String(e))?.[0] ??
    'MIGRATION_FAILED';
  const showError = (e: unknown) => {
    if (current()) setError(errorCode(e));
  };
  useEffect(() => {
    live.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const epoch = mutationEpoch.current;
      try {
        const next = await request({ action: 'status', sessionId: session.id });
        if (!disposed && current() && epoch === mutationEpoch.current && !pending.current) {
          if (!observingCopy.current) {
            if (epoch === 0) previousCopy.current = next.targetSessionId;
            const newCopy =
              epoch > 0 && next.targetSessionId && next.targetSessionId !== previousCopy.current;
            const unfinished =
              next.stage && !['complete', 'active', 'cancelled'].includes(next.stage);
            if (newCopy || unfinished) {
              observingCopy.current = true;
              // A changed copy ID recovers a lost start acknowledgement, even if already complete.
              if (newCopy) setError('');
            }
          }
          // A fresh menu selection starts a new copy, not the previous success screen.
          setStatus(observingCopy.current ? next : { supported: true, deviceId: next.deviceId });
          setPollError('');
        }
      } catch (e) {
        if (!disposed && current() && epoch === mutationEpoch.current && !pending.current)
          setPollError(errorCode(e));
      }
      if (!disposed && current()) timer = setTimeout(() => void poll(), 1000);
    };
    void Promise.all([
      window.electronAPI.deviceLink.listDevices(),
      window.electronAPI.deviceLink.taskMigration(null, { action: 'caps' }),
      request({ action: 'caps' }),
    ])
      .then(([list, local, source]) => {
        if (disposed || !current()) return;
        setSelf(local.deviceId);
        setDevices(
          list.devices.filter(
            (d) =>
              d.deviceId !== source.deviceId &&
              d.online &&
              d.remoteControlEnabled &&
              d.controlEnabled &&
              !['ios', 'android'].includes(d.platform ?? ''),
          ),
        );
      })
      .catch((e) => {
        if (!disposed) showError(e);
      });
    void poll();
    return () => {
      disposed = true;
      live.current = false;
      clearTimeout(timer);
    };
  }, [session.id, session.deviceLinkDeviceId]);
  useEffect(() => {
    let disposed = false;
    setReadyTarget('');
    setProjects([]);
    setProject(destination?.project ?? '');
    if (target)
      void window.electronAPI.deviceLink
        .taskMigration(destination?.isSelf || target === self ? null : target, { action: 'caps' })
        .then((caps) => {
          if (!disposed && current()) {
            setProjects(caps.projects ?? []);
            setReadyTarget(target);
            setError('');
          }
        })
        .catch((e) => {
          if (!disposed) showError(e);
        });
    return () => {
      disposed = true;
    };
  }, [target, self]);
  const act = async (command: TaskMigrationRequest, dismissOnSuccess = false) => {
    if (pending.current || !current()) return;
    pending.current = true;
    mutationEpoch.current++;
    setStarting(command.action === 'start');
    setBusy(true);
    setError('');
    try {
      const next = await request(command);
      if (current()) {
        if (command.action === 'start') observingCopy.current = true;
        setStatus(next);
        if (dismissOnSuccess) onDismiss();
      }
    } catch (e) {
      showError(e);
    } finally {
      pending.current = false;
      if (current()) {
        setBusy(false);
        setStarting(false);
      }
    }
  };
  const started = !!status?.stage && !['cancelled', 'active', 'complete'].includes(status.stage);
  const openTarget = async () => {
    if (!status?.targetSessionId || !status.targetDeviceId || pending.current || !current()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const device = status.targetDeviceId,
        id = status.targetSessionId;
      if (device !== self) {
        await window.electronAPI.deviceLink.openLink(device);
        if (!current()) return;
        const valid = remoteProjectsStore.captureSessionRead(device, id);
        const row = (await window.electronAPI.deviceLink.invoke(device, 'local-db:sessions:get', [
          id,
        ])) as Session;
        if (!current()) return;
        if (!valid() || row?.id !== id) throw new Error('MIGRATION_TARGET_NOT_READY');
        remoteProjectsStore.mergeDeviceSessions(
          device,
          devices.find((d) => d.deviceId === device)?.name ?? device,
          [valid.mergeActivity(row)],
        );
      }
      navigate('/cc-agent/' + encodeURIComponent(id));
      onDismiss();
    } catch (e) {
      showError(e);
    } finally {
      pending.current = false;
      if (current()) {
        setBusy(false);
        setStarting(false);
      }
    }
  };
  const complete = status?.stage === 'complete' || status?.stage === 'active';
  const copying = starting || !!status?.running;
  const failure =
    error || pollError || status?.error || (started && !copying ? 'MIGRATION_FAILED' : '');
  const confirming = !started && !complete && !failure && !busy;
  useEffect(() => {
    if (!confirming) return;
    let disposed = false;
    setEstimate(undefined);
    setEstimateError('');
    void request({ action: 'caps' })
      .then(async (caps) => {
        if (!caps.copyEstimate) throw new Error('Estimate unavailable');
        return request({ action: 'estimate', sessionId: session.id });
      })
      .then((result) => {
        if (
          !result.estimate ||
          !Number.isSafeInteger(result.estimate.fileCount) ||
          result.estimate.fileCount < 0 ||
          !Number.isSafeInteger(result.estimate.bytes) ||
          result.estimate.bytes < 0
        )
          throw new Error('Invalid estimate');
        if (!disposed && current()) setEstimate(result.estimate);
      })
      .catch((e: unknown) => {
        if (!disposed && current()) setEstimateError(errorCode(e));
      });
    return () => {
      disposed = true;
    };
  }, [confirming, session.id, session.deviceLinkDeviceId]);
  const displayDevice =
    status?.targetDeviceId && observingCopy.current ? status.targetDeviceId : target;
  const computerName =
    displayDevice === self || (displayDevice === destination?.deviceId && destination?.isSelf)
      ? t('taskMigration.thisComputer')
      : (devices.find((device) => device.deviceId === displayDevice)?.name ??
        (displayDevice === destination?.deviceId
          ? destination.deviceName
          : t('taskMigration.selectedComputer')));
  const closeCancels = started && !status?.running;
  const cancelling = copying && !!status?.cancelling;
  const cancelRequested = useRef(false);
  const cancelCopy = () => {
    cancelRequested.current = true;
    void act({ action: 'cancel', sessionId: session.id });
  };
  useEffect(() => {
    // The running copy unwinds asynchronously; close once it has fully stopped.
    if (cancelRequested.current && status?.stage === 'cancelled' && !status.running) onDismiss();
  }, [status?.stage, status?.running]);
  const dismiss = () => {
    if (pending.current) return;
    // Closing never stops a running copy; the source task header reopens this view.
    if (copying) onDismiss();
    else if (closeCancels) void act({ action: 'cancel', sessionId: session.id }, true);
    else onDismiss();
  };
  const progress = status?.progress;
  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.max(0, Math.floor((progress.sentBytes / progress.totalBytes) * 100)))
      : undefined;
  const bytes = (value: number) => {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(Math.max(0, value) / 1024).toFixed(1)} KB`;
  };
  const estimateText =
    estimateError === 'MIGRATION_TIMEOUT'
      ? t('taskMigration.estimateTimeout')
      : estimateError === 'MIGRATION_TOO_MANY_FILES'
        ? t('taskMigration.estimateTooManyFiles', { limit: TASK_MIGRATION_MAX_FILES })
        : estimateError === 'MIGRATION_FAILED'
          ? t('taskMigration.estimateFailed')
          : estimateError
            ? // The source refused for a stated reason (e.g. queued input); never blame the connection.
              t(`taskMigration.errors.${estimateError}`, {
                defaultValue: t('taskMigration.estimateFailedWithCode', { code: estimateError }),
              })
            : estimate
              ? t('taskMigration.fileSummary', {
                  count: estimate.fileCount,
                  size: bytes(estimate.bytes),
                })
              : t('taskMigration.estimating');
  const errorKey =
    failure &&
    t(`taskMigration.errors.${failure}`, {
      // The code is the only lead once the dialog closes; keep it visible for unmapped errors.
      defaultValue: t('taskMigration.failed', { code: failure }),
    });
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
          onClick={(e) => e.stopPropagation()}
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[10000] w-[calc(100%-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-[var(--confirm-bg)] p-4 shadow-[var(--confirm-shadow)] [-webkit-app-region:no-drag]"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          // 按 DESIGN.md 关闭规则:点遮罩不关闭,只能用取消按钮或 Esc。
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
            {t(
              complete
                ? 'taskMigration.successTitle'
                : copying
                  ? 'taskMigration.copyingTitle'
                  : failure
                    ? 'taskMigration.failureTitle'
                    : 'taskMigration.title',
              { name: computerName },
            )}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--confirm-desc)]">
            {complete
              ? t('taskMigration.successDescription', { name: computerName })
              : copying
                ? t('taskMigration.keepOpen', { name: computerName })
                : failure
                  ? t('taskMigration.failureDescription')
                  : t('taskMigration.description', { name: computerName })}
          </Dialog.Description>
          {complete && status?.skipped && (
            <div className="mt-3 text-sm text-[var(--confirm-desc)]">
              <p>{t('taskMigration.skippedTitle', { count: status.skipped.total })}</p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                {status.skipped.entries.map((entry) => (
                  <li key={entry.path} className="break-all">
                    <span className="text-[var(--confirm-title)]">{entry.path}</span>
                    {' · '}
                    {t(`taskMigration.skippedReasons.${entry.code}`, {
                      defaultValue: entry.code,
                    })}
                  </li>
                ))}
              </ul>
              {status.skipped.total > status.skipped.entries.length && (
                <p className="mt-1">
                  {t('taskMigration.skippedMore', {
                    count: status.skipped.total - status.skipped.entries.length,
                  })}
                </p>
              )}
            </div>
          )}
          {confirming && (
            <p className="mt-2 text-sm text-[var(--confirm-desc)]">
              {t('taskMigration.bindingsNotice')}
            </p>
          )}
          {confirming && destination && (
            <div className="mt-4 space-y-2 text-sm text-[var(--confirm-title)]">
              <p className="break-all">
                {t('taskMigration.project')}:{' '}
                {destination.project ?? t('taskMigration.defaultFolder')}
              </p>
              <p className="text-[var(--confirm-desc)]">{t('taskMigration.newFolder')}</p>
            </div>
          )}
          {confirming && !destination && (
            <div className="mt-4 flex flex-col gap-3">
              <p className="text-sm text-[var(--confirm-desc)]">{t('taskMigration.limits')}</p>
              <FormField label={t('taskMigration.device')}>
                {(control) => (
                  <Select
                    {...control}
                    label={t('taskMigration.device')}
                    value={target}
                    disabled={busy}
                    options={devices.map((d) => ({
                      value: d.deviceId,
                      label:
                        d.isSelf || d.deviceId === self
                          ? `${d.name} · ${t('settings.devices.thisDevice')}`
                          : d.name,
                    }))}
                    onValueChange={setTarget}
                  />
                )}
              </FormField>
              {!devices.length && (
                <p className="text-sm text-[var(--confirm-desc)]">{t('taskMigration.noDevices')}</p>
              )}
              <FormField label={t('taskMigration.project')} hint={t('taskMigration.newFolder')}>
                {(control) => (
                  <Select
                    {...control}
                    label={t('taskMigration.project')}
                    value={project || '__default__'}
                    disabled={busy || !target || readyTarget !== target}
                    options={[
                      { value: '__default__', label: t('taskMigration.defaultFolder') },
                      ...projects.map((p) => ({ value: p, label: p })),
                    ]}
                    onValueChange={(value) => setProject(value === '__default__' ? '' : value)}
                  />
                )}
              </FormField>
            </div>
          )}
          {confirming && (
            <div className="mt-4 text-sm">
              <p
                role="status"
                className={estimateError ? 'text-[var(--error-fg)]' : 'text-[var(--confirm-title)]'}
              >
                {estimateText}
              </p>
              {estimate && (
                <p className="mt-2 text-[var(--confirm-desc)]">{t('taskMigration.estimateNote')}</p>
              )}
            </div>
          )}
          {copying && (
            <div className="mt-4 space-y-2">
              <p
                className="flex items-center gap-2 text-sm text-[var(--confirm-title)]"
                role="status"
              >
                <Spinner size={14} className="shrink-0 text-[var(--confirm-desc)]" />
                {t(
                  cancelling
                    ? 'taskMigration.cancelling'
                    : progress?.phase === 'finishing'
                      ? 'taskMigration.finishing'
                      : `taskMigration.stages.${status?.stage ?? 'preparing'}`,
                  { name: computerName },
                )}
              </p>
              <div
                role="progressbar"
                aria-label={t('taskMigration.copyingTitle', { name: computerName })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-chip)]"
              >
                {percent !== undefined && (
                  <div
                    className="h-full rounded-full bg-[var(--accent-cta-bg)] transition-[width] duration-[var(--motion-base)] ease-[var(--motion-ease-move)]"
                    style={{ width: `${percent}%` }}
                  />
                )}
              </div>
              {progress?.phase === 'sending' && !cancelling && (
                <p className="text-sm tabular-nums text-[var(--confirm-desc)]">
                  {t('taskMigration.transferProgress', {
                    sent: bytes(progress.sentBytes),
                    total: bytes(progress.totalBytes),
                    speed: bytes(progress.bytesPerSecond),
                  })}
                </p>
              )}
            </div>
          )}
          {failure && (
            <p className="mt-3 text-sm text-[var(--error-fg)]" role="alert">
              {errorKey}
              {/* The path belongs to the source's recorded error, never to a local action error. */}
              {failure === status?.error && status.errorPath && (
                <span className="mt-1 block break-all">
                  {t('taskMigration.errorPath', { path: status.errorPath })}
                </span>
              )}
              {failure === status?.error && status.errorSize && (
                <span className="mt-1 block">
                  {t('taskMigration.errorSize', {
                    needed: bytes(status.errorSize.needed),
                    limit: bytes(status.errorSize.limit),
                  })}
                </span>
              )}
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {copying ? (
              <>
                {status?.cancellable && (
                  <Button variant="secondary" disabled={busy} onClick={cancelCopy}>
                    {t('taskMigration.cancelCopy')}
                  </Button>
                )}
                <Button variant="secondary" disabled={busy} onClick={dismiss}>
                  {t('taskMigration.runInBackground')}
                </Button>
              </>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={dismiss}>
                {t(confirming ? 'taskMigration.cancel' : 'taskMigration.close')}
              </Button>
            )}
            {complete && status?.targetSessionId && (
              <Button disabled={busy} onClick={() => void openTarget()}>
                {t('taskMigration.openTarget')}
              </Button>
            )}
            {confirming && (
              <Button
                disabled={!status || !estimate || busy || readyTarget !== target || !target}
                onClick={() =>
                  void act({
                    action: 'start',
                    sessionId: session.id,
                    targetDeviceId: target,
                    targetProject: project || null,
                  })
                }
              >
                {t('taskMigration.start')}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
