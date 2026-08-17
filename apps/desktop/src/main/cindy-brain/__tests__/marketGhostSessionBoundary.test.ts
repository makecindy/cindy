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
    expect(captureBody).toContain('const owner = getActiveAppSession();');
    expect(captureBody).toContain('isGhostSkillProjectionBoundaryStableForOwner(owner.dataOwnerId)');

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
    const body = source.slice(updateStart, updateEnd);

    const ledgerReadIndex = body.indexOf(
      'marketLedger.installationForGhost(inspected.manifest.id)',
    );
    const captureIndex = body.indexOf('const mutationOwner = captureGhostMutationOwner();');
    const ledgerBindIndex = body.indexOf('const marketLedger = getPluginMarketLedger().bind(');
    const inspectIndex = body.indexOf('await manager.inspect(lizFilePath)');
    const leaseIndex = body.indexOf('const releaseMutation = beginGhostMutation(mutationOwner);');
    const detachDecisionIndex = body.indexOf(
      'const detachMarketRecord = Boolean(marketRecord?.installed)',
    );
    const runtimeStopIndex = body.indexOf('runtime.stop(inspected.manifest.id)');
    const stopAndWaitIndex = body.indexOf(
      'await getGhostNodeRuntimeBroker().stopAndWait(inspected.manifest.id);',
    );
    const oauthLockIndex = body.indexOf(
      'result = await withActiveOwnerGhostOauthMutationLock(inspected.manifest.id',
    );
    const managerUpdateIndex = body.indexOf('manager.update(lizFilePath,');
    const detachIndex = body.indexOf(
      'marketLedger.markRemoved(inspected.manifest.id, marketInstallSubject)',
    );

    expect(captureIndex).toBeGreaterThan(-1);
    expect(ledgerBindIndex).toBeGreaterThan(captureIndex);
    expect(ledgerBindIndex).toBeLessThan(inspectIndex);
    expect(leaseIndex).toBeGreaterThan(inspectIndex);
    expect(ledgerReadIndex).toBeGreaterThan(leaseIndex);
    expect(detachDecisionIndex).toBeGreaterThan(ledgerReadIndex);
    expect(runtimeStopIndex).toBeGreaterThan(leaseIndex);
    expect(stopAndWaitIndex).toBeGreaterThan(runtimeStopIndex);
    // 只有确认旧进程退出，才切断旧市场的自动更新路由；等待失败时保留原路由，
    // 也不会尝试恢复第二份 resident 进程。
    expect(detachIndex).toBeGreaterThan(stopAndWaitIndex);
    expect(oauthLockIndex).toBeGreaterThan(detachIndex);
    expect(managerUpdateIndex).toBeGreaterThan(oauthLockIndex);
    expect(body).toContain('marketLedger.isDefaultInstallSuppressed(');
    expect(body).toContain('marketLedger.restoreInstallation(');
    expect(body).toContain('suppressed: marketRecordWasSuppressed');
    expect(body).toContain('onPackagePlaced: () => {');
    expect(body).toContain('packagePlaced = true;');
    expect(body).toContain('if (!packagePlaced) {\n            restoreMarketRecord();');
    expect(body).toContain('releaseMutation();');
    expect(body).not.toContain('GHOST_SOURCE_CONFLICT');
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
      initialBranch.indexOf('return installAndDock('),
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
    const body = source.slice(updateStart, updateEnd);

    const waitIndex = body.indexOf(
      'await getGhostNodeRuntimeBroker().stopAndWait(inspected.manifest.id);',
    );
    const oauthLockIndex = body.indexOf(
      'result = await withActiveOwnerGhostOauthMutationLock(inspected.manifest.id',
    );
    const updateIndex = body.indexOf('manager.update(lizFilePath');
    const restoreIndex = body.indexOf(
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
    expect(body).toContain('finally {\n      releaseMutation();');
    expect(body).toContain("throwIpcError('INTERNAL', 'Unable to verify the installed Plugin source');");
    expect(body).toContain("throwIpcError('INTERNAL', 'Unable to detach the installed Plugin source');");
  });

  it('Ghost 媒体在途守卫注入 durable owner 组合条件,而不是退化成只看进程内边界', () => {
    const helperStart = source.indexOf('function isGhostBoundaryPending(): boolean {');
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = source.indexOf('\n}\n', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    // helper 必须是组合条件:进程内 App boundary + durable projection owner 稳定性。
    expect(helperBody).toContain('isAppSessionBoundaryPending()');
    expect(helperBody).toContain('isGhostSkillProjectionBoundaryStableForOwner');
    // 两处 Ghost 专属消费点(xAI 通道与 GhostCindySlot)都必须走 helper。
    const injections =
      source.match(/isOwnerBoundaryPending: \(\) => isGhostBoundaryPending\(\)/g)?.length ?? 0;
    expect(injections).toBeGreaterThanOrEqual(2);
  });

  it('Ghost 媒体持久化写入守卫(resolveOwnedMedia/saveGhostMedia)也用 durable owner 组合条件', () => {
    // 这两处是 GhostCindySlot 的 deps,内部 assertStillValid 会在 ingestMedia 的
    // await 边界反复断言。持久化写入守卫必须和入口/生成守卫一样用 isGhostBoundaryPending,
    // 否则另一实例在落盘窗口翻转 durable owner 时,字节仍会被登记为 ghost-gallery ref。
    const resolveStart = source.indexOf('resolveOwnedMedia: async (ghostId, hash, ownerScopeKey)');
    const saveStart = source.indexOf('saveGhostMedia: async ({ ghostId, buffer, mimeType, ownerScopeKey');
    expect(resolveStart).toBeGreaterThan(-1);
    expect(saveStart).toBeGreaterThan(-1);
    const resolveBody = source.slice(resolveStart, resolveStart + 700);
    const saveBody = source.slice(saveStart, saveStart + 700);
    const combinedGuard = 'isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey';
    expect(resolveBody).toContain(combinedGuard);
    expect(saveBody).toContain(combinedGuard);
    // 持久化守卫不得退化回只看进程内边界的旧写法。
    expect(source).not.toContain('isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey');
  });

  it('networkSlot 的 saveGhostMedia(as:media fetch 落仓)也用 durable owner 组合条件', () => {
    // networkSlot 与 cindy 槽是两个独立实现,签名不带 ownerScopeKey(在函数体开头
    // 捕获)。它的落仓路径(ghost-gallery 作品归属 + recordGhostCallMedia)必须同样
    // 有 durable owner 守卫 + assertStillValid + 补偿 journal,否则 as:'media' fetch
    // 读取窗口内 durable owner 翻转时仍会落仓到错误 owner 的画廊。
    const networkStart = source.indexOf('saveGhostMedia: async ({ ghostId, buffer, mimeType, label, callId }) =>');
    expect(networkStart).toBeGreaterThan(-1);
    const networkBody = source.slice(networkStart, networkStart + 1800);
    expect(networkBody).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(networkBody).toContain('isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey');
    expect(networkBody).toContain('assertStillValid: assertOwnerScopeCurrent');
    expect(networkBody).toContain('refCompensationScope: captureMediaRefCompensationScope(ownerScopeKey)');
  });

  it('depositMedia(ghost-deposit 寄存器落仓)也用 durable owner 组合条件', () => {
    // 寄存器引用按 ghostId 落到 owner 作用域账本(originKind:'user' 但 refId 仍是意识),
    // 落仓窗口翻转全局 owner 时必须 fail closed,与 saveGhostMedia 同口径。
    const depositStart = source.indexOf('depositMedia: async ({ ghostId, buffer, mimeType, label }) =>');
    expect(depositStart).toBeGreaterThan(-1);
    const depositBody = source.slice(depositStart, depositStart + 1800);
    expect(depositBody).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(depositBody).toContain('isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey');
    expect(depositBody).toContain('assertStillValid: assertOwnerScopeCurrent');
    expect(depositBody).toContain('refCompensationScope: captureMediaRefCompensationScope(ownerScopeKey)');
  });
});
