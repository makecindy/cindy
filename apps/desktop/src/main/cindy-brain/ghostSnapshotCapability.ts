import { utilityProcess } from 'electron';
import path from 'node:path';

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

export function mutateGhostSnapshotWithStableParent(
  request: GhostSnapshotMutationRequest,
): Promise<void> {
  const child = utilityProcess.fork(path.join(__dirname, 'ghostSnapshotWorkerProcess.js'), [], {
    cwd: request.parentDir,
    stdio: ['ignore', 'ignore', 'pipe'],
    serviceName: 'cindy-ghost-snapshot',
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let ready = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('ghost snapshot worker timed out')), 30_000);
    timer.unref?.();
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const value = message as { type?: unknown; ok?: unknown; message?: unknown };
      if (!ready && value.type === 'ready') {
        ready = true;
        const { parentDir: _parentDir, ...workerRequest } = request;
        child.postMessage({ type: 'mutate', request: workerRequest });
      } else if (value.ok === true) finish();
      else if (value.ok === false) finish(new Error(String(value.message ?? 'ghost snapshot worker failed')));
    });
    child.on('error', (error) => finish(new Error(String(error))));
    child.on('exit', (code) => { if (!settled) finish(new Error(`ghost snapshot worker exited (${code})`)); });
  });
}
