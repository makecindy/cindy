import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GHOST_MANIFEST_SCHEMA_VERSION, parseGetPluginResponse } from '@cindy/plugin-protocol';
import { describe, expect, it } from 'vitest';

import {
  isPluginHostUnsupportedError,
  isPluginManifestIncompatibilityError,
} from '../protocolErrors';

function parserError(parse: () => unknown): unknown {
  try {
    parse();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the protocol parser to reject the response');
}

function invalidManifestResponse(
  manifestSchemaVersion: unknown = GHOST_MANIFEST_SCHEMA_VERSION,
  manifestOverrides: Record<string, unknown> = {},
  omitSchemaVersion = false,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    schemaVersion: manifestSchemaVersion,
    id: 'acme-helper',
    name: 'Acme Helper',
    version: '1.0.0',
    kind: 'chip',
    entry: 'index.js',
    slots: ['tool'],
    tools: 'not an array',
    ...manifestOverrides,
  };
  if (omitSchemaVersion) delete manifest.schemaVersion;

  return {
    schemaVersion: GHOST_MANIFEST_SCHEMA_VERSION,
    plugin: {
      id: `c${'a'.repeat(24)}`,
      ghostId: 'acme-helper',
      name: 'Acme Helper',
      description: null,
      author: null,
      scope: 'public',
      organizationId: null,
      defaultInstall: false,
      currentRelease: {
        id: 'release-1',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
        publishedAt: '2026-07-23T00:00:00.000Z',
        manifest,
      },
    },
  };
}

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
    expect(body).toContain('isPluginManifestIncompatibilityError(error)');
    expect(body).toContain("throwIpcError('GHOST_FILE_INVALID', 'This Plugin manifest is not supported');");
    expect(body).toContain("throwIpcError('INTERNAL', 'Plugin market operation failed');");
    expect(registerSource.match(/return invokePluginMarket\(/g)?.length).toBe(13);
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

  it.each([
    {
      label: 'an ordinary malformed manifest',
      response: invalidManifestResponse(),
      hostUnsupported: false,
      manifestIncompatible: true,
    },
    {
      label: 'a future schema version',
      response: invalidManifestResponse(GHOST_MANIFEST_SCHEMA_VERSION + 1),
      hostUnsupported: true,
      manifestIncompatible: false,
    },
    {
      label: 'a much newer schema version',
      response: invalidManifestResponse(99),
      hostUnsupported: true,
      manifestIncompatible: false,
    },
    {
      label: 'the legacy schema version',
      response: invalidManifestResponse(1),
      hostUnsupported: false,
      manifestIncompatible: true,
    },
    {
      label: 'a missing schema version',
      response: invalidManifestResponse(GHOST_MANIFEST_SCHEMA_VERSION, {}, true),
      hostUnsupported: false,
      manifestIncompatible: true,
    },
    {
      label: 'a non-numeric schema version',
      response: invalidManifestResponse(GHOST_MANIFEST_SCHEMA_VERSION, {
        schemaVersion: '3',
      }),
      hostUnsupported: false,
      manifestIncompatible: true,
    },
    {
      label: 'a fractional future schema version',
      response: invalidManifestResponse(GHOST_MANIFEST_SCHEMA_VERSION, {
        schemaVersion: GHOST_MANIFEST_SCHEMA_VERSION + 0.5,
      }),
      hostUnsupported: false,
      manifestIncompatible: true,
    },
    {
      label: 'an unknown string slot in an otherwise valid manifest',
      response: invalidManifestResponse(GHOST_MANIFEST_SCHEMA_VERSION, {
        slots: ['future-capability'],
        // 声明了未知卡槽时不再声明 tool 槽相关字段,保证除此之外清单结构合法。
        tools: undefined,
      }),
      hostUnsupported: true,
      manifestIncompatible: false,
    },
    {
      label: 'a duplicated unknown string slot',
      // 同一个未知 slot 出现两次:新 Host 识别后仍会因重复声明而拒包,所以不该
      // 提示升级,应判为包本身无效(GHOST_FILE_INVALID)。
      response: invalidManifestResponse(GHOST_MANIFEST_SCHEMA_VERSION, {
        slots: ['future-capability', 'future-capability'],
        tools: undefined,
      }),
      hostUnsupported: false,
      manifestIncompatible: true,
    },
    {
      label: 'an unknown string slot alongside another malformed field',
      // slots 的未知字符串项本可提示升级,但 tools 字段也畸形——包本身有问题,
      // 必须报文件无效而非让用户升级 Cindy(其余字段先校验,错误不被升级提示掩盖)。
      response: invalidManifestResponse(GHOST_MANIFEST_SCHEMA_VERSION, {
        slots: ['future-capability'],
      }),
      hostUnsupported: false,
      manifestIncompatible: true,
    },
    {
      label: 'a numeric slot',
      response: invalidManifestResponse(GHOST_MANIFEST_SCHEMA_VERSION, {
        slots: [42],
      }),
      hostUnsupported: false,
      manifestIncompatible: true,
    },
    {
      label: 'a null slot',
      response: invalidManifestResponse(GHOST_MANIFEST_SCHEMA_VERSION, {
        slots: [null],
      }),
      hostUnsupported: false,
      manifestIncompatible: true,
    },
  ])(
    'classifies $label without widening the compatibility boundary',
    ({ response, hostUnsupported, manifestIncompatible }) => {
      const error = parserError(() => parseGetPluginResponse(response));

      expect(isPluginHostUnsupportedError(error)).toBe(hostUnsupported);
      expect(isPluginManifestIncompatibilityError(error)).toBe(manifestIncompatible);
    },
  );

  it('does not classify unrelated protocol or network failures as manifest errors', () => {
    expect(isPluginHostUnsupportedError(new Error('network failed'))).toBe(false);
    expect(isPluginManifestIncompatibilityError(new Error('network failed'))).toBe(false);
    expect(
      isPluginHostUnsupportedError(
        Object.assign(new Error('plugin.currentRelease.manifest is missing'), {
          name: 'PluginProtocolError',
        }),
      ),
    ).toBe(false);
  });

  // Non-parse protocol errors whose message merely mentions currentRelease.manifest
  // (oidc scope mismatch, name/description/author consistency) are envelope-level
  // failures, not a bad package. They must stay INTERNAL rather than being mapped
  // to GHOST_FILE_INVALID by the broad `.includes('currentRelease.manifest')` match.
  it.each([
    'response.plugin.currentRelease.manifest 的 oidc-token 仅允许 organization scope',
    'response.plugin.name 与 currentRelease.manifest.name 不一致',
    'response.plugin.description 与 currentRelease.manifest.description 不一致',
    'response.plugin.author 与 currentRelease.manifest.author 不一致',
    'response.plugin.currentRelease.manifest.id 与 ghostId 不一致',
  ])('does not map non-parse protocol error %j to a manifest/package failure', (message) => {
    const error = Object.assign(new Error(message), { name: 'PluginProtocolError' });
    expect(isPluginHostUnsupportedError(error)).toBe(false);
    expect(isPluginManifestIncompatibilityError(error)).toBe(false);
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
      'export async function syncDefaultMarketPlugins(): Promise<DefaultMarketPluginSyncOutcome>',
    );
    const syncEnd = registerSource.indexOf('\n}\n\n/**\n * Preserve stable IPC errors', syncStart);
    const syncBody = registerSource.slice(syncStart, syncEnd);
    expect(syncBody).toContain('const snapshot = await snapshotAndSignalRemovalNotice({');
    expect(syncBody).toContain('onDefaultReconciliationOutcome: (outcome) => {');
    expect(syncBody).toContain("reconciliationOutcome ?? 'completed'");
    expect(syncBody).toContain('defaultMarketPluginSyncOutcome(');
    expect(syncBody).toContain("log.warn('default plugin startup sync failed'");
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
    expect(snapshotBody).toContain('signalUpgradeNoticeAvailable();');

    expect(serviceSource).toContain("onDefaultReconciliationOutcome?: (outcome: 'completed' | 'failed') => void;");
    expect(serviceSource).toContain("const outcome = completed ? 'completed' : 'failed';");
    expect(serviceSource).toContain('options.onDefaultReconciliationOutcome?.(outcome);');
    expect(serviceSource).toContain('if (!(await this.applyDefaultInstalls(plugins, owner, ledger))) completed = false;');
    expect(serviceSource).toContain('if (!(await this.applyDefaultUpgrades(plugins, owner, ledger))) completed = false;');
    expect(serviceSource).toContain('if (error instanceof SilentUpgradeBusyError) {');

    expect(registerSource).toContain('deferDefaultReconciliation: true');
    expect(registerSource).toContain('onDeferredReconciliationSettled: () => {');
    expect(ghostPluginPageSource).toContain(
      'window.electronAPI.pluginMarket.onUpgradeNoticeAvailable(() => {',
    );
    expect(ghostPluginPageSource).toContain('void refreshMarket(true).catch(() => undefined);');

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
      ownerTaskBody.indexOf('syncDefaultMarketPlugins()'),
    );
    expect(ownerTaskBody).not.toContain("builtinOutcome === 'failed') return builtinOutcome");
    expect(ownerTaskBody).toContain("builtinOutcome === 'retry-pending'");
    expect(ownerTaskBody).toContain("builtinOutcome === 'failed'");
    expect(ownerTaskBody).toContain('const marketOutcome = await syncDefaultMarketPlugins()');
    expect(ownerTaskBody).toContain("marketOutcome === 'failed'");
    expect(ownerTaskBody).toContain("marketOutcome === 'deferred'");
    expect(ownerTaskBody).toContain('await reconcileGhostOauthAccountsForActiveOwner()');
    expect(ownerTaskBody).toContain(
      "return needsRetry ? 'failed' : deferred ? 'deferred' : 'completed';",
    );
    expect(bootstrapSource).toContain(
      "await authManager.ensureStableOwnerPostCommitTasks('auth-initialize');",
    );
    expect(authManagerSource).toContain("requestStableOwnerPostCommit('owner-commit');");
    expect(authManagerSource).not.toContain("await ensureStableOwnerPostCommit('owner-commit');");
    expect(bootstrapSource).not.toContain('disposePluginMarketAuthListener');
    expect(bootstrapSource).not.toContain('syncDefaultPluginsForActiveOwner');
  });
});
