/**
 * digest 记忆类型 —— 压缩即记忆的存储契约:
 *  - digest 可写入 store、进 list()(→ 进 FTS,可被 memory_search 检索);
 *  - 但**排除出 MEMORY.md 索引**(rebuildIndex 只列 curated 类型),故不自动注入 system prompt、
 *    不污染 curated 记忆。
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStorage } from './storage.js';
import { MakerMemoryManager } from './manager.js';
import { DEFAULT_MEMORY_CONFIG, MEMORY_TYPES, CURATED_MEMORY_TYPES } from './types.js';
import type { Logger } from '../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'memory-digest-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('digest memory type', () => {
  it('is a valid storage type but not a curated type', () => {
    expect(MEMORY_TYPES).toContain('digest');
    expect(CURATED_MEMORY_TYPES).not.toContain('digest');
  });

  it('writes a digest entry that lists() sees but MEMORY.md excludes', async () => {
    const storage = new MemoryStorage(dir, DEFAULT_MEMORY_CONFIG);
    await storage.write({
      type: 'project',
      name: 'curated-note',
      title: 'Curated project note',
      description: 'a curated one-liner',
      body: 'curated body',
    });
    await storage.write({
      type: 'digest',
      name: 'pi-compaction-1',
      title: 'PI compaction digest (threshold)',
      description: 'summary of dropped context about the API redesign',
      body: 'The conversation covered the API redesign, auth changes, and test plan.',
    });

    // list() 两条都在(→ FTS 会索引 digest,memory_search 可查)。
    const records = await storage.list();
    const types = records.map((r) => r.frontmatter.type).sort();
    expect(types).toEqual(['digest', 'project']);

    // MEMORY.md:curated 在、digest 不在。
    const indexRaw = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(indexRaw).toContain('Curated project note');
    expect(indexRaw).not.toContain('PI compaction digest');
    expect(indexRaw).not.toContain('## digest');
    // digest 的文件确实落盘了(digest_<slug>.md)。
    expect(records.some((r) => r.filename === 'digest_pi-compaction-1.md')).toBe(true);
  });

  it('resetDigests removes only Pi digests and preserves curated memory', async () => {
    const basePath = dir;
    const storageDir = path.join(basePath, 'maker-memory', 'repo');
    const storage = new MemoryStorage(storageDir, DEFAULT_MEMORY_CONFIG);
    await storage.init('/repo');
    await storage.write({
      type: 'project', name: 'keep', title: 'Keep me', description: 'curated', body: 'important',
    });
    await storage.write({
      type: 'digest', name: 'drop', title: 'Drop me', description: 'pi digest', body: 'summary',
    });
    const manager = new MakerMemoryManager({
      basePath,
      sqliteFactory: () => { throw new Error('unopened stores must not need sqlite'); },
      agents: {},
      logger: noopLogger,
    });

    await expect(manager.resetDigests()).resolves.toEqual({ removedCount: 1 });
    expect((await storage.list()).map((record) => record.filename)).toEqual(['project_keep.md']);
    expect(await storage.getIndex()).toContain('Keep me');
  });
});
