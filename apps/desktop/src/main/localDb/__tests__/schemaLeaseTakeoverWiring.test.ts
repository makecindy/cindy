import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  acquireSchemaMigrationWriterLease,
  acquireSchemaStartupLease,
  SchemaMigrationReaderLeaseLifecycle,
} from '../schemaMigrationLease';

describe('shared-passive schema lease worker takeover wiring', () => {
  // #7135: acquisition is async; logout must also cancel an in-flight reader.
  it('releases a reader acquired after its lifecycle was closed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-schema-takeover-'));
    const dbFilePath = path.join(dir, 'shared.db');
    const lifecycle = new SchemaMigrationReaderLeaseLifecycle();
    try {
      const pending = lifecycle.ensure(dbFilePath);
      lifecycle.release();
      expect(await pending).toEqual({ acquired: false, reason: 'recovery-busy' });
      const writer = await acquireSchemaMigrationWriterLease(dbFilePath);
      expect(writer.acquired).toBe(true);
      if (writer.acquired) writer.lease.release();
    } finally {
      lifecycle.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('wires worker takeover to the preserve-lease close mode', async () => {
    const bootstrap = readFileSync(
      path.resolve(__dirname, '..', '..', 'bootstrap-electron.ts'),
      'utf8',
    );
    const unchangedGuard = bootstrap.indexOf("dbClientTakeover.mode === 'unchanged'");
    const unchangedReturn = bootstrap.indexOf('return;', unchangedGuard);
    const takeoverStart = bootstrap.indexOf(
      'if (dbClientTakeover.shouldReleaseMainDb',
      unchangedReturn,
    );
    const takeoverEnd = bootstrap.indexOf('custom-mcp-account-switch', takeoverStart);
    const takeoverBlock = bootstrap.slice(takeoverStart, takeoverEnd);
    expect(unchangedGuard).toBeGreaterThanOrEqual(0);
    expect(unchangedReturn).toBeGreaterThan(unchangedGuard);
    expect(takeoverStart).toBeGreaterThan(unchangedReturn);
    expect(takeoverBlock).toContain('localDbCloseDb({ preserveSchemaMigrationLease: true })');
  });

  it('preserves the real lease across takeover close and releases it on logout/quit close', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-schema-takeover-'));
    const dbFilePath = path.join(dir, 'shared.db');
    const lifecycle = new SchemaMigrationReaderLeaseLifecycle();
    try {
      expect(await lifecycle.ensure(dbFilePath)).toEqual({ acquired: true, newlyAcquired: true });

      // worker takeover:main connection closes, worker remains on the DB, writer must stay blocked.
      lifecycle.closeConnection(true);
      expect(await acquireSchemaMigrationWriterLease(dbFilePath)).toMatchObject({
        acquired: false,
        reason: 'readers-active',
      });

      // logout / account switch / app quit:the actual DB lifecycle ends, writer may proceed.
      lifecycle.closeConnection(false);
      const writer = await acquireSchemaMigrationWriterLease(dbFilePath);
      expect(writer.acquired).toBe(true);
      if (!writer.acquired) throw new Error(writer.reason);
      writer.lease.release();
    } finally {
      lifecycle.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packaged fallback acquires a reader and does not acquire a writer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-schema-packaged-fallback-'));
    const dbFilePath = path.join(dir, 'shared.db');
    const passiveLifecycle = new SchemaMigrationReaderLeaseLifecycle();
    const packagedLifecycle = new SchemaMigrationReaderLeaseLifecycle();
    try {
      expect(await passiveLifecycle.ensure(dbFilePath)).toEqual({
        acquired: true,
        newlyAcquired: true,
      });
      const result = await acquireSchemaStartupLease({
        dbFilePath,
        packaged: true,
        sharedPassive: false,
        readerLifecycle: packagedLifecycle,
      });
      expect(result.acquired).toBe(true);
      if (!result.acquired) throw new Error(result.reason);
      expect(result.kind).toBe('reader');
      expect(await acquireSchemaMigrationWriterLease(dbFilePath)).toMatchObject({
        acquired: false,
        reason: 'readers-active',
        activeReaderCount: 2,
      });
      result.lease.release();
      expect(await acquireSchemaMigrationWriterLease(dbFilePath)).toMatchObject({
        acquired: false,
        reason: 'readers-active',
        activeReaderCount: 1,
      });
    } finally {
      packagedLifecycle.release();
      passiveLifecycle.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('allows another reader to join while preserving writer exclusion', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-schema-packaged-reader-'));
    const dbFilePath = path.join(dir, 'shared.db');
    const passiveLifecycle = new SchemaMigrationReaderLeaseLifecycle();
    const packagedLifecycle = new SchemaMigrationReaderLeaseLifecycle();
    try {
      expect(await passiveLifecycle.ensure(dbFilePath)).toEqual({
        acquired: true,
        newlyAcquired: true,
      });
      expect(await packagedLifecycle.ensure(dbFilePath)).toEqual({
        acquired: true,
        newlyAcquired: true,
      });
      expect(await acquireSchemaMigrationWriterLease(dbFilePath)).toMatchObject({
        acquired: false,
        reason: 'readers-active',
        activeReaderCount: 2,
      });
    } finally {
      packagedLifecycle.release();
      passiveLifecycle.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
