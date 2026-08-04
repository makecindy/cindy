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

  it('preserves structured errors and normalizes unexpected failures', () => {
    const start = registerSource.indexOf('async function invokePluginMarket');
    const end = registerSource.indexOf('\n}\n\n/** 注册 renderer', start);
    const body = registerSource.slice(start, end);

    expect(body).toContain('if (isIpcError(error)) throw error;');
    expect(body).toContain("throwIpcError('INTERNAL', 'Plugin market operation failed');");
    expect(registerSource.match(/return invokePluginMarket\(/g)?.length).toBe(10);
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
    expect(syncBody).toContain('await service().snapshot();');
    expect(syncBody).toContain("log.warn('default plugin startup sync failed'");

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
