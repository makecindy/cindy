/**
 * 回收站契约 (review P1 修正):
 *  - softDelete 必须把文件 rename 进 .trash/ 而不是 unlink (否则无法恢复);
 *  - restore 遇主目录同名条目时 fail closed, 不得静默覆盖。
 */

import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStorage } from './storage.js';
import { MemoryError } from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'memory-trash-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeStorage(): MemoryStorage {
  return new MemoryStorage(dir, DEFAULT_MEMORY_CONFIG);
}

async function writeNote(storage: MemoryStorage, name: string, body: string): Promise<void> {
  await storage.write({
    type: 'project',
    name,
    title: 'Note ' + name,
    description: 'hook for ' + name,
    body,
  });
}

describe('memory trash lifecycle', () => {
  it('softDelete moves the file into .trash instead of unlinking', async () => {
    const storage = makeStorage();
    await writeNote(storage, 'to_delete', 'body v1');

    await storage.softDelete('project_to_delete.md');

    const trashPath = path.join(dir, '.trash', 'project_to_delete.md');
    await expect(access(trashPath)).resolves.toBeUndefined();
    const raw = await readFile(trashPath, 'utf8');
    expect(raw).toContain('body v1');
    const listed = await storage.list();
    expect(listed.map((r) => r.filename)).not.toContain('project_to_delete.md');

    const trash = await storage.listTrash();
    expect(trash.map((entry) => entry.filename)).toContain('project_to_delete.md');
  });

  it('restore moves the trash entry back into the store', async () => {
    const storage = makeStorage();
    await writeNote(storage, 'to_restore', 'body v1');
    await storage.softDelete('project_to_restore.md');

    const result = await storage.restore('project_to_restore.md');
    expect(result.ok).toBe(true);
    const listed = await storage.list();
    expect(listed.map((r) => r.filename)).toContain('project_to_restore.md');
    await expect(access(path.join(dir, '.trash', 'project_to_restore.md'))).rejects.toThrow();
  });

  it('restore fails closed when the same filename exists in the store', async () => {
    const storage = makeStorage();
    await writeNote(storage, 'dup', 'old body');
    await storage.softDelete('project_dup.md');
    await writeNote(storage, 'dup', 'new body');

    await expect(storage.restore('project_dup.md')).rejects.toMatchObject({
      code: 'already-exists',
    });
    // 新条目不被覆盖, 回收站条目也保留 (用户可先删除同名条目再恢复)。
    const listed = await storage.list();
    const dup = listed.find((r) => r.filename === 'project_dup.md');
    expect(dup?.body).toBe('new body');
    await expect(access(path.join(dir, '.trash', 'project_dup.md'))).resolves.toBeUndefined();
  });

  it('restore of a missing trash entry is not-found', async () => {
    const storage = makeStorage();
    await expect(storage.restore('project_absent.md')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('softDelete of a missing entry is not-found', async () => {
    const storage = makeStorage();
    await expect(storage.softDelete('project_absent.md')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('MemoryError carries already-exists code for conflict detection', () => {
    const err = new MemoryError('already-exists', 'x');
    expect(err.code).toBe('already-exists');
  });
});
