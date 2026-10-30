import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Ghost account-boundary teardown ordering', () => {
  const bootstrap = readFileSync(
    resolve(__dirname, '../bootstrap-electron.ts'),
    'utf8',
  ).replace(/\r\n?/g, '\n');
  const ghostIndex = readFileSync(
    resolve(__dirname, '../cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n?/g, '\n');

  it('interrupts long setup, grant, and pipe waits before draining owner leases', () => {
    const start = bootstrap.indexOf(
      'async function teardownGhostProjectionBoundary(reason: string): Promise<void> {',
    );
    const end = bootstrap.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = bootstrap.slice(start, end);

    // Match complete awaited calls, allowing formatter-only whitespace/trailing commas.
    const interrupt = body.search(
      /await\s+run\(\s*'interruptGhostCallsForAccountBoundary'\s*,\s*\(\s*\)\s*=>\s*withAuthBoundaryTimeout\(\s*'interrupt Ghost calls'\s*,\s*interruptGhostCallsForAccountBoundary\s*,?\s*\)\s*,?\s*\)\s*;/,
    );
    const wait = body.search(
      /await\s+run\(\s*'waitForGhostMutations'\s*,\s*\(\s*\)\s*=>\s*withAuthBoundaryTimeout\(\s*'wait for Ghost mutations'\s*,\s*waitForGhostMutations\s*,?\s*\)\s*,?\s*\)\s*;/,
    );
    const suspend = body.search(/await\s+run\(\s*'suspendAllGhosts'\s*,\s*suspendAllGhosts\s*,?\s*\)\s*;/);

    expect(interrupt).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(-1);
    expect(suspend).toBeGreaterThan(-1);
    expect(interrupt).toBeLessThan(wait);
    expect(wait).toBeLessThan(suspend);
  });

  it('replaces the terminal Node broker after an owner boundary', () => {
    const helperStart = ghostIndex.indexOf(
      'function resetNodeRuntimeBrokerForAccountBoundary(): void {',
    );
    const helperEnd = ghostIndex.indexOf('\n}', helperStart);
    const helper = ghostIndex.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain('broker.destroyAll();');
    expect(helper).toContain('nodeRuntimeBrokerSingleton = null;');
    expect(ghostIndex).toContain('resetNodeRuntimeBrokerForAccountBoundary();');
  });
});
