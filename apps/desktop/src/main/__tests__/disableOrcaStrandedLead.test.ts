import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// register.ts wires disableOrcaInternal inside one large closure with many runtime
// deps (maker, stores, caches), so the repo tests its IPC-boundary invariants via
// source assertion (see makerOrcaRoleMarking.test.ts / orcaWorkflowRoute.test.ts).
// The *behavioral* predicate (clear lead role iff no active team) is covered by
// orcaStrandedLeadReconcile.test.ts; here we lock down that disableOrcaInternal's
// "no active team" branch is no longer an unconditional no-op.
const registerSource = readFileSync(resolve(__dirname, '..', 'maker-ipc', 'register.ts'), 'utf8');
const orcaQueueItemSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'orcaQueueItem.ts'),
  'utf8',
);

describe('disableOrcaInternal stranded-lead recovery', () => {
  it('extracts a shared clearLeadOrcaRoleState helper', () => {
    expect(registerSource).toContain(
      'async function clearLeadOrcaRoleState(leadSessionId: string)',
    );
  });

  it('reconciles a stranded lead in the "no active team" branch instead of plain no-op', () => {
    // The branch must consult the persisted role and clear it when still 'lead'.
    expect(registerSource).toContain('const role = await getSessionOrcaRole(leadSessionId);');
    expect(registerSource).toContain("if (role === 'lead') {");
  });

  it('also archives orphaned workers from non-active teams in the recovery branch', () => {
    // If the prior disable was interrupted before archiveWorkersByTeam, the lead's worker
    // sessions stay active+hidden+unreachable; the recovery must reconcile them too.
    const reconcileIndex = registerSource.indexOf(
      'await reconcileInactiveTeamWorkersForLead(leadSessionId)',
    );
    const recycleIndex = registerSource.indexOf(
      "await recycleSessionWorktreeForStatusChange(sid, 'archived', workerRecycleScope)",
      reconcileIndex,
    );
    const scopeIndex = registerSource.lastIndexOf(
      'const workerRecycleScope = captureSessionRecycleScope();',
      reconcileIndex,
    );
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeLessThan(reconcileIndex);
    expect(reconcileIndex).toBeGreaterThanOrEqual(0);
    expect(recycleIndex).toBeGreaterThan(reconcileIndex);
  });

  it('fully cleans Host-owned worker runtimes after normal team archival', () => {
    expect(registerSource).toContain('await cancelIOSSimulatorSessionOperations(w.sessionId)');
    const archiveIndex = registerSource.indexOf(
      'const archivedWorkerSessionIds = await archiveWorkersByTeam(team.id)',
    );
    const recycleIndex = registerSource.indexOf(
      "recycleSessionWorktreeForStatusChange(sessionId, 'archived', workerRecycleScope)",
      archiveIndex,
    );
    const scopeIndex = registerSource.lastIndexOf(
      'const workerRecycleScope = captureSessionRecycleScope();',
      archiveIndex,
    );
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeLessThan(archiveIndex);
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(recycleIndex).toBeGreaterThan(archiveIndex);
  });

  it('runs full removed-session cleanup after archiving one worker', () => {
    const archiveIndex = registerSource.indexOf('await archiveSingleWorkerSession(sessionId);');
    const recycleIndex = registerSource.indexOf(
      "await recycleSessionWorktreeForStatusChange(sessionId, 'archived', workerRecycleScope);",
      archiveIndex,
    );
    const scopeIndex = registerSource.lastIndexOf(
      'const workerRecycleScope = captureSessionRecycleScope();',
      archiveIndex,
    );
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeLessThan(archiveIndex);
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(recycleIndex).toBeGreaterThan(archiveIndex);
  });

  it('reuses clearLeadOrcaRoleState on BOTH the normal-close and stranded-recovery paths', () => {
    const calls = registerSource.match(/await clearLeadOrcaRoleState\(leadSessionId\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('waits for ingress settlement and durable marker cleanup before terminal commit', () => {
    const helperAt = registerSource.indexOf(
      'async function prepareOrcaTeamTerminalCommit',
    );
    const waitedAt = registerSource.indexOf(
      'await orcaInterAgentDispatcher.waitForTeamDispatchSettlements(input.teamId)',
      helperAt,
    );
    const helperPreparedAt = registerSource.indexOf(
      'await prepareOrcaTeamCleanupIntents(input)',
      helperAt,
    );
    const durableSweepAt = registerSource.indexOf(
      'await rewindOrcaPreVendorCleanupRows(input.teamId, input.sessionIds)',
      helperAt,
    );
    const endedAt = registerSource.indexOf("await markTeamEnded(team.id, 'completed', {");
    const preparedAt = registerSource.indexOf(
      'beforeTerminalCommit: () => prepareOrcaTeamTerminalCommit(cleanupScope)',
      endedAt,
    );
    const rollbackAt = registerSource.indexOf(
      'onTerminalCommitFailed: () => settleOrcaTeamQueuedInputs(cleanupScope)',
      endedAt,
    );
    const settledAt = registerSource.indexOf(
      'await settleOrcaTeamQueuedInputs(cleanupScope)',
      endedAt,
    );
    const clearedAt = registerSource.indexOf('await clearLeadOrcaRoleState(leadSessionId)', endedAt);

    expect(helperAt).toBeGreaterThan(-1);
    expect(waitedAt).toBeGreaterThan(helperAt);
    expect(durableSweepAt).toBeGreaterThan(waitedAt);
    expect(helperPreparedAt).toBeGreaterThan(durableSweepAt);
    expect(endedAt).toBeGreaterThan(-1);
    expect(preparedAt).toBeGreaterThan(endedAt);
    expect(rollbackAt).toBeGreaterThan(preparedAt);
    expect(settledAt).toBeGreaterThan(rollbackAt);
    expect(clearedAt).toBeGreaterThan(settledAt);
  });

  it('uses the legacy workflow id fallback for both end-team invalidation and snapshot restore', () => {
    expect(orcaQueueItemSource).toContain(
      'function resolveOrcaQueueItemTeamId(item: AgentInputQueuedMessage)',
    );
    expect(orcaQueueItemSource).toContain(
      'const legacyTeamId = item.createOpts.vendorOptions?.orcaWorkflowId;',
    );
    expect(registerSource).toContain(
      '(item) => resolveOrcaQueueItemTeamId(item) === input.teamId',
    );
    expect(registerSource).toContain('const teamId = resolveOrcaQueueItemTeamId(item);');
    const resolverCalls = registerSource.match(/resolveOrcaQueueItemTeamId\(item\)/g) ?? [];
    expect(resolverCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('serializes Lead start/end independently from the input-send lock', () => {
    expect(registerSource).toContain('function withOrcaLeadLifecycleLock<T>(');
    expect(registerSource).toContain(
      'const orcaLeadLifecycleLocks = new Map<string, Promise<void>>();',
    );
    const lockStart = registerSource.indexOf('function withOrcaLeadLifecycleLock<T>(');
    const lockEnd = registerSource.indexOf(
      'function assertOrcaQueueOriginActive',
      lockStart,
    );
    const lockSource = registerSource.slice(lockStart, lockEnd);
    expect(lockSource).toContain('const previous = orcaLeadLifecycleLocks.get(leadSessionId)');
    expect(lockSource).not.toContain('withSendToSessionLock');
    expect(registerSource).toContain('enableOrca: enableOrcaWithLeadLifecycleLock');
    expect(registerSource).toContain('disableOrca: disableOrcaWithLeadLifecycleLock');
    expect(registerSource).toMatch(
      /startTeam: \(params\) =>\s+withOrcaLeadLifecycleLock\(params\.leadSessionId, \(\) =>\s+orcaLifecycleService\.startTeam\(params\)/,
    );
    const lockedDisableCalls =
      registerSource.match(/disableOrcaWithLeadLifecycleLock\(leadSessionId\)/g) ?? [];
    expect(lockedDisableCalls.length).toBeGreaterThanOrEqual(3);
  });
});
