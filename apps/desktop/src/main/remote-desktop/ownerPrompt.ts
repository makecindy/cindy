import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveDesktopInputBinary } from './inputHost';

/**
 * The system's own Touch ID prompt, armed while the privacy screen keeps the display
 * awake (docs/product-rules/privacy-screen.md). Physical keys and clicks still turn into
 * the real system lock; resting a finger on the sensor is the one owner action the cover
 * answers by uncovering, and it never unlocks a locked Mac. Only fixed words cross
 * stdout: the prompt belongs to the OS, so no credential or fingerprint data reaches
 * Cindy.
 */
export type OwnerAnswer = 'verified' | 'denied' | 'unavailable';

export interface OwnerPrompt {
  /** Takes the prompt down. Resolves once the helper is gone. */
  stop(): Promise<void>;
}

export async function watchOwnerPrompt(
  onAnswer: (answer: OwnerAnswer) => void,
  reason: string,
  runtime = {
    resolveBinary: resolveDesktopInputBinary,
    spawn: (binary: string, args: string[]): ChildProcessWithoutNullStreams =>
      spawn(binary, args, { stdio: 'pipe', windowsHide: true }),
  },
  /** The cover no longer holds the display while the helper is still starting. */
  signal?: AbortSignal,
): Promise<OwnerPrompt> {
  if (signal?.aborted) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
  // Resolving the helper can take a while (a cold build of the native source, a slow
  // probe). A cover that let go during that wait has already marked the signal aborted,
  // and listening for the event afterwards never replays it: re-check before spawning so
  // the system sheet cannot flash onto a screen nobody is holding awake.
  const binary = await runtime.resolveBinary();
  if (signal?.aborted) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
  const child = runtime.spawn(binary, ['--owner-prompt', reason]);
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let buffer = '';
  let started = false;
  let done = false;
  let settle: ((error?: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    settle = (error) => (error ? reject(error) : resolve());
  });
  const timer = setTimeout(() => settle?.(new Error('DESKTOP_PRIVACY_UNAVAILABLE')), 5000);
  timer.unref();
  const emit = (answer: OwnerAnswer) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    // Answers only mean something once the prompt is up: anything earlier is a helper
    // this build cannot use, and the cover has to stay guarded.
    if (!started) return settle?.(new Error('DESKTOP_PRIVACY_UNAVAILABLE'));
    settle?.();
    settle = undefined;
    onAnswer(answer);
  };
  child.stderr.resume();
  child.stdin.on('error', () => {});
  // The system owns the sheet: only the helper's own `stop` runs `context.invalidate()`,
  // and killing it here leaves the prompt on screen for about ten seconds. Main is gone
  // means a closed stdin, so every path that takes a prompt down uses this protocol, also
  // while the helper is still starting (`stop` waits in the pipe until it reads stdin).
  const requestStop = () => {
    child.stdin.write('stop\n');
    const kill = setTimeout(() => child.kill(), 2000);
    kill.unref();
    return () => clearTimeout(kill);
  };
  // A prompt cancelled before it came up must not flash on screen afterwards.
  const onAbort = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    requestStop();
    settle?.(new Error('DESKTOP_PRIVACY_UNAVAILABLE'));
    settle = undefined;
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  child.on('error', () => settle?.(new Error('DESKTOP_PRIVACY_UNAVAILABLE')));
  child.on('close', () => {
    // A prompt that ends on its own leaves the cover in charge: no answer arrived.
    if (started) return emit('unavailable');
    done = true;
    clearTimeout(timer);
    settle?.(new Error('DESKTOP_PRIVACY_UNAVAILABLE'));
  });
  child.stdout.on('data', (data: Buffer) => {
    if (done) return;
    buffer += data.toString();
    if (buffer.length > 1024) return emit('unavailable');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      // Anything else is a helper this build cannot use; the cover stays locked down.
      if (line === 'ready') {
        started = true;
        clearTimeout(timer);
        settle?.();
        settle = undefined;
      } else if (line === 'verified' || line === 'denied') emit(line);
      // No Touch ID, a locked session or an unusable build: the cover stays in charge.
      else emit('unavailable');
    }
  });
  try {
    await ready;
  } catch (error) {
    // An abort already took the helper down; a helper that never came up is stopped here.
    if (!done) {
      done = true;
      requestStop();
    }
    signal?.removeEventListener('abort', onAbort);
    throw error;
  }
  signal?.removeEventListener('abort', onAbort);
  return {
    stop: () => {
      if (done) return closed;
      done = true;
      return closed.finally(requestStop());
    },
  };
}
