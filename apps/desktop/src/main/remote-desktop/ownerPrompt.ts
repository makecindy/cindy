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
): Promise<OwnerPrompt> {
  const child = runtime.spawn(await runtime.resolveBinary(), ['--owner-prompt', reason]);
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
    child.kill();
    throw error;
  }
  return {
    stop: () => {
      if (done) return closed;
      done = true;
      child.stdin.write('stop\n');
      const kill = setTimeout(() => child.kill(), 2000);
      kill.unref();
      return closed.finally(() => clearTimeout(kill));
    },
  };
}
