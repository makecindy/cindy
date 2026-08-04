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
  it('wires worker takeover to the preserve-lease close mode', () => {
    const bootstrap = readFileSync(
      path.resolve(__dirname, '..', '..', 'bootstrap-electron.ts'),
      'utf8',
    );
    const takeoverStart = bootstrap.indexOf('if (dbClientTakeover.shouldReleaseMainDb');
    const takeoverEnd = bootstrap.indexOf('custom-mcp-account-switch', takeoverStart);
    expect(bootstrap.slice(takeoverStart, takeoverEnd)).toContain(
      'localDbCloseDb({ preserveSchemaMigrationLease: true })',
    );
  });

  it('preserves the real lease across takeover close and releases it on logout/quit close', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-schema-takeover-'));
    const dbFilePath = path.join(dir, 'shared.db');
    const lifecycle = new SchemaMigrationReaderLeaseLifecycle();
    try {
      expect(lifecycle.ensure(dbFilePath)).toEqual({ acquired: true, newlyAcquired: true });

      // worker takeover:main connection closes, worker remains on the DB, writer must stay blocked.
      lifecycle.closeConnection(true);
      expect(acquireSchemaMigrationWriterLease(dbFilePath)).toMatchObject({
        acquired: false,
        reason: 'readers-active',
      });

      // logout / account switch / app quit:the actual DB lifecycle ends, writer may proceed.
      lifecycle.closeConnection(false);
      const writer = acquireSchemaMigrationWriterLease(dbFilePath);
      expect(writer.acquired).toBe(true);
      if (!writer.acquired) throw new Error(writer.reason);
      writer.lease.release();
    } finally {
      lifecycle.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packaged fallback acquires a reader and does not acquire a writer', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-schema-packaged-fallback-'));
    const dbFilePath = path.join(dir, 'shared.db');
    const passiveLifecycle = new SchemaMigrationReaderLeaseLifecycle();
    const packagedLifecycle = new SchemaMigrationReaderLeaseLifecycle();
    try {
      expect(passiveLifecycle.ensure(dbFilePath)).toEqual({
        acquired: true,
        newlyAcquired: true,
      });
      const result = acquireSchemaStartupLease({
        dbFilePath,
        packaged: true,
        sharedPassive: false,
        readerLifecycle: packagedLifecycle,
      });
      expect(result.acquired).toBe(true);
      if (!result.acquired) throw new Error(result.reason);
      expect(result.kind).toBe('reader');
      expect(acquireSchemaMigrationWriterLease(dbFilePath)).toMatchObject({
        acquired: false,
        reason: 'readers-active',
        activeReaderCount: 2,
      });
      result.lease.release();
      expect(acquireSchemaMigrationWriterLease(dbFilePath)).toMatchObject({
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
  it('allows another reader to join while preserving writer exclusion', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-schema-packaged-reader-'));
    const dbFilePath = path.join(dir, 'shared.db');
    const passiveLifecycle = new SchemaMigrationReaderLeaseLifecycle();
    const packagedLifecycle = new SchemaMigrationReaderLeaseLifecycle();
    try {
      expect(passiveLifecycle.ensure(dbFilePath)).toEqual({
        acquired: true,
        newlyAcquired: true,
      });
      expect(packagedLifecycle.ensure(dbFilePath)).toEqual({
        acquired: true,
        newlyAcquired: true,
      });
      expect(acquireSchemaMigrationWriterLease(dbFilePath)).toMatchObject({
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
