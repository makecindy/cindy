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
  const ghostPluginPageSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/features/plugin/GhostPluginPage.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('preserves structured errors and normalizes unexpected failures', () => {
    const start = registerSource.indexOf('async function invokePluginMarket');
    const end = registerSource.indexOf('\n}\n\n/** 注册 renderer', start);
    const body = registerSource.slice(start, end);

    expect(body).toContain('if (isIpcError(error)) throw error;');
    expect(body).toContain("throwIpcError('INTERNAL', 'Plugin market operation failed');");
    expect(registerSource.match(/return invokePluginMarket\(/g)?.length).toBe(13);
  });

  it('validates local icon keys with the same reserved-prefix contract as the service', () => {
    const start = registerSource.indexOf("ipcMain.handle('plugin-market:local-icons'");
    const end = registerSource.indexOf("ipcMain.handle(\n    'plugin-market:install'", start);
    const body = registerSource.slice(start, end);

    expect(body).toContain('isPluginMarketCustomIconKey(expectedIconKey)');
    expect(registerSource).toContain(
      "import { isPluginMarketCustomIconKey } from '../../shared/pluginMarket.js';",
    );
    expect(body).toContain('localIconRequestGate.tryRun');
    expect(body).toContain(
      "throwIpcError('PRECONDITION_FAILED', 'Too many local Plugin icon requests');",
    );
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

  it('runs default plugin reconciliation on cold start and stable owner changes', () => {
    const syncStart = registerSource.indexOf(
      'export async function syncDefaultMarketPlugins(): Promise<void>',
    );
    const syncEnd = registerSource.indexOf('\n}\n\n/**\n * Preserve stable IPC errors', syncStart);
    const syncBody = registerSource.slice(syncStart, syncEnd);
    expect(syncBody).toContain('await snapshotAndSignalRemovalNotice();');
    expect(syncBody).toContain("log.warn('default plugin startup sync failed'");

    const snapshotStart = registerSource.indexOf(
      'async function snapshotAndSignalRemovalNotice(options?: PluginMarketSnapshotOptions)',
    );
    const snapshotEnd = registerSource.indexOf('\n}\n\n/**', snapshotStart);
    const snapshotBody = registerSource.slice(snapshotStart, snapshotEnd);
    expect(snapshotBody).toContain('finally {');
    expect(snapshotBody).toContain('signalRemovalNoticeAvailable();');
    expect(snapshotBody).toContain('signalUpgradeNoticeAvailable();');

    expect(registerSource).toContain('deferDefaultReconciliation: true');
    expect(registerSource).toContain('onDeferredReconciliationSettled: () => {');
    expect(ghostPluginPageSource).toContain(
      'window.electronAPI.pluginMarket.onUpgradeNoticeAvailable(() => {',
    );
    expect(ghostPluginPageSource).toContain('void refreshMarket(true).catch(() => undefined);');

    const ownerSyncStart = bootstrapSource.indexOf(
      'function syncDefaultPluginsForActiveOwner(): void',
    );
    const ownerSyncEnd = bootstrapSource.indexOf('\n}\n\nconst registerIpcHandlers', ownerSyncStart);
    const ownerSyncBody = bootstrapSource.slice(ownerSyncStart, ownerSyncEnd);
    expect(ownerSyncBody).toContain(
      'if (!session.dataOwnerId || isAppSessionBoundaryPending()) return;',
    );
    expect(ownerSyncBody).toContain('if (scope === defaultPluginSyncInFlightScope) return;');
    expect(ownerSyncBody).toContain('void syncDefaultMarketPlugins().finally(() => {');
    expect(ownerSyncBody).toContain('defaultPluginSyncInFlightScope = null;');

    const listenerStart = bootstrapSource.indexOf(
      'disposePluginMarketAuthListener = authManager.onAuthStateChange',
    );
    expect(listenerStart).toBeGreaterThan(-1);
    expect(
      bootstrapSource.indexOf(
        'queueMicrotask(syncDefaultPluginsForActiveOwner);',
        listenerStart,
      ),
    ).toBeGreaterThan(listenerStart);
    expect(bootstrapSource).toContain("'plugin-market-auth-listener'");
  });
});
