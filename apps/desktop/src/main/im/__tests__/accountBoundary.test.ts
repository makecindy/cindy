import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activateImAccountBoundary,
  captureImAccountGeneration,
  deactivateImAccountBoundary,
  runInImAccountGeneration,
  runImMigrationExclusive,
  waitForImAccountGenerationIdle,
} from '../accountBoundary';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('IM account boundary', () => {
  afterEach(() => activateImAccountBoundary());

  it('rejects queued work whose generation closed before execution', async () => {
    const token = captureImAccountGeneration();
    expect(token).not.toBeNull();
    const operation = vi.fn(async () => undefined);

    const work = runInImAccountGeneration(token!, operation);
    deactivateImAccountBoundary();

    await expect(work).rejects.toMatchObject({ code: 'IM_ACCOUNT_SCOPE_CLOSED' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('drains a handler admitted by the closing account before teardown continues', async () => {
    const gate = deferred();
    const token = captureImAccountGeneration();
    expect(token).not.toBeNull();
    let started = false;
    const work = runInImAccountGeneration(token!, async () => {
      started = true;
      await gate.promise;
    });
    await vi.waitFor(() => expect(started).toBe(true));

    deactivateImAccountBoundary();
    let drained = false;
    const draining = waitForImAccountGenerationIdle(token!).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    gate.resolve();
    await work;
    await draining;
    expect(drained).toBe(true);
  });

  it('drains pre-admitted work and blocks new handlers until migration commits', async () => {
    const token = captureImAccountGeneration();
    expect(token).not.toBeNull();
    const oldGate = deferred();
    const migrationGate = deferred();
    let oldStarted = false;
    let migrationStarted = false;
    let newStarted = false;
    const oldWork = runInImAccountGeneration(token!, async () => {
      oldStarted = true;
      await oldGate.promise;
    });
    await vi.waitFor(() => expect(oldStarted).toBe(true));

    const migration = runImMigrationExclusive('telegram', async () => {
      migrationStarted = true;
      await migrationGate.promise;
    });
    const newWork = runInImAccountGeneration(token!, async () => {
      newStarted = true;
    });
    await Promise.resolve();
    expect(migrationStarted).toBe(false);
    expect(newStarted).toBe(false);

    oldGate.resolve();
    await oldWork;
    await vi.waitFor(() => expect(migrationStarted).toBe(true));
    expect(newStarted).toBe(false);

    migrationGate.resolve();
    await migration;
    await newWork;
    expect(newStarted).toBe(true);
  });

  it('does not deadlock work admitted in the same tick before the migration gate', async () => {
    const token = captureImAccountGeneration();
    expect(token).not.toBeNull();
    const operation = vi.fn(async () => undefined);
    const work = runInImAccountGeneration(token!, operation);
    const migration = runImMigrationExclusive('telegram', async () => undefined);

    await expect(Promise.all([work, migration])).resolves.toEqual([undefined, undefined]);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('does not freeze an unrelated IM provider during migration', async () => {
    const token = captureImAccountGeneration();
    expect(token).not.toBeNull();
    const gate = deferred();
    let migrationStarted = false;
    let feishuStarted = false;
    const migration = runImMigrationExclusive('telegram', async () => {
      migrationStarted = true;
      await gate.promise;
    });
    await vi.waitFor(() => expect(migrationStarted).toBe(true));

    await runInImAccountGeneration(
      token!,
      async () => {
        feishuStarted = true;
      },
      'feishu',
    );
    expect(feishuStarted).toBe(true);

    gate.resolve();
    await migration;
  });
});
