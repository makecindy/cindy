import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** A native thread has one durable rollout, regardless of the account resuming it. */
export class CodexThreadLocations {
  constructor(private readonly directory: string) {}

  private file(threadId: string): string {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(threadId)) throw new Error('Invalid Codex thread id');
    return path.join(this.directory, `${threadId}.json`);
  }

  async read(threadId: string): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(threadId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const value = JSON.parse(raw);
    if (
      value.threadId !== threadId ||
      typeof value.path !== 'string' ||
      !path.isAbsolute(value.path)
    ) {
      throw new Error('Invalid Codex thread location');
    }
    // A missing canonical file must not silently select an older copy.
    const stat = await fs.lstat(value.path);
    if (!stat.isFile()) throw new Error('Codex thread history is unavailable');
    return value.path;
  }

  async readStorage(
    threadId: string,
    legacy?: { home: string; prepare: (threadId: string) => Promise<string | undefined> },
  ): Promise<{ historyHome: string; sqliteHome: string } | undefined> {
    const rollout = await this.read(threadId);
    if (!rollout) {
      // Pre-multi-account threads have no location record. Resolve their native
      // storage before an account-specific host starts, without moving history.
      const legacyRollout = await legacy?.prepare(threadId);
      if (!legacy || !legacyRollout) return;
      await this.record(threadId, legacyRollout, legacy.home);
      return { historyHome: historyHomeForRollout(legacyRollout), sqliteHome: legacy.home };
    }
    const value = JSON.parse(await fs.readFile(this.file(threadId), 'utf8'));
    if (value.sqliteHome !== undefined) {
      if (typeof value.sqliteHome !== 'string' || !path.isAbsolute(value.sqliteHome)) throw new Error('Invalid Codex history storage');
      return { historyHome: historyHomeForRollout(rollout), sqliteHome: value.sqliteHome };
    }
    // Compatibility with locations written before native database ownership was recorded.
    const historyHome = historyHomeForRollout(rollout);
    return { historyHome, sqliteHome: historyHome };
  }

  async record(threadId: string, rolloutPath: string, sqliteHome?: string): Promise<void> {
    if (!path.isAbsolute(rolloutPath)) throw new Error('Invalid Codex rollout path');
    const file = this.file(threadId);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ threadId, path: rolloutPath, sqliteHome }), {
        mode: 0o600,
      });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

function historyHomeForRollout(rollout: string): string {
  for (let dir = path.dirname(rollout); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (['sessions', 'archived_sessions'].includes(path.basename(dir))) return path.dirname(dir);
  }
  throw new Error('Codex history storage is unavailable');
}
