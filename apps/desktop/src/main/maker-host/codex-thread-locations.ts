import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

interface ThreadLocation {
  threadId: string;
  path: string;
  sqliteHome?: string;
}

/** A native thread has one durable rollout, regardless of the account resuming it. */
export class CodexThreadLocations {
  constructor(private readonly directory: string) {}

  private file(threadId: string): string {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(threadId)) throw new Error('Invalid Codex thread id');
    return path.join(this.directory, `${threadId}.json`);
  }

  private async readLocation(threadId: string): Promise<ThreadLocation | undefined> {
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
      !path.isAbsolute(value.path) ||
      (value.sqliteHome !== undefined &&
        (typeof value.sqliteHome !== 'string' || !path.isAbsolute(value.sqliteHome)))
    ) {
      throw new Error('Invalid Codex thread location');
    }
    return value;
  }

  private async rolloutExists(rollout: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(rollout);
      if (!stat.isFile()) throw new Error('Codex thread history is unavailable');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async read(threadId: string): Promise<string | undefined> {
    const value = await this.readLocation(threadId);
    if (!value) return;
    if (!await this.rolloutExists(value.path)) throw new Error('Codex thread history is unavailable');
    return value.path;
  }

  /** Missing indexed paths are resolved by native resume in their original home.
   * Never search legacy homes or silently substitute an older rollout for them. */
  async prepareResume(
    threadId: string,
    prepareLegacy: (threadId: string) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const value = await this.readLocation(threadId);
    if (!value) return prepareLegacy(threadId);
    return await this.rolloutExists(value.path) ? value.path : undefined;
  }

  async readStorage(
    threadId: string,
    legacy?: { home: string; prepare: (threadId: string) => Promise<string | undefined> },
  ): Promise<{ historyHome: string; sqliteHome: string; rolloutPath?: string } | undefined> {
    const value = await this.readLocation(threadId);
    if (!value) {
      // Pre-multi-account threads have no location record. Resolve their native
      // storage before an account-specific host starts, without moving history.
      const legacyRollout = await legacy?.prepare(threadId);
      if (!legacy || !legacyRollout) return;
      await this.record(threadId, legacyRollout, legacy.home);
      return { historyHome: historyHomeForRollout(legacyRollout), sqliteHome: legacy.home, rolloutPath: legacyRollout };
    }
    const historyHome = historyHomeForRollout(value.path);
    // thread/start returns a future path before the first turn materializes it.
    // Keep storage ownership even then, so native resume can distinguish an unused
    // thread from unreadable history without looking in the newly selected account.
    return {
      historyHome,
      sqliteHome: value.sqliteHome ?? historyHome,
      rolloutPath: value.path,
    };
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
