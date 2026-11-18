import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { isSharedTaskPeer, TASK_MIGRATION_CHANNEL, type TaskMigrationView } from '@cindy/device-link';
import { isTeammateProjectPath } from '@cindy/maker-shared/teammate-project';
import { sessionProjectDirectory } from '@cindy/maker-shared/worktree-paths';
import { useTranslation } from 'react-i18next';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import type { RemoteDirectoryListResult } from '@/device-link/mobileMakerTransport';
import { NewTaskSelectionSheet } from './NewTaskSelectionSheet';
import { filterRemoteDirectoryEntries, normalizeRemoteDirectoryDrives, shouldRetryRemoteBrowseDrives } from './newSession';
import { remoteSessionStore, resolveSessionWriteDevices } from './remoteSessionStore';
import type { RemoteSession } from './types';
import { workspacePathsEqual } from './workspaceSelection';

export function sessionAllowsProjectMove(session?: RemoteSession | null): boolean {
  return (Platform.OS === 'ios' || Platform.OS === 'android') && !!session && session.status === 'active' && !session.remoteHostId
    && session.source !== 'review' && session.source !== 'bot' && session.orcaRole !== 'worker'
    && !isSharedTaskPeer(session.deviceLinkDeviceId ?? '')
    && !isSharedTaskPeer(session.canonicalDeviceId ?? '');
}

/** Pin the selected task, and wait for the original native sheet to finish dismissing. */
export function useSessionProjectMoveSheet() {
  const pending = useRef<{ session: RemoteSession; deviceId?: string; owner: ReturnType<typeof getMobileAuthOwner> } | null>(null);
  const [target, setTarget] = useState<typeof pending.current>(null);
  const open = useCallback((session: RemoteSession, closeMenu: () => void, deviceId?: string) => {
    if (!sessionAllowsProjectMove(session)) return;
    pending.current = { session, deviceId, owner: getMobileAuthOwner() };
    closeMenu();
  }, []);
  const parentClosed = useCallback(() => {
    if (!pending.current) return;
    setTarget(pending.current);
    pending.current = null;
  }, []);
  return {
    open,
    parentClosed,
    sheet: target ? <SessionProjectMoveSheet key={target.session.id} session={target.session}
      preferredDeviceId={target.deviceId} owner={target.owner} onClosed={() => setTarget(null)} /> : null,
  };
}

/** Uses the existing host move transaction; no metadata patch can bypass its live guards. */
function SessionProjectMoveSheet({ session, preferredDeviceId, owner, onClosed }: {
  session: RemoteSession;
  preferredDeviceId?: string;
  owner: ReturnType<typeof getMobileAuthOwner>;
  onClosed(): void;
}) {
  const { t } = useTranslation();
  const { invoke } = useDeviceLink();
  const [devices] = useState(() => resolveSessionWriteDevices(session.id, session, preferredDeviceId));
  const [page, setPage] = useState<'workspace' | 'directory' | null>('workspace');
  const [projects, setProjects] = useState<string[]>([]);
  const [directory, setDirectory] = useState<RemoteDirectoryListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const active = useRef(true);
  const lock = useRef(false);
  const readGeneration = useRef(0);
  const current = useCallback(() => active.current && isMobileAuthOwnerCurrent(owner), [owner]);
  const assertCurrent = useCallback(() => {
    if (!current()) throw new Error('PROJECT_MOVE_CLOSED');
  }, [current]);
  const failureText = useCallback((err: unknown) => {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
    const text = `${code} ${String(err)}`;
    if (/CHANNEL_NOT_ALLOWED|MIGRATION_UNSUPPORTED|MIGRATION_INVALID_REQUEST|VERSION_MISMATCH/.test(text))
      return t('session.menu.moveUnsupported');
    if (/WORKTREE_MOVE|WORKTREE.*BOUNDARY|WORKTREE.*MOVE/.test(text))
      return t('session.menu.moveWorktree');
    return t('session.menu.moveFailed');
  }, [t]);

  useEffect(() => {
    active.current = true;
    if (!devices) {
      setLoading(false);
      setError(t('devices.list.error.sessionDeviceNotFound'));
      return;
    }
    const request = ++readGeneration.current;
    void invoke<TaskMigrationView>(devices.rpcDeviceId, TASK_MIGRATION_CHANNEL, [{ action: 'caps' }],
      { preSend: assertCurrent }).then((caps) => {
      if (!current() || readGeneration.current !== request) return;
      if (caps.supported !== true) throw new Error('MIGRATION_UNSUPPORTED');
      setProjects([...new Set(caps.projects ?? [])].filter(path => !isTeammateProjectPath(path)));
    }).catch((err: unknown) => {
      if (current() && readGeneration.current === request) setError(failureText(err));
    }).finally(() => {
      if (current() && readGeneration.current === request) setLoading(false);
    });
    return () => { active.current = false; readGeneration.current++; };
  }, [assertCurrent, current, devices, failureText, invoke, t]);

  const close = () => {
    if (lock.current) return;
    active.current = false;
    readGeneration.current++;
    setPage(null);
  };
  const browse = async (path: string, fallbackToHome = false) => {
    if (!devices || lock.current || !current()) return;
    const request = ++readGeneration.current;
    const currentRead = () => current() && request === readGeneration.current;
    const assertCurrentRead = () => {
      if (!currentRead()) throw new Error('PROJECT_MOVE_CLOSED');
    };
    setPage('directory');
    setLoading(true);
    setError(null);
    setActionError(null);
    try {
      const readDirectory = (target: string) => invoke<RemoteDirectoryListResult>(devices.rpcDeviceId, 'fs:list-dir',
        [{ path: target || '~' }], { preSend: assertCurrentRead });
      let result: RemoteDirectoryListResult;
      try { result = await readDirectory(path); }
      catch (err) {
        // A moved or deleted task cwd must not strand the initial folder picker.
        if (!fallbackToHome || !path || path === '~' || !currentRead()) throw err;
        result = await readDirectory('~');
      }
      if (!currentRead()) return;
      setDirectory(result);
      setLoading(false);
      // Show the folder immediately while Windows finishes enumerating its drives.
      for (let attempt = 0; shouldRetryRemoteBrowseDrives(result.drivesPending, attempt); attempt += 1) {
        if (!currentRead()) return;
        try {
          result = await invoke<RemoteDirectoryListResult>(devices.rpcDeviceId, 'fs:list-dir',
            [{ path: result.resolvedPath }], { preSend: assertCurrentRead });
        } catch { return; } // A drive refresh failure does not invalidate the loaded folder.
        if (!currentRead()) return;
        setDirectory(result);
      }
    } catch (err) {
      if (current() && request === readGeneration.current) setError(failureText(err));
    } finally {
      if (current() && request === readGeneration.current) setLoading(false);
    }
  };
  const currentProject = session.workspaceKind === 'project' ? sessionProjectDirectory(session) : null;
  const isCurrentProject = (path: string) => currentProject !== null && workspacePathsEqual(currentProject, path);
  const choose = async (workingDir: string | null) => {
    if (!devices || lock.current || loading || !current()) return;
    if (workingDir !== null && isCurrentProject(workingDir)) return;
    if (remoteSessionStore.getSessionRunStatus(session.id).isRunning) {
      setActionError(t('session.menu.moveRunning'));
      return;
    }
    lock.current = true;
    setBusy(true);
    setActionError(null);
    try {
      const result = await invoke<TaskMigrationView>(devices.rpcDeviceId, TASK_MIGRATION_CHANNEL,
        [{ action: 'move-project', sessionId: session.id, workingDir }], { preSend: assertCurrent });
      assertCurrent();
      const moved = result.projectMove;
      if (moved?.sessionId !== session.id
        || (moved.workspaceKind !== 'project' && moved.workspaceKind !== 'dialogue'))
        throw new Error('MIGRATION_UNSUPPORTED');
      remoteSessionStore.applySessionPatch(devices.shardId, session.id, {
        workingDir: moved.workingDir,
        workspaceKind: moved.workspaceKind,
        // Explicit host moves clear membership, including when cwd stays unchanged.
        projectDir: null,
      });
      remoteSessionStore.requestReseed(devices.shardId);
      active.current = false;
      setPage(null);
    } catch (err) {
      if (current()) {
        // A lost reply may follow a completed move. Refresh instead of replaying the write.
        remoteSessionStore.requestReseed(devices.shardId);
        setActionError(failureText(err));
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return <NewTaskSelectionSheet
    page={page} workspaceTitle={t('session.menu.moveToProject')} workspaceLoading={loading} busy={busy} devices={[]}
    selectedDeviceId={devices?.rpcDeviceId ?? ''}
    workspaces={projects.map(path => ({ title: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
      workingDir: path, disabled: isCurrentProject(path) }))}
    workspaceKind={session.workspaceKind} workingDir={currentProject ?? session.workingDir ?? ''}
    path={directory?.resolvedPath ?? ''} parent={directory?.parent ?? null}
    entries={filterRemoteDirectoryEntries((directory?.entries ?? []).filter(entry => entry.kind !== 'file'), showHidden)}
    drives={normalizeRemoteDirectoryDrives(directory?.drives)} loading={loading || busy} error={error} actionError={actionError} showHidden={showHidden}
    onClose={close} onClosed={onClosed} onBack={() => {
      if (lock.current) return;
      readGeneration.current++; setLoading(false); setError(null); setActionError(null); setPage('workspace');
    }} onDevice={() => undefined} onDialogue={() => void choose(null)} onProject={path => void choose(path)}
    onBrowse={() => void browse(session.workspaceKind === 'project' ? session.workingDir || '~' : '~', true)} onEnter={path => void browse(path)}
    onChoose={path => void choose(path)} onShowHidden={setShowHidden}
  />;
}
