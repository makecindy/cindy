import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeMeta } from '../worktree/types';

const fixture = vi.hoisted(() => ({ db: null as Database.Database | null, unavailable: false }));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({
  queryOne: async (sql: string, params: unknown[]) => {
    if (fixture.unavailable) throw new Error('fixture DB unavailable');
    return fixture.db!.prepare(sql).get(...params);
  },
  readLocalWorktreeReferences: async () => [],
}) }));
vi.mock('../localDb/ipc/sessions', () => ({ setWorktreePathInDb: async (id: string, value: string) => {
  if (fixture.unavailable) throw new Error('fixture DB unavailable');
  fixture.db!.prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?').run(value, id);
} }));
vi.mock('../worktree/runtimeLeases', () => ({
  readWorktreeRuntimePaths: async () => new Set(),
  acquireWorktreeRuntimeLease: async () => {}, releaseWorktreeRuntimeLease: async () => {},
}));

let root: string;
let meta: WorktreeMeta;
let manager: typeof import('../worktree/WorktreeManager');
let store: typeof import('../worktree/worktreeStore');
const identity = { delegationId: 'delegation', requestingBotId: 'owner-bot' };
const intent = () => ({ ...meta, pendingSessionTransfer: { ...identity, sessionId: 'next' } });

async function reopenStorage() {
  fixture.db?.close();
  fixture.db = new Database(path.join(root, 'sessions.sqlite'));
  vi.resetModules();
  store = await import('../worktree/worktreeStore');
  // Real atomic disk snapshots, with no in-memory state surviving reopenStorage.
  const registry = path.join(root, 'worktrees.json');
  store._setStoreForTests({
    get: (key: string, fallback: unknown) => JSON.parse(readFileSync(registry, 'utf8'))[key] ?? fallback,
    set: (key: string, value: unknown) => {
      const data = JSON.parse(readFileSync(registry, 'utf8'));
      data[key] = value;
      writeFileSync(`${registry}.tmp`, JSON.stringify(data));
      renameSync(`${registry}.tmp`, registry);
    },
  } as never);
  manager = await import('../worktree/WorktreeManager');
}

function commitChild(next = 'next') {
  fixture.db!.transaction(() => {
    fixture.db!.prepare('INSERT INTO sessions VALUES (?, ?)').run(next, meta.path);
    fixture.db!.prepare('UPDATE bot_delegations SET child_session_id = ? WHERE id = ?').run(next, identity.delegationId);
  })();
  return { reopened: true };
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cindy-worktree-transfer-'));
  fixture.unavailable = false;
  writeFileSync(path.join(root, 'worktrees.json'), '{}');
  await reopenStorage();
  fixture.db!.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, worktree_path TEXT); CREATE TABLE bot_delegations (id TEXT PRIMARY KEY, child_session_id TEXT, requesting_bot_id TEXT)');
  meta = { sessionId: 'previous', name: 'task', path: path.join(root, '.cindy-worktrees', 'task'),
    baseRepo: root, branch: 'cindy/task', sourceBranch: 'main', createdAt: '2026-09-12T00:00:00.000Z', generation: 'generation-1' };
  mkdirSync(meta.path, { recursive: true });
  writeFileSync(path.join(meta.path, 'user-work.txt'), 'keep my changes');
  fixture.db!.prepare('INSERT INTO sessions VALUES (?, ?)').run(meta.sessionId, meta.path);
  fixture.db!.prepare('INSERT INTO bot_delegations VALUES (?, ?, ?)').run(identity.delegationId, meta.sessionId, identity.requestingBotId);
  await store.set(meta.sessionId, meta);
});
afterEach(() => {
  fixture.db?.close(); fixture.db = null;
  rmSync(root, { recursive: true, force: true });
});

describe('durable task worktree transfer', () => {
  it('journals before commit and preserves the branch and files through repeated continuations', async () => {
    await manager.withTransferredSession('previous', 'next', meta.path, async () => {
      expect(store.get('previous')).toEqual(intent());
      expect(store.get('next')).toBeNull();
      return commitChild();
    }, identity);
    await manager.removeWorktreeForSession('previous');
    expect(store.get('next')).toEqual({ ...meta, sessionId: 'next' });
    await manager.withTransferredSession('next', 'again', meta.path, async () => commitChild('again'), identity);
    expect(store.get('previous')).toBeNull();
    expect(store.get('next')).toBeNull();
    expect(store.get('again')).toEqual({ ...meta, sessionId: 'again' });
    expect(readFileSync(path.join(meta.path, 'user-work.txt'), 'utf8')).toBe('keep my changes');
  });

  it.each(['throw', 'cas'] as const)('retains the old owner after confirmed %s failure', async failure => {
    const op = manager.withTransferredSession('previous', 'next', meta.path, async () => {
      if (failure === 'throw') throw new Error('fixture commit failed');
      return { reopened: false };
    }, identity);
    if (failure === 'throw') await expect(op).rejects.toThrow('fixture commit failed');
    else expect(await op).toEqual({ reopened: false });
    expect(store.get('previous')).toEqual(meta);
    expect(store.get('next')).toBeNull();
  });

  it('recovers a process exit after the registry write and before the DB commit, then retries once', async () => {
    // Persist exactly the production pre-commit checkpoint; no catch/finally runs.
    await store.replace('previous', 'previous', intent(), meta);
    await reopenStorage();
    await manager.reconcileSessionTransfer('previous');
    expect(store.get('previous')).toEqual(meta);
    await manager.withTransferredSession('previous', 'next', meta.path, async () => commitChild(), identity);
    await reopenStorage();
    await manager.reconcileSessionTransfer('next');
    expect(store.get('next')).toEqual({ ...meta, sessionId: 'next' });
    expect(fixture.db!.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 2 });
  });

  it('recovers an uncommitted transfer when the old display snapshot was never available', async () => {
    await store.replace('previous', 'previous', intent(), meta);
    fixture.db!.prepare('UPDATE sessions SET worktree_path = NULL WHERE id = ?').run('previous');
    await reopenStorage();
    await manager.reconcileSessionTransfer('previous');
    expect(store.get('previous')).toEqual(meta);
    expect(store.get('next')).toBeNull();
  });

  it('rejects a missing or occupied owner before executing the DB transaction', async () => {
    const commit = vi.fn(async () => commitChild());
    await expect(manager.withTransferredSession('missing', 'next', meta.path, commit, identity)).rejects.toThrow('ownership changed');
    await store.set('next', { ...meta, sessionId: 'next', path: path.join(root, 'other') });
    await expect(manager.withTransferredSession('previous', 'next', meta.path, commit, identity)).rejects.toThrow('ownership changed');
    expect(commit).not.toHaveBeenCalled();
    expect(store.get('previous')).toEqual(meta);
  });

  it('finishes committed ownership when the worker commit receipt is lost', async () => {
    await expect(manager.withTransferredSession('previous', 'next', meta.path, async () => {
      commitChild();
      throw new Error('fixture lost receipt');
    }, identity)).rejects.toThrow('fixture lost receipt');
    expect(store.get('previous')).toBeNull();
    expect(store.get('next')).toEqual({ ...meta, sessionId: 'next' });
    await reopenStorage();
    await manager.reconcileSessionTransfer('next');
    expect(store.get('next')?.sessionId).toBe('next');
  });

  it.each([false, true])('preserves uncertain outcomes until restart readback (committed: %s)', async committed => {
    await expect(manager.withTransferredSession('previous', 'next', meta.path, async () => {
      if (committed) commitChild();
      fixture.unavailable = true;
      throw new Error('fixture worker exited');
    }, identity)).rejects.toThrow('fixture worker exited');
    expect(store.get('previous')).toEqual(intent());
    // Both ordinary recycling and precreation compensation preserve the journal/files.
    await manager.removeWorktreeForSession('previous', { canRemove: async () => true });
    await manager.removeWorktreeForSession('previous', { preserveDirty: true, canRemove: async () => true });
    expect(readFileSync(path.join(meta.path, 'user-work.txt'), 'utf8')).toBe('keep my changes');
    fixture.unavailable = false;
    await reopenStorage();
    await manager.reconcileSessionTransfer(committed ? 'next' : 'previous');
    await manager.reconcileSessionTransfer(committed ? 'next' : 'previous');
    expect(store.get(committed ? 'next' : 'previous')).toEqual({ ...meta, sessionId: committed ? 'next' : 'previous' });
  });

  it.each(['owner', 'target', 'path-owner', 'generation'] as const)('never steals conflicting %s ownership during recovery', async conflict => {
    await store.replace('previous', 'previous', intent(), meta);
    commitChild();
    if (conflict === 'owner') fixture.db!.prepare('UPDATE bot_delegations SET requesting_bot_id = ?').run('other-bot');
    if (conflict === 'target') await store.set('next', { ...meta, sessionId: 'next', path: path.join(root, 'other') });
    if (conflict === 'path-owner') await store.set('other', { ...meta, sessionId: 'other' });
    if (conflict === 'generation') {
      const originalReplace = store.replace;
      const replace = vi.spyOn(store, 'replace');
      replace.mockImplementationOnce(async (...args) => {
        await store.set('previous', { ...intent(), generation: 'replacement-generation' });
        return originalReplace(...args);
      });
    }
    await expect(manager.reconcileSessionTransfer('next')).rejects.toThrow('ownership changed');
    expect(store.get('previous')?.pendingSessionTransfer).toEqual(intent().pendingSessionTransfer);
    expect(readFileSync(path.join(meta.path, 'user-work.txt'), 'utf8')).toBe('keep my changes');
  });
});
