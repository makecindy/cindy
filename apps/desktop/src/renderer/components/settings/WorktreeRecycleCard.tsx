import { worktreeRecycleCardSettings } from './WorktreeRecycleCard.settings-search';
import { ErrorNotice } from '@/components/ui/error-notice';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  forgetPendingRemotePrecreatedWorktree,
  getRemoteWorktreeCleanupPendingMessage,
  isRemotePrecreatedWorktreeOwnerChangedError,
  recoverSinglePendingRemotePrecreatedWorktree,
  type PendingRemotePrecreatedWorktree,
} from '@/features/cc-agent/remotePrecreatedWorktree';
import { deviceDisplayName } from '@/lib/deviceName';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceNameSource } from '@cindy/maker-shared/device-list';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import type { WorktreeRecycleStatus } from '../../../shared/worktreeRecycle';

function remoteRecordKey(record: PendingRemotePrecreatedWorktree): string {
  return `${record.deviceId}:${record.sessionId}:${record.createdAt}`;
}

export function WorktreeRecycleCard() {
  const { t } = useTranslation();
  const confirmDialog = useOptionalConfirmDialog();
  const [rows, setRows] = useState<WorktreeRecycleStatus[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [remoteRecords, setRemoteRecords] = useState<PendingRemotePrecreatedWorktree[]>([]);
  const [remoteStorageReadable, setRemoteStorageReadable] = useState(true);
  const [knownDevices, setKnownDevices] = useState<readonly DeviceNameSource[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const loading = useRef(false);
  const refreshQueued = useRef(false);
  const controlBusy = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (loading.current) { refreshQueued.current = true; return; }
    loading.current = true;
    try {
      const localPromise = window.electronAPI.worktreeRecycle.list()
        .then((nextRows) => {
          setRows(nextRows);
          setFailed(false);
        })
        .catch(() => {
          setFailed(true);
        });

      const remoteLedgerApi = window.electronAPI?.remotePrecreatedWorktreeLedger;
      const remotePromise = remoteLedgerApi?.list
        ? remoteLedgerApi.list()
          .then(async (snapshot) => {
            setRemoteRecords(snapshot.records);
            setRemoteStorageReadable(snapshot.storageReadable);
            if (snapshot.records.length > 0 && window.electronAPI?.deviceLink?.listDevices) {
              try {
                const listed = await window.electronAPI.deviceLink.listDevices();
                if (Array.isArray(listed?.devices)) {
                  setKnownDevices(listed.devices);
                }
              } catch {
                // Device list is only used to enrich display names; fall back to stored name/ID.
              }
            }
          })
          .catch(() => {
            setRemoteRecords([]);
            setRemoteStorageReadable(false);
          })
        : Promise.resolve();

      await Promise.all([localPromise, remotePromise]);
    } finally {
      loading.current = false;
      if (refreshQueued.current) { refreshQueued.current = false; void refresh(); }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const control = async (row: WorktreeRecycleStatus, action: 'retry' | 'keep') => {
    if (controlBusy.current) return;
    controlBusy.current = true;
    setBusy(`local:${row.id}`);
    try {
      await window.electronAPI.worktreeRecycle.control({ id: row.id, generation: row.generation, action });
      await refresh();
    } catch { toast.error(t('settings.worktreeRecycle.actionFailed')); }
    finally { controlBusy.current = false; setBusy(null); }
  };

  const retryRemote = async (record: PendingRemotePrecreatedWorktree) => {
    if (controlBusy.current) return;
    const invokeRemote = window.electronAPI?.deviceLink?.invoke;
    if (!invokeRemote) {
      toast.error(t('settings.worktreeRecycle.actionFailed'));
      return;
    }
    const ownerAtStart = getDataOwnerGeneration();
    const isCurrent = () => isDataOwnerGenerationCurrent(ownerAtStart);
    controlBusy.current = true;
    setBusy(`remote:${remoteRecordKey(record)}`);
    try {
      const result = await recoverSinglePendingRemotePrecreatedWorktree({
        record,
        invoke: (channel, args) => invokeRemote(record.deviceId, channel, args),
        isCurrent,
      });
      if (result.recovered) {
        toast.success(t('settings.worktreeRecycle.remote.retrySuccess'));
      } else {
        toast.error(getRemoteWorktreeCleanupPendingMessage(result, t));
      }
      await refresh();
    } catch (err) {
      if (!isRemotePrecreatedWorktreeOwnerChangedError(err)) {
        toast.error(t('settings.worktreeRecycle.actionFailed'));
      }
    } finally {
      controlBusy.current = false;
      setBusy(null);
    }
  };

  const keepRemote = async (record: PendingRemotePrecreatedWorktree, deviceLabel: string) => {
    if (controlBusy.current) return;
    const ownerAtStart = getDataOwnerGeneration();
    const isCurrent = () => isDataOwnerGenerationCurrent(ownerAtStart);
    if (confirmDialog) {
      const confirmed = await confirmDialog.confirm({
        title: t('settings.worktreeRecycle.remote.confirmKeepTitle'),
        description: t('settings.worktreeRecycle.remote.confirmKeepDescription', { device: deviceLabel }),
        confirmText: t('settings.worktreeRecycle.remote.confirmKeepConfirm'),
      });
      if (!confirmed || !isCurrent()) return;
    }
    if (controlBusy.current) return;
    controlBusy.current = true;
    setBusy(`remote:${remoteRecordKey(record)}`);
    try {
      const persisted = await forgetPendingRemotePrecreatedWorktree(record, isCurrent);
      if (persisted) {
        toast.success(t('settings.worktreeRecycle.remote.keepSuccess'));
      } else {
        toast.error(t('settings.worktreeRecycle.remote.keepFailed'));
      }
      await refresh();
    } catch (err) {
      if (!isRemotePrecreatedWorktreeOwnerChangedError(err)) {
        toast.error(t('settings.worktreeRecycle.remote.keepFailed'));
      }
    } finally {
      controlBusy.current = false;
      setBusy(null);
    }
  };

  const hasRemoteSection = remoteRecords.length > 0 || !remoteStorageReadable;
  const showLocalRows = !failed && rows !== null && rows.length > 0;
  const showEmpty = !failed && rows !== null && rows.length === 0 && !hasRemoteSection;

  return (
    <div className="mt-6 rounded-xl border border-[var(--border-default)] p-4">
      <div className="flex items-center justify-between gap-4">
        <h3 id={worktreeRecycleCardSettings.worktreeRecycleTitle.targetId} className="text-sm font-medium text-[var(--text-primary)]">{t(worktreeRecycleCardSettings.worktreeRecycleTitle.titleKey)}</h3>
        <Button data-setting-id={worktreeRecycleCardSettings.worktreeRecycleTitle.id} variant="secondary" size="md" onClick={() => { void refresh(); }}>{t('settings.worktreeRecycle.refresh')}</Button>
      </div>
      {failed ? <ErrorNotice role="alert" className="mt-3" message={t('settings.worktreeRecycle.loadFailed')} />
        : showEmpty ? <p className="mt-3 text-sm text-[var(--text-secondary)]">{t('settings.worktreeRecycle.empty')}</p>
          : showLocalRows ? <ul className="mt-3 divide-y divide-[var(--border-default)]">
            {rows.map((row) => <li key={`${row.id}:${row.generation}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-[var(--text-primary)]" title={row.path}>{row.name}</p>
                <p className="break-all text-xs text-[var(--text-secondary)]">{row.path}</p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {t(`settings.worktreeRecycle.state.${row.state}`)} · {t(`settings.worktreeRecycle.reason.${row.reason}`)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button data-settings-search-action="Retry recycling or keep the selected worktree" variant="secondary" size="md" disabled={busy !== null} onClick={() => { void control(row, 'retry'); }}>{t('settings.worktreeRecycle.retry')}</Button>
                <Button data-settings-search-action="Retry recycling or keep the selected worktree" variant="secondary" size="md" disabled={busy !== null || row.state === 'kept'} onClick={() => { void control(row, 'keep'); }}>{t('settings.worktreeRecycle.keep')}</Button>
              </div>
            </li>)}
          </ul> : null}
      {hasRemoteSection && (
        <div className={showLocalRows || failed ? 'mt-4 border-t border-[var(--border-default)] pt-4' : 'mt-3'}>
          <p className="text-xs font-medium text-[var(--text-primary)]">{t('settings.worktreeRecycle.remote.title')}</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">{t('settings.worktreeRecycle.remote.description')}</p>
          {!remoteStorageReadable && (
            <ErrorNotice role="alert" className="mt-3" message={t('settings.worktreeRecycle.remote.storageUnreadable')} />
          )}
          {remoteRecords.length > 0 && (
            <ul className="mt-2 divide-y divide-[var(--border-default)]">
              {remoteRecords.map((record) => {
                const deviceLabel = deviceDisplayName(record.deviceId, record.deviceName, knownDevices);
                const detailLabel = record.path ?? t('settings.worktreeRecycle.remote.sessionLabel', { id: record.sessionId.slice(0, 8) });
                const phaseLabel = t(`settings.worktreeRecycle.remote.phase.${record.phase}`);
                const reasonLabel = record.lastFailureReason
                  ? t(`settings.worktreeRecycle.remote.preserveReason.${record.lastFailureReason}`)
                  : record.lastFailureKind
                    ? t(`settings.worktreeRecycle.remote.failure.${record.lastFailureKind}`)
                    : null;
                return (
                  <li key={remoteRecordKey(record)} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-[var(--text-primary)]" title={deviceLabel}>{deviceLabel}</p>
                      <p className="break-all text-xs text-[var(--text-secondary)]" title={record.path ?? record.sessionId}>{detailLabel}</p>
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">
                        {reasonLabel ? `${phaseLabel} · ${reasonLabel}` : phaseLabel}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button data-settings-search-action="Retry recycling or keep the selected worktree" variant="secondary" size="md" disabled={busy !== null} onClick={() => { void retryRemote(record); }}>{t('settings.worktreeRecycle.retry')}</Button>
                      <Button data-settings-search-action="Retry recycling or keep the selected worktree" variant="secondary" size="md" disabled={busy !== null} onClick={() => { void keepRemote(record, deviceLabel); }}>{t('settings.worktreeRecycle.remote.keepUnblock')}</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
