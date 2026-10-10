import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushStampCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';
import { extractIpcError } from '@/utils/ipcError';
import type {
  ProjectWorkspace,
  ProjectWorkspaceMutation,
  ProjectWorkspaceSnapshot,
} from '../../../../shared/projectWorkspaceSettings';

interface WorkspaceState {
  owner: DataOwnerGeneration;
  workspaces: ProjectWorkspace[];
  loading: boolean;
  error: string | null;
  pending: boolean;
  ready: boolean;
}

interface WorkspaceBinding {
  owner: DataOwnerGeneration;
  active: boolean;
  snapshot: ProjectWorkspaceSnapshot | null;
  revision: number;
  read: number;
  pending: number;
  queue: Promise<void>;
  reload: () => void;
}

function initialState(owner: DataOwnerGeneration): WorkspaceState {
  return { owner, workspaces: [], loading: true, error: null, pending: false, ready: false };
}

function isCurrent(binding: WorkspaceBinding): boolean {
  return binding.active && isDataOwnerGenerationCurrent(binding.owner);
}

function acceptsSnapshot(binding: WorkspaceBinding, snapshot: ProjectWorkspaceSnapshot): boolean {
  return isCurrent(binding) && isDataOwnerPushStampCurrent(snapshot.ownerStamp);
}

function errorMessage(error: unknown): string {
  return (
    extractIpcError(error)?.code ??
    (error instanceof Error ? error.message : 'PROJECT_WORKSPACES_FAILED')
  );
}

export function useProjectWorkspaces(): {
  workspaces: ProjectWorkspace[];
  loading: boolean;
  error: string | null;
  pending: boolean;
  ready: boolean;
  mutate: (mutation: ProjectWorkspaceMutation) => Promise<void>;
  reload: () => void;
} {
  const owner = useSyncExternalStore(recentWorkdirsStore.subscribe, getDataOwnerGeneration);
  const [state, setState] = useState<WorkspaceState>(() => initialState(owner));
  const bindingRef = useRef<WorkspaceBinding | null>(null);

  useLayoutEffect(() => {
    let unsubscribe: (() => void) | undefined;
    const binding: WorkspaceBinding = {
      owner,
      active: true,
      snapshot: null,
      revision: 0,
      read: 0,
      pending: 0,
      queue: Promise.resolve(),
      reload: () => {},
    };
    bindingRef.current = binding;
    setState(initialState(owner));

    const apply = (snapshot: ProjectWorkspaceSnapshot) => {
      binding.snapshot = snapshot;
      setState({
        owner,
        workspaces: snapshot.workspaces,
        loading: false,
        error: null,
        pending: binding.pending > 0,
        ready: true,
      });
    };
    binding.reload = () => {
      if (!isCurrent(binding)) return;
      const request = ++binding.read;
      const api = window.electronAPI?.sidebarSettings;
      if (
        typeof api?.getProjectWorkspaces !== 'function' ||
        typeof api.mutateProjectWorkspaces !== 'function' ||
        typeof api.onProjectWorkspacesChanged !== 'function'
      ) {
        binding.snapshot = null;
        setState({
          ...initialState(owner),
          loading: false,
          error: 'PROJECT_WORKSPACES_UNAVAILABLE',
        });
        return;
      }
      if (!unsubscribe) {
        unsubscribe = api.onProjectWorkspacesChanged((snapshot, stamp) => {
          if (!isDataOwnerPushStampCurrent(stamp) || !acceptsSnapshot(binding, snapshot)) return;
          binding.revision += 1;
          apply(snapshot);
        });
      }
      const revision = binding.revision;
      setState((current) => ({ ...current, loading: true, error: null }));
      void (async () => {
        try {
          const snapshot = await api.getProjectWorkspaces();
          if (!isCurrent(binding) || request !== binding.read || revision !== binding.revision)
            return;
          if (!snapshot.ownerStamp) {
            binding.snapshot = null;
            setState({ ...initialState(owner), loading: false, pending: binding.pending > 0 });
            return;
          }
          if (!acceptsSnapshot(binding, snapshot)) throw new Error('PRECONDITION_FAILED');
          apply(snapshot);
        } catch (error) {
          if (!isCurrent(binding) || request !== binding.read || revision !== binding.revision)
            return;
          setState((current) => ({ ...current, loading: false, error: errorMessage(error) }));
        }
      })();
    };
    binding.reload();
    return () => {
      binding.active = false;
      unsubscribe?.();
    };
  }, [owner]);

  const reload = useCallback(() => {
    const binding = bindingRef.current;
    if (binding?.owner === owner) binding.reload();
  }, [owner]);

  const mutate = useCallback(
    (mutation: ProjectWorkspaceMutation): Promise<void> => {
      const binding = bindingRef.current;
      const ownerStamp = binding?.snapshot?.ownerStamp;
      if (
        !binding ||
        binding.owner !== owner ||
        !isCurrent(binding) ||
        !isDataOwnerPushStampCurrent(ownerStamp)
      ) {
        return Promise.reject(new Error('PRECONDITION_FAILED'));
      }
      binding.pending += 1;
      setState((current) => ({ ...current, pending: true }));
      const operation = binding.queue
        .then(async () => {
          if (!isCurrent(binding)) throw new Error('PRECONDITION_FAILED');
          const revision = binding.revision;
          const snapshot = await window.electronAPI.sidebarSettings.mutateProjectWorkspaces({
            ownerStamp,
            mutation,
          });
          if (!acceptsSnapshot(binding, snapshot)) throw new Error('PRECONDITION_FAILED');
          if (revision !== binding.revision) return;
          binding.revision += 1;
          binding.snapshot = snapshot;
          setState({
            owner,
            workspaces: snapshot.workspaces,
            loading: false,
            error: null,
            pending: true,
            ready: true,
          });
        })
        .finally(() => {
          binding.pending -= 1;
          if (isCurrent(binding))
            setState((current) => ({ ...current, pending: binding.pending > 0 }));
        });
      binding.queue = operation.catch(() => {});
      return operation;
    },
    [owner],
  );

  const current =
    state.owner === owner && isDataOwnerGenerationCurrent(owner) ? state : initialState(owner);
  return {
    workspaces: current.workspaces,
    loading: current.loading,
    error: current.error,
    pending: current.pending,
    ready: current.ready,
    mutate,
    reload,
  };
}
