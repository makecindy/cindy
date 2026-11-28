/**
 * Plugin engines as the settings page, pickers, phones and other computers read them, with what the
 * user set in Settings → Model providers (docs/dev-rules/protocol-compatibility/plugin-harnesses.md).
 *
 * 测试价值
 * - 生产入口与可观察结果：register.ts 用的 registerPluginEnginesIpc，接上真实的 plugin-engine-prefs-store
 *   (账号目录由替身指到临时目录)。看 `maker:list-plugin-engines` 在本机窗口与 device-link 两种调用下的回包、
 *   `maker:set-plugin-engine-prefs` 的拒绝原因与写入后推给窗口的列表、账号目录里的文件，以及 Agent 工具
 *   读到的引擎描述。
 * - 规则依据：用户要求(2026-11-22)「新增这类供应商不能影响现有任何供应商功能，用户更新后照旧可用」；
 *   protocol-compatibility.md 的 append-only 与旧端降级；configuration-and-overrides.md「只记录 override、
 *   恢复默认 = 删除 override」「停用是准入，隐藏不是」；electron-security §5 写入前校验载荷与归属。
 * - 现有覆盖缺口：此前没有测试覆盖 pluginEnginesIpc 的列表投影与写入通道(appDefaultModelControl.test 把它整个替掉)。
 * - 最小失败输入：没有任何设置时回包多出字段(旧端与已有快照比较会当成变化)；停用的引擎仍报可用；关掉的模型
 *   仍在 `models` 里；手机或另一台电脑拿到只给设置页看的字段；另一台电脑借用时被主人的「隐藏」影响；
 *   device-link 能改这台电脑的设置；能给没列出的模型或已卸载的引擎写入设置；写入后窗口没收到新列表；
 *   恢复默认后文件里还留着条目；停用后其他电脑或受邀者仍能调用，或重新启用后「允许被远程调用」被悄悄关掉。
 * - 「允许被远程调用」的开关存储(remote-provider-access-store)用内存替身：它连着分享可用性的上报通道，
 *   不是这里要验证的东西；被验证的是 maker-host/pluginEngineRemoteUse.ts 里执行端准入用的三个判断。
 * - tier：unit(真实文件读写在临时目录；插件注册表与模型缓存用内存替身)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { runDeviceLinkInvokeContext } from '../../device-link/invoke-context.js';
import { hostSessionIdFor } from '../../remote-agent/host/sessionIdentity.js';
import type { PluginHarness } from '../../cindy-brain/pluginHarnesses.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-engines-ipc-test-'));
const host = vi.hoisted(() => ({ owner: 'first', harnesses: [] as unknown[] }));

vi.mock('electron', () => ({ app: { getPath: () => path.join(tmpDir, 'never-used-here') } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../ownerContext.js', () => ({
  configureOwnerContext: () => {},
  ownerScopedPath: (name: string) => path.join(tmpDir, host.owner, name),
}));
vi.mock('../../cindy-brain/pluginHarnesses.js', () => ({
  getPluginHarnessRegistry: () => ({ list: () => host.harnesses, onChange: () => () => {} }),
  requestPluginHarnessRefresh: () => {},
  readPluginHarnessUsage: () => null,
}));
vi.mock('../../maker-host/pluginEngineModelCache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../maker-host/pluginEngineModelCache.js')>();
  return {
    ...actual,
    getCachedPluginHarnessModels: () => [],
  };
});
const remoteAccess = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({
  isRemoteProviderInvocationAllowed: (providerId: string) => remoteAccess.allowed.has(providerId),
  setRemoteProviderInvocationEnabled: async (providerId: string, enabled: boolean) => {
    if (enabled) remoteAccess.allowed.add(providerId);
    else remoteAccess.allowed.delete(providerId);
  },
}));
// Cindy's two generic permission modes; the engine's permission menu is not what this file is about.
vi.mock('@cindy/maker-core', () => ({
  ACP_PERMISSION_MODES: [{ id: 'ask', displayName: 'Ask' }, { id: 'bypassPermissions', displayName: 'Allow all' }],
}));

import {
  onPluginEnginePrefsChanged,
  readPluginEnginePrefs,
  updatePluginEnginePrefs,
} from '../../maker-host/plugin-engine-prefs-store.js';
import {
  PLUGIN_ENGINES_INVOKE,
  parseOfferedPluginEngines,
  type PluginEngineView,
} from '../../../shared/pluginEngines.js';
import {
  isPluginEngineModelTurnedOff,
  isPluginEngineOfferedRemotely,
  isPluginEngineOfferedToGuests,
  pluginEngineRemoteUse,
  setPluginEngineRemoteUse,
} from '../../maker-host/pluginEngineRemoteUse.js';
import { observePluginEngineModelDetails } from '../../maker-host/pluginEngineModelCache.js';
import { onPluginEnginesChanged, pluginEngineDescriptors, pluginEngineSettingsOf, registerPluginEnginesIpc } from '../pluginEnginesIpc.js';

const KEY = '_ns__local__dsh-acp:dsh';
const dsh = (extra: Partial<PluginHarness> = {}): PluginHarness => ({
  key: KEY,
  ghostId: '_ns__local__dsh-acp',
  harnessId: 'dsh',
  name: 'DeepSeek Harness',
  protocol: 'acp',
  availability: { state: 'available', version: '0.2.2' },
  remoteWorkspace: true,
  models: [
    { id: 'deepseek-v4', name: 'DeepSeek-V4-Pro', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'deepseek-lite', name: 'DeepSeek Lite' },
  ],
  ...extra,
});

let disposers: Array<() => void> = [];
let caseIndex = 0;

/** The channel handlers as the main window (or, with `deviceLink`, another device) reaches them. */
function register(harnesses: PluginHarness[] = [dsh()]) {
  host.owner = `account-${caseIndex += 1}`;
  host.harnesses = harnesses;
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
  const pushes: PluginEngineView[][] = [];
  let deviceLink = false;
  disposers.push(registerPluginEnginesIpc({
    handle: (channel, listener) => { handlers.set(channel, listener as (event: unknown, input?: unknown) => unknown); },
    assertTrusted: () => {},
    broadcast: (_channel, payload) => { pushes.push(payload as PluginEngineView[]); },
    isDeviceLinkInvoke: () => deviceLink,
    remoteUse: { read: pluginEngineRemoteUse, set: setPluginEngineRemoteUse, onChange: () => () => {} },
    settings: { read: readPluginEnginePrefs, update: updatePluginEnginePrefs, onChange: onPluginEnginePrefsChanged },
    isCurrentOwner: (stamp) => stamp.dataOwnerId === host.owner && stamp.ownerGeneration === 1,
  }));
  const invoke = (channel: string, input?: unknown) => handlers.get(channel)!({}, input);
  return {
    pushes,
    list: () => invoke(PLUGIN_ENGINES_INVOKE.LIST) as PluginEngineView[],
    listFromAnotherDevice: () => {
      deviceLink = true;
      try { return invoke(PLUGIN_ENGINES_INVOKE.LIST) as PluginEngineView[]; } finally { deviceLink = false; }
    },
    set: (input: unknown) => Promise.resolve().then(() => invoke(PLUGIN_ENGINES_INVOKE.SET_PREFS, input)) as Promise<PluginEngineView | null>,
    setFromAnotherDevice: (input: unknown) => {
      deviceLink = true;
      return Promise.resolve().then(() => invoke(PLUGIN_ENGINES_INVOKE.SET_PREFS, input)).finally(() => { deviceLink = false; });
    },
    prefsFile: () => path.join(tmpDir, host.owner, 'plugin-engine-prefs.json'),
  };
}

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  remoteAccess.allowed.clear();
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('plugin engines with the settings from Settings → Model providers', () => {
  // The existing cross-device picker must never receive local settings observations.
  it('publishes model details locally and removes them when the ACP endpoint ends', () => {
    const ipc = register();
    const catalogueChanged = vi.fn();
    disposers.push(onPluginEnginesChanged(catalogueChanged));
    const report = observePluginEngineModelDetails(`acp-plugin:${KEY}`);
    expect(ipc.list()[0]?.reportedModelDetails).toBeUndefined();
    const data = { modelId: 'deepseek-v4', imageInput: false, contextWindow: 64000 };
    report(data);
    expect(ipc.pushes.at(-1)?.[0]?.reportedModelDetails).toEqual([data]);
    expect(ipc.list()[0]?.reportedModelDetails).toEqual([data]);
    expect(ipc.listFromAnotherDevice()[0]?.reportedModelDetails).toBeUndefined();
    report(undefined);
    expect(ipc.list()[0]?.reportedModelDetails).toBeUndefined();
    expect(ipc.pushes.at(-1)?.[0]?.reportedModelDetails).toBeUndefined();
    expect(catalogueChanged).not.toHaveBeenCalled();
  });

  it('lists an engine exactly as its plugin declares it until the user changes something', () => {
    const ipc = register();
    const unchanged: PluginEngineView = {
      key: KEY,
      providerId: `acp-plugin:${KEY}`,
      ghostId: '_ns__local__dsh-acp',
      harnessId: 'dsh',
      name: 'DeepSeek Harness',
      availability: { state: 'available', version: '0.2.2' },
      models: [
        { id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro', efforts: ['low', 'high'], defaultEffort: 'high' },
        { id: 'deepseek-lite', displayName: 'DeepSeek Lite' },
      ],
      permissionModes: [{ id: 'ask', displayName: 'Ask' }, { id: 'bypassPermissions', displayName: 'Allow all' }],
      defaultPermissionMode: 'ask',
      remoteUse: { supported: true, enabled: false, shareSupported: false },
    };
    // Field for field what older readers and stored snapshots compare against: nothing is added.
    expect(JSON.stringify(ipc.list())).toBe(JSON.stringify([unchanged]));
    expect(JSON.stringify(ipc.listFromAnotherDevice())).toBe(JSON.stringify([unchanged]));
    expect(fs.existsSync(ipc.prefsFile())).toBe(false);
  });

  // Unit: real settings IPC and owner-scoped file, with the plugin publishing two levels.
  it('persists and restores a per-model reasoning default and refuses invalid or stale choices', async () => {
    const ipc = register();
    const ownerStamp = { dataOwnerId: host.owner, ownerGeneration: 1 };
    const patch = { key: KEY, ownerStamp, modelEffort: { id: 'deepseek-v4', effort: 'low' } };
    await expect(ipc.set({ ...patch, modelEffort: { ...patch.modelEffort, effort: 'max' } })).rejects.toThrow('INVALID_PARAMS');
    await expect(ipc.set({ ...patch, ownerStamp: { ...ownerStamp, ownerGeneration: 0 } })).rejects.toThrow('PERMISSION_DENIED');
    await ipc.set(patch);
    expect(ipc.list()[0]).toMatchObject({ modelEfforts: { 'deepseek-v4': 'low' }, models: [{ defaultEffort: 'low', declaredDefaultEffort: 'high' }, { id: 'deepseek-lite' }] });
    expect(JSON.parse(fs.readFileSync(ipc.prefsFile(), 'utf8')).engines[KEY]).toEqual({ modelEfforts: { 'deepseek-v4': 'low' } });
    const remote = ipc.listFromAnotherDevice()[0];
    expect(remote).not.toHaveProperty('modelEfforts');
    expect(remote?.models[0]).toMatchObject({ defaultEffort: 'low', declaredDefaultEffort: 'high' });
    const other = await ipc.set({ ...patch, modelEffort: { id: 'deepseek-v4', effort: null } });
    expect(other).not.toHaveProperty('modelEfforts');
    expect(other?.models[0]?.defaultEffort).toBe('high');
    expect(other?.models[0]).not.toHaveProperty('declaredDefaultEffort');
    expect(readPluginEnginePrefs(KEY)).toEqual({});
  });

  it('shows the user’s name, hides, turns off models and suspends for every reader of this computer’s list', async () => {
    const ipc = register();
    await ipc.set({ key: KEY, name: '  Work DeepSeek  ' });
    await ipc.set({ key: KEY, hidden: true });
    const afterModelOff = await ipc.set({ key: KEY, models: { ids: ['deepseek-lite'], disabled: true } });

    const [engine] = ipc.list();
    expect(engine).toMatchObject({ name: 'Work DeepSeek', declaredName: 'DeepSeek Harness', hidden: true });
    expect(engine!.models.map((model) => model.id)).toEqual(['deepseek-v4']);
    expect(engine!.disabledModels).toEqual([{ id: 'deepseek-lite', displayName: 'DeepSeek Lite' }]);
    expect(engine!.availability.state).toBe('available');
    expect(afterModelOff).toEqual(engine);
    // The window is told after every change, with the complete list.
    expect(ipc.pushes).toHaveLength(3);
    expect(ipc.pushes.at(-1)).toEqual([engine]);
    // Agent tools (list_available_models) offer what a picker offers: hiding is not admission.
    expect(pluginEngineDescriptors()).toEqual([{
      providerId: `acp-plugin:${KEY}`,
      name: 'Work DeepSeek',
      available: true,
      models: [
        { id: 'deepseek-v4', label: 'DeepSeek-V4-Pro', efforts: ['low', 'high'] },
      ],
    }]);

    await ipc.set({ key: KEY, suspended: true });
    expect(ipc.list()[0]).toMatchObject({ suspended: true, availability: { state: 'unavailable', reason: 'suspended' } });
    expect(pluginEngineDescriptors()[0]!.available).toBe(false);
    expect(pluginEngineSettingsOf({ key: KEY })).toEqual({
      name: 'Work DeepSeek', hidden: true, suspended: true, disabledModels: ['deepseek-lite'],
    });
  });

  // The last model toggle must not reopen the engine-selected default in device catalogs (unit).
  it('keeps the default unavailable when all listed models are turned off', async () => {
    const ipc = register();
    await ipc.set({ key: KEY, models: { ids: ['deepseek-v4', 'deepseek-lite'], disabled: true } });
    expect(ipc.list()[0]).toMatchObject({ models: [], defaultModelAllowed: false });
    expect(pluginEngineDescriptors()[0]).toMatchObject({ available: false, models: [] });
    expect(isPluginEngineModelTurnedOff(ipc.list()[0]!.providerId, 'default')).toBe(true);
    await ipc.set({ key: KEY, models: { ids: ['deepseek-v4', 'deepseek-lite'], disabled: false } });
    expect(ipc.list()[0]).not.toHaveProperty('defaultModelAllowed');
  });

  it('gives a phone or another computer the engine as offered, without this computer’s settings details', async () => {
    const ipc = register();
    await ipc.set({ key: KEY, name: 'Work DeepSeek', hidden: true, models: { ids: ['deepseek-lite'], disabled: true } });
    const [remote] = ipc.listFromAnotherDevice();
    // The name and the model list are what that reader offers; the hidden flag lets a controller of
    // this computer keep it out of its picker.
    expect(remote).toMatchObject({ name: 'Work DeepSeek', hidden: true });
    expect(remote!.models.map((model) => model.id)).toEqual(['deepseek-v4']);
    expect(remote).not.toHaveProperty('declaredName');
    expect(remote).not.toHaveProperty('disabledModels');

    // Another computer borrowing the engine for its own tasks: the owner's picker choice does not apply there.
    const offered = (view: PluginEngineView) => parseOfferedPluginEngines([
      { ...view, remoteUse: { supported: true, enabled: true } },
    ]);
    expect(offered(remote!)).toHaveLength(1);
    expect(offered(remote!)[0]).not.toHaveProperty('hidden');

    // Turned off: an older phone or computer that never heard of `suspended` already treats it as not runnable.
    await ipc.set({ key: KEY, suspended: true });
    const [suspended] = ipc.listFromAnotherDevice();
    expect(suspended!.availability.state).toBe('unavailable');
    expect(offered(suspended!)).toEqual([]);
  });

  // What the computer that runs the engine answers when another computer of the account or a shared
  // friend opens or continues a task on it (remote-agent/host/service.ts, device-link/providerShareHost.ts).
  it('stops serving other computers and shared friends while turned off, and serves them again as before once turned on', async () => {
    const providerId = `acp-plugin:${KEY}`;
    const ipc = register([dsh({ guestWorkspace: true })]);
    await setPluginEngineRemoteUse(KEY, true);
    expect([isPluginEngineOfferedRemotely(providerId), isPluginEngineOfferedToGuests(providerId)]).toEqual([true, true]);

    // Hiding is presentation only: both keep being served.
    await ipc.set({ key: KEY, hidden: true });
    expect([isPluginEngineOfferedRemotely(providerId), isPluginEngineOfferedToGuests(providerId)]).toEqual([true, true]);

    await ipc.set({ key: KEY, suspended: true });
    expect([isPluginEngineOfferedRemotely(providerId), isPluginEngineOfferedToGuests(providerId)]).toEqual([false, false]);
    // The switch itself is left as the user set it.
    expect(ipc.list()[0]!.remoteUse).toEqual({ supported: true, enabled: true, shareSupported: true });

    await ipc.set({ key: KEY, suspended: false });
    expect([isPluginEngineOfferedRemotely(providerId), isPluginEngineOfferedToGuests(providerId)]).toEqual([true, true]);

    // One model turned off: the closed model and the harness-controlled default are refused.
    await ipc.set({ key: KEY, models: { ids: ['deepseek-lite'], disabled: true } });
    expect(['deepseek-lite', 'deepseek-v4', 'default'].map((model) => isPluginEngineModelTurnedOff(providerId, model)))
      .toEqual([true, false, true]);
    expect(isPluginEngineModelTurnedOff('anthropic', 'deepseek-lite')).toBe(false);
  });

  it('refuses a change from another device, a malformed request, an unlisted model and a missing engine', async () => {
    const ipc = register();
    await expect(ipc.set({ key: KEY, name: 'Stale', ownerStamp: { dataOwnerId: host.owner, ownerGeneration: 0 } }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(ipc.setFromAnotherDevice({ key: KEY, suspended: true })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const malformed of [
      null,
      { key: KEY },
      { key: KEY, suspended: 'yes' },
      { key: KEY, name: '' },
      { key: KEY, name: 'x'.repeat(65) },
      { key: KEY, models: { ids: [], disabled: true } },
      { key: KEY, models: { ids: ['deepseek-lite'] } },
      { key: KEY, hidden: true, providerId: 'anthropic' },
      { key: 'x'.repeat(201), hidden: true },
    ]) {
      await expect(ipc.set(malformed), JSON.stringify(malformed)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    await expect(ipc.set({ key: KEY, models: { ids: ['not-listed'], disabled: true } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(ipc.set({ key: 'gone-plugin:engine', hidden: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // None of it was written, and the window was not told about a change that did not happen.
    expect(fs.existsSync(ipc.prefsFile())).toBe(false);
    expect(ipc.pushes).toEqual([]);
    expect(ipc.list()[0]).not.toHaveProperty('suspended');
  });

  it('stores only what was changed, and going back to the default removes it, also after the plugin is gone', async () => {
    const ipc = register();
    await ipc.set({ key: KEY, name: 'Work DeepSeek', suspended: true, models: { ids: ['deepseek-lite'], disabled: true } });
    expect(JSON.parse(fs.readFileSync(ipc.prefsFile(), 'utf8'))).toEqual({
      engines: { [KEY]: { name: 'Work DeepSeek', suspended: true, disabledModels: ['deepseek-lite'] } },
    });
    // The plugin's own name again is the default: nothing is kept for it.
    await ipc.set({ key: KEY, name: 'DeepSeek Harness' });
    await ipc.set({ key: KEY, models: { ids: ['deepseek-lite'], disabled: false } });
    expect(JSON.parse(fs.readFileSync(ipc.prefsFile(), 'utf8'))).toEqual({ engines: { [KEY]: { suspended: true } } });
    expect(ipc.list()[0]).not.toHaveProperty('declaredName');

    // The plugin was turned off meanwhile: what was set can still be undone, nothing new can be set.
    host.harnesses = [];
    await expect(ipc.set({ key: KEY, hidden: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ipc.set({ key: KEY, suspended: false })).resolves.toBeNull();
    expect(fs.existsSync(ipc.prefsFile())).toBe(false);

    // Turned on again: listed as declared.
    host.harnesses = [dsh()];
    expect(ipc.list()[0]).toMatchObject({ name: 'DeepSeek Harness', availability: { state: 'available' } });
    expect(ipc.list()[0]).not.toHaveProperty('declaredName');
  });
});

/*
 * 插件引擎的账号(subscription-account-pools.md 插件引擎的账号，2026-11-23)。生产入口同上。可观察结果：拿出来的单独供应商
 * 作为一项列出(沿用引擎的模型清单，不对其他电脑开放，显示名、模型开关与停用按自己的键保存，与引擎互不影响)；
 * 任务输入框的用量按任务所在账号读，另一台电脑问起这台不认识的任务时保留引擎原有的读法。最小失败输入：引擎有一个
 * 拿出来的供应商；只在其中一方关掉模型或停用；带 sessionId 的用量读取。
 */
describe('plugin engines with accounts', () => {
  it('lists a provider taken out of an engine on its own, closed to other computers, and reads a task account usage', async () => {
    host.owner = `account-${caseIndex += 1}`;
    host.harnesses = [dsh({ accounts: { methods: [{ id: 'api-key', label: 'API Key', kind: 'secret' }] } })];
    const handlers = new Map<string, (event: unknown, ...input: unknown[]) => unknown>();
    const readTaskUsage = vi.fn(async () => ({ updatedAt: 1, balances: [{ currency: 'CNY', amount: '1.00' }] }));
    let deviceLink = false;
    disposers.push(registerPluginEnginesIpc({
      handle: (channel, listener) => { handlers.set(channel, listener as (event: unknown, ...input: unknown[]) => unknown); },
      assertTrusted: () => {},
      broadcast: () => {},
      isDeviceLinkInvoke: () => deviceLink,
      remoteUse: { read: pluginEngineRemoteUse, set: setPluginEngineRemoteUse, onChange: () => () => {} },
      settings: { read: readPluginEnginePrefs, update: updatePluginEnginePrefs, onChange: onPluginEnginePrefsChanged },
      accountProviders: { list: () => [{ suffix: 'ab12cd34', identity: 'b@example.com' }], onChange: () => () => {} },
      readTaskUsage,
    }));
    await setPluginEngineRemoteUse(KEY, true);
    const list = () => handlers.get(PLUGIN_ENGINES_INVOKE.LIST)!({}) as PluginEngineView[];
    const [engine, separate] = list();
    expect(engine).toMatchObject({ key: KEY, remoteUse: { enabled: true } });
    expect(engine).not.toHaveProperty('accountProviderOf');
    expect(separate).toMatchObject({
      key: `${KEY}~ab12cd34`, providerId: `acp-plugin:${KEY}~ab12cd34`, name: 'DeepSeek Harness · b@example.com',
      accountProviderOf: KEY, remoteUse: { supported: false, enabled: false }, models: engine!.models,
    });
    expect(isPluginEngineOfferedRemotely(separate!.providerId)).toBe(false);

    await handlers.get(PLUGIN_ENGINES_INVOKE.SET_PREFS)!({}, { key: `${KEY}~ab12cd34`, name: 'Work key' });
    expect(list().map(view => view.name)).toEqual(['DeepSeek Harness', 'Work key']);

    // Its own model switches and turning off, independent of the engine's (review of #12242).
    await handlers.get(PLUGIN_ENGINES_INVOKE.SET_PREFS)!({}, { key: KEY, models: { ids: ['deepseek-lite'], disabled: true } });
    await handlers.get(PLUGIN_ENGINES_INVOKE.SET_PREFS)!({}, { key: `${KEY}~ab12cd34`, models: { ids: ['deepseek-v4'], disabled: true } });
    let [base, own] = list();
    expect(base!.models.map(model => model.id)).toEqual(['deepseek-v4']);
    expect(own!.models.map(model => model.id)).toEqual(['deepseek-lite']);
    expect(own).toMatchObject({ defaultModelAllowed: false, disabledModels: [{ id: 'deepseek-v4' }] });
    await handlers.get(PLUGIN_ENGINES_INVOKE.SET_PREFS)!({}, { key: `${KEY}~ab12cd34`, suspended: true });
    [base, own] = list();
    expect(base!.availability.state).toBe('available');
    expect(own).toMatchObject({ suspended: true, availability: { state: 'unavailable', reason: 'suspended' } });

    const usage = handlers.get(PLUGIN_ENGINES_INVOKE.USAGE)!;
    await usage({}, KEY, { sessionId: 's1' });
    expect(readTaskUsage).toHaveBeenLastCalledWith(KEY, 's1', { fallbackToOriginal: false });
    deviceLink = true;
    await usage({}, KEY, { sessionId: 's1' });
    expect(readTaskUsage).toHaveBeenLastCalledWith(KEY, 's1', { fallbackToOriginal: true });
    // Unit #13748: borrowing the engine uses the authenticated peer's hosted task, even
    // when a task with the same original id exists here or a caller supplies a different peer.
    await runDeviceLinkInvokeContext({ controllerDeviceId: 'desk', channel: PLUGIN_ENGINES_INVOKE.USAGE },
      () => usage({}, KEY, { sessionId: 's1', hosted: true, controllerDeviceId: 'other' }));
    expect(readTaskUsage).toHaveBeenLastCalledWith(KEY, hostSessionIdFor('desk', 's1'), { fallbackToOriginal: true });
    deviceLink = false;
    expect(await usage({}, KEY)).toBeNull();
    expect(readTaskUsage).toHaveBeenCalledTimes(3);
  });
});
