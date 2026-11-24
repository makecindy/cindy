import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import { shouldNotifyAgentIslandForSession } from '../agent-island/notificationPolicy.js';
import {
  forgetKnownOrcaWorkerSession as forgetWorkerIdentity,
  isKnownOrcaWorkerSession,
  markKnownOrcaWorkerSession,
} from '../maker-ipc/orcaManualInterrupt.js';

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

  // Worker notification suppression is covered through AgentIslandService's real
  // display/activity projections in agent-island/__tests__/service.test.ts. Do not
  // require discarding its lifecycle events or deleting its live activity here.
  // #12558, unit: execute the production forwarding gate with in-memory identity
  // boundaries; the former literal assertions required the buggy Worker exclusion.
  it('forwards Worker lifecycle activity while retaining the hidden-task boundary', () => {
    const source = registerSource.match(/function shouldNotifyAgentIslandForSession\(sessionId: string\): boolean \{[\s\S]*?\n\}/)?.[0];
    if (!source) throw new Error('Activity forwarding gate missing');
    const gate = new Function('isSessionHiddenSync', 'isKnownOrcaWorkerSession',
      'shouldNotifyAgentIslandForSessionByPolicy', 'AGENT_ISLAND_DISPLAY_CONFIG',
      transpileModule(`${source}\nreturn shouldNotifyAgentIslandForSession;`, {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText,
    )((id: string) => id === 'hidden', (id: string) => id === 'worker',
      shouldNotifyAgentIslandForSession, { notifyOrcaWorkerSessions: false }) as (id: string) => boolean;
    expect(gate('worker')).toBe(true);
    expect(gate('ordinary')).toBe(true);
    expect(gate('hidden')).toBe(false);
  });

  // #12570 review: register's shared forget boundary must discard live projections
  // while the Worker identity still suppresses notifications. Ordinary close keeps
  // unread activity, so forgetting first can publish it as a normal task. Unit;
  // service.test.ts covers the real close/discard/display/relay projections.
  it('discards Worker activity before forgetting its notification identity', () => {
    const source = registerSource.match(/function forgetKnownOrcaWorkerSession\(sessionId: string\): void \{[\s\S]*?\n\}/)?.[0];
    if (!source) throw new Error('Worker activity cleanup boundary missing');
    const handleSessionClosed = vi.fn(() => {
      expect(isKnownOrcaWorkerSession('archive-worker')).toBe(true);
    });
    const forget = new Function('getAgentIslandService', 'forgetOrcaWorkerIdentity',
      transpileModule(`${source}\nreturn forgetKnownOrcaWorkerSession;`, {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText,
    )(() => ({ handleSessionClosed }), forgetWorkerIdentity) as (id: string) => void;
    markKnownOrcaWorkerSession('archive-worker');
    try {
      forget('archive-worker');
      expect(handleSessionClosed).toHaveBeenCalledWith('archive-worker', { reason: 'discarded' });
      expect(isKnownOrcaWorkerSession('archive-worker')).toBe(false);
    } finally {
      forgetWorkerIdentity('archive-worker');
    }
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
