import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRemoteAuxiliaryModelRef } from '../../../shared/remoteAuxiliaryModelRef.js';

const remoteMocks = vi.hoisted(() => ({ caps: vi.fn(), read: vi.fn(), state: vi.fn(), write: vi.fn(), handle: vi.fn(), owner: vi.fn(() => 'owner') }));
vi.mock('../../app-settings/runtime.js', () => ({ registerRuntimeSettingsSection: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: remoteMocks.owner, isAppSessionBoundaryPending: () => false }));

import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { ipcMain } from 'electron';
import { notifyAppSettingsChanged } from '../../app-settings/changes.js';
import { getDesktopSelectableCatalog } from '../../maker-host/createDesktopProviderService.js';
import { readAuxiliaryModelSettings, readAuxiliaryModelSettingsState, writeAuxiliaryModelSettingsPatch } from '../../utility-model/auxiliary-model-settings-store.js';
import { reportAuxiliaryChainOutcome } from '../../utility-model/auxiliaryChainOutcomeSink.js';
import { hasOneshotProviderCredential } from '../../utility-model/oneshotProviderUsability.js';
import { MAKER_INVOKE } from '../channels.js';

vi.mock('../../app-settings/changes.js', () => ({ notifyAppSettingsChanged: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopSelectableCatalog: vi.fn(() => ({ providers: [] })),
}));

vi.mock('../../cindyAiProviderName.js', () => ({ getCindyAiProviderName: () => 'Cindy AI · 心动' }));

vi.mock('electron', () => ({
  ipcMain: { handle: remoteMocks.handle },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: [] }),
  isXdGatewayPaymentRequiredRoute: () => false,
}));

vi.mock('../../maker-host/model-disable-store.js', () => ({
  readModelDisableOverrides: () => ({ disabledModels: {}, disabledProviders: {} }),
}));

vi.mock('../../maker-host/provider-order-store.js', () => ({
  readProviderOrder: () => [],
}));

vi.mock('../../utility-model/auxiliary-model-settings-store.js', () => ({
  readAuxiliaryModelSettings: remoteMocks.read,
  readAuxiliaryModelSettingsState: remoteMocks.state,
  writeAuxiliaryModelSettingsPatch: remoteMocks.write,
}));

vi.mock('../../utility-model/oneshotProviderUsability.js', () => ({
  hasOneshotProviderCredential: vi.fn(() => false),
}));

vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  isUtilityRouteDisabled: () => false,
  isUtilityRoutePaymentRequired: () => false,
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

import {
  buildAuxiliaryModelOptions,
  parseAuxiliaryModelSettingsPatch,
  registerAuxiliaryModelSettingsIpc,
} from '../auxiliary-model-settings.js';
import { setRemoteUtilityTextClient } from '../../utility-model/remote/registry.js';

const PIN = 'cat:openrouter:codex:openai/gpt-5-mini';
const PROFILE = 'codex-gpt-5.4-mini';

function catalog() {
  return {
    providers: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {
          codex: {
            upstream: 'https://openrouter.example/v1',
            authStrategy: 'api-key-header',
            wireProtocol: 'openai-chat',
          },
        },
        models: {
          codex: [
            {
              id: 'openai/gpt-5-mini',
              name: 'GPT 5 mini',
              contextWindow: 100_000,
              group: 'custom:openrouter',
            },
          ],
        },
      },
    ],
  } as never;
}

function builtinCodexCatalog() {
  return {
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'builtin',
        agents: ['codex'],
        auth: { method: 'oauth' },
        routing: {
          codex: {
            upstream: 'https://openai.example/v1',
            authStrategy: 'oauth-passthrough',
          },
        },
        models: { codex: [] },
      },
    ],
  } as never;
}

// 测试价值：设置 IPC 保存远程模型时按设备能力验证并持久化；依据远程辅助模型身份隔离契约；
// 原 helper 测试没有保存 IPC 和远端能力；最小输入为可用和不在能力列表中的远程路由。
// tier: unit（内存配置和 RPC fake）；单文件实测墙钟 2.010s。
describe('remote auxiliary settings save', () => {
  const route = { deviceId: 'device-b', providerId: 'provider', agentKind: 'codex' as const, model: 'model' };
  const ref = encodeRemoteAuxiliaryModelRef(route);
  beforeEach(() => {
    vi.clearAllMocks();
    remoteMocks.owner.mockReturnValue('owner');
    remoteMocks.read.mockReturnValue({ models: [] });
    remoteMocks.state.mockReturnValue({ value: { models: [] }, isCustomized: false, customizedKeys: [], defaults: { models: [] } });
    remoteMocks.write.mockResolvedValue(undefined);
    setRemoteUtilityTextClient({ request: async () => ({ ok: false, reason: 'no_candidate', attempts: [] }),
      readCapabilities: remoteMocks.caps });
    registerAuxiliaryModelSettingsIpc();
  });
  function setHandler() {
    return remoteMocks.handle.mock.calls.find(([channel]) => channel === MAKER_INVOKE.AUXILIARY_MODEL_SETTINGS_SET)![1];
  }
  it('saves a route advertised by the selected device', async () => {
    remoteMocks.caps.mockResolvedValue({ allowedRoutes: [{ providerId: route.providerId, agentKind: route.agentKind, model: route.model }] });
    await setHandler()({}, { models: [ref] });
    expect(remoteMocks.caps).toHaveBeenCalledWith('device-b');
    expect(remoteMocks.write).toHaveBeenCalledWith({ models: [ref] });
  });
  it('rejects a route not advertised by that device', async () => {
    remoteMocks.caps.mockResolvedValue({ allowedRoutes: [] });
    await expect(setHandler()({}, { models: [ref] })).rejects.toThrow(/not currently routable/);
    expect(remoteMocks.write).not.toHaveBeenCalled();
  });
});

describe('auxiliary model settings IPC helpers', () => {
  // Unit: a native Settings save must clear the observed config problem without
  // a later health read or model request (auxiliary-model-health.md, recovery).
  it('announces recovery when saving a usable replacement for a missing model', async () => {
    const missing = 'cat:missing:codex:old-model';
    const store = vi.mocked(readAuxiliaryModelSettings);
    const state = vi.mocked(readAuxiliaryModelSettingsState);
    const write = vi.mocked(writeAuxiliaryModelSettingsPatch);
    const catalogRead = vi.mocked(getDesktopSelectableCatalog);
    const credentials = vi.mocked(hasOneshotProviderCredential);
    store.mockReturnValue({ models: [missing] });
    const saved = { value: { models: [PIN] }, isCustomized: true, customizedKeys: ['models'], defaults: { models: [] } };
    state.mockReturnValue(saved);
    write.mockImplementation(async () => {
      store.mockReturnValue({ models: [PIN] });
    });
    catalogRead.mockReturnValue(catalog());
    credentials.mockReturnValue(true);
    try {
      registerAuxiliaryModelSettingsIpc();
      reportAuxiliaryChainOutcome('no_candidate');
      const notify = vi.mocked(notifyAppSettingsChanged);
      expect(notify).toHaveBeenCalledWith('auxiliary-model-health');
      notify.mockClear();

      const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === MAKER_INVOKE.AUXILIARY_MODEL_SETTINGS_SET)?.[1];
      expect(handler).toBeDefined();
      await expect(handler!({} as Electron.IpcMainInvokeEvent, { models: [PIN] })).resolves.toMatchObject({ models: [PIN] });
      expect(notify).toHaveBeenCalledExactlyOnceWith('auxiliary-model-health');
    } finally {
      reportAuxiliaryChainOutcome('success');
      store.mockReset();
      state.mockReset();
      write.mockReset();
      catalogRead.mockReset();
      credentials.mockReset();
    }
  });

  // Unit: retain experimental remote settings for removal, but reject new selections.
  // Existing persisted-route cases do not distinguish execution computers.
  it('keeps a remote selection unavailable even when the local route is usable', () => {
    const pin = 'remote-cat:other:' + PIN;
    const choices = buildAuxiliaryModelOptions({ settings: { models: [pin] }, catalog: catalog(),
      overrides: undefined, hasCredential: () => true });
    expect(choices.find(option => option.id === pin)?.available).toBe(false);
    expect(() => parseAuxiliaryModelSettingsPatch({ models: [pin] }, new Set([PIN]))).toThrow();
    expect(parseAuxiliaryModelSettingsPatch({ models: [] }, new Set([PIN]), new Set([pin]))).toEqual({ models: [] });
  });

  it('round-trips a Pi-only HTTP choice while retaining old catalog pins', () => {
    const preset = BUNDLED_CATALOG.presets!.find((entry) => entry.id === 'opencode-go')!;
    const provider = buildUserProvider({ id: 'go', name: 'Go', runtimes: {
      pi: { ...preset.runtimes.pi!, catalogPresetId: preset.id, models: [{ id: 'deepseek-v4.1-flash', name: 'Flash' }] },
    } }, { presets: BUNDLED_CATALOG.presets });
    const pin = `cat:${provider.id}:pi:deepseek-v4.1-flash`;
    const options = buildAuxiliaryModelOptions({
      settings: { models: [PIN] }, catalog: { ...BUNDLED_CATALOG, providers: [provider] },
      overrides: undefined, hasCredential: () => true,
    });
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pin, defaultEnabled: true, available: true }),
      expect.objectContaining({ id: PIN, available: false }),
    ]));
    expect(parseAuxiliaryModelSettingsPatch({ models: [pin, PIN] }, new Set([pin]), new Set([PIN]))).toEqual({ models: [pin, PIN] });
    expect(() => parseAuxiliaryModelSettingsPatch({ models: ['cat:unknown:pi:model'] }, new Set([pin]))).toThrow(/not currently routable/);
  });
  it('accepts a unique models list and empty automatic reset', () => {
    const allowed = new Set([PIN]);
    expect(parseAuxiliaryModelSettingsPatch({ models: [PIN] }, allowed)).toEqual({
      models: [PIN],
    });
    expect(parseAuxiliaryModelSettingsPatch({ models: [] }, allowed)).toEqual({
      models: [],
    });
    expect(parseAuxiliaryModelSettingsPatch({ models: [PROFILE] }, allowed)).toEqual({
      models: [PROFILE],
    });
  });

  it('keeps a persisted catalog pin removable even when it left the live allowlist', () => {
    expect(
      parseAuxiliaryModelSettingsPatch({ models: [PIN] }, new Set(), new Set([PIN])),
    ).toEqual({ models: [PIN] });
  });

  it('rejects unknown keys, padded refs, and unroutable catalog pins', () => {
    const allowed = new Set([PIN]);
    expect(() =>
      parseAuxiliaryModelSettingsPatch({ sessionTitleModel: PIN }, allowed),
    ).toThrow(/invalid keys/);
    expect(() =>
      parseAuxiliaryModelSettingsPatch({ models: [` ${PIN}`] }, allowed),
    ).toThrow(/unique list of at most 3/);
    expect(() =>
      parseAuxiliaryModelSettingsPatch({ models: ['cat:other:codex:model'] }, allowed),
    ).toThrow(/not currently routable/);
  });

  it('keeps a selected but credential-unavailable route visible and removable', () => {
    const options = buildAuxiliaryModelOptions({
      settings: { models: [PIN] },
      catalog: catalog(),
      overrides: { disabledModels: {}, disabledProviders: {} },
      hasCredential: () => false,
    });

    expect(options).toEqual([
      expect.objectContaining({
        id: PIN,
        providerId: 'openrouter',
        modelId: 'openai/gpt-5-mini',
        available: false,
      }),
    ]);
  });

  it('routes pi-runtime options through toWireOption without throwing', () => {
    const piCatalog = {
      providers: [
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          source: 'user',
          agents: ['pi'],
          auth: { method: 'apiKey' },
          routing: {
            pi: {
              upstream: 'https://opencode.example/zen/go/v1',
              authStrategy: 'api-key-header',
              wireProtocol: 'openai-chat',
            },
          },
          models: {
            pi: [
              {
                id: 'step-5-preview-free',
                name: 'Step 5 preview free',
                contextWindow: 200_000,
                group: 'custom:opencode-go',
              },
            ],
          },
        },
      ],
    } as never;
    const pin = 'cat:opencode-go:pi:step-5-preview-free';
    // 用户尚未选中 pi 档(空自定义链)时,设置读取同样要能活着列出可用 pi 选项。
    const unselected = buildAuxiliaryModelOptions({
      settings: { models: [] },
      catalog: piCatalog,
      overrides: { disabledModels: {}, disabledProviders: {} },
      hasCredential: () => true,
    });
    expect(unselected.map((o) => [o.id, o.available, o.agentSuffix])).toEqual([
      [pin, true, 'Pi'],
    ]);

    const options = buildAuxiliaryModelOptions({
      settings: { models: [pin] },
      catalog: piCatalog,
      overrides: { disabledModels: {}, disabledProviders: {} },
      hasCredential: () => true,
    });

    expect(options).toEqual([
      expect.objectContaining({
        id: pin,
        providerId: 'opencode-go',
        agentKind: 'pi',
        modelId: 'step-5-preview-free',
        agentSuffix: 'Pi',
        available: true,
      }),
    ]);
  });

  it('marks a migrated utility profile available when its direct route is usable', () => {
    const options = buildAuxiliaryModelOptions({
      settings: { models: [PROFILE] },
      catalog: builtinCodexCatalog(),
      overrides: { disabledModels: {}, disabledProviders: {} },
      hasCredential: () => true,
    });

    expect(options).toEqual([
      expect.objectContaining({
        id: PROFILE,
        providerId: 'openai',
        available: true,
      }),
    ]);
  });

  it('does not expose a stale selection as available when it left the catalog', () => {
    const stalePin = 'cat:removed:claude-code:old-model';
    const options = buildAuxiliaryModelOptions({
      settings: { models: [stalePin] },
      catalog: catalog(),
      overrides: { disabledModels: {}, disabledProviders: {} },
      hasCredential: () => true,
    });

    expect(options.find((option) => option.id === stalePin)).toMatchObject({
      available: false,
      providerId: 'removed',
      agentKind: 'claude-code',
      modelId: 'old-model',
    });
  });
});
