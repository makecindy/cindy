import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Dir } from 'node:fs';
import path from 'node:path';
import {
  OperationBudget,
  currentOperationBudget,
  operationCheckpoint,
  operationWait,
} from '../utils/operationBudget';

/** Durable dispatch intent, independent of Git availability. No prompt or file contents. */
export interface SnapshotAttempt {
  id: string;
  anchor?: string;
}

const MAX_ATTEMPTS = 10_000;
const MAX_RECORD_BYTES = 4_096;

/**
 * Immutable records avoid read/modify/write races between retries and processes.
 * A failed/partial write is deliberately retained: unreadable evidence blocks rewind.
 * The caller must await record() before authorizing vendor dispatch. Timed-out writes
 * may finish late, but can only leave an extra pending intent, never authorize a send.
 */
export class SnapshotAttemptStore {
  constructor(private readonly ownerRoot: string) {}

  private directory(sessionId: string): string {
    return path.join(
      this.ownerRoot,
      'git-snapshot-attempts',
      createHash('sha256').update(sessionId).digest('hex'),
    );
  }

  async record(sessionId: string, anchor?: string): Promise<SnapshotAttempt> {
    if (anchor !== undefined && (!anchor || anchor.length > 1024))
      throw new Error('Invalid snapshot anchor');
    const attempt = { id: randomUUID(), ...(anchor ? { anchor } : {}) };
    const content = JSON.stringify({ version: 1, ...attempt });
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES)
      throw new Error('Snapshot attempt record too large');
    const dir = this.directory(sessionId);
    operationCheckpoint();
    await operationWait(fs.mkdir(dir, { recursive: true }));
    operationCheckpoint();
    await operationWait(
      fs.writeFile(path.join(dir, `${attempt.id}.json`), content, {
        flag: 'wx',
        mode: 0o600,
        flush: true,
        signal: currentOperationBudget()?.signal,
      }),
    );
    return attempt;
  }

  /** null means unknown/corrupt/truncated, never an empty successful history. */
  async read(sessionId: string): Promise<SnapshotAttempt[] | null> {
    return new OperationBudget(8_000).run(() => this.readRecords(sessionId)).catch(() => null);
  }

  private async readRecords(sessionId: string): Promise<SnapshotAttempt[] | null> {
    const attempts: SnapshotAttempt[] = [];
    let dir: Dir;
    try {
      dir = await fs.opendir(this.directory(sessionId));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
    }
    try {
      for await (const entry of dir) {
        operationCheckpoint();
        if (
          !entry.isFile() ||
          !/^[a-f0-9-]{36}\.json$/.test(entry.name) ||
          attempts.length >= MAX_ATTEMPTS
        )
          return null;
        const file = await fs.open(path.join(this.directory(sessionId), entry.name), 'r');
        try {
          operationCheckpoint();
          const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > MAX_RECORD_BYTES) return null;
          const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
          if (
            record.version !== 1 ||
            `${record.id}.json` !== entry.name ||
            (record.anchor !== undefined &&
              (typeof record.anchor !== 'string' || !record.anchor || record.anchor.length > 1024))
          )
            return null;
          attempts.push({ id: record.id, ...(record.anchor ? { anchor: record.anchor } : {}) });
        } finally {
          await file.close();
        }
      }
      return attempts;
    } catch {
      return null;
    }
  }
}
