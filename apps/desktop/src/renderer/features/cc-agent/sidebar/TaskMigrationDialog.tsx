import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { TaskMigrationRequest, TaskMigrationView } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import type { TaskMoveDestination } from './TaskMoveSubmenu';
import { Button } from '@/components/ui/button';
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
}: {
  session: Session;
  onDismiss(): void;
  destination?: TaskMoveDestination;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [devices, setDevices] = useState<DeviceLinkDeviceView[]>([]);
  const [target, setTarget] = useState(destination?.deviceId ?? '');
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState(destination?.project ?? '');
  const [status, setStatus] = useState<TaskMigrationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [readyTarget, setReadyTarget] = useState('');
  const [error, setError] = useState('');
  const [self, setSelf] = useState('');
  const pending = useRef(false);
  const mutationEpoch = useRef(0);
  const owner = useRef(getDataOwnerGeneration()).current;
  const live = useRef(true);
  const current = () => live.current && isDataOwnerGenerationCurrent(owner);
  const request = (command: TaskMigrationRequest) =>
    window.electronAPI.deviceLink.taskMigration(session.deviceLinkDeviceId ?? null, command);
  const showError = (e: unknown) => {
    if (current())
      setError(
        /\bMIGRATION_[A-Z_]+\b/.exec(e instanceof Error ? e.message : String(e))?.[0] ??
          'MIGRATION_FAILED',
      );
  };
  useEffect(() => {
    live.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const epoch = mutationEpoch.current;
      try {
        const next = await request({ action: 'status', sessionId: session.id });
        if (!disposed && current() && epoch === mutationEpoch.current && !pending.current)
          setStatus(next);
      } catch (e) {
        if (!disposed) showError(e);
      }
      if (!disposed && current()) timer = setTimeout(() => void poll(), 2000);
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
  const act = async (command: TaskMigrationRequest) => {
    if (pending.current || !current()) return;
    pending.current = true;
    mutationEpoch.current++;
    setBusy(true);
    setError('');
    try {
      const next = await request(command);
      if (current()) setStatus(next);
    } catch (e) {
      showError(e);
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };
  const started = !!status?.stage && !['cancelled', 'active'].includes(status.stage);
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
      if (current()) setBusy(false);
    }
  };
  const failure = error || status?.error;
  const errorKey =
    failure && t(`taskMigration.errors.${failure}`, { defaultValue: t('taskMigration.failed') });
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
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
        >
          <Dialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
            {t('taskMigration.title')}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--confirm-desc)]">
            {t('taskMigration.description')}
          </Dialog.Description>
          {!started && destination && (
            <div className="mt-4 space-y-2 text-sm text-[var(--confirm-title)]">
              <p>
                {t('taskMigration.device')}: {destination.deviceName}
              </p>
              <p className="break-all">
                {t('taskMigration.project')}:{' '}
                {destination.project ?? t('taskMigration.defaultFolder')}
              </p>
              <p className="text-[var(--confirm-desc)]">{t('taskMigration.newFolder')}</p>
            </div>
          )}
          {!started && !destination && (
            <div className="mt-4 flex flex-col gap-3">
              <p className="text-sm text-[var(--confirm-desc)]">{t('taskMigration.limits')}</p>
              <FormField label={t('taskMigration.device')}>
                {(control) => (
                  <Select
                    {...control}
                    label={t('taskMigration.device')}
                    value={target}
                    disabled={busy}
                    options={devices.map((d) => ({ value: d.deviceId, label: d.name }))}
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
          {started && (
            <p className="mt-4 text-sm text-[var(--confirm-title)]" role="status">
              {t(`taskMigration.stages.${status?.stage}`)}
            </p>
          )}
          {failure && (
            <p className="mt-3 text-sm text-[var(--error-fg)]" role="alert">
              {errorKey}
            </p>
          )}
          {started && (
            <p className="mt-3 text-sm text-[var(--confirm-desc)]">
              {t('taskMigration.background')}
            </p>
          )}
          {status?.stage === 'complete' && status.targetSessionId && (
            <div className="mt-3">
              <Button disabled={busy} onClick={() => void openTarget()}>
                {t('taskMigration.openTarget')}
              </Button>
            </div>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onDismiss}>
              {t('taskMigration.close')}
            </Button>
            {started &&
              !status?.running &&
              ['preparing', 'transferring', 'moved'].includes(status?.stage ?? '') && (
                <>
                  {status?.stage === 'preparing' && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void act({ action: 'cancel', sessionId: session.id })}
                    >
                      {t('taskMigration.cancel')}
                    </Button>
                  )}
                  <Button
                    disabled={busy}
                    onClick={() => void act({ action: 'retry', sessionId: session.id })}
                  >
                    {t('taskMigration.retry')}
                  </Button>
                </>
              )}
            {!started && (
              <Button
                disabled={!status || busy || readyTarget !== target || !target}
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
