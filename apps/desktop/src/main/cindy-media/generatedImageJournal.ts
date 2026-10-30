import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedImageEventData } from '@cindy/maker-core';
import { withCrossProcessLock } from '../device-link/crossProcessLock';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile';

/** Only recovery metadata lives here. Image bytes always live in cindy-media. */
export interface GeneratedImageUpstream {
  agentDeviceId: string;
  sessionId: string;
  relay: string;
}

export interface GeneratedImageCleanup {
  version: 1;
  scope: string;
  sessionId: string;
  agentDeviceId: string;
  clearedAt: number | null;
  deleted: boolean;
}

export interface GeneratedImageRecord {
  version: 1;
  id: string;
  scope: string;
  createdAt: number;
  image: Omit<GeneratedImageEventData, 'data' | 'url'>;
  sourceUrl?: string;
  blobUrl?: string;
  state: 'pending' | 'stored' | 'failed' | 'released';
  errorCode?: string;
  /** Task clear boundary captured before the asynchronous delivery starts. */
  clearedAt?: number | null;
  agentDeviceId?: string;
  remoteHostId?: string | null;
  workingDir?: string | null;
  sourceReleased?: boolean;
  upstream?: GeneratedImageUpstream;
  upstreamReleased?: boolean;
}

export function generatedImageId(
  image: Pick<GeneratedImageEventData, 'threadId' | 'turnId' | 'blockId'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([image.threadId ?? '', image.turnId ?? '', image.blockId]))
    .digest('hex');
}

export function createGeneratedImageJournal(root: string, assertCurrent: () => void) {
  const scopeDir = (scope: string) =>
    path.join(root, createHash('sha256').update(scope).digest('hex'));
  const fileFor = (scope: string, id: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('INVALID_IMAGE_DELIVERY');
    return path.join(scopeDir(scope), `${id}.json`);
  };

  async function read(scope: string, id: string): Promise<GeneratedImageRecord | null> {
    assertCurrent();
    const file = fileFor(scope, id);
    try {
      await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const source = await readBoundedFileNoFollow(file, 128 * 1024, { nonBlocking: true });
    if (!source) throw new Error('INVALID_IMAGE_DELIVERY');
    const record = JSON.parse(source.toString('utf8')) as GeneratedImageRecord;
    assertCurrent();
    if (
      record.version !== 1 ||
      record.id !== id ||
      record.scope !== scope ||
      !record.image ||
      record.image.kind !== 'generation' ||
      typeof record.image.blockId !== 'string' ||
      generatedImageId(record.image) !== id ||
      !Number.isFinite(record.createdAt) ||
      !['pending', 'stored', 'failed', 'released'].includes(record.state)
    )
      throw new Error('INVALID_IMAGE_DELIVERY');
    return record;
  }

  async function update(
    scope: string,
    id: string,
    change: (
      previous: GeneratedImageRecord | null,
    ) => Promise<GeneratedImageRecord> | GeneratedImageRecord,
  ): Promise<GeneratedImageRecord> {
    fileFor(scope, id); // Validate before deriving a lock or temporary path.
    return updateFile(scope, `${id}.json`, () => read(scope, id), change);
  }

  async function updateFile<T>(
    scope: string,
    name: string,
    previous: () => Promise<T | null>,
    change: (value: T | null) => Promise<T> | T,
  ): Promise<T> {
    assertCurrent();
    const dir = scopeDir(scope);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('INVALID_IMAGE_DELIVERY');
    return withCrossProcessLock(
      path.join(dir, `${name}.lock`),
      { label: 'generated-image-delivery' },
      async (lock) => {
        if (!lock.held) throw new Error('IMAGE_DELIVERY_BUSY');
        assertCurrent();
        const next = await change(await previous());
        assertCurrent();
        const encoded = JSON.stringify(next);
        if (Buffer.byteLength(encoded) > 128 * 1024) throw new Error('INVALID_IMAGE_DELIVERY');
        const temporary = path.join(dir, `.${name}.${randomUUID()}.tmp`);
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(encoded);
            await handle.sync();
          } finally {
            await handle.close();
          }
          assertCurrent();
          await fs.rename(temporary, path.join(dir, name));
          if (process.platform !== 'win32') {
            const directory = await fs.open(dir, 'r');
            try {
              await directory.sync();
            } finally {
              await directory.close();
            }
          }
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => undefined);
        }
        return next;
      },
    );
  }

  async function list(scope: string): Promise<GeneratedImageRecord[]> {
    assertCurrent();
    let names: string[];
    try {
      names = await fs.readdir(scopeDir(scope));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: GeneratedImageRecord[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = await read(scope, name.slice(0, -5));
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function listAll(): Promise<GeneratedImageRecord[]> {
    assertCurrent();
    let dirs: string[];
    try {
      dirs = await fs.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: GeneratedImageRecord[] = [];
    for (const dir of dirs) {
      if (!/^[a-f0-9]{64}$/.test(dir)) continue;
      const info = await fs.lstat(path.join(root, dir));
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      for (const name of await fs.readdir(path.join(root, dir))) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const raw = await readBoundedFileNoFollow(path.join(root, dir, name), 128 * 1024, {
          nonBlocking: true,
        });
        if (!raw) continue;
        const value = JSON.parse(raw.toString('utf8')) as { scope?: unknown };
        if (typeof value.scope !== 'string' || path.basename(scopeDir(value.scope)) !== dir)
          continue;
        const record = await read(value.scope, name.slice(0, -5));
        if (record) records.push(record);
      }
    }
    assertCurrent();
    return records;
  }
  async function readCleanup(scope: string): Promise<GeneratedImageCleanup | null> {
    assertCurrent();
    const file = path.join(scopeDir(scope), 'cleanup.json');
    try {
      await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const raw = await readBoundedFileNoFollow(file, 128 * 1024, { nonBlocking: true });
    assertCurrent();
    if (!raw) throw new Error('INVALID_IMAGE_DELIVERY');
    const value = JSON.parse(raw.toString('utf8')) as GeneratedImageCleanup;
    if (
      value.version !== 1 ||
      value.scope !== scope ||
      typeof value.sessionId !== 'string' ||
      typeof value.agentDeviceId !== 'string' ||
      typeof value.deleted !== 'boolean' ||
      (value.clearedAt !== null && (!Number.isSafeInteger(value.clearedAt) || value.clearedAt < 0))
    )
      throw new Error('INVALID_IMAGE_DELIVERY');
    return value;
  }

  const updateCleanup = (
    scope: string,
    change: (value: GeneratedImageCleanup | null) => GeneratedImageCleanup,
  ) => updateFile(scope, 'cleanup.json', () => readCleanup(scope), change);

  async function listCleanups(): Promise<GeneratedImageCleanup[]> {
    assertCurrent();
    const dirs = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const result: GeneratedImageCleanup[] = [];
    for (const dir of dirs) {
      if (!/^[a-f0-9]{64}$/.test(dir)) continue;
      const info = await fs.lstat(path.join(root, dir));
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const file = path.join(root, dir, 'cleanup.json');
      const raw = await readBoundedFileNoFollow(file, 128 * 1024, { nonBlocking: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      if (!raw) continue;
      const value = JSON.parse(raw.toString('utf8')) as { scope?: unknown };
      if (typeof value.scope !== 'string' || path.basename(scopeDir(value.scope)) !== dir) continue;
      const record = await readCleanup(value.scope);
      if (record) result.push(record);
    }
    assertCurrent();
    return result;
  }
  return { read, update, list, listAll, readCleanup, updateCleanup, listCleanups };
}

export function initialGeneratedImageRecord(
  scope: string,
  image: GeneratedImageEventData,
): GeneratedImageRecord {
  // Explicit allowlist: no Base64, arbitrary event fields, or in-memory callbacks in the journal.
  return {
    version: 1,
    id: generatedImageId(image),
    scope,
    createdAt: Date.now(),
    state: 'pending',
    image: {
      kind: 'generation',
      blockId: image.blockId,
      ...(image.threadId ? { threadId: image.threadId } : {}),
      ...(image.turnId ? { turnId: image.turnId } : {}),
      ...(image.path ? { path: image.path } : {}),
      ...(image.pathOrigin ? { pathOrigin: image.pathOrigin } : {}),
      ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      ...(image.status ? { status: image.status } : {}),
      ...(image.deliveryEpoch !== undefined ? { deliveryEpoch: image.deliveryEpoch } : {}),
    },
    ...(image.url && !image.url.startsWith('data:') ? { sourceUrl: image.url } : {}),
  };
}
