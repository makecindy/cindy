import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression guards for the market Node-authorization/session-switch race.
 * cindy-brain/index.ts depends on Electron process state and is not safe to
 * import in the Node test environment, so this follows the repository's
 * established source-contract test pattern for main-process auth boundaries.
 */
describe('market Ghost session boundary', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('requires the pre-approval session generation when acquiring the mutation lease', () => {
    const captureStart = source.indexOf(
      'function captureGhostMutationOwner(): ActiveAppSession {',
    );
    const captureEnd = source.indexOf('\n}\n', captureStart);
    const captureBody = source.slice(captureStart, captureEnd);
    expect(captureBody).toContain('isAppSessionBoundaryPending()');
    expect(captureBody).toContain('return getActiveAppSession();');

    const leaseStart = source.indexOf(
      'function beginGhostMutation(expectedOwner?: ActiveAppSession): () => void {',
    );
    const leaseEnd = source.indexOf('\n}\n', leaseStart);
    const leaseBody = source.slice(leaseStart, leaseEnd);
    expect(leaseBody).toContain('isAppSessionBoundaryPending()');
    expect(leaseBody).toContain('currentOwner.mode !== expectedOwner.mode');
    expect(leaseBody).toContain('currentOwner.dataOwnerId !== expectedOwner.dataOwnerId');
    expect(leaseBody).toContain('currentOwner.generation !== expectedOwner.generation');
  });

  it('captures before async inspection but leases only after Node authorization', () => {
    const installStart = source.indexOf(
      'export async function installOrUpdateMarketGhostPackage(',
    );
    const installEnd = source.indexOf(
      '\n}\n\ntype GhostUninstallLedgerCompletion',
      installStart,
    );
    const body = source.slice(installStart, installEnd);

    const captureIndex = body.indexOf(
      'const mutationOwner = captureGhostMutationOwner();',
    );
    const inspectIndex = body.indexOf('await manager.inspect(cindyFilePath)');
    const leaseIndex = body.indexOf(
      'releaseMutation = beginGhostMutation(mutationOwner);',
    );

    expect(captureIndex).toBeGreaterThan(-1);
    expect(captureIndex).toBeLessThan(inspectIndex);
    expect(leaseIndex).toBeGreaterThan(inspectIndex);
    expect(body).toContain('releaseMutation?.();');
  });
});
