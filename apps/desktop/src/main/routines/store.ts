import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RoutineState } from '@cindy/maker-scheduler';

/** Account root is captured by the caller, never resolved again during an asynchronous write. */
export class RoutineFileStore {
  constructor(private readonly root: string) {}

  async load(): Promise<RoutineState | null> {
    try {
      return JSON.parse(
        await readFile(path.join(this.root, 'routines.json'), 'utf8'),
      ) as RoutineState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(state: RoutineState): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = path.join(this.root, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(state), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, path.join(this.root, 'routines.json'));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
