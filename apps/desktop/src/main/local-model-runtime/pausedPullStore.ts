import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isOllamaModelName, type LocalModelPullProgress } from '../../shared/localModelRuntime.js';

export interface PausedPullRecord {
  name: string;
  completed?: number;
  total?: number;
  percent?: number;
  digests: string[];
  updatedAt: number;
}

function sanitize(value: unknown): PausedPullRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isOllamaModelName(record.name)) return null;
  const digests = Array.isArray(record.digests)
    ? record.digests.filter((item): item is string => typeof item === 'string' && item.startsWith('sha256:'))
    : [];
  const completed = typeof record.completed === 'number' && record.completed >= 0 ? record.completed : undefined;
  const total = typeof record.total === 'number' && record.total > 0 ? record.total : undefined;
  const percent =
    typeof record.percent === 'number' && record.percent >= 0
      ? Math.min(100, Math.round(record.percent))
      : total && completed != null
        ? Math.min(100, Math.round((completed / total) * 100))
        : undefined;
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : Date.now();
  return { name: record.name, completed, total, percent, digests, updatedAt };
}

function parseRecords(value: unknown): PausedPullRecord[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (record.version === 2 && Array.isArray(record.items)) {
    const items: PausedPullRecord[] = [];
    const seen = new Set<string>();
    for (const item of record.items) {
      const next = sanitize(item);
      if (!next || seen.has(next.name)) continue;
      seen.add(next.name);
      items.push(next);
    }
    return items;
  }
  const single = sanitize(value);
  return single ? [single] : [];
}

export function progressFromPausedRecord(record: PausedPullRecord): LocalModelPullProgress {
  return {
    name: record.name,
    status: 'paused',
    phase: 'paused',
    done: true,
    ...(record.completed != null ? { completed: record.completed } : {}),
    ...(record.total != null ? { total: record.total } : {}),
    ...(record.percent != null ? { percent: record.percent } : {}),
  };
}

export function createPausedPullStore(filePath: string) {
  let queue: Promise<void> = Promise.resolve();
  const serialized = <T>(op: () => Promise<T>): Promise<T> => {
    const run = queue.then(op, op);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const persist = async (items: readonly PausedPullRecord[]): Promise<void> => {
    if (items.length === 0) {
      try {
        await unlink(filePath);
      } catch {
        /* already gone */
      }
      return;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 2, items })}\n`, 'utf8');
    await rename(tmp, filePath);
  };

  const readAll = async (): Promise<PausedPullRecord[]> => {
    try {
      return parseRecords(JSON.parse(await readFile(filePath, 'utf8')));
    } catch {
      return [];
    }
  };

  const readAllSync = (): PausedPullRecord[] => {
    try {
      return parseRecords(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
      return [];
    }
  };

  return {
    async readAll(): Promise<PausedPullRecord[]> {
      return readAll();
    },
    readAllSync(): PausedPullRecord[] {
      return readAllSync();
    },
    async read(name?: string): Promise<PausedPullRecord | null> {
      const items = await readAll();
      if (name) return items.find((item) => item.name === name) ?? null;
      return items[0] ?? null;
    },
    readSync(name?: string): PausedPullRecord | null {
      const items = readAllSync();
      if (name) return items.find((item) => item.name === name) ?? null;
      return items[0] ?? null;
    },
    async write(progress: LocalModelPullProgress, digests: readonly string[]): Promise<void> {
      if (!isOllamaModelName(progress.name)) return;
      const next: PausedPullRecord = {
        name: progress.name,
        ...(progress.completed != null ? { completed: progress.completed } : {}),
        ...(progress.total != null ? { total: progress.total } : {}),
        ...(progress.percent != null ? { percent: progress.percent } : {}),
        digests: [...new Set(digests.filter((item) => item.startsWith('sha256:')))],
        updatedAt: Date.now(),
      };
      await serialized(async () => {
        const items = (await readAll()).filter((item) => item.name !== next.name);
        items.push(next);
        await persist(items);
      });
    },
    async remove(name: string): Promise<PausedPullRecord | null> {
      return serialized(async () => {
        const items = await readAll();
        const record = items.find((item) => item.name === name) ?? null;
        await persist(items.filter((item) => item.name !== name));
        return record;
      });
    },
    async clear(): Promise<void> {
      await serialized(async () => {
        await persist([]);
      });
    },
  };
}
