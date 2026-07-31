import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression guards for the market Node-authorization/session-switch race.
 * cindy-brain/index.ts depends on Electron process state and is not safe to
 * import in the Node test environment, so this follows the repository's
 * established source-contract test pattern for main-process auth boundaries.
 */
describe('market Ghost session boundary', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('requires the pre-approval session generation when acquiring the mutation lease', () => {
    const captureStart = source.indexOf(
      'function captureGhostMutationOwner(): ActiveAppSession {',
    );
    const captureEnd = source.indexOf('\n}\n', captureStart);
    const captureBody = source.slice(captureStart, captureEnd);
    expect(captureBody).toContain('isAppSessionBoundaryPending()');
    expect(captureBody).toContain('return getActiveAppSession();');

    const leaseStart = source.indexOf(
      'function beginGhostMutation(expectedOwner?: ActiveAppSession): () => void {',
    );
    const leaseEnd = source.indexOf('\n}\n', leaseStart);
    const leaseBody = source.slice(leaseStart, leaseEnd);
    expect(leaseBody).toContain('isAppSessionBoundaryPending()');
    expect(leaseBody).toContain('currentOwner.mode !== expectedOwner.mode');
    expect(leaseBody).toContain('currentOwner.dataOwnerId !== expectedOwner.dataOwnerId');
    expect(leaseBody).toContain('currentOwner.generation !== expectedOwner.generation');
  });

  it('captures before async inspection but leases only after Node authorization', () => {
    const installStart = source.indexOf(
      'export async function installOrUpdateMarketGhostPackage(',
    );
    const installEnd = source.indexOf(
      '\n}\n\ntype GhostUninstallLedgerCompletion',
      installStart,
    );
    const body = source.slice(installStart, installEnd);

    const captureIndex = body.indexOf(
      'const mutationOwner = captureGhostMutationOwner();',
    );
    const inspectIndex = body.indexOf('await manager.inspect(cindyFilePath)');
    const leaseIndex = body.indexOf(
      'releaseMutation = beginGhostMutation(mutationOwner);',
    );

    expect(captureIndex).toBeGreaterThan(-1);
    expect(captureIndex).toBeLessThan(inspectIndex);
    expect(leaseIndex).toBeGreaterThan(inspectIndex);
    expect(body).toContain('releaseMutation?.();');
  });

  it('holds the same owner-stability lease across every appearance mutation entry', () => {
    const helperStart = source.indexOf(
      'async function withGhostAppearanceMutation<T>',
    );
    const helperEnd = source.indexOf(
      '\n}\n\nexport function getGhostAppearanceSlot',
      helperStart,
    );
    const helper = source.slice(helperStart, helperEnd);
    expect(helper).toContain('const owner = captureGhostMutationOwner();');
    expect(helper).toContain('const releaseMutation = beginGhostMutation(owner);');
    expect(helper).toContain('const run = ghostAppearanceMutationTail.then(operation);');
    expect(helper).toContain('ghostAppearanceMutationTail = run.then(');
    expect(helper).toContain('return await run;');
    expect(helper).toContain('releaseMutation();');

    for (const marker of [
      'getGhostAppearanceSlot().handleRequest(id, payload)',
      'await resetGhostAppearance();',
      'await activateGhostAppearancePreset(preset)',
      'await deleteGhostAppearancePreset(preset)',
    ]) {
      const markerIndex = source.indexOf(marker);
      const leaseIndex = source.lastIndexOf('withGhostAppearanceMutation(', markerIndex);
      expect(markerIndex).toBeGreaterThan(-1);
      expect(leaseIndex).toBeGreaterThan(-1);
      expect(markerIndex - leaseIndex).toBeLessThan(500);
    }
  });

  it('broadcasts trusted preset deletion so every window refreshes its library', () => {
    const handlerStart = source.indexOf(
      "ipcMain.handle('ghosts:appearance:delete-preset'",
    );
    const handlerEnd = source.indexOf('\n  });', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    expect(handler).toContain('const state = await readGhostAppearanceState();');
    expect(handler).toContain('broadcastGhostAppearance(state.appearance);');
    expect(handler).toContain('return state;');
  });

  it('keeps trusted appearance mutations behind the structured IPC error boundary', () => {
    for (const channel of [
      'ghosts:appearance:reset',
      'ghosts:appearance:activate-preset',
      'ghosts:appearance:delete-preset',
    ]) {
      const handlerStart = source.indexOf(`ipcMain.handle('${channel}'`);
      const handlerEnd = source.indexOf('\n  });', handlerStart);
      const handler = source.slice(handlerStart, handlerEnd);
      expect(handler).toContain('return invokeGhostAppearanceIpc(() =>');
      expect(handler).toContain('withGhostAppearanceMutation(async () =>');
    }
  });

  it('revokes plugin-owned appearance data after uninstall and recovers before install', () => {
    const installStart = source.indexOf('export async function installAndDock(');
    const installEnd = source.indexOf(
      '\n}\n\n/**\n * Plugin 市场专用装入入口',
      installStart,
    );
    const installBody = source.slice(installStart, installEnd);
    expect(installBody).toContain('await recoverGhostAppearanceTransaction();');
    expect(installBody.indexOf('await recoverGhostAppearanceTransaction();')).toBeLessThan(
      installBody.indexOf('await manager.install('),
    );

    const uninstallStart = source.indexOf(
      'export async function uninstallGhostAndCleanup(',
    );
    const uninstallEnd = source.indexOf(
      '\n}\n\n/** 市场默认安装',
      uninstallStart,
    );
    const uninstallBody = source.slice(uninstallStart, uninstallEnd);
    expect(uninstallBody).toContain(
      'await withGhostAppearanceMutation(async () => {',
    );
    expect(uninstallBody.indexOf('await withGhostAppearanceMutation(async () =>')).toBeGreaterThan(
      -1,
    );
    expect(uninstallBody).toContain('await prepareGhostAppearanceRemoval(id)');
    expect(uninstallBody.indexOf('await prepareGhostAppearanceRemoval(id)')).toBeLessThan(
      uninstallBody.indexOf('await manager.uninstall('),
    );
  });

  it('routes seeded plugin removal through the durable appearance cleanup boundary', () => {
    const reconcileStart = source.indexOf('async function reconcileBuiltinGhosts(');
    const reconcileEnd = source.indexOf(
      '\n}\n\n/** Cindy Brain 启动',
      reconcileStart,
    );
    const reconcileBody = source.slice(reconcileStart, reconcileEnd);
    expect(reconcileBody).toContain('removeInstalled: (id, removePackage)');
    expect(reconcileBody).toContain('withGhostAppearanceMutation(async () =>');
    expect(reconcileBody).toContain('await prepareGhostAppearanceRemoval(id)');
    expect(reconcileBody).toContain('await removePackage()');
    expect(reconcileBody).toContain('await cancelGhostAppearanceRemoval(id)');
    expect(reconcileBody).toContain('await recoverGhostAppearanceTransaction()');
  });
});
