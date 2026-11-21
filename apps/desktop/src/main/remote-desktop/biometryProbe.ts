import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { DesktopBiometry } from '../../shared/awayGuard';

const WORDS: readonly string[] = ['touchid', 'faceid', 'opticid', 'none'];

function asWord(line: string): DesktopBiometry | undefined {
  const word = line.trim();
  return WORDS.includes(word) ? (word as DesktopBiometry) : undefined;
}

/**
 * Which biometry this Mac offers, from `--biometry`'s single word.
 *
 * A Personal source runtime can keep reusing a shipped helper from before this flag
 * existed. Such a helper matches no branch, falls through to its event-stream reader,
 * greets with `ready` and then waits on stdin — so a buffered `exec` would block for its
 * whole timeout on every settings load, and again on the next one. Read the first line
 * instead and stop the child as soon as it is not one of the words this probe knows.
 */
export function probeBiometry(
  binary: string,
  runtime: {
    spawn: (binary: string, args: string[]) => ChildProcessWithoutNullStreams;
  } = {
    spawn: (file, args) => spawn(file, args, { stdio: 'pipe', windowsHide: true }),
  },
): Promise<DesktopBiometry | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = runtime.spawn(binary, ['--biometry']);
    } catch {
      return resolve(undefined);
    }
    let buffer = '';
    let settled = false;
    const finish = (value: DesktopBiometry | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // An unexpected greeting means a helper in a mode of its own: it holds nothing worth
      // asking for, and SIGKILL cannot turn into a lock.
      child.kill('SIGKILL');
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 5000);
    timer.unref();
    child.stderr?.resume();
    child.on('error', () => finish(undefined));
    child.on('close', () => finish(asWord(buffer.split('\n')[0] ?? '')));
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      if (buffer.length > 1024) return finish(undefined);
      if (!buffer.includes('\n')) return;
      finish(asWord(buffer.slice(0, buffer.indexOf('\n'))));
    });
  });
}
