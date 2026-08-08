import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// register.ts wires disableOrcaInternal inside one large closure with many runtime
// deps (maker, stores, caches), so the repo tests its IPC-boundary invariants via
// source assertion (see makerOrcaRoleMarking.test.ts / orcaWorkflowRoute.test.ts).
// The *behavioral* predicate (clear lead role iff no active team) is covered by
// orcaStrandedLeadReconcile.test.ts; here we lock down that disableOrcaInternal's
// "no active team" branch is no longer an unconditional no-op.
const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
);

describe('disableOrcaInternal stranded-lead recovery', () => {
  it('extracts a shared clearLeadOrcaRoleState helper', () => {
    expect(registerSource).toContain('async function clearLeadOrcaRoleState(leadSessionId: string)');
  });

  it('reconciles a stranded lead in the "no active team" branch instead of plain no-op', () => {
    // The branch must consult the persisted role and clear it when still 'lead'.
    expect(registerSource).toContain('const role = await getSessionOrcaRole(leadSessionId);');
    expect(registerSource).toContain("if (role === 'lead') {");
  });

  it('also archives orphaned workers from non-active teams in the recovery branch', () => {
    // If the prior disable was interrupted before archiveWorkersByTeam, the lead's worker
    // sessions stay active+hidden+unreachable; the recovery must reconcile them too.
    expect(registerSource).toContain('await reconcileInactiveTeamWorkersForLead(leadSessionId)');
  });

  it('reuses clearLeadOrcaRoleState on BOTH the normal-close and stranded-recovery paths', () => {
    const calls = registerSource.match(/await clearLeadOrcaRoleState\(leadSessionId\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('ends the active team before selectively invalidating only that team queued input', () => {
    const endedAt = registerSource.indexOf("await markTeamEnded(team.id, 'completed')");
    const invalidatedAt = registerSource.indexOf('await discardOrcaTeamQueuedInputs({');
    const clearedAt = registerSource.indexOf('await clearLeadOrcaRoleState(leadSessionId)', endedAt);

    expect(endedAt).toBeGreaterThan(-1);
    expect(invalidatedAt).toBeGreaterThan(endedAt);
    expect(clearedAt).toBeGreaterThan(invalidatedAt);
  });

  it('uses the legacy workflow id fallback for both end-team invalidation and snapshot restore', () => {
    expect(registerSource).toContain(
      'function resolveOrcaQueueItemTeamId(item: AgentInputQueuedMessage)',
    );
    expect(registerSource).toContain(
      'const legacyTeamId = item.createOpts.vendorOptions?.orcaWorkflowId;',
    );
    expect(registerSource).toContain(
      '(item) => resolveOrcaQueueItemTeamId(item) === input.teamId',
    );
    expect(registerSource).toContain('const teamId = resolveOrcaQueueItemTeamId(item);');
    const resolverCalls = registerSource.match(/resolveOrcaQueueItemTeamId\(item\)/g) ?? [];
    expect(resolverCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('serializes every external Lead start/end entrypoint on the session lifecycle lock', () => {
    expect(registerSource).toContain('function withOrcaLeadLifecycleLock<T>(');
    expect(registerSource).toContain('return withSendToSessionLock(leadSessionId, task);');
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
