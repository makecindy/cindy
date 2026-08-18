import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(
  new URL('../bootstrap-electron.ts', import.meta.url),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('Orca dispatch lease quit ordering', () => {
  it('stops maker providers before aborting submitted-state persistence', () => {
    expect(bootstrapSource).toContain(
      "onQuit('shutdown-maker', shutdownMakerOnce, 'async');",
    );
    expect(bootstrapSource).toContain(
      "'orca-team-dispatch-lease',\n  disposeOrcaTeamDispatchLeaseAfterMakerShutdown,\n  'post-async',",
    );

    const orderedDisposer = bootstrapSource.slice(
      bootstrapSource.indexOf(
        'async function disposeOrcaTeamDispatchLeaseAfterMakerShutdown()',
      ),
      bootstrapSource.indexOf(
        'async function disposeOrcaTeamDispatchLeaseAfterMakerShutdown()',
      ) + 900,
    );
    expect(orderedDisposer.indexOf('await shutdownMakerOnce();')).toBeGreaterThanOrEqual(0);
    expect(orderedDisposer.indexOf('await disposeOrcaTeamDispatchLeaseCoordinator();')).toBeGreaterThan(
      orderedDisposer.indexOf('await shutdownMakerOnce();'),
    );
  });
});
