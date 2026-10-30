import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveDesktopInputBinary } from './inputHost';

export interface PrivacyInputMonitor {
  confirm(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

/** The existing signed helper runs in a separate, mask-owned observation mode.
 * Only fixed status words cross stdout; no key, text or pointer data leaves it.
 * Native hooks consume the initiating physical input, then fence injected input
 * before the local dialog opens. EOF/watchdog always unhooks.
 */
export async function watchPrivacyInput(
  localInput: () => void,
  failed: () => void,
  runtime = {
    resolveBinary: resolveDesktopInputBinary,
    spawn: (binary: string): ChildProcessWithoutNullStreams =>
      spawn(binary, ['--privacy-input'], { stdio: 'pipe', windowsHide: true }),
  },
): Promise<PrivacyInputMonitor> {
  const child = runtime.spawn(await runtime.resolveBinary());
  // Process close proves the OS has removed its hooks, unlike merely sending EOF.
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let stopped = false;
  let buffer = '';
  let pending: { expected: string; done(error?: Error): void } | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (stopped) return closed;
    stopped = true;
    clearInterval(heartbeat);
    pending?.done(new Error('DESKTOP_PRIVACY_UNAVAILABLE'));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
    return closed;
  };
  const fail = () => {
    if (stopped) return;
    stop();
    failed();
  };
  const wait = (expected: string, command?: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (stopped || pending) return reject(new Error('DESKTOP_PRIVACY_UNAVAILABLE'));
      const timer = setTimeout(fail, 5000);
      pending = {
        expected,
        done(error) {
          clearTimeout(timer);
          pending = undefined;
          error ? reject(error) : resolve();
        },
      };
      if (command) child.stdin.write(`${command}\n`);
    });
  const ready = wait('ready');
  child.stderr.resume();
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', (data: Buffer) => {
    if (stopped) return;
    buffer += data.toString();
    if (buffer.length > 1024) return fail();
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === pending?.expected) pending.done();
      else if (line === 'local-input') localInput();
      else return fail();
    }
  });
  heartbeat = setInterval(() => {
    if (child.stdin.writableLength > 1024) fail();
    else child.stdin.write('ping\n');
  }, 1000);
  try {
    await ready;
    return {
      confirm: () => wait('confirmed', 'confirm'),
      resume: () => wait('ready', 'resume'),
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
