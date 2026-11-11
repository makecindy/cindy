import type { GhostInstallReceipt } from './ghostInstallReceipt.js';
import type { GhostSnapshotParentIdentity } from './ghostSnapshotIdentity.js';
import type { GhostSnapshotWorkerRequest } from './ghostSnapshotWorkerProcess.js';

export interface GhostSnapshotMutationRequest {
  parentDir: string;
  expectedParent: GhostSnapshotParentIdentity;
  operation: 'ensure' | 'remove';
  targetName: string;
  sourceDir?: string;
  receipt?: GhostInstallReceipt;
}

export type GhostSnapshotTestMutation = (request: GhostSnapshotMutationRequest) => Promise<void>;

export interface GhostSnapshotProcess {
  postMessage(message: unknown): void;
  kill(): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
}

let createWorker: ((parentDir: string) => GhostSnapshotProcess) | undefined;

/** The shell supplies only a process transport; the shared worker enforces identity and receipts. */
export function configureGhostSnapshotProcess(factory: (parentDir: string) => GhostSnapshotProcess): void {
  createWorker = factory;
}

export function mutateGhostSnapshotWithStableParent(
  request: GhostSnapshotMutationRequest,
): Promise<void> {
  if (!createWorker) return Promise.reject(new Error('ghost snapshot process is not configured'));
  const child = createWorker(request.parentDir);
  return new Promise((resolve, reject) => {
    let settled = false;
    let ready = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void Promise.resolve().then(() => child.kill()).then(
        () => { error ? reject(error) : resolve(); },
        (shutdownError) => reject(error ?? shutdownError),
      );
    };
    const timer = setTimeout(() => finish(new Error('ghost snapshot worker timed out')), 30_000);
    timer.unref?.();
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const value = message as { type?: unknown; ok?: unknown; message?: unknown };
      if (!ready && value.type === 'ready') {
        ready = true;
        const { parentDir: _parentDir, ...workerRequest } = request;
        try { child.postMessage({ type: 'mutate', request: workerRequest }); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      } else if (value.ok === true) finish();
      else if (value.ok === false) finish(new Error(String(value.message ?? 'ghost snapshot worker failed')));
    });
    child.on('error', (error) => finish(new Error(String(error))));
    child.on('exit', (code) => { if (!settled) finish(new Error(`ghost snapshot worker exited (${code})`)); });
  });
}
