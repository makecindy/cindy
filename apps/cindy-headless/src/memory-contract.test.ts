import { MakerMemoryManager } from '@cindy/maker-core';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openHeadlessSqlite } from './sqlite.js';

const logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
} as never;

describe('Cindy Maker Memory contract', () => {
  it('persists a workdir-scoped record and indexes it for search', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-memory-'));
    const manager = new MakerMemoryManager({
      basePath: root,
      sqliteFactory: openHeadlessSqlite,
      agents: {},
      initialEnabled: true,
      logger,
      reviewAgent: 'claude-code',
    });
    const store = await manager.getStore(path.join(root, 'workspace'));
    await store.write({ type: 'project', name: 'headless-contract', title: 'Headless contract', description: 'Cindy parity', body: 'Maker Memory persists project facts.' });
    expect((await store.list()).map((record) => record.frontmatter.title)).toContain('Headless contract');
    expect((await store.search('project facts')).length).toBeGreaterThan(0);
    manager.dispose();
  });
});
