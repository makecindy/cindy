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
  const marketServiceSource = readFileSync(
    resolve(process.cwd(), 'src/main/plugin-market/service.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('keeps automatic custom updates bound to the owner captured by synchronization', () => {
    const installStart = marketServiceSource.indexOf('  private async customInstall(');
    const installEnd = marketServiceSource.indexOf(
      '\n  private async installDetail(',
      installStart,
    );
    const installBody = marketServiceSource.slice(installStart, installEnd);
    const automaticStart = marketServiceSource.indexOf('  private async applyAutomaticUpgrades(');
    const automaticEnd = marketServiceSource.indexOf(
      '\n  private localInstallSnapshot(',
      automaticStart,
    );
    const automaticBody = marketServiceSource.slice(automaticStart, automaticEnd);

    expect(installBody).toContain('owner = captureMarketOwner(),');
    expect(installBody).toContain('const ledger = this.ledgerForOwner(owner);');
    expect(installBody).toContain('const manager = this.sourceManagerForOwner(owner);');
    expect(installBody).toContain('requireSameMarketOwner(owner);');
    expect(installBody).toContain(
      'beforePackagePlacement: () => {\n            requireSameMarketOwner(owner);',
    );
    expect(installBody).toContain(
      'afterCommit: async (_installed, packagedManifest) => {',
    );
    const afterCommitStart = installBody.indexOf(
      'afterCommit: async (_installed, packagedManifest) => {',
    );
    const afterCommitEnd = installBody.indexOf('\n          },\n        }).catch', afterCommitStart);
    const afterCommitBody = installBody.slice(afterCommitStart, afterCommitEnd);
    expect(afterCommitBody).toContain('this.withCapturedLedgerMutation(ledger, () => {');
    expect(afterCommitBody).not.toContain('requireSameMarketOwner(');
    expect(automaticBody).toContain('          true,\n          owner,\n        );');
  });

  it('keeps package placement and market ledger commit in the same owner lease', () => {
    const installStart = source.indexOf(
      'async function installOrUpdateMarketGhostPackageLocked(',
    );
    const installEnd = source.indexOf('\n}\n\ntype GhostUninstallLedgerCompletion', installStart);
    const installBody = source.slice(installStart, installEnd);
    const firstAfterCommit = installBody.indexOf(
      'await expected.afterCommitInLock?.(installedGhost);',
    );
    const updateAfterCommit = installBody.indexOf(
      'await expected.afterCommitInLock?.(result.ghost);',
    );
    const release = installBody.indexOf('releaseMutation?.();');

    expect(firstAfterCommit).toBeGreaterThan(-1);
    expect(updateAfterCommit).toBeGreaterThan(firstAfterCommit);
    expect(release).toBeGreaterThan(updateAfterCommit);
    const serverCommitStart = marketServiceSource.indexOf(
      'afterCommitInLock: async (committed) => {',
    );
    const serverCommitEnd = marketServiceSource.indexOf('\n        },\n      }).catch', serverCommitStart);
    const serverCommitBody = marketServiceSource.slice(serverCommitStart, serverCommitEnd);
    expect(serverCommitBody).toContain('this.withCapturedLedgerMutation(ledger, () => {');
    expect(serverCommitBody).not.toContain('requireSameMarketOwner(');
  });

  it('requires the pre-approval session generation when acquiring the mutation lease', () => {
    const captureStart = source.indexOf(
      'function captureGhostMutationOwner(): ActiveAppSession {',
    );
    const captureEnd = source.indexOf('\n}\n', captureStart);
    const captureBody = source.slice(captureStart, captureEnd);
    expect(captureBody).toContain('isAppSessionBoundaryPending()');
    expect(captureBody).toContain('return getActiveAppSession();');
    expect(captureBody).not.toContain('isGhostSkillProjectionBoundaryStableForOwner');

    const leaseStart = source.indexOf(
      'function beginGhostMutation(expectedOwner?: ActiveAppSession): () => void {',
    );
    const leaseEnd = source.indexOf('\n}\n', leaseStart);
    const leaseBody = source.slice(leaseStart, leaseEnd);
    expect(leaseBody).toContain('isAppSessionBoundaryPending()');
    expect(leaseBody).toContain('currentOwner.mode !== expectedOwner.mode');
    expect(leaseBody).toContain('currentOwner.dataOwnerId !== expectedOwner.dataOwnerId');
    expect(leaseBody).toContain('currentOwner.generation !== expectedOwner.generation');
    expect(leaseBody).not.toContain('isGhostSkillProjectionBoundaryStableForOwner');
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

  it('fails owner-scoped plugin reads closed while an account boundary is pending', () => {
    const start = source.indexOf('function availableGhosts(): InstalledGhost[] {');
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);
    expect(body).toContain('if (isAppSessionBoundaryPending()) return [];');
    expect(source).toContain(
      'return availableGhosts().find((ghost) => ghost.manifest.id === id) ?? null;',
    );
    expect(source.match(/getGhost: findAvailableGhost/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain('return findAvailableGhost(id)?.manifest.name ?? null;');
  });

  it('allows explicit local replacement and detaches market routing before landing', () => {
    const updateStart = source.indexOf(
      "ipcMain.handle('ghosts:update'",
    );
    const updateEnd = source.indexOf(
      "ipcMain.handle('ghosts:pick-file'",
      updateStart,
    );
    const updateBody = source.slice(updateStart, updateEnd);
    const helperStart = source.indexOf('async function updateLocalGhostPackageLocked(');
    const helperEnd = source.indexOf(
      '\n}\n\n/**\n * Forge 的显式安装入口。',
      helperStart,
    );
    const helperBody = source.slice(helperStart, helperEnd);

    const ledgerReadIndex = helperBody.indexOf(
      'marketLedger.installationForGhost(inspected.manifest.id)',
    );
    const captureIndex = updateBody.indexOf('const mutationOwner = captureGhostMutationOwner();');
    const inspectIndex = updateBody.indexOf('await manager.inspect(lizFilePath)');
    const leaseIndex = updateBody.indexOf('const releaseMutation = beginGhostMutation(mutationOwner);');
    const helperCallIndex = updateBody.indexOf('updateLocalGhostPackageLocked(');
    const ledgerBindIndex = helperBody.indexOf('const marketLedger = getPluginMarketLedger().bind(');
    const detachDecisionIndex = helperBody.indexOf(
      'const detachMarketRecord = Boolean(marketRecord?.installed)',
    );
    const runtimeStopIndex = helperBody.indexOf('runtime.stop(inspected.manifest.id)');
    const stopAndWaitIndex = helperBody.indexOf(
      'await getGhostNodeRuntimeBroker().stopAndWait(inspected.manifest.id);',
    );
    const oauthLockIndex = helperBody.indexOf(
      'result = await withActiveOwnerGhostOauthMutationLock(inspected.manifest.id',
    );
    const managerUpdateIndex = helperBody.indexOf('manager.update(cindyFilePath,');
    const detachIndex = helperBody.indexOf(
      'marketLedger.markRemoved(inspected.manifest.id, marketInstallSubject)',
    );

    expect(captureIndex).toBeGreaterThan(-1);
    expect(captureIndex).toBeLessThan(inspectIndex);
    expect(leaseIndex).toBeGreaterThan(inspectIndex);
    expect(helperCallIndex).toBeGreaterThan(leaseIndex);
    expect(ledgerBindIndex).toBeGreaterThan(-1);
    expect(runtimeStopIndex).toBeGreaterThan(ledgerBindIndex);
    expect(ledgerReadIndex).toBeGreaterThan(stopAndWaitIndex);
    expect(detachDecisionIndex).toBeGreaterThan(ledgerReadIndex);
    expect(stopAndWaitIndex).toBeGreaterThan(runtimeStopIndex);
    // 只有确认旧进程退出，才切断旧市场的自动更新路由；等待失败时保留原路由，
    // 也不会尝试恢复第二份 resident 进程。
    expect(detachIndex).toBeGreaterThan(stopAndWaitIndex);
    expect(oauthLockIndex).toBeGreaterThan(detachIndex);
    expect(managerUpdateIndex).toBeGreaterThan(oauthLockIndex);
    expect(helperBody).toContain('marketLedger.isDefaultInstallSuppressed(');
    expect(helperBody).toContain('marketLedger.restoreInstallation(');
    expect(helperBody).toContain('suppressed: marketRecordWasSuppressed');
    expect(helperBody).toContain('onPackagePlaced: () => {');
    expect(helperBody).toContain('packagePlaced = true;');
    expect(helperBody).toContain('if (!packagePlaced) {\n      restoreMarketRecord();');
    expect(updateBody).toContain('releaseMutation();');
    expect(helperBody).not.toContain('GHOST_SOURCE_CONFLICT');
  });

  it('runs the final market callback before both initial install and update placement', () => {
    const installStart = source.indexOf(
      'async function installOrUpdateMarketGhostPackageLocked(',
    );
    const installEnd = source.indexOf(
      '\n}\n\ntype GhostUninstallLedgerCompletion',
      installStart,
    );
    const body = source.slice(installStart, installEnd);
    const initialBranch = body.slice(
      body.indexOf('if (!installed) {'),
      body.indexOf('const runtime = getGhostRuntime();'),
    );

    expect(initialBranch.indexOf('expected.beforeCommitInLock?.();')).toBeGreaterThan(-1);
    expect(initialBranch.indexOf('expected.beforeCommitInLock?.();')).toBeLessThan(
      initialBranch.indexOf('await installAndDock('),
    );
    expect(body.match(/expected\.beforeCommitInLock\?\.\(\);/g)).toHaveLength(2);

    const waitIndex = body.indexOf(
      'await getGhostNodeRuntimeBroker().stopAndWait(expected.ghostId);',
    );
    const oauthLockIndex = body.indexOf(
      'await withActiveOwnerGhostOauthMutationLock(expected.ghostId',
    );
    const updateIndex = body.indexOf('manager.update(cindyFilePath,');

    expect(waitIndex).toBeGreaterThan(-1);
    expect(waitIndex).toBeLessThan(oauthLockIndex);
    expect(oauthLockIndex).toBeLessThan(updateIndex);
    const restoreIndex = body.indexOf('spawnIfResident(installed);');
    expect(restoreIndex).toBeGreaterThan(updateIndex);
  });

  it('releases the mutation lease for shutdown failures and restores only after confirmed shutdown', () => {
    const updateStart = source.indexOf("ipcMain.handle('ghosts:update'");
    const updateEnd = source.indexOf("ipcMain.handle('ghosts:pick-file'", updateStart);
    const updateBody = source.slice(updateStart, updateEnd);
    const helperStart = source.indexOf('async function updateLocalGhostPackageLocked(');
    const helperEnd = source.indexOf(
      '\n}\n\n/**\n * Forge 的显式安装入口。',
      helperStart,
    );
    const helperBody = source.slice(helperStart, helperEnd);

    const waitIndex = helperBody.indexOf(
      'await getGhostNodeRuntimeBroker().stopAndWait(inspected.manifest.id);',
    );
    const oauthLockIndex = helperBody.indexOf(
      'result = await withActiveOwnerGhostOauthMutationLock(inspected.manifest.id',
    );
    const updateIndex = helperBody.indexOf('manager.update(cindyFilePath');
    const restoreIndex = helperBody.indexOf(
      'if (previousGhost) spawnIfResident(previousGhost);',
    );

    // stopAndWait must be called before manager.update (safe directory
    // replacement on Windows). The owner lease is outside the per-id lock
    // per the documented invariant (owner lease → per-id lock).
    expect(waitIndex).toBeGreaterThan(-1);
    expect(waitIndex).toBeLessThan(oauthLockIndex);
    expect(oauthLockIndex).toBeLessThan(updateIndex);
    // spawnIfResident is in the market-provenance catch block, after
    // stopAndWait (rollback if provenance check fails).
    expect(restoreIndex).toBeGreaterThan(waitIndex);
    expect(updateBody).toContain('finally {\n      releaseMutation();');
    expect(helperBody).toContain("throwIpcError('INTERNAL', 'Unable to verify the installed Plugin source');");
    expect(helperBody).toContain("throwIpcError('INTERNAL', 'Unable to detach the installed Plugin source');");
  });

  it('Ghost 媒体在途守卫只依赖当前进程的 AppSession owner 边界', () => {
    const helperStart = source.indexOf('function isGhostBoundaryPending(): boolean {');
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = source.indexOf('\n}\n', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain('isAppSessionBoundaryPending()');
    expect(helperBody).not.toContain('isGhostSkillProjectionBoundaryStableForOwner');
    // 两处 Ghost 专属消费点(xAI 通道与 GhostCindySlot)都必须走 helper。
    const injections =
      source.match(/isOwnerBoundaryPending: \(\) => isGhostBoundaryPending\(\)/g)?.length ?? 0;
    expect(injections).toBeGreaterThanOrEqual(2);
  });

  it('Ghost 媒体持久化写入守卫也绑定当前进程的 owner scope', () => {
    // 这两处是 GhostCindySlot 的 deps,内部 assertStillValid 会在 ingestMedia 的
    // await 边界反复断言。持久化写入守卫必须同时检查本进程边界与 scope generation。
    const resolveStart = source.indexOf('resolveOwnedMedia: async (ghostId, hash, ownerScopeKey)');
    const saveStart = source.indexOf('saveGhostMedia: async ({ ghostId, buffer, mimeType, ownerScopeKey');
    expect(resolveStart).toBeGreaterThan(-1);
    expect(saveStart).toBeGreaterThan(-1);
    const resolveBody = source.slice(resolveStart, resolveStart + 700);
    const saveBody = source.slice(saveStart, saveStart + 700);
    const combinedGuard = 'isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey';
    expect(resolveBody).toContain(combinedGuard);
    expect(saveBody).toContain(combinedGuard);
    // generation 不能退化成只看 pending 位。
    expect(source).not.toContain('isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey');
  });

  it('networkSlot 的 saveGhostMedia(as:media fetch 落仓)也绑定本地 owner scope', () => {
    // networkSlot 与 cindy 槽是两个独立实现,签名不带 ownerScopeKey(在函数体开头
    // 捕获)。它的落仓路径(ghost-gallery 作品归属 + recordGhostCallMedia)必须同样
    // 有本地 owner 守卫 + assertStillValid + 补偿 journal,否则账号切换期间的
    // as:'media' fetch 仍可能落仓到错误 owner 的画廊。
    const networkStart = source.indexOf('saveGhostMedia: async ({ ghostId, buffer, mimeType, label, callId }) =>');
    expect(networkStart).toBeGreaterThan(-1);
    const networkBody = source.slice(networkStart, networkStart + 1800);
    expect(networkBody).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(networkBody).toContain('isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey');
    expect(networkBody).toContain('assertStillValid: assertOwnerScopeCurrent');
    expect(networkBody).toContain('refCompensationScope: captureMediaRefCompensationScope(ownerScopeKey)');
  });

  it('depositMedia(ghost-deposit 寄存器落仓)也绑定本地 owner scope', () => {
    // 寄存器引用按 ghostId 落到 owner 作用域账本(originKind:'user' 但 refId 仍是意识),
    // 本进程账号切换时必须 fail closed,与 saveGhostMedia 同口径。
    const depositStart = source.indexOf('depositMedia: async ({ ghostId, buffer, mimeType, label }) =>');
    expect(depositStart).toBeGreaterThan(-1);
    const depositBody = source.slice(depositStart, depositStart + 1800);
    expect(depositBody).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(depositBody).toContain('isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey');
    expect(depositBody).toContain('assertStillValid: assertOwnerScopeCurrent');
    expect(depositBody).toContain('refCompensationScope: captureMediaRefCompensationScope(ownerScopeKey)');
  });
});
