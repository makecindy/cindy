import path from 'node:path';

/** Bound native process creation and share pending probes; never cache completed Git state.
 * The probe must bound its Git commands and await cleanup before settling.
 */
export function createCwdProbeScheduler<T>(probe: (cwd: string) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  const queue: Array<() => void> = [];
  let active = 0;

  const drain = () => {
    while (active < 4 && queue.length > 0) {
      queue.shift()!();
    }
  };

  return (cwd: string): Promise<T> => {
    const key = path.resolve(cwd);
    const existing = pending.get(key);
    if (existing) return existing;

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending.set(key, result);
    queue.push(() => {
      active++;
      const finish = () => {
        pending.delete(key);
        active--;
        drain();
      };
      void Promise.resolve().then(() => probe(key)).then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    });
    drain();
    return result;
  };
}
