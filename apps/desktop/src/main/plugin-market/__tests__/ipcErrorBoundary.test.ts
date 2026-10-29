import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The IPC registration module imports Electron and the full Ghost host graph,
 * so guard its error-boundary contract using the established main-process
 * source-test pattern.
 */
describe('Plugin Market IPC error boundary', () => {
  const registerSource = readFileSync(
    resolve(process.cwd(), 'src/main/plugin-market/registerIpc.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const serviceSource = readFileSync(
    resolve(process.cwd(), 'src/main/plugin-market/service.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const bootstrapSource = readFileSync(
    resolve(process.cwd(), 'src/main/bootstrap-electron.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const authManagerSource = readFileSync(
    resolve(process.cwd(), 'src/main/authManager.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const ghostPluginPageSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/features/plugin/GhostPluginPage.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('preserves structured errors and normalizes unexpected failures', () => {
    const start = registerSource.indexOf('async function invokePluginMarket');
    const end = registerSource.indexOf('\n}\n\n/** 注册 renderer', start);
    const body = registerSource.slice(start, end);

    expect(body).toContain('if (isIpcError(error)) throw error;');
    expect(body).toContain('isPluginMarketPassthroughErrorCode(error.code)');
    expect(body).toContain("throwIpcError(error.code, 'Plugin market operation failed');");
    expect(body).toContain("throwIpcError('INTERNAL', 'Plugin market operation failed');");
    // Fixed-snapshot detail and install use the same sanitized boundary as the
    // existing twelve market operations; keep all fourteen entry points guarded.
    expect(registerSource.match(/return invokePluginMarket\(/g)?.length).toBe(14);
  });

  it('validates local icon keys with the same reserved-prefix contract as the service', () => {
    const start = registerSource.indexOf("ipcMain.handle('plugin-market:local-icons'");
    const end = registerSource.indexOf("ipcMain.handle(\n    'plugin-market:install'", start);
    const body = registerSource.slice(start, end);

    expect(body).toContain('isPluginMarketCustomIconKey(expectedIconKey)');
    expect(registerSource).toContain('isPluginMarketCustomIconKey,');
    expect(registerSource).toContain("from '../../shared/pluginMarket.js';");
    expect(body).toContain('localIconRequestGate.tryRun');
    expect(body).toContain(
      "throwIpcError('PRECONDITION_FAILED', 'Too many local Plugin icon requests');",
    );
  });

  it('forwards the validated selected-manifest facts without a compatibility override', () => {
    const start = registerSource.indexOf("ipcMain.handle(\n    'plugin-market:install'");
    const end = registerSource.indexOf("ipcMain.handle('plugin-market:uninstall'", start);
    const body = registerSource.slice(start, end);

    expect(body).not.toContain('allowHostIncompatible');
    expect(body).toContain('requireObject(obj.expectedManifest)');
    expect(body).toContain('...(expectedManifest !== undefined ? { expectedManifest } : {})');
  });

  it('guards removal notice consumption and signals trusted app windows only', () => {
    const consumeStart = registerSource.indexOf(
      "ipcMain.handle('plugin-market:consume-removal-notice'",
    );
    const consumeEnd = registerSource.indexOf("ipcMain.handle('plugin-market:detail'", consumeStart);
    const consumeBody = registerSource.slice(consumeStart, consumeEnd);
    expect(consumeBody).toContain('assertTrustedAppRendererEvent(event);');
    expect(consumeBody).toContain('service().consumeRemovalNotice()');

    const signalStart = registerSource.indexOf('function signalRemovalNoticeAvailable()');
    const signalEnd = registerSource.indexOf('\n}\n', signalStart);
    const signalBody = registerSource.slice(signalStart, signalEnd);
    // 出站广播必须走共享的可信窗口收口(isDestroyed + isTrustedAppRendererWindow
    // 判据都在 helper 里),不允许退回手写 getAllWindows 循环。
    expect(signalBody).toContain('sendToTrustedAppWindows(REMOVAL_NOTICE_AVAILABLE_CHANNEL');
    expect(signalBody).not.toContain('getAllWindows');
  });

  it('refuses renderer-supplied local paths and only grants them via the picker', () => {
    // 本地目录授权边界:Renderer 直传绝对路径不构成授权,必须由 Main 原生
    // 目录选择器签发(用户的选择即授权)。此断言防止有人退回"直传即添加"。
    expect(registerSource).toContain("parsed.source.type === 'local'");
    expect(registerSource).toContain('Local folders must be added via the directory picker');
    expect(registerSource).toContain("ipcMain.handle('plugin-market:pick-local-source'");
    expect(serviceSource).toContain('addLocalSourceFromPicker');
    expect(serviceSource).toContain("properties: ['openDirectory']");
  });

  it('does not throw user-visible plain errors from the market service', () => {
    expect(serviceSource).not.toContain('throw new Error(');
    expect(serviceSource).toContain("throwIpcError('PRECONDITION_FAILED'");
    expect(serviceSource).toContain("throwIpcError('PERMISSION_DENIED'");
  });

  it('runs plugin reconciliation on cold start, foreground, resume and stable owner changes', () => {
    const syncStart = registerSource.indexOf(
      'export async function syncDefaultMarketPlugins(',
    );
    const syncEnd = registerSource.indexOf('\n}\n\n/**\n * Preserve stable IPC errors', syncStart);
    const syncBody = registerSource.slice(syncStart, syncEnd);
    expect(syncBody).toContain('const snapshot = await snapshotAndSignalRemovalNotice({');
    expect(syncBody).toContain('onDefaultReconciliationOutcome: (outcome) => {');
    expect(syncBody).toContain("reconciliationOutcome ?? 'completed'");
    expect(syncBody).toContain('defaultMarketPluginSyncOutcome(');
    expect(syncBody).toContain("log.warn('default plugin startup sync incomplete'");
    expect(syncBody).toContain("return 'failed';");

    const outcomeStart = registerSource.indexOf(
      'export function defaultMarketPluginSyncOutcome(',
    );
    const outcomeEnd = registerSource.indexOf('\n}\n\nexport async function syncDefaultMarketPlugins', outcomeStart);
    const outcomeBody = registerSource.slice(outcomeStart, outcomeEnd);
    expect(outcomeBody).toContain("snapshot.unavailableReason === 'not-configured'");
    expect(outcomeBody).toContain("snapshot.unavailableReason === 'session-switching'");
    expect(outcomeBody).toContain("snapshot.unavailableReason === 'authentication-required'");
    expect(outcomeBody).toContain("return 'deferred';");
    expect(outcomeBody).toContain("return 'failed';");

    const snapshotStart = registerSource.indexOf(
      'async function snapshotAndSignalRemovalNotice(options?: PluginMarketSnapshotOptions)',
    );
    const snapshotEnd = registerSource.indexOf('\n}\n\n/**', snapshotStart);
    const snapshotBody = registerSource.slice(snapshotStart, snapshotEnd);
    expect(snapshotBody).toContain('finally {');
    expect(snapshotBody).toContain('signalRemovalNoticeAvailable();');

    expect(serviceSource).toContain("onDefaultReconciliationOutcome?: (outcome: 'completed' | 'failed') => void;");
    expect(serviceSource).toContain("const outcome = completed ? 'completed' : 'failed';");
    expect(serviceSource).toContain('options.onDefaultReconciliationOutcome?.(outcome);');
    expect(serviceSource).toContain(
      'await this.applyDefaultInstalls(plugins, currentOrganization, owner, ledger, refresh)',
    );
    expect(serviceSource).toContain('await this.applyAutomaticUpgrades(plugins, customDiscovery.entries, owner, ledger, refresh)');
    expect(serviceSource).toContain('if (error instanceof SilentUpgradeBusyError) {');

    // Capability boundary: catalog readers cannot initiate install/update/removal maintenance.
    expect(registerSource).toContain('discoveryOnly: true');
    expect(registerSource).toContain('plugin-market:update-consent-holds-changed');
    expect(registerSource).toContain('onConsentHoldsChanged:');
    expect(ghostPluginPageSource).toContain('const installedGhostMarketKey = useMemo(');
    expect(ghostPluginPageSource).toContain('void refreshMarket(true).catch(() => undefined);');
    expect(ghostPluginPageSource).toContain('onUpdateConsentHoldsChanged');

    const ownerTaskStart = bootstrapSource.indexOf(
      'authManager.setStableOwnerPostCommitTask(async ({ reason, scopeKey, dataOwnerId }) => {',
    );
    const ownerTaskEnd = bootstrapSource.indexOf('\n});', ownerTaskStart);
    const ownerTaskBody = bootstrapSource.slice(ownerTaskStart, ownerTaskEnd);
    expect(ownerTaskStart).toBeGreaterThan(-1);
    expect(ownerTaskBody).toContain(
      'await runStableOwnerPostCommitTask(reason, { scopeKey, dataOwnerId })',
    );
    expect(ownerTaskBody).toContain("if (builtinOutcome === 'deferred') return builtinOutcome;");
    expect(ownerTaskBody).toContain(
      "if (dataOwnerId === null) return needsRetry ? 'failed' : 'completed';",
    );
    expect(ownerTaskBody.indexOf('dataOwnerId === null')).toBeLessThan(
      ownerTaskBody.indexOf("syncDefaultMarketPlugins('owner-ready')"),
    );
    expect(ownerTaskBody).not.toContain("builtinOutcome === 'failed') return builtinOutcome");
    expect(ownerTaskBody).toContain("outcome === 'retry-pending' ? 'failed' : outcome");
    expect(ownerTaskBody).toContain("builtinOutcome === 'failed'");
    expect(ownerTaskBody).toContain('const marketOutcome = await marketPostCommitStep.run(');
    expect(ownerTaskBody).toContain("return syncDefaultMarketPlugins('owner-ready');");
    expect(ownerTaskBody).toContain("marketOutcome === 'failed'");
    expect(ownerTaskBody).toContain("marketOutcome === 'deferred'");
    expect(ownerTaskBody).toContain('await reconcileGhostOauthAccountsForActiveOwner()');
    expect(ownerTaskBody).toContain(
      "return needsRetry ? 'failed' : deferred ? 'deferred' : 'completed';",
    );
    expect(bootstrapSource).toContain(
      "authManager.requestStableOwnerPostCommit('auth-initialize');",
    );
    expect(authManagerSource).toContain("requestStableOwnerPostCommit('owner-commit');");
    expect(authManagerSource).not.toContain("await ensureStableOwnerPostCommit('owner-commit');");
    expect(bootstrapSource).not.toContain('disposePluginMarketAuthListener');
    expect(bootstrapSource).not.toContain('syncDefaultPluginsForActiveOwner');

    const ownerSyncStart = bootstrapSource.indexOf(
      'function syncPluginMarketForActiveOwner(',
    );
    const ownerSyncEnd = bootstrapSource.indexOf('\n}\n\nfunction parseOptionalDeviceLinkDeviceId', ownerSyncStart);
    const ownerSyncBody = bootstrapSource.slice(ownerSyncStart, ownerSyncEnd);
    expect(ownerSyncBody).toContain(
      'if (!session.dataOwnerId || isAppSessionBoundaryPending()) return;',
    );
    expect(ownerSyncBody).toContain('if (scope === pluginMarketSyncInFlightScope) return;');
    expect(ownerSyncBody).toContain('void marketPostCommitStep.run(scope,');
    expect(ownerSyncBody).toContain('pluginMarketSyncInFlightScope = null;');
    expect(bootstrapSource).toContain('PLUGIN_MARKET_PERIODIC_SYNC_MS = 30 * 60 * 1000');
    expect(bootstrapSource).toContain("syncPluginMarketForActiveOwner(30_000, 'resume');");
  });
});

// All production cache deletions must pass the lease boundary. Keep this
// cross-file contract in guard; cacheLease runtime behavior remains in unit.
describe('缓存删除收口(结构门禁)', () => {
  const sourcesDir = resolve(
    __dirname,
    '..',
    'sources',
  );
  // 容忍链式换行(fs.promises\n.rm(…)):否则漏数 cacheLease/git 的真实删除点。
  const countRawDeletions = (file: string): number =>
    [
      ...readFileSync(resolve(sourcesDir, file), 'utf8')
        .matchAll(/fs\s*\.\s*(?:promises\s*\.\s*)?rm(?:Sync|dir)?\s*\(/g),
    ].length;

  // 门禁扩到整个 sources/,而不只 index.ts:任一 lease 管理的文件新增直接删除点
  // 就是又一个绕过租约守卫的口子——这正是此前每一轮返工的形态。
  it.each(['index.ts', 'store.ts', 'discover.ts', 'parse.ts', 'preflight.ts'])(
    'sources/%s never deletes filesystem paths directly',
    (file) => {
      expect(countRawDeletions(file)).toBe(0);
    },
  );

  it('git.ts only deletes its own private clone staging, nothing else', () => {
    // git.ts 的唯一直接删除是它自己 clone 出的 `<dest>.staging-<uuid>` 私有目录
    // (UUID 私有、同函数内建同函数内删、从不被租约持有),是经过审阅的例外。
    // 断言"只删 stagingPath":出现任何删别的路径的调用都要重新确认边界。
    const git = readFileSync(resolve(sourcesDir, 'git.ts'), 'utf8');
    const deletions = [...git.matchAll(/\.\s*rm(?:Sync|dir)?\s*\(\s*([A-Za-z]+)/g)].map((m) => m[1]);
    expect(deletions).toEqual(['stagingPath']);
  });
});
