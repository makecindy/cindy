import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('legacy Ghost recovery acknowledgement orchestration', () => {
  it('routes startup migration through the stable-owner task instead of timing callbacks', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    ).replace(/\r\n?/g, '\n');

    expect(source).toContain('stableOwnerPostCommitTask = async (reason, scope) => {');
    expect(source).not.toContain("scheduleBuiltinReconcile('startup')");
    expect(source).not.toContain("scheduleBuiltinReconcile('auth-change')");
    expect(source).not.toContain('ghost oauth startup reconciliation failed');
    expect(source).not.toContain('queueMicrotask(() => {\n      void reconcileGhostOauthAccountsForActiveOwner()');
    expect(source).toContain("return migrationNeedsRetry ? 'retry-pending' : 'completed';");
    expect(source).toContain('migrationNeedsRetry ||= approvalNeedsRetry;');
    expect(source).toContain('approvalNeedsRetry = true;');
    expect(source).toContain("if (outcome === 'deferred') return outcome;");
    expect(source).toContain('if (dataOwnerId !== null) {');
    expect(source).toContain('activeOwnerScopeKey() !== scope.scopeKey');
    expect(source).toContain('getActiveAppSession().dataOwnerId !== scope.dataOwnerId');
    expect(source).toContain('const activationOutcome = activateGhostsAndMigrateLegacyAccounts();');
    expect(source).toContain("return outcome === 'failed'");
    expect(source).toContain(
      "const activateGhostsAndMigrateLegacyAccounts = (): 'completed' | 'retry-pending' => {",
    );
    expect(
      source.match(/if \(migration\.retryPending\) legacyMigrationNeedsRetry = true;/g),
    ).toHaveLength(4);
    expect(
      source.match(/catch \(err\) \{\n\s+legacyMigrationNeedsRetry = true;/g),
    ).toHaveLength(4);
    expect(source).toContain(
      "return legacyMigrationNeedsRetry ? 'retry-pending' : 'completed';",
    );
    expect(source).toContain(
      "outcome === 'retry-pending' || activationOutcome === 'retry-pending'",
    );
    expect(source).toContain("(error as NodeJS.ErrnoException).code === 'ENOENT'");
    expect(source).toContain('LEGACY_MIGRATION_RETRYABLE_FAILURE');
  });

  it('keeps both retry-pending and deterministic backfill failures in the durable marker', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    const start = source.indexOf(
      'const backfill = await getGhostManager().backfillRecoveredLegacyGhosts(',
    );
    const end = source.indexOf("log.warn('recovered legacy ghost backfill pass failed'", start);
    const acknowledgementBlock = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(acknowledgementBlock).toContain('const pending = new Set(backfill.pending ?? []);');
    expect(acknowledgementBlock).toContain('const failed = new Set(backfill.failed);');
    expect(acknowledgementBlock).toContain(
      'recoveredLegacyIds.filter((id) => !pending.has(id) && !failed.has(id))',
    );
  });
});
