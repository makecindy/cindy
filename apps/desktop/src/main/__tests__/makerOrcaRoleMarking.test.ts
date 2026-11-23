import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createSetSessionThinkingEnabled } from '../maker-ipc/sessionRuntimeAxisSettings';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
);
const makerHostSource = readFileSync(
  resolve(__dirname, '..', 'maker-host', 'index.ts'),
  'utf8',
);

describe('maker Orca role marking IPC boundary', () => {
  it('exposes explicit markOrcaRole IPC for post-addWorker marking', () => {
    expect(registerSource).toContain('ipcMain.handle(MAKER_INVOKE.MARK_ORCA_ROLE');
    expect(registerSource).toContain('await markOrcaRoleIfNeeded(sessionId, role);');
  });

  it('suppresses Agent Island notifications for known Orca workers', () => {
    expect(registerSource).toContain("from '../agent-island/notificationPolicy.js'");
    expect(registerSource).toContain('function shouldNotifyAgentIslandForSession(sessionId: string): boolean');
    expect(registerSource).toContain('isKnownOrcaWorkerSession(sessionId)');
    expect(registerSource).toContain('if (!shouldNotifyAgentIslandForSession(session.id)) return;');
    expect(registerSource).toContain('if (!shouldNotifyAgentIslandForSession(sessionId)) return;');
  });

  it('clears any existing Agent Island entry when a session is marked as an Orca worker', () => {
    const roleMarkingSource = registerSource.slice(registerSource.indexOf('async function markOrcaRoleIfNeeded'));

    expect(roleMarkingSource).toContain("if (orcaRole === 'worker') {");
    expectOrder(roleMarkingSource, 'markKnownOrcaWorkerSession(sessionId);', 'clearSuppressedOrcaWorkerAgentIslandSession(sessionId);');
  });

  it('rejects Review sessions before either Orca entry point can mutate state', () => {
    const roleMarkingSource = registerSource.slice(
      registerSource.indexOf('async function markOrcaRoleIfNeeded'),
      registerSource.indexOf('async function bootstrapSession'),
    );
    const collabGuardSource = registerSource.slice(
      registerSource.indexOf('async function assertLeadCollabProjectEnabled'),
      registerSource.indexOf('async function sendUserMessageWithAwaitedGitBaseline'),
    );

    expectOrder(
      roleMarkingSource,
      'await assertReviewSettingsUnlocked(sessionId);',
      'await setSessionOrcaRole(sessionId, orcaRole, { owner: owner!, assertCurrent });',
    );
    expectOrder(
      collabGuardSource,
      'await assertReviewSettingsUnlocked(leadSessionId);',
      'const lead = maker.getSession(leadSessionId);',
    );
  });

  it('routes IPC and MCP team/worker creation through the shared Review guard', () => {
    const workerIpcSource = registerSource.slice(
      registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.WORKER_CREATE'),
      registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.WORKER_LIST'),
    );
    const collabHolderSource = registerSource.slice(
      registerSource.indexOf('orcaCollabServiceHolder = {'),
      registerSource.indexOf('// ─── Agent Team heartbeat watcher'),
    );

    expect(workerIpcSource).toContain('await assertLeadCollabProjectEnabled(b.leadSessionId);');
    const sharedStart = registerSource.slice(
      registerSource.indexOf('const startOrcaTeamForCaller ='),
      registerSource.indexOf('const pluginPermissionRequests ='),
    );
    expectOrder(sharedStart, 'await assertLeadCollabProjectEnabled(leadSessionId);', 'return await startOrcaTeamWithPermissionGate(');
    expect(collabHolderSource).toContain('startOrcaTeamForCaller(leadSessionId, workerPermissionMode)');
    expect(collabHolderSource).toContain('createWorker: async');
    expect(collabHolderSource).toContain('createWorkerFromTask: async');
    expect(
      collabHolderSource.match(/await assertLeadCollabProjectEnabled\(/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it('registers rehydrated worker sessions as known before Maker publishes them', () => {
    const successHookSource = makerHostSource.slice(
      makerHostSource.indexOf('onStartSucceeded:'),
      makerHostSource.indexOf('getCodexHistoryHasProductPrompt:'),
    );

    expect(successHookSource).toContain("if (createOpts.orcaRole === 'worker') {");
    expect(successHookSource).toContain('markKnownOrcaWorkerSession(sessionId);');
  });

  // The SET_THINKING_ENABLED body after its sender check runs from sessionRuntimeAxisSettings.ts; a
  // Review task is refused before the runtime's thinking is touched.
  it('rejects Review sessions before thinking can be flipped', async () => {
    const setThinkingEnabled = vi.fn(async () => {});
    const handle = createSetSessionThinkingEnabled({
      maker: { getSession: () => ({ setThinkingEnabled }) } as never,
      assertReviewSettingsUnlocked: async () => { throw new Error('Review task settings are fixed to the source task'); },
      captureSharedTaskSettingGuard: () => Object.assign(() => {}, { admit: () => {} }) as never,
    });
    await expect(handle('review-task', true)).rejects.toThrow('Review task settings are fixed to the source task');
    expect(setThinkingEnabled).not.toHaveBeenCalled();
  });
});

function expectOrder(source: string, before: string, after: string): void {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  expect(beforeIndex).toBeGreaterThanOrEqual(0);
  expect(afterIndex).toBeGreaterThan(beforeIndex);
}
