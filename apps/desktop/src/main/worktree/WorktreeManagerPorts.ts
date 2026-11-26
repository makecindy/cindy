import type { WorktreeMeta } from './types';

/** Platform services used by the shared Worktree lifecycle. */
export interface WorktreeManagerPorts {
  withPrecreatedSessionOperationLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  assertPrecreatedSessionNotCancelled(sessionId: string): void;
  sealPrecreatedSessionCancellation(sessionId: string): void;
  /** General archive/recovery removal. Precreated discard never calls this port. */
  recycleManagedWorktree(
    meta: WorktreeMeta,
    options: {
      canRemove?: () => Promise<boolean>;
      isSessionRuntimeAlive?: (sessionId: string) => boolean | undefined;
      onRemoved?: () => Promise<void>;
    },
  ): Promise<unknown>;
}

let ports: WorktreeManagerPorts | null = null;

/** Called by each launcher's composition root before any Worktree operation. */
export function configureWorktreeManagerPorts(next: WorktreeManagerPorts): void {
  ports = next;
}

export function worktreeManagerPorts(): WorktreeManagerPorts {
  if (!ports) throw new Error('Worktree platform ports are not configured');
  return ports;
}
