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
      'async function teardownAuthAccountBoundary(reason: string): Promise<void> {',
    );
    const end = bootstrap.indexOf('\n}\n', start);
    const body = bootstrap.slice(start, end);

    const interrupt = body.indexOf('await interruptGhostCallsForAccountBoundary();');
    const wait = body.indexOf('await waitForGhostMutations();');
    const suspend = body.indexOf('suspendAllGhosts();');

    expect(interrupt).toBeGreaterThan(-1);
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
