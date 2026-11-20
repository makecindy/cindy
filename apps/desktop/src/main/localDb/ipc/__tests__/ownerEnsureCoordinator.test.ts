import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

import { createOwnerEnsureCoordinator } from '../ownerEnsureCoordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createOwnerEnsureCoordinator', () => {
  it('keeps the target unopened when preflight fails and allows a later retry', async () => {
    let failPreflight = true;
    const ensure = vi.fn(async () => ({ ready: true as const }));
    const run = createOwnerEnsureCoordinator({
      isOwnerCurrent: () => true,
      beforeEnsureReady: () => {
        if (failPreflight) throw new Error('local profile adoption failed');
      },
      ensureReady: ensure,
      discardReadyOwner: vi.fn(),
    });

    await expect(run('cloud-a')).rejects.toThrow('local profile adoption failed');
    expect(ensure).not.toHaveBeenCalled();

    failPreflight = false;
    await expect(run('cloud-a')).resolves.toEqual({ ready: true });
    expect(ensure).toHaveBeenCalledOnce();
  });

  // #9555 / unit: the same queued readiness entry must reject an old recovery
  // generation before touching a DB, including an owner change during preflight.
  it('fences explicit recovery across same-owner generations and keeps ordinary readiness passive', async () => {
    let generation = 1;
    const preflight = deferred<void>();
    const ensure = vi.fn(async () => ({ ready: true as const }));
    const prepare = vi.fn(async (_id, recovery) => { if (recovery) await preflight.promise; });
    const run = createOwnerEnsureCoordinator({
      isOwnerCurrent: (id, recovery) => id === 'owner-a' && (!recovery || recovery.ownerGeneration === generation),
      beforeEnsureReady: prepare, ensureReady: ensure, discardReadyOwner: vi.fn(),
    });
    const recovery = run('owner-a', { dataOwnerId: 'owner-a', ownerGeneration: 1 });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    generation = 2;
    const queuedOld = run('owner-a', { dataOwnerId: 'owner-a', ownerGeneration: 1 });
    const passive = run('owner-a');
    preflight.resolve();
    await expect(recovery).resolves.toMatchObject({ ready: false });
    await expect(queuedOld).resolves.toMatchObject({ ready: false });
    await expect(passive).resolves.toEqual({ ready: true });
    expect(ensure).toHaveBeenCalledOnce();
    expect(prepare.mock.calls).toEqual([
      ['owner-a', { dataOwnerId: 'owner-a', ownerGeneration: 1 }], ['owner-a', undefined],
    ]);
  });

  it.each([false, true])('keeps a corrupt client quarantined when the ready hook encounters corruption (wrapped=%s)', async wrapped => {
    const discard = vi.fn();
    const run = createOwnerEnsureCoordinator({
      isOwnerCurrent: () => true, ensureReady: async () => ({ ready: true }),
      getCorruptionError: () => wrapped ? Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' }) : null,
      onReady: () => { throw wrapped ? new Error('Drizzle query failed') : Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' }); },
      discardReadyOwner: discard,
    });
    await expect(run('owner-a')).resolves.toMatchObject({ ready: false, error: { code: 'DB_RUNTIME_CORRUPT' } });
    expect(discard).not.toHaveBeenCalled();
  });

  it('drops an owner superseded while its preflight is pending', async () => {
    let activeOwner = 'cloud-a';
    const preflightA = deferred<void>();
    const ensure = vi.fn(async () => ({ ready: true as const }));
    const discard = vi.fn();
    const run = createOwnerEnsureCoordinator({
      isOwnerCurrent: (ownerId) => ownerId === activeOwner,
      beforeEnsureReady: (ownerId) => (ownerId === 'cloud-a' ? preflightA.promise : undefined),
      ensureReady: ensure,
      discardReadyOwner: discard,
    });

    const stale = run('cloud-a');
    activeOwner = 'local-v1';
    const local = run('local-v1');
    preflightA.resolve();

    await expect(stale).resolves.toMatchObject({ ready: false });
    await expect(local).resolves.toEqual({ ready: true });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith('local-v1');
    expect(discard).not.toHaveBeenCalled();
  });

  it('discards a stale committed DB before allowing the next owner to open', async () => {
    let activeOwner = 'cloud-a';
    const ensureA = deferred<{ ready: true }>();
    const events: string[] = [];
    const run = createOwnerEnsureCoordinator({
      isOwnerCurrent: (ownerId) => ownerId === activeOwner,
      ensureReady: async (ownerId) => {
        events.push(`ensure:${ownerId}`);
        return ownerId === 'cloud-a' ? ensureA.promise : { ready: true };
      },
      discardReadyOwner: (ownerId) => {
        events.push(`discard:${ownerId}`);
      },
    });

    const stale = run('cloud-a');
    await vi.waitFor(() => expect(events).toEqual(['ensure:cloud-a']));
    activeOwner = 'local-v1';
    const local = run('local-v1');
    ensureA.resolve({ ready: true });

    await expect(stale).resolves.toMatchObject({ ready: false });
    await expect(local).resolves.toEqual({ ready: true });
    expect(events).toEqual(['ensure:cloud-a', 'discard:cloud-a', 'ensure:local-v1']);
  });

  it('discards an owner superseded while its ready callback is pending', async () => {
    let activeOwner = 'cloud-a';
    const readyA = deferred<void>();
    const discard = vi.fn();
    const onReady = vi.fn((ownerId: string) =>
      ownerId === 'cloud-a' ? readyA.promise : undefined,
    );
    const run = createOwnerEnsureCoordinator({
      isOwnerCurrent: (ownerId) => ownerId === activeOwner,
      ensureReady: async () => ({ ready: true }),
      onReady,
      discardReadyOwner: discard,
    });

    const stale = run('cloud-a');
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledWith('cloud-a'));
    activeOwner = 'local-v1';
    const local = run('local-v1');
    readyA.resolve();

    await expect(stale).resolves.toMatchObject({ ready: false });
    await expect(local).resolves.toEqual({ ready: true });
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith('cloud-a');
  });

  it('discards a committed DB and reports failure when its ready callback throws', async () => {
    const readyError = new Error('lifecycle client startup failed');
    const discard = vi.fn();
    const onReadyError = vi.fn();
    const run = createOwnerEnsureCoordinator({
      isOwnerCurrent: (ownerId) => ownerId === 'local-v1',
      ensureReady: async () => ({ ready: true }),
      onReady: async () => {
        throw readyError;
      },
      onReadyError,
      discardReadyOwner: discard,
    });

    await expect(run('local-v1')).resolves.toEqual({
      ready: false,
      error: {
        code: 'DB_INIT_FAILED',
        message: 'local database startup hook failed: lifecycle client startup failed',
      },
    });
    expect(onReadyError).toHaveBeenCalledWith('local-v1', readyError);
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith('local-v1');
  });
});

describe('registerLocalDbIpc ready-hook composition', () => {
  it('installs DbClient before runtime recovery and deleted-media reconcile', () => {
    const source = fs.readFileSync(new URL('../registerAll.ts', import.meta.url), 'utf8');
    const start = source.indexOf('onReady: async (userId) => {');
    const end = source.indexOf('onReadyError:', start);
    const hook = source.slice(start, end);

    expect(hook.indexOf('await opts.onReady?.(userId)')).toBeLessThan(
      hook.indexOf('tryGetDbClient()'),
    );

    expect(hook).toContain('if (');
    expect(hook).toContain('!client');
    expect(hook).toContain('!withSessionLock');
    expect(hook).toContain('withSessionLock,');
  });
});
