import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const context = vi.hoisted(() => ({ root: '', owner: 'first', generation: 1, pending: false,
  connected: true, modelsPerAgent: 1, routeStamp: '1:0', catalogRevision: 1,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('electron', () => ({ app: { getPath: () => context.root } }));
const prepareImDefaults = vi.hoisted(() => vi.fn<(channel?: string) => Promise<void>>(async () => {}));
vi.mock('../../im/index.js', () => ({ prepareImDefaultSettingsChange: prepareImDefaults }));
// Model preference axes are Host settings only on a managed cloud instance.
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => ({}) }));
vi.mock('../../logger.js', () => ({ createLogger: () => context.log }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => context.log } }));
vi.mock('../../appSessionState.js', () => ({
  peekCommittedAppSession: () => ({ mode: 'cloud', dataOwnerId: context.owner, generation: context.generation }),
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: context.owner, generation: context.generation }),
  activeOwnerScopeKey: () => `${context.owner}:${context.generation}`,
  isAppSessionBoundaryPending: () => context.pending,
  dataOwnerStorageKey: (id: string) => `test-${id}`,
  ownerScopedUserDataPath: (...segments: string[]) => path.join(context.root, 'owners', `test-${context.owner}`, ...segments),
}));
// Native stores resolve the owner through the injected owner context that the real
// appSessionState installs; it is mocked above, so keep the context on the same owner.
vi.mock('../../ownerContext.js', () => ({
  configureOwnerContext: () => {},
  ownerScopedPath: (...segments: string[]) => path.join(context.root, 'owners', `test-${context.owner}`, ...segments),
  activeDataOwnerId: () => context.owner,
  hasCommittedOwner: () => true,
  isOwnerBoundaryPending: () => context.pending,
  ownerGeneration: () => context.generation,
}));
vi.mock('../../im/ownerScopedStorage.js', () => ({
  claimLegacyImPath: vi.fn(),
  ownerScopedImUserDataPath: (...segments: string[]) => path.join(context.root, 'owners', `test-${context.owner}`, ...segments),
}));

vi.mock('../catalog.js', () => ({ readSettingsModelCatalog: async () => ({
  providers: [{ id: 'fixture-provider', name: 'Fixture Provider', source: 'user', connected: context.connected,
    agents: ['claude-code', 'codex', 'pi'], auth: { method: 'api-key' },
    models: Object.fromEntries(['claude-code', 'codex', 'pi'].map(agent => [agent, Array.from({ length: context.modelsPerAgent }, (_, index) => ({ id: index === 0 ? 'fixture-model' : `fixture-${index}`, name: 'Fixture Model', type: 'chat',
      efforts: ['low', 'high'], defaultEffort: 'high', supportsFastMode: true, defaultEnabled: true }))])),
  }], agents: ['claude-code', 'codex', 'pi'], assertCurrent() {},
}) }));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({ getModelVisibilityOverride: () => undefined, waitForModelVisibilityMirror: async () => {}, getModelVisibilityMirrorSnapshot: () => ({}) }));
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: () => ({ listAvailableAgents: () => ['claude-code', 'codex', 'pi'] }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ getDesktopProviderService: () => ({ listProviders: async () => [] }) }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => ({ providers: [] }), getActiveCatalogRevision: () => context.catalogRevision }));
vi.mock('../../maker-host/provider-route.js', () => ({ getProviderRouteMutationStamp: () => context.routeStamp }));
vi.mock('../../usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: () => 'USD' }));
vi.mock('../../usage/accountReferencePrice.js', () => ({ accountReferencePriceQuote: () => ({ currency: 'USD', inputPerMtok: 2, outputPerMtok: 10, source: 'reference' }) }));
vi.mock('../../cindy-brain/index.js', () => ({ getHostPluginPreferenceContext: () => [{ id: 'fixture-plugin', name: 'Fixture Plugin', supported: { cindy: true, agent: true, model: true, mainView: true }, options: { 'image.generate': [{ id: 'fixture-image', label: 'Fixture Image' }] } }], notifyHostPluginPreferenceChanged: vi.fn() }));
vi.mock('../../maker-host/provider-order-store.js', () => ({ readProviderOrder: () => [] }));
vi.mock('../../utility-model/oneshotProviderUsability.js', () => ({ hasOneshotProviderCredential: () => true }));
vi.mock('../../utility-model/textOneshotPinOptions.js', () => ({ buildTextOneshotPinOptions: () => [{ id: 'fixture-pin', label: 'Fixture Auxiliary Model' }] }));
vi.mock('../../ownerNamespaceMigration.js', () => ({ isLegacyOwnerNamespaceClaimedByOtherOwner: () => true, hasExclusiveSharedLegacyUserDataAccess: () => false, hasLegacyOwnerNamespaceClaim: () => false }));

import { configureHostSettingsApplication, getHostSettings, getHostSettingsOperation, updateHostSettings } from '../index.js';
import { normalizeHostSettingsChange, type HostSettingsDomain, type HostSettingsUpdate } from '../../../shared/hostSettings.js';
import { modelSettingsChoices, readModelSettings, validateModelSettingsChange, commitModelSettings } from '../additionalModels.js';
import { settingsWebReadResultSchema } from '../../../shared/settingsWeb.js';
import { readModelContextLimit } from '../../maker-host/model-context-limit-store.js';
import { readModelDisableOverrides } from '../../maker-host/model-disable-store.js';
import { readSubagentModelSettings, writeSubagentModelSettingsPatch } from '../../maker-host/subagent-model-settings-store.js';
import { createHostImDefaultsStore, readImDefaultSettings } from '../../im/defaultSettingsStore.js';
import { nativePluginSettings } from '../additionalPlugins.js';
import { configureAdditionalNativeOperations } from '../additionalRuntime.js';
import { commitHostModelPrices, getHostModelPriceStore, readModelPriceOverrideView, inspectModelPriceOverrides } from '../../usage/modelPriceOverrideStore.js';
import { configureUserDataDir } from '../../userDataPath.js';
import { registerRuntimeSectionsForTest } from './settingsSectionFixture.js';
import { registerRuntimeSettingsSection, runtimeSettingsSections } from '../../app-settings/runtime.js';
const caller = { id: 'model-test', assertCurrent() {} };
const route = { providerId: 'fixture-provider', modelId: 'fixture-model' };
async function request(domain: HostSettingsDomain, values: Pick<HostSettingsUpdate, 'set' | 'clear'>) {
  const state = await getHostSettings(caller, domain);
  if (state.status !== 'ready' || !('operationId' in state)) throw new Error(`Not ready: ${domain}`);
  return { domain, expectedRevision: state.revision, operationId: state.operationId, ...values };
}
registerRuntimeSectionsForTest();
beforeEach(() => { configureHostSettingsApplication({ models: { read: readModelSettings, validate: validateModelSettingsChange, commit: commitModelSettings }, databaseWarning() {} }); context.root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-models-')); configureUserDataDir(context.root); context.owner = 'first'; context.generation++; context.pending = false; context.connected = true; context.modelsPerAgent = 1; vi.clearAllMocks(); });
afterEach(() => fs.rmSync(context.root, { recursive: true, force: true }));
describe('model and IM settings native persistence', () => {
  // A saved remote-Agent route is not representable in this wire version. Reading
  // it as a local route would silently clear agentDeviceId on the next edit (unit).
  it('leaves saved cross-device IM routes untouched when the editor cannot represent them', async () => {
    const store = createHostImDefaultsStore();
    await store.commitAtomic({ set: { schemaVersion: 3, channels: { feishu: {
      agents: { codex: { ...route, model: route.modelId, effort: 'high', agentDeviceId: 'other-device' } },
    } } } });
    const before = store.inspect();
    expect(await getHostSettings(caller, 'imFeishu')).toMatchObject({ status: 'unavailable', revision: null });
    expect(await getHostSettings(caller, 'imSlack')).toMatchObject({ status: 'ready' });
    expect(store.inspect()).toEqual(before);
    expect(readImDefaultSettings('feishu').agents.codex.agentDeviceId).toBe('other-device');
  });
  it.each(['modelVisibility', 'modelEngines', 'modelFavorites', 'modelContext'] as const)(
    'keeps all 267 catalog routes in %s, including disconnected providers', async domain => {
      context.modelsPerAgent = 89;
      context.connected = false;
      const choices = await modelSettingsChoices(domain);
      expect(choices.entries).toHaveLength(267);
      expect(new Set(choices.entries.map(option => JSON.stringify(option.value))).size).toBe(267);
      expect(choices.entries.at(-1)?.value).toEqual({ providerId: 'fixture-provider', modelId: 'fixture-88', harness: 'pi' });
    });
  it('rejects an oversized catalog without silently truncating routes', async () => {
    context.modelsPerAgent = 171;
    await expect(modelSettingsChoices('modelVisibility')).rejects.toThrow('MODEL_CATALOG_TOO_LARGE');
  });
  it('retains untouched sparse price records, their original baseline and unknown metadata', async () => {
    const store = getHostModelPriceStore();
    const target = { providerId: 'fixture-provider', agent: 'pi' as const, modelId: 'fixture-model' };
    const key = JSON.stringify([target.providerId, target.agent, target.modelId]);
    const original = { ...target, values: { inputPerMtok: 3 }, baseReference: { currency: 'USD' as const, inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: null, cacheCreatePerMtok: null }, updatedAt: '2026-09-01T00:00:00.000Z', future: true };
    await store.commitAtomic({ set: { version: 1, entries: { [key]: original } } });
    const before = store.inspect(); if (before.status !== 'ready') throw new Error('fixture');
    const effective = readModelPriceOverrideView(target, undefined).effective!;
    await commitHostModelPrices([{ ...target, currency: effective.currency, inputPerMtok: effective.inputPerMtok, outputPerMtok: effective.outputPerMtok, cacheReadPerMtok: effective.cacheReadPerMtok ?? null, cacheCreatePerMtok: effective.cacheCreatePerMtok ?? null },
      { ...target, modelId: 'another-model', currency: 'USD', inputPerMtok: 4, outputPerMtok: 8, cacheReadPerMtok: null, cacheCreatePerMtok: null }], undefined, { expectedRevision: before.revision });
    const after = store.inspect(); if (after.status !== 'ready') throw new Error('fixture');
    const raw = inspectModelPriceOverrides(path.join(context.root, 'owners', 'test-first'));
    if (raw.status !== 'ready') throw new Error('fixture');
    expect((raw.raw.entries as Record<string, unknown>)[key]).toEqual(original);
    await expect(commitHostModelPrices([], undefined, { expectedRevision: before.revision })).rejects.toThrow();
  });
  // Per-capability pins are retired: older controllers must not persist inert choices.
  it('rejects retired Plugin pins and preserves legacy data when changing concurrency', async () => {
    configureAdditionalNativeOperations({ plugins: nativePluginSettings } as never);
    const dir = path.join(context.root, 'owners', 'test-first'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ghost-cindy-prefs.json');
    const previous = { future: true, overrides: { 'fixture-plugin': { 'text.oneshot': 'saved-pin' } }, inflightLimits: { 'fixture-plugin': 2 } };
    fs.writeFileSync(file, JSON.stringify(previous));
    expect(await updateHostSettings(caller, await request('pluginCindy', { set: { imageGenerate: [{ ghostId: 'fixture-plugin', model: 'fixture-image' }] } }))).toMatchObject({ saved: false, code: 'UNSUPPORTED_CAPABILITY' });
    expect(await updateHostSettings(caller, await request('pluginCindy', { clear: ['imageGenerate'] }))).toMatchObject({ saved: false, code: 'UNSUPPORTED_CAPABILITY' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(previous);
    expect(await updateHostSettings(caller, await request('pluginCindy', { set: { inflightLimits: [{ ghostId: 'fixture-plugin', limit: 3 }] } }))).toMatchObject({ saved: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ ...previous, inflightLimits: { 'fixture-plugin': 3 } });
  });
  it('passive reads do not claim legacy files or create defaults', async () => {
    for (const domain of ['subagentModel', 'auxiliaryModel', 'imGlobal', 'imFeishu', 'imWechat'] as const) {
      expect(await getHostSettings(caller, domain)).toMatchObject({ status: 'ready', customizedKeys: [] });
    }
    expect(fs.readdirSync(context.root)).toEqual([]);
  });
  it('updates and clears both halves of the native subagent route', async () => {
    expect(await updateHostSettings(caller, await request('subagentModel', { set: { claudeCode: route } }))).toMatchObject({ saved: true });
    expect(readSubagentModelSettings()).toMatchObject({ claudeCode: route.modelId, claudeCodeProviderId: route.providerId });
    await updateHostSettings(caller, await request('subagentModel', { clear: ['claudeCode'] }));
    expect(readSubagentModelSettings()).toMatchObject({ claudeCode: null, claudeCodeProviderId: null });
  });
  // Smart subagent routing restarts Codex while the section applies it, which refreshes the model
  // catalog. The write has landed by then; the save must not be reported as a conflict.
  it('reports a saved subagent change when applying it refreshed the model catalog', async () => {
    const section = runtimeSettingsSections().find(item => item.id === 'subagent-models')!;
    registerRuntimeSettingsSection({ ...section, update: async patch => { await section.update(patch); context.catalogRevision += 1; } });
    try {
      expect(await updateHostSettings(caller, await request('subagentModel', { set: { codexSmartSubagentRouting: true } })))
        .toMatchObject({ saved: true, status: 'saved' });
      expect(readSubagentModelSettings().codexSmartSubagentRouting).toBe(true);
      expect(await updateHostSettings(caller, await request('subagentModel', { clear: ['codexSmartSubagentRouting'] })))
        .toMatchObject({ saved: true, status: 'saved' });
      expect(readSubagentModelSettings().codexSmartSubagentRouting).toBe(false);
    } finally {
      registerRuntimeSettingsSection(section);
      context.catalogRevision = 1;
    }
  });
  it('still refuses a model choice when the catalog changed before the write', async () => {
    const input = await request('subagentModel', { set: { claudeCode: route } });
    const section = runtimeSettingsSections().find(item => item.id === 'subagent-models')!;
    const update = vi.fn(section.update);
    registerRuntimeSettingsSection({ ...section, update });
    const validate = validateModelSettingsChange;
    configureHostSettingsApplication({ models: { read: readModelSettings, commit: commitModelSettings,
      validate: async (domain, change) => { const result = await validate(domain, change); context.catalogRevision += 1; return result; } },
      databaseWarning() {} });
    try {
      expect(await updateHostSettings(caller, input)).toMatchObject({ saved: false, code: 'CONFLICT' });
      expect(update).not.toHaveBeenCalled();
    } finally {
      registerRuntimeSettingsSection(section);
      context.catalogRevision = 1;
    }
  });
  // The instance's own settings window can save while a cloud save is still checking its model.
  it('keeps the model the instance window saved while an older cloud save was being checked', async () => {
    context.modelsPerAgent = 2;
    const input = await request('subagentModel', { set: { claudeCode: route } });
    configureHostSettingsApplication({ models: { read: readModelSettings, commit: commitModelSettings,
      validate: async (domain, change) => {
        const result = await validateModelSettingsChange(domain, change);
        writeSubagentModelSettingsPatch({ claudeCode: 'fixture-1', claudeCodeProviderId: route.providerId });
        return result;
      } }, databaseWarning() {} });
    expect(await updateHostSettings(caller, input)).toMatchObject({ saved: false, status: 'rejected', code: 'CONFLICT' });
    expect(readSubagentModelSettings()).toMatchObject({ claudeCode: 'fixture-1', claudeCodeProviderId: route.providerId });
  });
  it('reports a persisted change as saved when reading it back fails', async () => {
    const input = await request('subagentModel', { set: { codexSmartSubagentRouting: true } });
    const section = runtimeSettingsSections().find(item => item.id === 'subagent-models')!;
    registerRuntimeSettingsSection({ ...section, read: () => { throw new Error('read failed'); } });
    let reads = 0;
    configureHostSettingsApplication({ models: { commit: commitModelSettings, validate: validateModelSettingsChange,
      read: async domain => { if (++reads > 1) throw new Error('read failed'); return readModelSettings(domain); } }, databaseWarning() {} });
    try {
      const receipt = await updateHostSettings(caller, input);
      expect(receipt).toMatchObject({ saved: true, status: 'saved' });
      expect(receipt.revision).toBeUndefined();
      expect(readSubagentModelSettings().codexSmartSubagentRouting).toBe(true);
      expect(getHostSettingsOperation(caller, input.operationId)).toMatchObject({ saved: true, status: 'saved' });
    } finally {
      registerRuntimeSettingsSection(section);
    }
  });
  it('rejects a new route whose provider disconnected after the form was read', async () => {
    const input = await request('subagentModel', { set: { claudeCode: route } });
    context.connected = false;
    expect(await updateHostSettings(caller, input)).toMatchObject({ saved: false, code: 'MODEL_UNAVAILABLE' });
    expect(readSubagentModelSettings().claudeCode).toBeNull();
  });
  // There is no global teammate model chain editor.
  it('keeps the global teammate model chain read-only and still rejects duplicate routes on the wire', async () => {
    expect(await getHostSettings(caller, 'botModelChain')).toMatchObject({ status: 'unavailable', revision: null });
    const item = { harness: 'codex', providerId: route.providerId, model: route.modelId, effort: 'low', fastMode: false };
    await expect(validateModelSettingsChange('botModelChain', { set: { modelChain: [item] }, clear: [] })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(() => normalizeHostSettingsChange({ domain: 'botModelChain', set: { modelChain: [item, { ...item, effort: 'high' }] } })).toThrow();
    expect(fs.readdirSync(context.root)).toEqual([]);
  });
  it('preserves per-channel IM overrides and explicitly chosen defaults', async () => {
    await updateHostSettings(caller, await request('imFeishu', { set: { permissionMode: 'auto' } }));
    expect(await getHostSettings(caller, 'imFeishu')).toMatchObject({ customizedKeys: ['permissionMode'] });
    // Permission-only saves keep older tasks as they are; a route change records them first.
    expect(prepareImDefaults).not.toHaveBeenCalled();
    await updateHostSettings(caller, await request('imSlack', { set: { codex: { ...route, effort: 'low' } } }));
    expect(prepareImDefaults).toHaveBeenCalledExactlyOnceWith('slack');
    expect(readImDefaultSettings('slack').agents.codex).toEqual({ providerId: route.providerId, model: route.modelId, effort: 'low' });
    await updateHostSettings(caller, await request('imFeishu', { clear: ['permissionMode'] }));
    expect((await getHostSettings(caller, 'imFeishu')).status).toBe('ready');
    expect(readImDefaultSettings('slack').agents.codex.model).toBe(route.modelId);
  });
  it('does not save a channel route default when older tasks cannot be recorded first', async () => {
    prepareImDefaults.mockRejectedValueOnce(new Error('fixture backfill failure'));
    expect(await updateHostSettings(caller, await request('imSlack', { set: { agentKind: 'codex' } }))).toMatchObject({ saved: false, code: 'SAVE_FAILED' });
    expect(readImDefaultSettings('slack').agentKind).not.toBe('codex');
  });
  it('keeps the existing WeChat agent and permission boundaries', async () => {
    expect(await updateHostSettings(caller, await request('imWechat', { set: { agentKind: 'pi' } }))).toMatchObject({ saved: false });
    expect(await updateHostSettings(caller, await request('imWechat', { set: { permissionMode: 'bypassPermissions' } }))).toMatchObject({ saved: false });
    expect(readImDefaultSettings('wechat').agentKind).toBe('claude-code');
  });
  // The app has no vision bridge; the domain stays in the catalog for older clients.
  it('reports the removed vision bridge as unavailable and rejects writes', async () => {
    expect(await getHostSettings(caller, 'visionBridge')).toMatchObject({ status: 'unavailable', revision: null });
    await expect(validateModelSettingsChange('visionBridge', { set: { enabled: true }, clear: [] })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
  it('updates actual context limits and disabled model/provider maps', async () => {
    const target = { ...route, harness: 'codex' };
    expect(await updateHostSettings(caller, await request('modelContext', { set: { entries: [{ ...target, limit: 32000 }] } }))).toMatchObject({ saved: true });
    expect(readModelContextLimit('codex', route.providerId, route.modelId)).toBe(32000);
    expect(await updateHostSettings(caller, await request('modelAccess', { set: { models: [route], providers: [route.providerId] } }))).toMatchObject({ saved: true });
    expect(readModelDisableOverrides()).toEqual({ disabledModels: { 'fixture-provider:fixture-model': true }, disabledProviders: { 'fixture-provider': true }, hiddenProviders: {} });
    await updateHostSettings(caller, await request('modelAccess', { clear: ['models'] }));
    expect(readModelDisableOverrides().disabledProviders).toEqual({ 'fixture-provider': true });
    await updateHostSettings(caller, await request('modelContext', { clear: ['entries'] }));
    expect(readModelContextLimit('codex', route.providerId, route.modelId)).toBeNull();
  });
  it('fails closed on corrupt native fields without normalizing away the bytes', async () => {
    const dir = path.join(context.root, 'owners', `test-${context.owner}`); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'subagent-model-settings.json');
    const raw = '{"claudeCode":42}'; fs.writeFileSync(file, raw);
    expect(await getHostSettings(caller, 'subagentModel')).toMatchObject({ status: 'unreadable' });
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });
});

// Native defaults use empty routes for automatic selection, and the real web response
// validator must accept that read (unit); test the writer + real file as well.
it.each([['imFeishu', 'feishu'], ['imWechat', 'wechat'], ['imWecom', 'wecom'], ['imDingtalk', 'dingtalk'], ['imDiscord', 'discord'], ['imTelegram', 'telegram']] as const)('round-trips %s automatic defaults without pinning a model or another channel', async (domain, channel) => {
  const before = await getHostSettings(caller, domain);
  expect(settingsWebReadResultSchema.safeParse({ ok: true, settings: { ...before, domain } }).success).toBe(true);
  await updateHostSettings(caller, await request(domain, { set: { codex: { ...route, effort: 'low' } } }));
  await updateHostSettings(caller, await request('imSlack', { set: { codex: { ...route, effort: 'low' } } }));
  expect(await updateHostSettings(caller, await request(domain, { set: { codex: { providerId: null, modelId: '', effort: 'high' } } }))).toMatchObject({ saved: true });
  expect(readImDefaultSettings(channel).agents.codex.model).toBe('');
  expect(readImDefaultSettings('slack').agents.codex.model).toBe(route.modelId);
  expect(() => normalizeHostSettingsChange({ domain, set: { codex: { providerId: 'fixed-provider', modelId: '', effort: 'high' } } })).toThrow();
});

// 回归：Node Host host-settings v1 协议不含 acp 引擎；本地若已保存插件引擎默认，getHostSettings
// 必须返回 unavailable 而不是把无效值写进 v1 schema 或静默覆盖。最小失败输入与 tier：unit。
it('reports an IM domain as unavailable on host-settings v1 when a plugin engine route is saved', async () => {
  const { writeImDefaultSettingsPatch } = await import('../../im/defaultSettingsStore');
  writeImDefaultSettingsPatch(
    {
      agentKind: 'acp',
      agents: {
        acp: {
          providerId: 'acp-plugin:_ns__local__agy-acp:agy',
          model: 'gemini-4-neon',
          effort: 'high',
        },
      },
    },
    'feishu',
  );
  expect(await getHostSettings(caller, 'imFeishu')).toMatchObject({ status: 'unavailable', revision: null });
});

it('preserves modelGroup on effort-only IM updates and clears modelGroup on default reset', async () => {
  const { writeModelGroupsConfig } = await import('../../model-groups/store.js');
  writeModelGroupsConfig({ routes: [{ id: 'coding', name: 'Coding', strategy: 'order', candidates: [] }] });
  expect(await updateHostSettings(caller, await request('imFeishu', {
    set: {
      agentKind: 'codex',
      modelGroup: 'coding',
      codex: { providerId: route.providerId, modelId: route.modelId, effort: 'high' },
    },
  }))).toMatchObject({ saved: true });
  expect(await getHostSettings(caller, 'imFeishu')).toMatchObject({
    status: 'ready',
    value: { modelGroup: 'coding' },
  });

  // Effort-only change on the same concrete route keeps modelGroup.
  expect(await updateHostSettings(caller, await request('imFeishu', {
    set: { codex: { providerId: route.providerId, modelId: route.modelId, effort: 'low' } },
  }))).toMatchObject({ saved: true });
  expect(await getHostSettings(caller, 'imFeishu')).toMatchObject({
    status: 'ready',
    value: { modelGroup: 'coding', codex: { effort: 'low' } },
  });

  // Clearing default keys (even without explicitly naming modelGroup) clears modelGroup.
  const beforeReset = await getHostSettings(caller, 'imFeishu');
  expect(beforeReset.status).toBe('ready');
  const defaultKeys = Object.keys((beforeReset as { defaults: Record<string, unknown> }).defaults);
  expect(await updateHostSettings(caller, await request('imFeishu', { clear: defaultKeys }))).toMatchObject({ saved: true });
  const afterReset = await getHostSettings(caller, 'imFeishu');
  expect(afterReset.status).toBe('ready');
  expect((afterReset as { value: Record<string, unknown>; isCustomized: boolean }).value.modelGroup).toBeUndefined();
  expect((afterReset as { isCustomized: boolean }).isCustomized).toBe(false);
});
