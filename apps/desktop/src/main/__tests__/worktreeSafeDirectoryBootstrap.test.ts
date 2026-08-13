import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');
const poolSource = readFileSync(resolve(__dirname, '..', 'worktree', 'WorktreePool.ts'), 'utf8');
const sessionsSource = readFileSync(
  resolve(__dirname, '..', 'localDb', 'ipc', 'sessions.ts'),
  'utf8',
);

describe('safe.directory startup reconciliation', () => {
  it('wires Maker liveness before local DB readiness without making base reconciliation depend on Maker', () => {
    const wiring = bootstrapSource.indexOf('setSafeDirectorySessionRuntimeAliveProvider(');
    const localDbRegistration = bootstrapSource.indexOf('registerLocalDbIpc({');
    const onReady = bootstrapSource.indexOf('onReady: async (userId) => {', localDbRegistration);
    const dbTakeover = bootstrapSource.indexOf(
      'const dbClientTakeover = await ensureLifecycleDbClient(userId);',
      onReady,
    );
    const dbReadyReconciliation = bootstrapSource.indexOf(
      'void reconcileSafeDirectories().catch',
      dbTakeover,
    );
    const unchangedBranch = bootstrapSource.indexOf(
      "if (dbClientTakeover.mode === 'unchanged')",
      dbTakeover,
    );
    expect(wiring).toBeGreaterThan(-1);
    expect(bootstrapSource).toMatch(
      /setSafeDirectorySessionRuntimeAliveProvider\(\s*\(sessionId\) =>\s*getMakerIfReady\(\)\?\.isSessionAlive\(sessionId\)/,
    );
    expect(wiring).toBeLessThan(localDbRegistration);
    expect(dbReadyReconciliation).toBeGreaterThan(dbTakeover);
    expect(dbReadyReconciliation).toBeLessThan(unchangedBranch);
    expect(bootstrapSource).toContain('Maker-ready safe.directory reconcile failed (non-fatal)');
  });

  it('injects session-change reconciliation without a main-process dynamic import', () => {
    expect(bootstrapSource).toMatch(/registerLocalDbIpc\(\{[\s\S]*reconcileSafeDirectories,/);
    expect(sessionsSource).not.toContain("import('../../worktree/safeDirectory.js')");
  });

  it('is triggered without awaiting it in the bootstrap path', () => {
    expect(bootstrapSource).toContain('void reconcileSafeDirectories().catch((err) => {');
    expect(bootstrapSource).not.toContain('await reconcileSafeDirectories()');
  });

  it('does not turn recoverPool cleanup into an indirect startup blocker', () => {
    const recoverPoolBody = poolSource.slice(
      poolSource.indexOf('export async function recoverPool'),
    );
    expect(recoverPoolBody).toContain('await evictIfOverLimit(liveSessionPathKeys, false);');
    expect(recoverPoolBody).not.toContain('reconcileSafeDirectoriesAfterCleanup()');
  });
});
