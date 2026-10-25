import { fork } from 'node:child_process';
import path from 'node:path';
import type { GhostSnapshotMutationRequest } from './store/ghostSnapshotCapability.js';

/** Uses the same verified copy/rename transaction as Desktop in a separate
 * cwd-bound process. It never changes the daemon's process-wide cwd. */
export function createNativeSnapshotMutation(options: { nodePath: string; workerPath: string }) {
  if (![options.nodePath, options.workerPath].every(value => path.isAbsolute(value))) throw new Error('PLUGIN_WORKER_PATH_INVALID');
  return (request: GhostSnapshotMutationRequest): Promise<void> => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const child = fork(options.workerPath, [], { execPath: options.nodePath, cwd: request.parentDir, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
    return new Promise((resolve, reject) => {
      let settled = false, ready = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); child.kill();
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error('ghost snapshot worker timed out')), 30_000);
      timer.unref();
      child.stderr?.resume();
      child.on('message', message => {
        if (!message || typeof message !== 'object') return;
        const value = message as { type?: unknown; ok?: unknown; message?: unknown };
        if (!ready && value.type === 'ready') {
          ready = true;
          const { parentDir: _parentDir, ...workerRequest } = request;
          child.send({ type: 'mutate', request: workerRequest }, error => { if (error) finish(error); });
        } else if (value.ok === true) finish();
        else if (value.ok === false) finish(new Error(String(value.message ?? 'ghost snapshot worker failed')));
      });
      child.on('error', finish);
      child.on('exit', code => { if (!settled) finish(new Error(`ghost snapshot worker exited (${code})`)); });
    });
  };
}
