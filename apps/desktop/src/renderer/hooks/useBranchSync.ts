import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BRANCH_SYNC_ERROR_PREFIX,
  type BranchSyncStatus,
  type BranchSyncResult,
  type BranchSyncReply,
} from '../../shared/worktreeBranchSync';
import { extractIpcError } from '@/utils/ipcError';
import { toast } from '@/lib/toast';

/** One state source for the capsule action and the selected branch's status row. */
export function useBranchSync(
  baseRepo: string | undefined,
  branch: string,
  deviceId?: string | null,
) {
  const { t } = useTranslation();
  const key = JSON.stringify([baseRepo, branch, deviceId]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    status?: BranchSyncStatus;
    busy?: boolean;
    result?: BranchSyncResult;
    error?: string;
    missingRemote?: boolean;
    unsupported?: boolean;
  }>({ key });
  const request = useRef(0);
  const busy = useRef(false);
  const continuation = useRef<{ key: string; operationId: string } | undefined>(undefined);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const invoke = useCallback(
    (sync: boolean, operationId?: string) => {
      const req = {
        baseRepo: baseRepo!,
        branch,
        ...(sync ? { waitForResult: true, ...(operationId ? { operationId } : {}) } : {}),
      };
      if (deviceId)
        return window.electronAPI.deviceLink.invoke(
          deviceId,
          sync ? 'worktree:sync-branch' : 'worktree:branch-sync-status',
          [req],
        );
      return sync
        ? window.electronAPI.worktreeSyncBranch(req)
        : window.electronAPI.worktreeBranchSyncStatus(req);
    },
    [baseRepo, branch, deviceId],
  );
  const refresh = useCallback(async () => {
    if (!baseRepo || busy.current) return;
    const id = ++request.current;
    try {
      const status = (await invoke(false)) as BranchSyncStatus;
      if (currentKey.current === key && id === request.current)
        setSnapshot((old) => ({
          ...old,
          key,
          status:
            old.key === key && old.missingRemote
              ? { ...status, blocked: 'missing-remote' }
              : status,
        }));
    } catch (error) {
      if (
        currentKey.current === key &&
        id === request.current &&
        deviceId &&
        extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
      ) {
        setSnapshot({ key, unsupported: true });
        return;
      }
      if (currentKey.current === key && id === request.current)
        setSnapshot((old) =>
          old.key === key && old.missingRemote
            ? old
            : {
                key,
                error:
                  extractIpcError(error)?.message ??
                  (error instanceof Error ? error.message : String(error)),
              },
        );
    }
  }, [baseRepo, invoke, key, deviceId]);
  useEffect(() => {
    busy.current = false;
    continuation.current = undefined;
    setSnapshot({ key });
    void refresh();
    return () => {
      ++request.current;
      clearTimeout(hoverTimer.current);
      clearTimeout(doneTimer.current);
    };
  }, [key, refresh]);
  const blockedHint = (status: BranchSyncStatus) =>
    t(`newChat.branchSync.${status.blocked}`, {
      branch,
      remote: status.remote ?? 'origin',
      remoteBranch: status.remoteBranch ?? branch,
    });
  const sync = async () => {
    if (!baseRepo || busy.current) return;
    busy.current = true;
    const id = ++request.current;
    setSnapshot((old) => ({ ...old, key, busy: true, error: undefined, result: undefined }));
    try {
      let reply = (await invoke(true,
        continuation.current?.key === key ? continuation.current.operationId : undefined,
      )) as BranchSyncReply;
      while ('pending' in reply) {
        if (currentKey.current !== key || id !== request.current) return;
        continuation.current = { key, operationId: reply.operationId };
        reply = (await invoke(true, reply.operationId)) as BranchSyncReply;
      }
      const result = reply;
      if (currentKey.current !== key || id !== request.current) return;
      continuation.current = undefined;
      if (result.status.blocked) toast.warning(blockedHint(result.status));
      setSnapshot({
        key,
        status: result.status,
        result,
        missingRemote: result.status.blocked === 'missing-remote',
      });
      clearTimeout(doneTimer.current);
      doneTimer.current = setTimeout(() => {
        if (currentKey.current === key) setSnapshot((old) => ({ ...old, result: undefined }));
      }, 2_000);
    } catch (error) {
      if (currentKey.current !== key || id !== request.current) return;
      const message =
        extractIpcError(error)?.message ?? (error instanceof Error ? error.message : String(error));
      // Host-classified failures are terminal (including expired handles).
      // Transport errors leave the operation unknown: an explicit click resumes
      // the same handle instead of starting another mutation.
      if (message.startsWith(BRANCH_SYNC_ERROR_PREFIX)) continuation.current = undefined;
      setSnapshot((old) => ({ ...old, busy: false, error: message }));
      toast.error(
        t('newChat.branchSync.failed', {
          reason: message.startsWith(BRANCH_SYNC_ERROR_PREFIX)
            ? t(`newChat.branchSync.errors.${message.slice(BRANCH_SYNC_ERROR_PREFIX.length)}`)
            : message,
        }),
      );
    } finally {
      if (currentKey.current === key && id === request.current) busy.current = false;
    }
  };
  const state = snapshot.key === key ? snapshot : { key };
  const status = state.status;
  const vars = {
    branch,
    remote: status?.remote ?? 'origin',
    remoteBranch: status?.remoteBranch ?? branch,
  };
  const errorText = state.error?.startsWith(BRANCH_SYNC_ERROR_PREFIX)
    ? t(`newChat.branchSync.errors.${state.error.slice(BRANCH_SYNC_ERROR_PREFIX.length)}`)
    : state.error;
  let hint = t('newChat.branchSync.action', vars);
  if (status?.remoteOnly) hint = t('newChat.branchSync.remoteAction', vars);
  if (status?.checkoutPath) hint += `\n${t('newChat.branchSync.checkedOut')}`;
  if (status?.blocked) hint = blockedHint(status);
  if (state.result && !status?.blocked)
    hint = state.result.updated
      ? t('newChat.branchSync.updated', { count: state.result.updated })
      : status?.ahead
        ? t('newChat.branchSync.keptAhead', { count: status.ahead })
        : t('newChat.branchSync.current');
  if (state.error) hint = t('newChat.branchSync.failed', { reason: errorText });
  if (state.busy) hint = t('newChat.branchSync.fetching', vars);
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const diverging = ahead > 0 && behind > 0;
  const details = [
    diverging
      ? t('newChat.branchSync.diverging', {
          remote: `${vars.remote}/${vars.remoteBranch}`,
          ahead,
          behind,
          count: ahead,
        })
      : status?.ahead
        ? t('newChat.branchSync.ahead', {
            ...vars,
            remote: `${vars.remote}/${vars.remoteBranch}`,
            count: status.ahead,
          })
        : '',
    !diverging && status?.behind
      ? t('newChat.branchSync.behind', {
          ...vars,
          remote: `${vars.remote}/${vars.remoteBranch}`,
          count: status.behind,
        })
      : '',
    status?.checkoutPath && status.dirtyFiles
      ? t('newChat.branchSync.dirty', { count: status.dirtyFiles })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    visible: !!baseRepo && !state.unsupported && status?.blocked !== 'not-local',
    disabled: !!state.busy || !!status?.blocked || (!status && !state.error),
    busy: !!state.busy,
    done: !!state.result && !status?.blocked,
    hint,
    details,
    sync,
    refresh,
    onHover: () => {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => void refresh(), 250);
    },
  };
}
