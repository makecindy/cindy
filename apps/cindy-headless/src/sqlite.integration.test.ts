// Real on-disk SQLite through the node:sqlite adapter that replaces better-sqlite3
// in the Linux headless runtime. Kept out of the unit tier (engineering-conventions
// §3.1): on cold Windows CI runners the file and SQLite I/O alone exceeded 5 s.
import { MakerMemoryManager } from '@cindy/maker-core';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteSessionStorage } from './session-storage.js';
import { openHeadlessSqlite } from './sqlite.js';

const logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
} as never;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-sqlite-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Cindy Maker Memory contract', () => {
  it('persists a workdir-scoped record and indexes it for search', async () => {
    const manager = new MakerMemoryManager({
      basePath: path.join(root, 'memory'),
      sqliteFactory: openHeadlessSqlite,
      agents: {},
      initialEnabled: true,
      logger,
      reviewAgent: 'claude-code',
    });
    try {
      const store = await manager.getStore(path.join(root, 'workspace'));
      await store.write({ type: 'project', name: 'headless-contract', title: 'Headless contract', description: 'Cindy parity', body: 'Maker Memory persists project facts.' });
      expect((await store.list()).map((record) => record.frontmatter.title)).toContain('Headless contract');
      expect((await store.search('project facts')).length).toBeGreaterThan(0);
    } finally {
      manager.dispose();
    }
  });
});

describe('SqliteSessionStorage', () => {
  it('persists session metadata and clears the expected SDK id atomically', async () => {
    const file = path.join(root, 'sessions.sqlite');
    const first = new SqliteSessionStorage(file);
    await first.create({ id: 'session-1', agentKind: 'codex', workDir: root, title: 'test', model: 'gpt-test', sdkSessionId: 'sdk-1' });
    first.close();

    const reopened = new SqliteSessionStorage(file);
    try {
      expect((await reopened.get('session-1'))?.sdkSessionId).toBe('sdk-1');
      expect(await reopened.compareAndClearSdkSessionId('session-1', 'wrong')).toBe(false);
      expect(await reopened.compareAndClearSdkSessionId('session-1', 'sdk-1')).toBe(true);
      expect(await reopened.compareAndClearSdkSessionId('session-1', 'sdk-1')).toBe(false);
      expect((await reopened.get('session-1'))?.sdkSessionId).toBeUndefined();
    } finally {
      reopened.close();
    }
  });
});
