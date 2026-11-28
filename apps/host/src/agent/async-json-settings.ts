/**
 * An asynchronous JSON settings file for Host Device Link handlers.
 *
 * Remote calls run on the Host's only event loop, so a preference write must not
 * block it (engineering-conventions §8.5). Every read and read-modify-write of one
 * store runs in order, so two controllers changing it at once never lose an update;
 * a write replaces the file through a temporary file and a rename.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface AsyncJsonSettings<T> {
  read(): Promise<T>;
  /** Reads the current value, lets `change` compute the next one and replaces the file. */
  update<R>(change: (current: T) => { next: T; result: R }): Promise<R>;
  reset(): Promise<void>;
}

// Windows can refuse a rename while another process briefly holds the target open.
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function replaceFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, contents, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (process.platform !== 'win32' || !RETRYABLE_RENAME.has(code) || attempt >= 4) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createAsyncJsonSettings<T>(options: {
  filePath(): string;
  defaults(): T;
  normalize(raw: unknown): T;
  log: { warn(message: string, meta?: unknown): void };
  label: string;
}): AsyncJsonSettings<T> {
  let tail: Promise<unknown> = Promise.resolve();
  const inOrder = <R>(task: () => Promise<R>): Promise<R> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
  const load = async (file: string): Promise<T> => {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return options.defaults();
      throw error;
    }
    try {
      return options.normalize(JSON.parse(text));
    } catch (error) {
      options.log.warn(`${options.label} is unreadable; using defaults`, { file, error: String(error) });
      return options.defaults();
    }
  };
  return {
    read: () => inOrder(() => load(options.filePath())),
    update: change => inOrder(async () => {
      const file = options.filePath();
      const { next, result } = change(await load(file));
      await replaceFile(file, `${JSON.stringify(next, null, 2)}\n`);
      return result;
    }),
    reset: () => inOrder(() => fs.rm(options.filePath(), { force: true })),
  };
}
