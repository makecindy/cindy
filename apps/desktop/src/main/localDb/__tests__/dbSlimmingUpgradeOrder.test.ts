import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('database cleanup and upgrade startup order', () => {
  it('derives both the cleanup database path and request owner from the same user id', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');
    const pathBinding = source.indexOf('const filePath = dbPath(userId)');
    const cleanup = source.indexOf('maintenance = await runPendingDbSlimmingAtStartup', pathBinding);
    const cleanupBlock = source.slice(cleanup, source.indexOf('});', cleanup) + 3);

    expect(pathBinding).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(pathBinding);
    expect(cleanupBlock).toContain('dbFilePath: filePath');
    expect(cleanupBlock).toContain('ownerId: userId');
  });

  it('finishes cleanup recovery before opening the database for migration', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');
    const cleanup = source.indexOf('maintenance = await runPendingDbSlimmingAtStartup');
    const recoveryGuard = source.indexOf('if (!maintenance.originalDatabaseReady)', cleanup);
    const open = source.indexOf('_db = openWithPragmas(filePath)', recoveryGuard);
    const schemaStartup = source.indexOf(
      'const schemaStartup = await runSchemaStartupPolicy',
      open,
    );
    const migration = source.indexOf(
      'runMigrations: () => runMigrations(db, filePath)',
      schemaStartup,
    );

    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(recoveryGuard).toBeGreaterThan(cleanup);
    expect(open).toBeGreaterThan(recoveryGuard);
    expect(schemaStartup).toBeGreaterThan(open);
    expect(migration).toBeGreaterThan(schemaStartup);
  });
});
