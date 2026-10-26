import { fork, type ChildProcess } from 'node:child_process';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({
  id: 'test:11111111-1111-1111-1111-111111111111' as string | null,
}));
vi.mock('../schemaMigrationBootIdentity', () => ({
  readSchemaMigrationBootIdentity: async () => boot.id,
}));

import {
  acquireSchemaMigrationReaderLease,
  acquireSchemaMigrationWriterLease,
  type SchemaMigrationLease,
} from '../schemaMigrationLease';

const cleanupDirs: string[] = [];
const leases: SchemaMigrationLease[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  boot.id = 'test:11111111-1111-1111-1111-111111111111';
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(stopChild));
  for (const lease of leases.splice(0).reverse()) lease.release();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-schema-lease-'));
  cleanupDirs.push(dir);
  return path.join(dir, 'shared.db');
}

async function startChild(filePath: string, kind: 'reader' | 'writer'): Promise<ChildProcess> {
  const child = fork(path.join(__dirname, 'fixtures', 'schemaLeaseChild.ts'), [filePath, kind], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`lease child exited before ready: ${code}`)));
    child.on('message', (message) => {
      if ((message as { type?: string }).type === 'ready') resolve();
      if ((message as { type?: string }).type === 'failed') {
        reject(new Error(`lease child failed: ${JSON.stringify(message)}`));
      }
    });
  });
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.send?.('release');
  await new Promise<void>((resolve) => {
    // real-wait: bound cleanup while the child process may ignore the release message.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function hold(
  result: Awaited<ReturnType<typeof acquireSchemaMigrationReaderLease>>,
): SchemaMigrationLease {
  expect(result.acquired).toBe(true);
  if (!result.acquired) throw new Error(result.reason);
  leases.push(result.lease);
  return result.lease;
}

describe('schema migration lease', () => {
  // #7135 / unit: real acquisition APIs and files. Existing coverage only exercised
  // valid owners. Empty/corrupt records, interrupted publication and competing
  // recovery must preserve exclusion and the account DB, without time-based takeover.
  it.each(['', '{', '{}'])(
    'preserves malformed lock %j until an observed reboot, then backs it up',
    async (bytes) => {
      const filePath = dbPath();
      fs.writeFileSync(filePath, 'account data sentinel');
      const lock = `${filePath}.schema-writer.lock`;
      fs.writeFileSync(lock, bytes);
      fs.utimesSync(lock, new Date(0), new Date(0));
      expect(await acquireSchemaMigrationWriterLease(filePath)).toEqual({
        acquired: false,
        reason: 'lock-corrupt',
      });
      // A second application start within the same OS boot is not recovery authority.
      expect(await acquireSchemaMigrationWriterLease(filePath)).toEqual({
        acquired: false,
        reason: 'lock-corrupt',
      });
      expect(fs.readFileSync(lock, 'utf8')).toBe(bytes);
      boot.id = 'test:22222222-2222-2222-2222-222222222222';
      hold(await acquireSchemaMigrationWriterLease(filePath));
      const backups = fs
        .readdirSync(path.dirname(filePath))
        .filter((name) => name.includes('.schema-lease-backup-'));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(path.dirname(filePath), backups[0]), 'utf8')).toBe(bytes);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('account data sentinel');
    },
  );

  it('does not reuse reboot evidence after a lock changes or when boot identity is unavailable', async () => {
    const filePath = dbPath();
    const lock = `${filePath}.schema-writer.lock`;
    fs.writeFileSync(lock, '{');
    await acquireSchemaMigrationWriterLease(filePath);
    boot.id = 'test:22222222-2222-2222-2222-222222222222';
    fs.writeFileSync(lock, '{"pid":');
    expect(await acquireSchemaMigrationWriterLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'lock-corrupt',
    });
    boot.id = null;
    expect(await acquireSchemaMigrationWriterLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'lock-corrupt',
    });
    expect(fs.readFileSync(lock, 'utf8')).toBe('{"pid":');
  });

  it('distinguishes unreadable locks and never quarantines them', async () => {
    const filePath = dbPath();
    const lock = `${filePath}.schema-writer.lock`;
    fs.writeFileSync(lock, '{');
    vi.spyOn(fs, 'lstatSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    });
    expect(await acquireSchemaMigrationWriterLease(filePath)).toEqual({
      acquired: false,
      reason: 'lock-unreadable',
    });
    expect(fs.readFileSync(lock, 'utf8')).toBe('{');
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([path.basename(lock)]);
  });

  it('leaves the canonical path absent after a failed candidate flush and permits a retry', async () => {
    const filePath = dbPath();
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
    });
    expect(await acquireSchemaMigrationWriterLease(filePath)).toEqual({
      acquired: false,
      reason: 'lock-unreadable',
    });
    expect(fs.existsSync(`${filePath}.schema-writer.lock`)).toBe(false);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([]);
    hold(await acquireSchemaMigrationWriterLease(filePath));
  });

  it.each([
    'crash-before-publish',
    'crash-after-publish',
    'crash-after-gate-publish',
    'crash-during-gate-release',
  ])('recovers after a publisher exits at %s', async (mode) => {
    const filePath = dbPath();
    const child = fork(
      path.join(__dirname, 'fixtures', 'schemaLeaseChild.ts'),
      [filePath, 'writer', mode],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    children.push(child);
    await waitForExit(child);
    expect(child.exitCode).toBe(17);
    expect(fs.existsSync(`${filePath}.schema-writer.lock`)).toBe(
      mode === 'crash-after-publish' || mode === 'crash-during-gate-release',
    );
    hold(await acquireSchemaMigrationWriterLease(filePath));
    expect(await acquireSchemaMigrationReaderLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'writer-active',
    });
  });

  it('allows exactly one competing recovery to acquire a writer and keeps a single backup', async () => {
    const filePath = dbPath();
    fs.writeFileSync(`${filePath}.schema-writer.lock`, '{');
    await acquireSchemaMigrationWriterLease(filePath);
    boot.id = 'test:22222222-2222-2222-2222-222222222222';
    const results = await Promise.all([
      acquireSchemaMigrationWriterLease(filePath),
      acquireSchemaMigrationWriterLease(filePath),
    ]);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    for (const result of results) if (result.acquired) leases.push(result.lease);
    expect(results.find((result) => !result.acquired)).toMatchObject({ reason: 'recovery-busy' });
    expect(
      fs
        .readdirSync(path.dirname(filePath))
        .filter((name) => name.includes('.schema-lease-backup-')),
    ).toHaveLength(1);
    expect(await acquireSchemaMigrationReaderLease(filePath)).toEqual({
      acquired: false,
      reason: 'writer-active',
    });
  });

  it('can retry after isolation was interrupted, retaining the original corrupt bytes', async () => {
    const filePath = dbPath();
    const lock = `${filePath}.schema-writer.lock`;
    fs.writeFileSync(lock, '{');
    await acquireSchemaMigrationWriterLease(filePath);
    boot.id = 'test:22222222-2222-2222-2222-222222222222';
    const original = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      original(from, to);
      if (from === lock) {
        throw Object.assign(new Error('injected interruption after isolation'), { code: 'EIO' });
      }
    });
    expect(await acquireSchemaMigrationWriterLease(filePath)).toMatchObject({ acquired: false });
    hold(await acquireSchemaMigrationWriterLease(filePath));
    const backup = fs
      .readdirSync(path.dirname(filePath))
      .find((name) => name.includes('.schema-lease-backup-'))!;
    expect(fs.readFileSync(path.join(path.dirname(filePath), backup), 'utf8')).toBe('{');
  });

  it('refuses a writer and restores a legacy live owner replaced during isolation', async () => {
    const filePath = dbPath();
    const lock = `${filePath}.schema-writer.lock`;
    fs.writeFileSync(lock, '{');
    await acquireSchemaMigrationWriterLease(filePath);
    boot.id = 'test:22222222-2222-2222-2222-222222222222';
    const legacy = JSON.stringify({
      pid: process.pid,
      token: 'legacy-live-owner',
      createdAt: new Date().toISOString(),
    });
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === lock) {
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, legacy, { flag: 'wx' });
      }
      rename(from, to);
    });
    expect(await acquireSchemaMigrationWriterLease(filePath)).toEqual({
      acquired: false,
      reason: 'recovery-busy',
    });
    expect(fs.readFileSync(lock, 'utf8')).toBe(legacy);
    expect(await acquireSchemaMigrationReaderLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'writer-active',
    });
  });

  it('recovers a corrupt reader without leaving a backup inside the reader directory', async () => {
    const filePath = dbPath();
    const readers = `${filePath}.schema-readers`;
    fs.mkdirSync(readers);
    fs.writeFileSync(path.join(readers, 'legacy.json'), '{');
    expect(await acquireSchemaMigrationWriterLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'lock-corrupt',
    });
    expect(fs.existsSync(`${filePath}.schema-writer.lock`)).toBe(false);
    boot.id = 'test:22222222-2222-2222-2222-222222222222';
    hold(await acquireSchemaMigrationWriterLease(filePath));
    expect(fs.readdirSync(readers)).toEqual([]);
  });

  it('keeps a live gate despite damaged marker bytes and never removes a successor during release', async () => {
    const filePath = dbPath();
    const gate = `${filePath}.schema-transition`;
    const marker = `owner-${process.pid}-00000000-0000-0000-0000-000000000000`;
    fs.mkdirSync(gate);
    fs.writeFileSync(path.join(gate, marker), '{');
    expect(await acquireSchemaMigrationWriterLease(filePath)).toEqual({
      acquired: false,
      reason: 'recovery-busy',
    });
    fs.unlinkSync(path.join(gate, marker));
    fs.rmdirSync(gate);
    const rmdir = fs.rmdirSync;
    let replaced = false;
    vi.spyOn(fs, 'rmdirSync').mockImplementation((directory) => {
      if (directory === gate && !replaced) {
        // Pause releaser after its marker is gone. A successor publishes a full
        // gate before the releaser's final rmdir resumes.
        replaced = true;
        rmdir(gate);
        fs.mkdirSync(gate);
        fs.writeFileSync(path.join(gate, marker), '');
      }
      rmdir(directory);
    });
    const writer = hold(await acquireSchemaMigrationWriterLease(filePath));
    expect(fs.readdirSync(gate)).toEqual([marker]);
    writer.release();
    expect(await acquireSchemaMigrationReaderLease(filePath)).toEqual({
      acquired: false,
      reason: 'recovery-busy',
    });
  });

  // PR #7146 / unit: crash leftovers were tested only with dead PIDs. A reboot
  // can reuse the PID; compare boot generations without weakening live-owner exclusion.
  it.each([
    { name: 'same boot', published: 'boot-a', current: 'boot-a', acquired: false },
    {
      name: 'previous boot with reused live PID',
      published: 'boot-a',
      current: 'boot-b',
      acquired: true,
    },
    { name: 'unavailable current boot', published: 'boot-a', current: null, acquired: false },
    {
      name: 'legacy marker without boot evidence',
      published: null,
      current: 'boot-b',
      acquired: false,
    },
  ])('handles a gate from $name', async ({ published, current, acquired }) => {
    const filePath = dbPath();
    const gate = `${filePath}.schema-transition`;
    boot.id = published;
    const rename = fs.renameSync;
    // Leave the real published gate behind, before acquiring any schema lease.
    const interrupted = vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      rename(from, to);
      throw Object.assign(new Error('interrupted after gate publication'), { code: 'EIO' });
    });
    expect(await acquireSchemaMigrationWriterLease(filePath)).toEqual({
      acquired: false,
      reason: 'recovery-busy',
    });
    interrupted.mockRestore();
    const originalMarker = fs.readdirSync(gate);
    // process.pid remains alive: only evidence of another boot may reclaim it.
    boot.id = current;
    const result = await acquireSchemaMigrationWriterLease(filePath);
    if (acquired) {
      hold(result);
      expect(fs.existsSync(gate)).toBe(false);
      expect(await acquireSchemaMigrationReaderLease(filePath)).toEqual({
        acquired: false,
        reason: 'writer-active',
      });
    } else {
      expect(result).toEqual({ acquired: false, reason: 'recovery-busy' });
      expect(fs.readdirSync(gate)).toEqual(originalMarker);
      expect(fs.existsSync(`${filePath}.schema-writer.lock`)).toBe(false);
    }
  });

  it('does not remove a successor when another reclaimer wins the dead-gate race', async () => {
    const filePath = dbPath();
    const gate = `${filePath}.schema-transition`;
    const deadMarker = 'owner-2147483647-00000000-0000-0000-0000-000000000000';
    const liveMarker = `owner-${process.pid}-11111111-1111-1111-1111-111111111111`;
    fs.mkdirSync(gate);
    fs.writeFileSync(path.join(gate, deadMarker), '');
    vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('dead fixture process'), { code: 'ESRCH' });
    });
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (file === path.join(gate, deadMarker)) {
        unlink(file);
        fs.rmdirSync(gate);
        fs.mkdirSync(gate);
        fs.writeFileSync(path.join(gate, liveMarker), '');
      }
      unlink(file);
    });
    expect(await acquireSchemaMigrationWriterLease(filePath)).toEqual({
      acquired: false,
      reason: 'recovery-busy',
    });
    expect(fs.readdirSync(gate)).toEqual([liveMarker]);
    expect(fs.existsSync(`${filePath}.schema-writer.lock`)).toBe(false);
  });

  it('grants only one writer when separate processes recover the same dead owner', async () => {
    const filePath = dbPath();
    const previous = await startChild(filePath, 'writer');
    previous.kill('SIGKILL');
    await waitForExit(previous);
    const contenders = [0, 1].map(() => {
      const child = fork(
        path.join(__dirname, 'fixtures', 'schemaLeaseChild.ts'),
        [filePath, 'writer', 'compete'],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      children.push(child);
      return child;
    });
    await Promise.all(
      contenders.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code) =>
              reject(new Error(`contender exited before barrier: ${code}`)),
            );
            child.once('message', () => resolve());
          }),
      ),
    );
    const outcomes = contenders.map(
      (child) =>
        new Promise<string>((resolve, reject) => {
          child.once('error', reject);
          child.once('message', (message) => resolve((message as { type: string }).type));
        }),
    );
    for (const child of contenders) child.send('go');
    expect((await Promise.all(outcomes)).sort()).toEqual(['failed', 'ready']);
    expect(await acquireSchemaMigrationReaderLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'writer-active',
    });
    expect(
      fs
        .readdirSync(path.dirname(filePath))
        .filter((name) => name.includes('.schema-lease-backup-')),
    ).toHaveLength(1);
  });
  it('allows arbitrary reader owners and rejects a writer until every reader exits', async () => {
    const filePath = dbPath();
    const first = hold(await acquireSchemaMigrationReaderLease(filePath));
    const second = hold(await acquireSchemaMigrationReaderLease(filePath));

    expect(await acquireSchemaMigrationWriterLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'readers-active',
      activeReaderCount: 2,
    });
    first.release();
    expect(await acquireSchemaMigrationWriterLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'readers-active',
      activeReaderCount: 1,
    });
    second.release();

    const writer = await acquireSchemaMigrationWriterLease(filePath);
    expect(writer.acquired).toBe(true);
    if (!writer.acquired) throw new Error(writer.reason);
    leases.push(writer.lease);
  });

  it('rejects readers while a writer is active and admits them after release', async () => {
    const filePath = dbPath();
    const writer = await acquireSchemaMigrationWriterLease(filePath);
    expect(writer.acquired).toBe(true);
    if (!writer.acquired) throw new Error(writer.reason);
    leases.push(writer.lease);

    expect(await acquireSchemaMigrationReaderLease(filePath)).toEqual({
      acquired: false,
      reason: 'writer-active',
    });
    writer.lease.release();
    hold(await acquireSchemaMigrationReaderLease(filePath));
  });

  it('enforces reader/writer exclusion across processes', async () => {
    const filePath = dbPath();
    const reader = await startChild(filePath, 'reader');
    expect(await acquireSchemaMigrationWriterLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'readers-active',
    });
    await stopChild(reader);

    const writer = await startChild(filePath, 'writer');
    expect(await acquireSchemaMigrationReaderLease(filePath)).toEqual({
      acquired: false,
      reason: 'writer-active',
    });
    await stopChild(writer);
    hold(await acquireSchemaMigrationReaderLease(filePath));
  });

  it('reclaims a stale reader after its owner exits abnormally', async () => {
    const filePath = dbPath();
    const reader = await startChild(filePath, 'reader');
    reader.kill('SIGKILL');
    await waitForExit(reader);

    const writer = await acquireSchemaMigrationWriterLease(filePath);
    expect(writer.acquired).toBe(true);
    if (!writer.acquired) throw new Error(writer.reason);
    leases.push(writer.lease);
  });

  it('reclaims a stale writer after its owner exits abnormally', async () => {
    const filePath = dbPath();
    const writer = await startChild(filePath, 'writer');
    writer.kill('SIGKILL');
    await waitForExit(writer);

    hold(await acquireSchemaMigrationReaderLease(filePath));
  });
});
