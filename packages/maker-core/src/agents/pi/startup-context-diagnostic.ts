import { execFile, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { PI_GLOBAL_CONTEXT_FILE_NAMES } from './global-context.js';

const SF_DATALESS = 0x40000000;
const DIAGNOSTIC_BUDGET_MS = 1_000;
const MAX_ANCESTORS = 32;

/** Metadata-only, best-effort evidence. Never open a possibly cloud-only file.
 * Node Stats omits Darwin st_flags. Use BSD stat in a killable child instead of
 * blocking the host or leaving a read running in its filesystem thread pool.
 */
export async function findPiCloudContextFile(workingDir: string): Promise<string | undefined> {
  if (process.platform !== 'darwin' || !path.isAbsolute(workingDir)) return undefined;
  const controller = new AbortController();
  let activeChild: ChildProcess | undefined;
  let expire!: () => void;
  const expired = new Promise<undefined>((resolve) => { expire = () => resolve(undefined); });
  const timer = setTimeout(() => {
    // execFile does not forward its killSignal option to spawn's AbortSignal
    // handler in Node 22. Kill the owned child explicitly before aborting.
    try { activeChild?.kill('SIGKILL'); } catch { /* best-effort diagnostic cleanup */ }
    controller.abort();
    expire();
  }, DIAGNOSTIC_BUDGET_MS);

  const inspect = (file: string): Promise<'missing' | 'other' | 'local' | 'cloud' | 'unknown'> =>
    new Promise((resolve) => {
      try {
        activeChild = execFile('/usr/bin/stat', ['-L', '-f', '%f:%HT', file], {
          encoding: 'utf8', maxBuffer: 512, signal: controller.signal,
          killSignal: 'SIGKILL', env: { LC_ALL: 'C' },
        }, (error, stdout, stderr) => {
          activeChild = undefined;
          if (error) {
            resolve(/: No such file or directory\n?$/.test(stderr) ? 'missing' : 'unknown');
            return;
          }
          const match = /^(\d+):([^\r\n]+)\n?$/.exec(stdout);
          if (!match) { resolve('unknown'); return; }
          const flags = Number(match[1]);
          if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0xffffffff) {
            resolve('unknown'); return;
          }
          if (match[2] !== 'Regular File') { resolve('other'); return; }
          resolve((flags & SF_DATALESS) !== 0 ? 'cloud' : 'local');
        });
      } catch { resolve('unknown'); }
    });

  const scan = async (): Promise<string | undefined> => {
    let directory = workingDir;
    for (let depth = 0; depth < MAX_ANCESTORS && !controller.signal.aborted; depth++) {
      // Native Pi uses the first matching context filename in each directory.
      // A normal override shadows lower-priority cloud files. Unknown metadata
      // cannot prove absence, so do not diagnose a lower-priority candidate.
      for (const name of PI_GLOBAL_CONTEXT_FILE_NAMES) {
        if (controller.signal.aborted) return undefined;
        const file = path.join(directory, name);
        const state = await inspect(file);
        if (controller.signal.aborted) return undefined;
        if (state === 'cloud') return file;
        if (state === 'local' || state === 'unknown') break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return undefined;
  };

  try { return await Promise.race([scan(), expired]); }
  finally { clearTimeout(timer); controller.abort(); }
}

/** The path is for this user's recovery, never a shell command or raw log line. */
export function piCloudContextDisplayPath(file: string): string {
  const home = os.homedir();
  const relative = path.relative(home, file);
  const display = relative && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative) ? `~${path.sep}${relative}` : file;
  return JSON.stringify(redactSensitiveText(display));
}
