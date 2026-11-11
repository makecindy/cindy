import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dropPendingBuild,
  hasPendingBuild,
  initializePendingBuilds,
  readPendingBuilds,
  recordPendingBuild,
  rewritePendingBuilds,
  settlePendingBuilds,
} from '../pendingBuild';
import { hasUnbuiltPersonalChanges } from '../buildRollback';
import { CindyMakeHistoryStore } from '../historyStore';
import type { MakeFeatureReceipt } from '../../../shared/cindyMakeHistory';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cindy-pending-build-'));
  roots.push(directory);
  return directory;
}
const A = { commit: 'a'.repeat(40), tree: '1'.repeat(40) };
const B = { commit: 'b'.repeat(40), tree: '2'.repeat(40) };
const C = { commit: 'c'.repeat(40), tree: '3'.repeat(40) };

/** The account that integrated `changes`, as `recordAppliedMerge` records them. */
function account(directory: string, changes: Array<{ id: string; head: typeof A }>) {
  const store = new CindyMakeHistoryStore(path.join(directory, 'history'));
  store.seed({
    runId: 'task',
    sessionId: 'task',
    title: 'task',
    request: 'task',
    createdAt: 1,
    updatedAt: 1,
  });
  let before = { commit: '0'.repeat(40), tree: '0'.repeat(40) };
  for (const change of changes) {
    const receipt: MakeFeatureReceipt = {
      id: change.id,
      action: 'integrate',
      at: 1,
      baselineCommit: before.commit,
      commit: change.head.commit,
      beforeTree: before.tree,
      tree: change.head.tree,
      taskTree: change.head.tree,
    };
    recordPendingBuild(directory, change.head);
    store.receipt('task', receipt);
    before = change.head;
  }
  return store;
}

it('records the snapshot with its fact and keeps the newest entries', () => {
  const dir = root();
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, B);
  expect(readPendingBuilds(dir)).toEqual([A, B]);
  expect(hasPendingBuild(dir, A)).toBe(true);
  expect(hasPendingBuild(dir, C)).toBeUndefined();
});

it('initializes a fresh source as a trusted clean snapshot', () => {
  const dir = root();
  initializePendingBuilds(dir);
  expect(readPendingBuilds(dir)).toEqual([]);
  expect(hasPendingBuild(dir, A)).toBe(false);
  writeFileSync(path.join(dir, 'pending-build.json'), '{ not json');
  initializePendingBuilds(dir);
  expect(readPendingBuilds(dir)).toBeUndefined();
});

it.each(['integration', 'rewrite'] as const)(
  'keeps a truncated %s ledger unknown after rolling back every retained snapshot',
  (operation) => {
    const dir = root();
    initializePendingBuilds(dir);
    recordPendingBuild(dir, A);
    const later = Array.from({ length: 64 }, (_, i) => ({
      commit: (i + 1).toString(16).padStart(40, '0'),
      tree: (i + 1).toString(16).padStart(40, '0'),
    }));
    if (operation === 'integration') {
      for (const snapshot of later) recordPendingBuild(dir, snapshot);
    } else {
      // A readable older ledger can exceed the current bound as well.
      writeFileSync(path.join(dir, 'pending-build.json'), JSON.stringify({
        schema: 1, snapshots: [A, ...later], trusted: true,
      }));
      rewritePendingBuilds(dir, [later.at(-1)!.commit], C);
    }
    expect(readPendingBuilds(dir)).toHaveLength(64);
    for (const snapshot of readPendingBuilds(dir)!) dropPendingBuild(dir, snapshot);
    expect(readPendingBuilds(dir)).toEqual([]);
    expect(hasPendingBuild(dir, A)).toBeUndefined();
    const otherAccount = new CindyMakeHistoryStore(path.join(dir, 'other-owner'));
    expect(hasUnbuiltPersonalChanges(otherAccount, dir, A, () => false)).toBe(true);
    settlePendingBuilds(dir);
    expect(hasPendingBuild(dir, A)).toBe(false);
  },
);

it('treats a missing or unreadable record as unknown until a generation settles it', () => {
  const dir = root();
  expect(readPendingBuilds(dir)).toBeUndefined();
  expect(hasPendingBuild(dir, A)).toBeUndefined();
  mkdirSync(path.join(dir), { recursive: true });
  writeFileSync(path.join(dir, 'pending-build.json'), '{ not json');
  expect(readPendingBuilds(dir)).toBeUndefined();
  expect(hasPendingBuild(dir, A)).toBeUndefined();
  const empty = new CindyMakeHistoryStore(path.join(dir, 'empty-history'));
  expect(hasUnbuiltPersonalChanges(empty, dir, A, () => false)).toBe(true);
  settlePendingBuilds(dir);
  expect(readPendingBuilds(dir)).toEqual([]);
  expect(hasPendingBuild(dir, A)).toBe(false);
});

it('does not clear an unreadable record when dropping a rolled-back snapshot', () => {
  const dir = root();
  writeFileSync(path.join(dir, 'pending-build.json'), '{ not json');
  dropPendingBuild(dir, A);
  expect(readPendingBuilds(dir)).toBeUndefined();
  expect(hasPendingBuild(dir, A)).toBeUndefined();
});

it('accepts only Git SHA-1 or SHA-256 lengths', () => {
  const dir = root();
  expect(() => recordPendingBuild(dir, { commit: 'a'.repeat(41), tree: '1'.repeat(40) })).toThrow(
    'Invalid pending build snapshot',
  );
  expect(() => recordPendingBuild(dir, { commit: 'a'.repeat(40), tree: '1'.repeat(63) })).toThrow(
    'Invalid pending build snapshot',
  );
  expect(() =>
    recordPendingBuild(dir, { commit: 'a'.repeat(64), tree: '1'.repeat(64) }),
  ).not.toThrow();
});

it.each(['missing', 'corrupt'] as const)(
  'keeps an unknown %s baseline across integration, rewrite and rollback until generation',
  (state) => {
    const dir = root();
    if (state === 'corrupt') writeFileSync(path.join(dir, 'pending-build.json'), 'broken');
    const otherAccount = new CindyMakeHistoryStore(path.join(dir, 'other-owner'));
    expect(hasUnbuiltPersonalChanges(otherAccount, dir, A, () => false)).toBe(true);
    expect(hasUnbuiltPersonalChanges(otherAccount, dir, A, (commit) => commit === A.commit)).toBe(
      false,
    );

    recordPendingBuild(dir, B);
    expect(hasPendingBuild(dir, B)).toBe(true);
    expect(hasPendingBuild(dir, A)).toBeUndefined();
    rewritePendingBuilds(dir, [B.commit], C);
    expect(hasPendingBuild(dir, C)).toBe(true);
    expect(hasPendingBuild(dir, A)).toBeUndefined();
    dropPendingBuild(dir, C);
    expect(hasPendingBuild(dir, C)).toBeUndefined();
    // Rolling back the new work must not hide another account's older work.
    expect(hasUnbuiltPersonalChanges(otherAccount, dir, A, () => false)).toBe(true);

    settlePendingBuilds(dir);
    expect(hasUnbuiltPersonalChanges(otherAccount, dir, A, () => false)).toBe(false);
    recordPendingBuild(dir, B);
    expect(hasPendingBuild(dir, B)).toBe(true);
    dropPendingBuild(dir, B);
    expect(hasPendingBuild(dir, A)).toBe(false);
  },
);

it.each([39, ...Array.from({ length: 23 }, (_, index) => index + 41), 65])(
  'rejects %i-character object IDs instead of treating a damaged record as settled',
  (length) => {
    const dir = root();
    for (const field of ['commit', 'tree'] as const) {
      const snapshot = { ...A, [field]: 'a'.repeat(length) };
      writeFileSync(
        path.join(dir, 'pending-build.json'),
        JSON.stringify({ schema: 1, snapshots: [snapshot] }),
      );
      expect(readPendingBuilds(dir)).toBeUndefined();
      expect(hasPendingBuild(dir, A)).toBeUndefined();
      expect(() => recordPendingBuild(dir, snapshot)).toThrow('Invalid pending build snapshot');
    }
  },
);

it.each([40, 64])('accepts complete %i-character Git object IDs', (length) => {
  const dir = root();
  const snapshot = { commit: 'a'.repeat(length), tree: '1'.repeat(length) };
  recordPendingBuild(dir, snapshot);
  expect(readPendingBuilds(dir)).toEqual([snapshot]);
  expect(hasPendingBuild(dir, snapshot)).toBe(true);
});

it('a generated personal version settles the pending generation', () => {
  const dir = root();
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, B);
  settlePendingBuilds(dir);
  expect(readPendingBuilds(dir)).toEqual([]);
});

it('a completed rollback or restore drops the snapshot the source left', () => {
  const dir = root();
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, B);
  dropPendingBuild(dir, B);
  expect(readPendingBuilds(dir)).toEqual([A]);
});

it('an adopted rewrite carries the fact to the result that contains it', () => {
  const dir = root();
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, B);
  rewritePendingBuilds(dir, [A.commit], C);
  expect(readPendingBuilds(dir)).toEqual([C, B]);
  expect(hasPendingBuild(dir, C)).toBe(true);
});

describe('the unbuilt-changes decision', () => {
  it('does not read the shared source through one account: another account still sees pending', () => {
    const dir = root();
    // Account A integrated `A`; the source carries it and no version covers it.
    const accountA = account(dir, [{ id: 'first', head: A }]);
    const accountB = new CindyMakeHistoryStore(path.join(dir, 'other-owner'));
    // The account that made the change sees it through its own receipts…
    expect(hasUnbuiltPersonalChanges(accountA, dir, A, () => false)).toBe(true);
    // …and another account of the same device must not conclude "nothing is
    // pending" just because its own history has no receipts for it.
    expect(hasUnbuiltPersonalChanges(accountB, dir, A, () => false)).toBe(true);
  });

  it('a snapshot fetched from another computer is pending until this one generates it', () => {
    const dir = root();
    // The adoption hook records the fetched snapshot (see `recordUnbuilt`): the
    // device has no build history for it at all.
    recordPendingBuild(dir, B);
    const empty = new CindyMakeHistoryStore(path.join(dir, 'history'));
    expect(hasUnbuiltPersonalChanges(empty, dir, B, () => false)).toBe(true);
    // This computer generated its own application from it: settled.
    expect(hasUnbuiltPersonalChanges(empty, dir, B, (commit) => commit === B.commit)).toBe(false);
  });

  it('a generated personal version settles the account facts too', () => {
    const dir = root();
    const store = account(dir, [{ id: 'first', head: A }]);
    settlePendingBuilds(dir);
    expect(hasUnbuiltPersonalChanges(store, dir, A, (commit) => commit === A.commit)).toBe(false);
  });

  it('a pending build rollback is still pending', () => {
    const dir = root();
    const store = account(dir, [{ id: 'first', head: A }]);
    store.saveBuildRollback([
      {
        runId: 'task',
        receipt: {
          id: 'first',
          action: 'integrate',
          at: 1,
          baselineCommit: '0'.repeat(40),
          commit: A.commit,
          beforeTree: '0'.repeat(40),
          tree: A.tree,
          taskTree: A.tree,
        },
      },
    ]);
    dropPendingBuild(dir, A); // even with the device record gone…
    expect(hasUnbuiltPersonalChanges(store, dir, A, () => true)).toBe(true); // …the rollback counts.
  });

  it('an unreadable record proves nothing: pending unless a version covers the snapshot', () => {
    const dir = root();
    mkdirSync(path.join(dir), { recursive: true });
    writeFileSync(path.join(dir, 'pending-build.json'), 'broken');
    const empty = new CindyMakeHistoryStore(path.join(dir, 'history'));
    expect(hasUnbuiltPersonalChanges(empty, dir, A, () => false)).toBe(true);
    expect(hasUnbuiltPersonalChanges(empty, dir, A, (commit) => commit === A.commit)).toBe(false);
  });

  it('a missing record fails closed even when no history fact exists', () => {
    const dir = root();
    const empty = new CindyMakeHistoryStore(path.join(dir, 'history'));
    expect(hasUnbuiltPersonalChanges(empty, dir, A, () => false)).toBe(true);
  });
});
