import { spawn, type ChildProcess } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateHostCommand, type TerminalHostCommand } from './host-command.js';

/** Task Scheduler retries launch failures, not the exit of a running action
 * (MS-TSCH §2.5.4.2). Keep its action alive while supervising the actual host.
 * A normal host exit ends this action; only an abnormal exit is restarted.
 * The IPC lifetime also prevents an orphan host if this supervisor disappears. */
export async function superviseTerminal(entry: string, profile: string, host?: TerminalHostCommand): Promise<void> {
  const command=validateHostCommand(host??{executable:process.execPath,args:[entry,'serve','--state-dir',profile]});
  const log = await open(path.join(profile, 'service.log'), 'a', 0o600);
  const stopped = new AbortController();
  let child: ChildProcess | undefined;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped.signal.aborted) return;
    stopped.abort();
    if (!child) return;
    if (child.connected) child.send({ type: 'cindy:service-stop' }, () => {});
    forceStop = setTimeout(() => child?.kill(), 45_000);
    forceStop.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let failures = 0;
  try {
    while (!stopped.signal.aborted) {
      const started = Date.now();
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child = spawn(command.executable, command.args, {
          stdio: ['ignore', log.fd, log.fd, 'ipc'], windowsHide: true, shell: false,
          env: { ...process.env, CINDY_SERVICE_SUPERVISED: '1' },
        });
        child.once('error', () => resolve({ code: 1, signal: null }));
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      child = undefined;
      if (forceStop) clearTimeout(forceStop);
      if (stopped.signal.aborted || result.code === 0) return;
      failures = Date.now() - started >= 30_000 ? 1 : failures + 1;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      // No task data, environment or credential bytes enter this diagnostic.
      await log.appendFile(`Service host exited (${result.signal ?? result.code}); retry in ${wait}ms\n`);
      await delay(wait, undefined, { signal: stopped.signal }).catch(error => {
        if (!stopped.signal.aborted) throw error;
      });
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (forceStop) clearTimeout(forceStop);
    await log.close();
  }
}
