import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

const OUTPUT_TAIL_CHARS = 2048;

async function resolvePnpm(environment: NodeJS.ProcessEnv): Promise<string | null> {
  const directories = (environment.PATH ?? environment.Path ?? '').split(path.delimiter);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const directory of directories) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const file = path.join(directory, `pnpm${extension}`);
      try {
        if (!(await stat(file)).isFile()) continue;
        await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return file;
      } catch {
        /* Try the next installed location. */
      }
    }
  }
  return null;
}

function killTree(child: ChildProcess, environment: NodeJS.ProcessEnv): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // pnpm.cmd runs a Node child; kill the tree so an abort does not leave it installing.
    const killer = spawn(
      path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/pid', String(child.pid), '/t', '/f'],
      { windowsHide: true, stdio: 'ignore' },
    );
    killer.on('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Run pnpm from the same PATH the Make toolchain resolved (system first, managed
 * copy otherwise). Arguments are fixed by callers, never user input; only the tail
 * of the output is kept for the error message.
 */
export async function runSourcePnpm(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (args.some((arg) => !/^[\w.=-]+$/.test(arg))) {
    throw Object.assign(new Error('unsafe pnpm argument'), { code: 'installFailed' });
  }
  const file = await resolvePnpm(env);
  if (!file) throw Object.assign(new Error('pnpm not found'), { code: 'installFailed' });
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  if (batch && /["%\r\n!^&|<>]/.test(file)) {
    throw Object.assign(new Error('unsafe pnpm path'), { code: 'installFailed' });
  }
  await new Promise<void>((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { ...env, CI: '1' };
    const child = batch
      ? spawn(
          path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
          ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`],
          {
            cwd,
            env: environment,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      : spawn(file, [...args], {
          cwd,
          env: environment,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    let tail = '';
    const collect = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const abort = () => killTree(child, environment);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort);
      reject(Object.assign(error, { code: 'installFailed' }));
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        reject(Object.assign(new Error('pnpm cancelled'), { code: 'cancelled' }));
        return;
      }
      if (code !== 0) {
        reject(
          Object.assign(new Error(`pnpm exited with ${code}: ${tail.trim()}`), {
            code: 'installFailed',
          }),
        );
        return;
      }
      resolve();
    });
    if (signal.aborted) abort();
  });
}
