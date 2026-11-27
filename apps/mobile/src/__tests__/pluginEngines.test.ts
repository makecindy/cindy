/**
 * 手机选择 / 使用被控电脑上的插件引擎(Desktop docs/plans/acp-plugin-bridge.md，第二期第二项)。
 *
 * 测试价值
 * - 生产入口与可观察结果：transport 的 listPluginEngines(经 device-link invoke)、sessions:patched 意图
 *   拆分(sessionAgentSwitchIntentPatch，store 入口同一函数)、新建任务的 create-session 参数
 *   (buildRemoteCreateSessionOptions + applyPluginEnginePick)、插件引擎任务的能力视图与选择器分组；
 *   看发出的参数、写进会话的字段与选择器行。
 * - 规则依据：2026-11-19 用户要求手机能正确选到插件引擎；协议兼容规则要求新手机连旧电脑时入口隐藏、
 *   不发 'acp'，旧意图链路看不到 'acp'。
 * - 现有覆盖缺口：手机此前不认识插件引擎：没有引擎列表读取，'acp' 意图被当成 Claude Code 展示，
 *   新建只能发三种内置引擎。
 * - 最小失败输入：旧电脑回 CHANNEL_NOT_ALLOWED 时列表不为空 / 抛错；不带引擎标识的 'acp' 意图被接受；
 *   插件引擎任务的 create 参数仍带内置 agentKind、Fast 或另一台电脑的位置；能力视图带 Fast / 计划模式；
 *   不可用的引擎能被选中。
 * - tier：unit(纯函数与注入 invoke 的 transport，无原生依赖)。
 */
import { describe, expect, it, vi } from 'vitest';

import { sharedTaskHostPeer } from '@cindy/device-link';
import { ANTIGRAVITY_MARK_DATA_URL } from '@cindy/maker-shared/branding';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { applyPluginEnginePick, buildRemoteCreateSessionOptions, type NewSessionDraft } from '@/session/newSession';
import {
  buildPluginEngineGroups,
  formatPluginEngineModelQuota,
  formatPluginEngineModelQuotaLabel,
  formatPluginEnginePickerQuota,
  getCachedControlledPluginEngines,
  getCachedPluginEngines,
  isPluginEngineSwitchSourceAllowed,
  loadControlledPluginEngines,
  loadPluginEngines,
  normalizeOfferedRemotePluginEngines,
  normalizePluginEngines,
  parseControlledModelLocations,
  pluginEngineChoiceKey,
  pluginEngineExecutionDeviceId,
  pluginEngineSessionCapabilities,
  resolveMobilePluginEngineFavorite,
  matchesPluginEngineFavoriteQuery,
  setCachedPluginEngines,
  type MobilePluginEngine,
} from '@/session/pluginEngines';
import { sessionAgentSwitchIntentPatch } from '@/session/sessionAgentSwitch';

const DSH = 'acp-plugin:_ns__local__dsh-acp:dsh';
const desktopView = {
  key: '_ns__local__dsh-acp:dsh',
  providerId: DSH,
  ghostId: '_ns__local__dsh-acp',
  harnessId: 'dsh',
  name: 'DeepSeek Harness',
  iconDataUrl: 'data:image/png;base64,AAAA',
  availability: { state: 'available', version: '0.2.2' },
  models: [{ id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
  permissionModes: [
    { id: 'default', displayName: 'Default' },
    { id: 'plan', displayName: 'Plan' },
    { id: 'bypassPermissions', displayName: 'Allow all' },
  ],
  defaultPermissionMode: 'default',
};

// Unit / #12735: old desktops can send generic engine IDs and stale artwork
// to the model picker and task metadata. The exact engine name identifies the mark.
it('projects the legacy Antigravity engine mark and preserves other artwork', () => {
  const legacy = { ...desktopView, providerId: 'acp-plugin:legacy:cli', ghostId: 'legacy', name: 'Antigravity' };
  const [antigravity, other] = normalizePluginEngines([legacy, desktopView]);
  expect(antigravity?.iconDataUrl).toBe(ANTIGRAVITY_MARK_DATA_URL);
  expect(other?.iconDataUrl).toBe(desktopView.iconDataUrl);
});

describe('reading the engines of the controlled computer', () => {
  it('reads the list over device-link and keeps only well-formed engines', async () => {
    const invoke = vi.fn(async () => [
      desktopView,
      { ...desktopView, providerId: 'anthropic', name: 'Not an engine' },
      { providerId: 'acp-plugin:broken', name: 'No harness id' },
      'garbage',
    ]) as unknown as RemoteInvoke;
    const engines = await createMobileMakerTransport({ deviceId: 'desk', invoke }).listPluginEngines();
    expect(invoke).toHaveBeenCalledWith('desk', 'maker:list-plugin-engines', []);
    expect(engines).toEqual([expect.objectContaining({
      providerId: DSH, name: 'DeepSeek Harness', iconDataUrl: 'data:image/png;base64,AAAA',
      models: [{ id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
      defaultPermissionMode: 'default',
    })]);
  });

  it('reads usage from the named computer only and keeps it out of shared tasks', async () => {
    const data = { updatedAt: 1234, balances: [{ currency: 'USD', amount: '0' }] };
    const invoke = vi.fn(async () => ({ ...data, identity: 'private' })) as unknown as RemoteInvoke;
    const maker = createMobileMakerTransport({ deviceId: 'desk', invoke });
    expect(await maker.getPluginEngineUsage('demo:engine')).toEqual(data);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('desk', 'maker:get-plugin-engine-usage', ['demo:engine']);
    const guest = createMobileMakerTransport({ deviceId: sharedTaskHostPeer('task', 'desk'), invoke });
    expect(await guest.getPluginEngineUsage('demo:engine')).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // Reopening a menu creates a new transport. The account, computer and engine still own
  // one request until the minute expires; expiry while hidden does not start a refresh.
  it('shares a usage read between menus and expires it without a background invoke', async () => {
    vi.useFakeTimers();
    try {
      const invoke = vi.fn(async () => ({ updatedAt: 1234, balances: [{ currency: 'USD', amount: '0' }] })) as unknown as RemoteInvoke;
      const read = (deviceId = 'menu-desk', key = 'demo:engine') =>
        createMobileMakerTransport({ deviceId, invoke }).getPluginEngineUsage(key);
      const [a, b] = await Promise.all([read(), read()]);
      expect(a).toEqual(b);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(await read()).toEqual(a);
      expect(invoke).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(await read()).toEqual(a);
      expect(invoke).toHaveBeenCalledTimes(2);
      await Promise.all([read('other-desk'), read('menu-desk', 'demo:other')]);
      expect(invoke).toHaveBeenCalledTimes(4);
      setCachedPluginEngines('menu-desk', [], false);
      await read();
      await read('other-desk');
      expect(invoke).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  // Unit, #11563: model discovery previously discarded every menu's pending balance.
  // Keep the reporting engine's reply while rejecting the other engine's old reply after regrant.
  it('preserves a pending balance only for engines that keep reporting it', async () => {
    const device = 'changing-catalogue';
    const second = { ...desktopView, providerId: 'acp-plugin:second:engine' };
    const catalogue = (reportsUsage: boolean) => normalizePluginEngines([
      { ...desktopView, reportsUsage: true }, { ...second, reportsUsage },
    ]);
    const [first, other] = catalogue(true);
    setCachedPluginEngines(device, catalogue(true), true);
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const invoke = vi.fn(() => pending) as unknown as RemoteInvoke;
    const maker = createMobileMakerTransport({ deviceId: device, invoke });
    const keep = maker.getPluginEngineUsage(first!.key);
    const revoke = maker.getPluginEngineUsage(other!.key);
    await Promise.resolve();
    setCachedPluginEngines(device, catalogue(false), true);
    setCachedPluginEngines(device, catalogue(true), true);
    const balance = { updatedAt: 1234, balances: [{ currency: 'USD', amount: '0' }] };
    finish(balance);
    expect(await Promise.all([keep, revoke])).toEqual([balance, null]);
    expect(await maker.getPluginEngineUsage(first!.key)).toEqual(balance);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('treats an older computer without the channel as having no engines', async () => {
    const invoke = vi.fn(async () => {
      throw Object.assign(new Error('[CHANNEL_NOT_ALLOWED] maker:list-plugin-engines'), { code: 'CHANNEL_NOT_ALLOWED' });
    }) as unknown as RemoteInvoke;
    const maker = createMobileMakerTransport({ deviceId: 'old-desk', invoke });
    await expect(maker.listPluginEngines()).resolves.toEqual([]);
    await expect(maker.refreshPluginEngines()).resolves.toBeUndefined();
    await expect(maker.getPluginEngineUsage("demo:engine")).resolves.toBeNull();
  });

  // Unit, #11563: a failed refresh used to look like a real empty catalogue,
  // hiding a working engine's quota. An actual empty reply still withdraws it.
  it('keeps the last known usage capability through a temporary connection failure', async () => {
    setMobileAuthOwner('catalogue-owner');
    const deviceId = 'interrupted-refresh';
    try {
      const invoke = vi.fn().mockResolvedValueOnce([{ ...desktopView, reportsUsage: true }])
        .mockRejectedValueOnce(new Error('connection unavailable')).mockResolvedValueOnce([]);
      const maker = createMobileMakerTransport({ deviceId, invoke });
      await loadPluginEngines(deviceId, maker);
      await loadPluginEngines(deviceId, maker);
      expect(getCachedPluginEngines(deviceId)[0]?.reportsUsage).toBe(true);
      await loadPluginEngines(deviceId, maker);
      expect(getCachedPluginEngines(deviceId)).toEqual([]);
    } finally {
      setMobileAuthOwner(null);
    }
  });

  // The catalogue may contain private model names and plugin metadata. An old account's
  // unresolved list must neither be reused nor publish into the next account's picker.
  it('discards a late engine list when the mobile account changes', async () => {
    setMobileAuthOwner('older-account');
    const [oldEngine] = normalizePluginEngines([desktopView]);
    let finishOld!: (engines: MobilePluginEngine[]) => void;
    const oldRequest = new Promise<MobilePluginEngine[]>((resolve) => { finishOld = resolve; });
    const refreshPluginEngines = vi.fn(async () => undefined);
    const deviceId = 'same-catalogue-device';
    try {
      const before = loadPluginEngines(deviceId, { listPluginEngines: () => oldRequest, refreshPluginEngines });
      setMobileAuthOwner('current-account');
      const listPluginEngines = vi.fn(async () => []);
      const after = loadPluginEngines(deviceId, { listPluginEngines, refreshPluginEngines });
      finishOld([oldEngine!]);
      await Promise.all([before, after]);
      expect(listPluginEngines).toHaveBeenCalledOnce();
      expect(getCachedPluginEngines(deviceId)).toEqual([]);
    } finally {
      setMobileAuthOwner(null);
    }
  });
});

describe('the pending engine switch the computer projects', () => {
  it('routes a plugin-engine intent to its own field and keeps built-in intents unchanged', () => {
    expect(sessionAgentSwitchIntentPatch({ targetAgentKind: 'acp', model: 'deepseek-v4', providerId: DSH, effort: 'max' }))
      .toEqual({ agentSwitchIntent: null, pluginEngineSwitchIntent: { providerId: DSH, model: 'deepseek-v4', effort: 'max' } });
    expect(sessionAgentSwitchIntentPatch({ targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null }))
      .toEqual({ agentSwitchIntent: { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null }, pluginEngineSwitchIntent: null });
    // Without the engine identity an 'acp' intent is not an intent at all.
    expect(sessionAgentSwitchIntentPatch({ targetAgentKind: 'acp', model: 'default', providerId: 'openai' }))
      .toEqual({ agentSwitchIntent: null, pluginEngineSwitchIntent: null });
  });

  // The store receives a scoped ACP intent over the existing task patch. The picker must
  // distinguish another computer from an explicit return home or a legacy omitted device.
  it.each([
    [{ agentDeviceId: 'studio' }, 'studio'],
    [{ agentDeviceId: null }, null],
    [{}, 'original'],
  ] as const)('keeps the execution computer for %j', (location, expectedDeviceId) => {
    const { pluginEngineSwitchIntent } = sessionAgentSwitchIntentPatch({
      targetAgentKind: 'acp', model: 'deepseek-v4', providerId: DSH, ...location,
    });
    expect(pluginEngineSwitchIntent).toEqual({ providerId: DSH, model: 'deepseek-v4', ...location });
    expect(pluginEngineExecutionDeviceId('original', pluginEngineSwitchIntent)).toBe(expectedDeviceId);
  });
});

describe('creating a task on a plugin engine', () => {
  const draft: NewSessionDraft = {
    agentKind: 'claude-code', workspaceKind: 'project', workingDir: '/repo', model: 'claude-fable-5',
    providerId: 'xd', effort: 'high', permissionMode: 'bypassPermissions', fastMode: true, firstMessage: 'hi',
    agentDeviceId: 'mac-mini',
  };

  it('sends the engine fields instead of the built-in route, on this computer and without Fast', () => {
    const opts = buildRemoteCreateSessionOptions(applyPluginEnginePick(draft, {
      providerId: DSH, model: 'deepseek-v4', effort: 'max', permissionMode: 'default',
    }));
    expect(opts).toMatchObject({
      agentKind: 'acp', providerId: DSH, model: 'deepseek-v4', effort: 'max', permissionMode: 'default',
      fastMode: false, workspaceKind: 'project', workingDir: '/repo',
    });
    expect(opts).not.toHaveProperty('agentDeviceId');
  });

  // 桌面对插件引擎隐藏额外目录、引擎也不接受；手机此前仍把记住的额外目录带进创建。最小失败输入：extraDirs=['/docs']。
  it('does not send extra directories the engine cannot use', () => {
    const opts = buildRemoteCreateSessionOptions(applyPluginEnginePick({ ...draft, extraDirs: ['/docs'] }, {
      providerId: DSH, model: 'deepseek-v4', effort: '', permissionMode: 'default',
    }));
    expect(opts).not.toHaveProperty('extraDirs');
    expect(buildRemoteCreateSessionOptions({ ...draft, extraDirs: ['/docs'] })).toMatchObject({ extraDirs: ['/docs'] });
  });

  it('leaves the built-in options untouched when no engine is picked', () => {
    expect(buildRemoteCreateSessionOptions(applyPluginEnginePick(draft, null))).toMatchObject({
      agentKind: 'claude-code', providerId: 'xd', model: 'claude-fable-5', fastMode: true, agentDeviceId: 'mac-mini',
    });
  });
});

describe('a task running on a plugin engine', () => {
  const [engine] = normalizePluginEngines([desktopView]) as [MobilePluginEngine];
  const labels = { defaultModel: 'Default model', effort: (id: string) => `level:${id}` };

  it('shows the engine models, levels and modes, keeps host switches, has no Fast, and enables plan mode only when declared', () => {
    const host = {
      availableModels: [{ id: 'claude-fable-5', label: 'Fable', efforts: ['high'], effortDisplayNames: {}, defaultEffort: 'high', supportsFastMode: true }],
      effortLevels: [], permissionModes: [{ id: 'acceptEdits', label: 'Accept edits' }],
      hasFastMode: true, planModeSupported: true, supportsSessionAgentSwitch: true,
    };
    const caps = pluginEngineSessionCapabilities(host, engine, labels);
    expect(caps).toMatchObject({
      hasFastMode: false, planModeSupported: true, supportsSessionAgentSwitch: true,
      permissionModes: [{ id: 'default' }, { id: 'plan' }, { id: 'bypassPermissions' }],
    });
    expect(caps.availableModels).toEqual([expect.objectContaining({
      id: 'deepseek-v4', label: 'DeepSeek-V4-Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high', supportsFastMode: false,
    })]);
    const [withoutPlan] = normalizePluginEngines([{
      ...desktopView,
      permissionModes: [{ id: 'default', displayName: 'Default' }, { id: 'bypassPermissions', displayName: 'Allow all' }],
    }]) as [MobilePluginEngine];
    expect(pluginEngineSessionCapabilities(host, withoutPlan, labels).planModeSupported).toBe(false);
  });

  // 2026-11-20 用户反馈：只安装了插件但尚未登录/不可用(unavailable)的引擎不在模型选择器里占位；仅当前已选该引擎时保留提示。
  // An explicitly closed default is absent even with an empty catalog (unit, mobile picker).
  it('does not recreate a default when the host has turned it off', () => {
    const engines = normalizePluginEngines([{ ...desktopView, models: [], defaultModelAllowed: false }]);
    expect(engines[0]).toMatchObject({ defaultModelAllowed: false, models: [] });
    expect(buildPluginEngineGroups({ engines, active: null }, '', { ...labels, unavailable: () => '' })).toEqual([]);
  });

  it('omits an unavailable engine unless it is already the active selection', () => {
    const [unavailable] = normalizePluginEngines([{ ...desktopView, providerId: 'acp-plugin:_ns__local__agy:agy',
      name: 'Antigravity', availability: { state: 'unavailable', message: 'Install agy' } }]);
    const groups = buildPluginEngineGroups({ engines: [unavailable!, engine], active: { providerId: DSH, modelId: 'deepseek-v4' } }, '', {
      ...labels,
      unavailable: (name, hint) => `${name} unavailable: ${hint}`,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows[0]).toMatchObject({ disabled: false, selected: true, effort: 'high', effortLabel: 'level:high' });

    const activeUnavailable = buildPluginEngineGroups(
      { engines: [unavailable!], active: { providerId: unavailable!.providerId, modelId: 'default' } },
      '',
      { ...labels, unavailable: (name, hint) => `${name} unavailable: ${hint}` },
    );
    expect(activeUnavailable[0]?.rows[0]).toMatchObject({ disabled: true, notice: 'Antigravity unavailable: Install agy', selected: true });
    expect(buildPluginEngineGroups({ engines: [engine], active: null }, 'nothing matches', {
      ...labels, unavailable: () => '',
    })).toEqual([]);
  });

  // 2026-11-22：电脑上的「设置 → 模型供应商」可以把插件引擎从模型选择器中隐藏(引擎列表追加可选 hidden)。
  // 生产入口：normalizePluginEngines(device-link 回包) + buildPluginEngineGroups(选择器分组)。
  // 依据：隐藏只改陈列，Desktop 与 Mobile 选择器同一口径，已选着它的任务照常显示。此前的用例没有这个字段。
  // 最小失败输入：隐藏的引擎仍列在选择器里；当前任务选着的引擎被隐藏后选不中 / 不显示；hidden 不是 true 也被隐藏。
  it('omits an engine hidden on its computer unless the task is already on it', () => {
    const [hidden, notHidden] = normalizePluginEngines([
      { ...desktopView, hidden: true },
      { ...desktopView, providerId: 'acp-plugin:_ns__local__agy:agy', name: 'Antigravity', hidden: 'yes' },
    ]);
    expect(hidden).toMatchObject({ providerId: DSH, hidden: true });
    expect(notHidden).not.toHaveProperty('hidden');
    const picker = (active: { providerId: string; modelId: string } | null) =>
      buildPluginEngineGroups({ engines: [hidden!, notHidden!], active }, '', { ...labels, unavailable: () => '' })
        .map((group) => group.title);
    expect(picker(null)).toEqual(['Antigravity']);
    expect(picker({ providerId: DSH, modelId: 'deepseek-v4' })).toEqual(['DeepSeek Harness', 'Antigravity']);
  });

  // Unit: Mobile model picker plugin engine group header quota formatting (windows, expired
  // windows falling back to balances, and depleted balance warning). Minimal failing input:
  // tightest window not chosen or balance-only plugin returns undefined.
  it('formats plugin engine picker quota from tightest unexpired window or currency balance', () => {
    const now = 1_700_000_000_000;
    const countdown = (resetsAtSec: number) => `${Math.round((resetsAtSec * 1000 - now) / 3_600_000)}h`;
    expect(formatPluginEnginePickerQuota({
      updatedAt: now,
      windows: [
        { label: 'Weekly', remainingPercent: 80, resetsAt: now + 24 * 3_600_000 },
        { label: '5h', remainingPercent: 20, resetsAt: now + 2 * 3_600_000 },
        { label: 'Expired', remainingPercent: 0, resetsAt: now - 1000 },
      ],
    }, now, 'en-US', countdown)).toEqual({
      summary: '20% · 2h',
      remaining: 20,
      level: 'warn',
      accessibilityLabel: '5h · 20% · 2h',
      groups: [
        {
          id: 'default',
          label: '5h',
          remaining: 20,
          level: 'warn',
          reset: '2h',
          summary: '20% · 2h',
          accessibilityLabel: '5h · 20% · 2h',
        },
      ],
    });

    // Multi-group plugin engine (Antigravity): Gemini and Claude & GPT stay separate.
    const agyUsage = {
      updatedAt: now,
      windows: [
        { label: 'Gemini Models · weekly', remainingPercent: 89, resetsAt: now + 6 * 24 * 3_600_000 },
        { label: 'Gemini Models · 5h', remainingPercent: 8.4, resetsAt: now + 3_600_000 },
        { label: 'Claude and GPT models · weekly', remainingPercent: 84.09, resetsAt: now + 6 * 24 * 3_600_000 },
        { label: 'Claude and GPT models · 5h', remainingPercent: 100 },
      ],
    };
    expect(formatPluginEnginePickerQuota(agyUsage, now, 'en-US', countdown)).toEqual({
      summary: 'Gemini 8% · Claude & GPT 84%',
      level: 'crit',
      accessibilityLabel: 'Gemini · 8% · 1h · Claude & GPT · 84% · 144h',
      isMultiGroup: true,
      groups: [
        {
          id: 'label:gemini models',
          label: 'Gemini',
          remaining: 8,
          level: 'crit',
          reset: '1h',
          summary: '8% · 1h',
          accessibilityLabel: 'Gemini · 8% · 1h',
        },
        {
          id: 'label:claude and gpt models',
          label: 'Claude & GPT',
          remaining: 84,
          level: 'normal',
          reset: '144h',
          summary: '84% · 144h',
          accessibilityLabel: 'Claude & GPT · 84% · 144h',
        },
      ],
    });
    expect(formatPluginEngineModelQuotaLabel(agyUsage, { id: 'gemini-4-neon', name: 'Gemini 4 Neon' }, now, countdown)).toBe('1h · 8%');
    expect(formatPluginEngineModelQuotaLabel(agyUsage, { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' }, now, countdown)).toBe('1h · 8%');
    expect(formatPluginEngineModelQuotaLabel(agyUsage, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, now, countdown)).toBe('144h · 84%');
    expect(formatPluginEngineModelQuotaLabel(agyUsage, { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }, now, countdown)).toBe('144h · 84%');

    expect(formatPluginEnginePickerQuota({
      updatedAt: now,
      windows: [{ label: 'Expired', remainingPercent: 0, resetsAt: now - 1000 }],
      balances: [{ currency: 'USD', amount: '12.50' }],
    }, now, 'en-US', countdown)).toMatchObject({
      level: 'normal',
      summary: expect.stringContaining('12.50'),
    });

    expect(formatPluginEnginePickerQuota({
      updatedAt: now,
      balances: [{ currency: 'CNY', amount: '0' }],
    }, now, 'zh-CN', countdown)).toMatchObject({
      level: 'crit',
    });

    expect(formatPluginEnginePickerQuota(null, now, 'en-US', countdown)).toBeUndefined();
  });

  // 回归：Mobile 会话页的模型选择器需与 Desktop 保持一致，对除 review 外的所有任务来源开放插件引擎切换。
  it.each([
    ['desktop', true],
    ['bot', true],
    ['x', true],
    ['feishu', true],
    ['telegram', true],
    ['discord', true],
    ['discord-hook', true],
    ['slack', true],
    ['wechat', true],
    ['dingtalk', true],
    ['wecom', true],
    ['imessage', true],
    ['learn', true],
    ['cindy-make', true],
    ['scheduler', true],
    [null, true],
    ['review', false],
  ] as const)('switch source allowlist: %s -> %s', (source, allowed) => {
    expect(isPluginEngineSwitchSourceAllowed(source)).toBe(allowed);
  });

  // 生产入口：resolveMobilePluginEngineFavorite + matchesPluginEngineFavoriteQuery。
  // 规则依据：protocol-compatibility/plugin-harnesses.md「插件引擎模型收藏」— 已隐藏但可用的引擎照常解析收藏，
  // 不可用引擎、被关闭模型与 defaultModelAllowed=false 不解析也不删原收藏。
  // 覆盖缺口：此前手机端无插件引擎收藏解析逻辑。最小失败输入与 tier：unit，传入 hidden/unavailable/defaultModelAllowed=false。
  it('resolves plugin engine favorites including hidden engines while rejecting unavailable or disallowed models', () => {
    const [hidden] = normalizePluginEngines([{ ...desktopView, hidden: true }]) as [MobilePluginEngine];
    const [unavailable] = normalizePluginEngines([{
      ...desktopView,
      providerId: 'acp-plugin:_ns__local__agy:agy',
      name: 'Antigravity',
      availability: { state: 'unavailable', message: 'Install agy' },
    }]) as [MobilePluginEngine];
    const [noDefault] = normalizePluginEngines([{
      ...desktopView,
      providerId: 'acp-plugin:nodefault:cli',
      name: 'NoDefault',
      defaultModelAllowed: false,
    }]) as [MobilePluginEngine];

    const fav = {
      uid: 'fav-1',
      providerId: hidden.providerId,
      modelId: 'deepseek-v4',
      agent: 'claude-code' as const,
      effort: 'max',
      fast: false,
    };
    const resolved = resolveMobilePluginEngineFavorite(fav, [hidden, unavailable, noDefault], labels);
    expect(resolved).toMatchObject({
      key: 'fav-1',
      providerId: hidden.providerId,
      modelId: 'deepseek-v4',
      title: 'DeepSeek-V4-Pro',
      subtitle: 'DeepSeek Harness',
      effort: 'max',
      effortLabel: 'level:max',
      selected: false,
      disabled: false,
      favorite: fav,
    });
    expect(matchesPluginEngineFavoriteQuery(resolved!, 'deepseek')).toBe(true);
    expect(matchesPluginEngineFavoriteQuery(resolved!, 'nonexistent')).toBe(false);
    // Unavailable engine, missing model, and closed default do not resolve.
    expect(resolveMobilePluginEngineFavorite({ ...fav, providerId: unavailable.providerId }, [hidden, unavailable], labels)).toBeNull();
    expect(resolveMobilePluginEngineFavorite({ ...fav, modelId: 'removed' }, [hidden], labels)).toBeNull();
    expect(resolveMobilePluginEngineFavorite({ ...fav, providerId: noDefault.providerId, modelId: 'default' }, [noDefault], labels)).toBeNull();
  });

  // Unit: remote & shared plugin engines via maker:model-catalog:read (excluding built-in shares),
  // per-model quota window filtering, and agentDeviceId round-trip in create-session options.
  it('filters remote model locations, normalizes offered remote engines, and formats per-model quotas', async () => {
    const locations = parseControlledModelLocations('host-a', {
      locations: [
        { agentDeviceId: 'studio', name: 'Studio Mac' },
        {
          agentDeviceId: 'share:plugin-1',
          name: 'Alice DSH',
          favoriteSource: { shareId: 'plugin-1', memberId: 'alice', providerId: DSH, owner: { region: 'global' } },
        },
        {
          agentDeviceId: 'share:builtin-1',
          name: 'Built-in Share',
          favoriteSource: { shareId: 'builtin-1', memberId: 'bob', providerId: 'openai', owner: { region: 'global' } },
        },
      ],
    });
    expect(locations.map((loc) => loc.agentDeviceId)).toEqual(['studio', 'share:plugin-1']);

    const offered = normalizeOfferedRemotePluginEngines(
      [
        { ...desktopView, remoteUse: { supported: true, enabled: true }, hidden: true, reportsUsage: true },
        { ...desktopView, providerId: 'acp-plugin:local-only:eng', remoteUse: { supported: true, enabled: false } },
      ],
      { deviceId: 'studio', deviceName: 'Studio Mac' },
    );
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ providerId: DSH, deviceId: 'studio', deviceName: 'Studio Mac', reportsUsage: true });
    expect(offered[0]).not.toHaveProperty('hidden');
    expect(pluginEngineChoiceKey(offered[0]!)).toBe(`studio\n${DSH}`);

    const sharedOffered = normalizeOfferedRemotePluginEngines(
      [{ ...desktopView, remoteUse: { supported: true, enabled: true }, reportsUsage: true }],
      { deviceId: 'share:plugin-1', deviceName: 'Alice DSH' },
    );
    expect(sharedOffered[0]?.reportsUsage).toBeUndefined();

    setMobileAuthOwner('remote-plugin-owner');
    try {
      const invoke = vi.fn(async () => [
        { ...desktopView, remoteUse: { supported: true, enabled: true } },
      ]) as unknown as RemoteInvoke;
      await loadControlledPluginEngines('host-a', 'studio', invoke, {
        deviceName: 'Studio Mac',
        force: true,
      });
      expect(invoke).toHaveBeenCalledWith('host-a', 'maker:model-catalog:read', [{
        op: 'read',
        agentDeviceId: 'studio',
        channel: 'maker:list-plugin-engines',
        args: [],
      }]);
      const loaded = getCachedControlledPluginEngines('host-a', 'studio');
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({
        providerId: DSH,
        deviceId: 'studio',
        deviceName: 'Studio Mac',
      });

      // Transient timeout keeps the last known catalog; PRECONDITION_FAILED (revoked source) evicts it.
      const timeoutInvoke = vi.fn(async () => {
        throw Object.assign(new Error('[DEVICE_LINK_TIMEOUT] slow'), { code: 'DEVICE_LINK_TIMEOUT' });
      }) as unknown as RemoteInvoke;
      await loadControlledPluginEngines('host-a', 'studio', timeoutInvoke, { force: true });
      expect(getCachedControlledPluginEngines('host-a', 'studio')).toHaveLength(1);

      const revokedInvoke = vi.fn(async () => {
        throw Object.assign(new Error('[PRECONDITION_FAILED] Model source is no longer available'), {
          code: 'PRECONDITION_FAILED',
        });
      }) as unknown as RemoteInvoke;
      await loadControlledPluginEngines('host-a', 'studio', revokedInvoke, { force: true });
      expect(getCachedControlledPluginEngines('host-a', 'studio')).toEqual([]);
    } finally {
      setMobileAuthOwner(null);
    }

    const now = 1_700_000_000_000;
    const countdown = (resetsAtSec: number) => `${Math.round((resetsAtSec * 1000 - now) / 3_600_000)}h`;
    const usage = {
      updatedAt: now,
      windows: [
        { label: 'V4-5h', remainingPercent: 42, resetsAt: now + 3 * 3_600_000, models: ['deepseek-v4'] },
        { label: 'Global', remainingPercent: 80, resetsAt: now + 5 * 3_600_000 },
      ],
    };
    expect(formatPluginEngineModelQuota(usage, 'deepseek-v4', now, countdown)).toBe('3h · 42%');
    expect(formatPluginEngineModelQuota(usage, 'other-model', now, countdown)).toBeNull();
    expect(formatPluginEngineModelQuota(usage, 'default', now, countdown)).toBeNull();

    const remoteCreateOpts = buildRemoteCreateSessionOptions(applyPluginEnginePick({
      agentKind: 'claude-code', workspaceKind: 'project', workingDir: '/repo', model: 'claude-fable-5',
      providerId: 'xd', effort: 'high', permissionMode: 'ask', fastMode: true, firstMessage: 'hi',
    }, {
      providerId: DSH, model: 'deepseek-v4', effort: 'high', permissionMode: 'default', agentDeviceId: 'share:plugin-1',
    }));
    expect(remoteCreateOpts).toMatchObject({
      agentKind: 'acp',
      providerId: DSH,
      model: 'deepseek-v4',
      agentDeviceId: 'share:plugin-1',
      fastMode: false,
    });
  });
});
