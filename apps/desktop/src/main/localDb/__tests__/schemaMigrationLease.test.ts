import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireSchemaMigrationReaderLease,
  acquireSchemaMigrationWriterLease,
  type SchemaMigrationLease,
} from '../schemaMigrationLease';

const cleanupDirs: string[] = [];
const leases: SchemaMigrationLease[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
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

function hold(result: ReturnType<typeof acquireSchemaMigrationReaderLease>): SchemaMigrationLease {
  expect(result.acquired).toBe(true);
  if (!result.acquired) throw new Error(result.reason);
  leases.push(result.lease);
  return result.lease;
}

describe('schema migration lease', () => {
  it('allows arbitrary reader owners and rejects a writer until every reader exits', () => {
    const filePath = dbPath();
    const first = hold(acquireSchemaMigrationReaderLease(filePath));
    const second = hold(acquireSchemaMigrationReaderLease(filePath));

    expect(acquireSchemaMigrationWriterLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'readers-active',
      activeReaderCount: 2,
    });
    first.release();
    expect(acquireSchemaMigrationWriterLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'readers-active',
      activeReaderCount: 1,
    });
    second.release();

    const writer = acquireSchemaMigrationWriterLease(filePath);
    expect(writer.acquired).toBe(true);
    if (!writer.acquired) throw new Error(writer.reason);
    leases.push(writer.lease);
  });

  it('rejects readers while a writer is active and admits them after release', () => {
    const filePath = dbPath();
    const writer = acquireSchemaMigrationWriterLease(filePath);
    expect(writer.acquired).toBe(true);
    if (!writer.acquired) throw new Error(writer.reason);
    leases.push(writer.lease);

    expect(acquireSchemaMigrationReaderLease(filePath)).toEqual({
      acquired: false,
      reason: 'writer-active',
    });
    writer.lease.release();
    hold(acquireSchemaMigrationReaderLease(filePath));
  });

  it('enforces reader/writer exclusion across processes', async () => {
    const filePath = dbPath();
    const reader = await startChild(filePath, 'reader');
    expect(acquireSchemaMigrationWriterLease(filePath)).toMatchObject({
      acquired: false,
      reason: 'readers-active',
    });
    await stopChild(reader);

    const writer = await startChild(filePath, 'writer');
    expect(acquireSchemaMigrationReaderLease(filePath)).toEqual({
      acquired: false,
      reason: 'writer-active',
    });
    await stopChild(writer);
    hold(acquireSchemaMigrationReaderLease(filePath));
  });

  it('reclaims a stale reader after its owner exits abnormally', async () => {
    const filePath = dbPath();
    const reader = await startChild(filePath, 'reader');
    reader.kill('SIGKILL');
    await waitForExit(reader);

    const writer = acquireSchemaMigrationWriterLease(filePath);
    expect(writer.acquired).toBe(true);
    if (!writer.acquired) throw new Error(writer.reason);
    leases.push(writer.lease);
  });

  it('reclaims a stale writer after its owner exits abnormally', async () => {
    const filePath = dbPath();
    const writer = await startChild(filePath, 'writer');
    writer.kill('SIGKILL');
    await waitForExit(writer);

    hold(acquireSchemaMigrationReaderLease(filePath));
  });
});
