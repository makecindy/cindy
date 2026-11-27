import { fork } from 'node:child_process';
import { hostRuntimeLayout } from './runtime-layout.mjs';

/** Same cwd-bound worker as Desktop, with Node IPC preserving bigint identities. */
export function createSnapshotProcess(parentDir) {
  const layout = hostRuntimeLayout();
  const child = fork(layout.snapshotWorker, [], {
    cwd: parentDir,
    execArgv: layout.packaged ? [] : ['--import', import.meta.resolve('tsx'), '--import', new URL('./loaders/register-raw.mjs', import.meta.url).href],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    env: { ...process.env, CINDY_SNAPSHOT_WORKER: '1' },
    windowsHide: true,
  });
  // Drain diagnostics so a full pipe cannot deadlock the worker.
  child.stderr?.resume();
  const closed = new Promise(resolve => child.once('close', resolve));
  return {
    postMessage: message => child.send(message),
    // Windows retains the cwd directory while the process is alive. Do not
    // report cleanup complete until its process and stdio handles have closed.
    kill: () => { child.kill(); return closed; },
    on: (event, listener) => child.on(event, listener),
  };
}
