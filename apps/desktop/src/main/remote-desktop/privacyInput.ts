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

export interface AwayGuardInputMonitor extends PrivacyInputMonitor {
  /** Ask the helper to lock now. Resolves true only once the OS reported the lock. */
  lock(): Promise<boolean>;
  /** Best-effort synchronous lock request for app shutdown; the helper also locks on EOF. */
  lockOnExit(): void;
}

/** `--away-guard`: the helper itself turns physical input, a missed heartbeat or a
 * dead Main into the system lock. `stop()` releases it without a lock (the screen is
 * already locked, or remote desktop takes over the display). `ended` runs once: on the
 * confirmed lock, or when the helper is gone. The helper stops reading input as soon
 * as the lock is up and then exits.
 */
export async function watchAwayGuardInput(
  ended: (locked: boolean) => void,
  /** Fixed word naming what made the helper lock (key, click, heartbeat, …), for logs. */
  lockingBecause: (reason: string) => void = () => {},
  runtime = {
    resolveBinary: resolveDesktopInputBinary,
    spawn: (binary: string): ChildProcessWithoutNullStreams =>
      spawn(binary, ['--away-guard'], { stdio: 'pipe', windowsHide: true }),
  },
): Promise<AwayGuardInputMonitor> {
  const child = runtime.spawn(await runtime.resolveBinary());
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let locked = false;
  let ready = false;
  let reported = false;
  let lockedNow: (() => void) | undefined;
  const lockConfirmed = new Promise<void>((resolve) => {
    lockedNow = resolve;
  });
  const report = () => {
    if (reported || !ready) return;
    reported = true;
    clearInterval(heartbeat);
    ended(locked);
  };
  let buffer = '';
  let settleReady: ((error?: Error) => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    settleReady = (error) => {
      settleReady = undefined;
      if (error) reject(error);
      else resolve();
    };
  });
  const readyTimer = setTimeout(
    () => settleReady?.(new Error('DESKTOP_PRIVACY_UNAVAILABLE')),
    5000,
  );
  const write = (command: string) => {
    if (child.stdin.writable) child.stdin.write(`${command}\n`);
  };
  const heartbeat = setInterval(() => write('ping'), 1000);
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.on('error', () => settleReady?.(new Error('DESKTOP_PRIVACY_UNAVAILABLE')));
  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    if (buffer.length > 1024) buffer = '';
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === 'ready') {
        ready = true;
        settleReady?.();
      } else if (/^reason [a-z-]{1,16}$/.test(line)) {
        lockingBecause(line.slice('reason '.length));
      } else if (line === 'locked') {
        locked = true;
        lockedNow?.();
        report();
      }
      // `permission`, `error`, `released` and `lock-failed` all end with process exit.
    }
  });
  void closed.then(() => {
    clearTimeout(readyTimer);
    clearInterval(heartbeat);
    settleReady?.(new Error('DESKTOP_PRIVACY_UNAVAILABLE'));
    report();
  });
  const finish = (command: 'lock' | 'release', timeoutMs: number): Promise<void> => {
    // Once locked, the helper has stopped reading input and is exiting by itself.
    if (locked) return Promise.resolve();
    write(command);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref();
    return Promise.race([closed, lockConfirmed]).finally(() => clearTimeout(timer));
  };
  try {
    await readyPromise;
  } catch (error) {
    child.kill();
    await closed;
    throw error;
  }
  return {
    confirm: () => Promise.reject(new Error('DESKTOP_PRIVACY_UNAVAILABLE')),
    resume: () => Promise.reject(new Error('DESKTOP_PRIVACY_UNAVAILABLE')),
    stop: () => finish('release', 2000),
    lock: async () => {
      // The helper waits up to 3 s for the OS to report the lock before giving up.
      await finish('lock', 6000);
      return locked;
    },
    lockOnExit: () => write('lock'),
  };
}
