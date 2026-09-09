import { readFileSync } from 'node:fs';
import { transpileModule, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual closure helpers with controlled async host dependencies.
const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const helperStart = source.indexOf('  type OrcaTeamCleanupScope =');
const helperEnd = source.indexOf('  /**\n   * disableOrcaInternal', helperStart);
expect(helperStart).toBeGreaterThanOrEqual(0);
expect(helperEnd).toBeGreaterThan(helperStart);
const helpers = source.slice(helperStart, helperEnd);

function harness(pausedWait: number) {
  const firstOwner = { owner: 'first' };
  let currentOwner = firstOwner;
  let resolveEntered!: () => void;
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  let resume!: () => void;
  const pending = new Promise<void>((resolve) => { resume = resolve; });
  let waits = 0;
  const wait = vi.fn(async () => {
    waits += 1;
    if (waits === pausedWait) {
      resolveEntered();
      await pending;
    }
  });
  const rewind = vi.fn(async () => []);
  const persistIntent = vi.fn(async () => undefined);
  const discard = vi.fn(async () => undefined);
  const finalized = vi.fn(async () => undefined);
  const markTeamEnded = vi.fn(async (_teamId: string, _status: string, hooks: {
    beforeTerminalCommit(): Promise<void>;
  }) => {
    await hooks.beforeTerminalCommit();
    return [];
  });
  const deps = {
    getDbClient: () => currentOwner,
    inputCoordinator: {
      discardQueuedItemsWhere: discard,
      persistOrcaCleanupIntentWhere: persistIntent,
    },
    resolveOrcaQueueItemTeamId: () => 'team-1',
    persistedOrcaPreVendorInputsForTeam: () => new Map(),
    orcaInterAgentDispatcher: { waitForTeamDispatchSettlements: wait },
    rewindOrcaPreVendorCleanupRows: rewind,
    finalizeRewoundOrcaPreVendorCleanupRows: finalized,
    markTeamEnded,
    untrackPersistedOrcaPreVendorInput: vi.fn(),
  };
  const js = transpileModule(`${helpers}\nreturn markOrcaTeamEndedWithCleanup;`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const run = new Function(...Object.keys(deps), js)(...Object.values(deps)) as (
    input: { teamId: string; status: string; sessionIds: string[] },
  ) => Promise<void>;
  return {
    run, entered, resume, rewind, persistIntent, discard, finalized,
    changeOwner: () => { currentOwner = { owner: 'next' }; },
  };
}

describe('Orca terminal cleanup owner scope', () => {
  it.each([
    { phase: 'prepare', pausedWait: 1 },
    { phase: 'settle', pausedWait: 2 },
  ])('stops before the next cleanup side effect when owner changes during $phase ingress wait', async ({ pausedWait }) => {
    const h = harness(pausedWait);
    const result = h.run({ teamId: 'team-1', status: 'completed', sessionIds: ['session-1'] })
      .then(() => null, (error: unknown) => error);
    await h.entered;
    const rewindsBeforeSwitch = h.rewind.mock.calls.length;
    const intentsBeforeSwitch = h.persistIntent.mock.calls.length;
    h.changeOwner();
    h.resume();
    const error = await result;
    expect(h.rewind).toHaveBeenCalledTimes(rewindsBeforeSwitch);
    expect(h.persistIntent).toHaveBeenCalledTimes(intentsBeforeSwitch);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('ORCA_CLEANUP_OWNER_CHANGED');
  });
});
