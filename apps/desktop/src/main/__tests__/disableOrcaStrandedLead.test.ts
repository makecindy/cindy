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

  it('keeps the active team retryable when a Worker runtime close fails', () => {
    const disableStart = registerSource.indexOf('async function disableOrcaInternal');
    const disableEnd = registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.SESSION_DISABLE_ORCA', disableStart);
    const disableBlock = registerSource.slice(disableStart, disableEnd);
    const closeIndex = disableBlock.indexOf('await releaseOrcaWorkerRuntime(w);');
    const rethrowIndex = disableBlock.indexOf('throw err;', closeIndex);
    const finalizeIndex = disableBlock.indexOf("await markTeamEnded(team.id, 'completed');");

    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(rethrowIndex).toBeGreaterThan(closeIndex);
    expect(finalizeIndex).toBeGreaterThan(rethrowIndex);
  });

  it('persists each Worker release before provider close so partial team shutdown remains recoverable', () => {
    expect(registerSource).toContain('const releaseOrcaWorkerRuntime = createOrcaRuntimeRelease({');
    expect(registerSource).toContain('markRelease: markWorkerRuntimeReleaseIntent');
    expect(registerSource).toContain('acknowledgeRelease: acknowledgeWorkerRuntimeRelease');
  });

  it('uses a generic close for failed Worker creation before the thread has a rollout', () => {
    const creationServiceStart = registerSource.indexOf(
      'const orcaWorkerCreationService = createOrcaWorkerCreationService({',
    );
    const lifecycleServiceStart = registerSource.indexOf(
      'const orcaLifecycleService = createOrcaLifecycleService({',
      creationServiceStart,
    );
    const creationServiceBlock = registerSource.slice(creationServiceStart, lifecycleServiceStart);

    expect(creationServiceBlock).toContain('await maker.closeSession(sessionId);');
    expect(creationServiceBlock).not.toContain(
      'await maker.closeSession(sessionId, { releaseRuntime: true });',
    );
  });

  it('maps disable IPC failures to a stable message', () => {
    const handlerStart = registerSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.SESSION_DISABLE_ORCA',
    );
    const handlerEnd = registerSource.indexOf('// ─── Orca worker IPC handlers', handlerStart);
    const handlerBlock = registerSource.slice(handlerStart, handlerEnd);

    expect(handlerBlock).toContain(
      "throwIpcError('INTERNAL', t('newChat.collaboration.stopFailed'));",
    );
  });
});
