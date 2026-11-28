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
  const continuation = useRef<
    { key: string; operationId: string; strategy?: 'ff-only' | 'rebase' } | undefined
  >(undefined);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const invoke = useCallback(
    (sync: boolean, operationId?: string, strategy?: 'ff-only' | 'rebase') => {
      const req = {
        baseRepo: baseRepo!,
        branch,
        ...(sync
          ? {
              waitForResult: true,
              ...(operationId ? { operationId } : {}),
              ...(strategy ? { strategy } : {}),
            }
          : {}),
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
  const state = snapshot.key === key ? snapshot : { key };
  const status = state.status;
  const canRebaseDiverged =
    status?.blocked === 'diverged' &&
    status.divergedConflict === false &&
    !status.inProgressOp &&
    !!status.checkoutPath &&
    status.dirtyFiles === 0;
  const divergedConflictFiles = status?.divergedConflictFiles ?? [];
  const blockedHint = (nextStatus: BranchSyncStatus) =>
    t(`newChat.branchSync.${nextStatus.blocked}`, {
      branch,
      remote: nextStatus.remote ?? 'origin',
      remoteBranch: nextStatus.remoteBranch ?? branch,
    });
  const sync = async (explicitStrategy?: 'ff-only' | 'rebase') => {
    if (!baseRepo || busy.current) return;
    const strategy = explicitStrategy ?? (canRebaseDiverged ? 'rebase' : undefined);
    busy.current = true;
    const id = ++request.current;
    setSnapshot((old) => ({ ...old, key, busy: true, error: undefined, result: undefined }));
    try {
      const resume =
        continuation.current?.key === key && continuation.current.strategy === strategy
          ? continuation.current.operationId
          : undefined;
      let reply = (await invoke(true, resume, strategy)) as BranchSyncReply;
      while ('pending' in reply) {
        if (currentKey.current !== key || id !== request.current) return;
        continuation.current = { key, operationId: reply.operationId, strategy };
        reply = (await invoke(true, reply.operationId, strategy)) as BranchSyncReply;
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
  const vars = {
    branch,
    remote: status?.remote ?? 'origin',
    remoteBranch: status?.remoteBranch ?? branch,
  };
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const diverging = ahead > 0 && behind > 0;
  const errorText = state.error?.startsWith(BRANCH_SYNC_ERROR_PREFIX)
    ? t(`newChat.branchSync.errors.${state.error.slice(BRANCH_SYNC_ERROR_PREFIX.length)}`)
    : state.error;
  let hint = t('newChat.branchSync.action', vars);
  if (status?.remoteOnly) hint = t('newChat.branchSync.remoteAction', vars);
  if (status?.checkoutPath) hint += `\n${t('newChat.branchSync.checkedOut')}`;
  if (status?.blocked) {
    if (canRebaseDiverged) {
      hint = t('newChat.branchSync.divergedCanRebase', { ...vars, ahead, behind });
    } else if (status.blocked === 'diverged' && divergedConflictFiles.length > 0) {
      hint = t('newChat.branchSync.divergedConflictHint', {
        ...vars,
        files:
          divergedConflictFiles.length > 2
            ? `${divergedConflictFiles.slice(0, 2).join(', ')} +${divergedConflictFiles.length - 2}`
            : divergedConflictFiles.join(', '),
      });
    } else {
      hint = blockedHint(status);
    }
  }
  if (state.result && !status?.blocked)
    hint = state.result.updated
      ? state.result.syncedMode === 'rebase'
        ? t('newChat.branchSync.rebased', { count: state.result.updated })
        : t('newChat.branchSync.updated', { count: state.result.updated })
      : status?.ahead
        ? t('newChat.branchSync.keptAhead', { count: status.ahead })
        : t('newChat.branchSync.current');
  if (state.error) hint = t('newChat.branchSync.failed', { reason: errorText });
  if (state.busy) hint = t('newChat.branchSync.fetching', vars);
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
    status,
    canRebaseDiverged,
    divergedConflictFiles,
    errorText,
    visible: !!baseRepo && !state.unsupported && status?.blocked !== 'not-local',
    disabled: !!state.busy || (!!status?.blocked && !canRebaseDiverged) || (!status && !state.error),
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
