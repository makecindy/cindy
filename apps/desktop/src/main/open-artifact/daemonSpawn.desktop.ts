// The Electron half of starting the Open Artifact daemon, kept apart so a test can load it with a mocked
// `utilityProcess` and the real kit, without the rest of the desktop assembly.
import { createWriteStream } from 'node:fs';
import { utilityProcess } from 'electron';
import type { CindyDaemonSpawn } from './runtime.js';

/**
 * The kit's `daemon.spawn`: forks the runtime entry in an Electron utility process, the same in dev and packaged
 * builds (the packaged RunAsNode fuse is off, so the app's executable cannot run it as Node). The daemon runs its type
 * servers in worker threads there; Cindy asks it to stop when it quits (`kill()` sends `SIGTERM`). Its output is
 * appended to the kit's log file; the process is returned so the kit stops waiting when it ends.
 */
export const spawnDaemonInUtilityProcess: CindyDaemonSpawn = ({ bin, args, env, logFile }) => {
  const child = utilityProcess.fork(bin, args, {
    env: { ...env, OPEN_ARTIFACT_NODE_CHILDREN: 'threads' },
    stdio: 'pipe',
    serviceName: 'Open Artifact',
  });
  const log = createWriteStream(logFile, { flags: 'a' });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once('exit', () => log.end());
  return child;
};
