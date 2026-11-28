/**
 * 测试价值
 * - 生产入口与可观察结果：withSourceRouteProviders(选模型面板列哪些供应商、点一行交出去的是谁)与
 *   implicitSourceRouteSelection(发送时这次任务经不经路由)。
 * - 规则依据：2026-11-24 用户裁决——合并后的路由在面板里是一个普通供应商，成员不再单列。
 * - 现有覆盖缺口：界面夹具 model-selector-source-routes 走的是点选的路径；草稿里原本就直接选着某个成员
 *   (升级前的草稿、最近、收藏)时既不经过点选，也没有别的测试覆盖。
 * - 最小失败输入：草稿直接选着成员的模型、没记路由——面板把它显示在合并条目下，发送却固定用那个成员；
 *   草稿选着成员自己才有的写法时，那个成员从面板里消失。
 * - tier：unit，纯函数。
 * - 实测耗时：单独运行不到 1 秒（pnpm exec vitest run src/renderer/features/model-groups/__tests__/sourceRouteProviders.test.ts）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { visiblePluginEngineChoices, type PluginEngineChoice } from '@/lib/pluginEngineSelection';
import type { ModelGroupsConfig } from '../../../../shared/modelGroups';
import { refreshModelGroups, saveModelGroups } from '../modelGroupsClient';
import {
  filterRemoteDeviceModelGroupsConfig,
  implicitSourceRouteSelection,
  userDefinedModelGroupRoutes,
  withSourceRoutePluginEngines,
  withSourceRouteProviders,
} from '../sourceRouteProviders';
import {
  buildPanelModelGroups,
  resolveModelSelectorDeviceGroups,
  resolveModelSelectorRoutingMode,
  resolveModelSelectorTriggerRouting,
  resolveStoredSourceRouteIdentity,
} from '../../../components/new-chat/modelSelectorSmartRouting';

const provider = (id: string, modelIds: string[]) => ({
  id, name: id, source: 'builtin', agents: ['codex'], auth: { method: 'api-key' }, connected: true, routing: { codex: {} },
  models: { codex: modelIds.map((modelId) => ({ id: modelId, name: modelId, efforts: [] })) },
}) as unknown as ProviderView;

const PROVIDERS = [provider('xd', ['gpt-5.5']), provider('openai', ['gpt-6-luna']), provider('byok-1', ['byok/gpt-6-luna', 'byok/only-here'])];
const config = (hidden = false): ModelGroupsConfig => ({
  sourceRoutes: [{ id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', auto: true, ...(hidden ? { hidden: true as const } : {}),
    sources: [{ providerId: 'openai' }, { providerId: 'byok-1' }] }],
  routes: [{ id: 'src:luna', name: 'GPT-6-LUNA', strategy: 'expiring', parent: { id: 'auto:openai', name: 'OpenAI' },
    ...(hidden ? { hidden: true as const } : {}),
    candidates: [
      { agentKind: 'codex', providerId: 'openai', model: 'gpt-6-luna' },
      { agentKind: 'codex', providerId: 'byok-1', model: 'byok/gpt-6-luna' },
    ] }],
});

describe('provider routes in the model picker', () => {
  it('lists one merged entry in the first member\'s place and maps a chosen row to a real member and its route', () => {
    const listed = withSourceRouteProviders(PROVIDERS, config());
    // 合并后的条目排在普通供应商前面：侧栏里它与「智能路由」那一格是一组。
    expect(listed.providers.map((item) => item.id)).toEqual(['sroute:auto:openai', 'xd']);
    expect(listed.hit('sroute:auto:openai', 'gpt-6-luna')).toMatchObject({ route: { id: 'src:luna' }, candidate: { providerId: 'openai', model: 'gpt-6-luna' } });
    expect(listed.hit('xd', 'gpt-5.5')).toBeNull();
    // 草稿里记着的成员、或选着的那条路由，在面板里都显示为合并后的条目。
    expect(listed.shownAs('openai')).toBe('sroute:auto:openai');
    expect(listed.shownAs(null, 'src:luna')).toBe('sroute:auto:openai');
  });

  it('keeps a member listed while the draft holds a model only that member writes this way', () => {
    const listed = withSourceRouteProviders(PROVIDERS, config(), { providerId: 'byok-1', modelId: 'byok/only-here' });
    expect(listed.providers.map((item) => item.id)).toEqual(['sroute:auto:openai', 'xd', 'byok-1']);
    expect(listed.shownAs('byok-1')).toBeNull();
  });

  it('leaves the list alone when the user hid the route', () => {
    expect(withSourceRouteProviders(PROVIDERS, config(true)).providers).toBe(PROVIDERS);
  });

  it('routes a task whose draft points straight at a member, unless the route is hidden or the provider is not a member', () => {
    expect(implicitSourceRouteSelection(config(), { providerId: 'byok-1', model: 'byok/gpt-6-luna' })).toEqual({ type: 'route', id: 'src:luna' });
    expect(implicitSourceRouteSelection(config(), { providerId: 'xd', model: 'gpt-5.5' })).toBeNull();
    expect(implicitSourceRouteSelection(config(true), { providerId: 'openai', model: 'gpt-6-luna' })).toBeNull();
  });

  it('merges local and shared ACP plugin engines into one picker entry and maps picks back to real member + route', () => {
    const localAgy: PluginEngineChoice = {
      key: 'antigravity:agy', providerId: 'acp-plugin:antigravity:agy', ghostId: 'antigravity', harnessId: 'agy',
      name: 'Antigravity', availability: { state: 'available' }, reportsUsage: true,
      models: [{ id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['high'] }],
      permissionModes: [], defaultPermissionMode: 'ask',
    };
    const sharedAgy: PluginEngineChoice = {
      ...localAgy, deviceId: 'share:dash-agy', deviceName: '来自 dash 的分享',
    };
    const otherPlugin: PluginEngineChoice = {
      ...localAgy, key: 'dsh:dsh', providerId: 'acp-plugin:dsh:dsh', name: 'DeepSeek',
    };
    const acpConfig: ModelGroupsConfig = {
      sourceRoutes: [
        {
          id: 'auto:antigravity', name: 'Antigravity', strategy: 'expiring', auto: true,
          sources: [
            { providerId: 'acp-plugin:antigravity:agy' },
            { providerId: 'acp-plugin:antigravity:agy', agentDeviceId: 'share:dash-agy' },
          ],
        },
        {
          // 混有内置供应商与插件引擎的手动路由由 withSourceRouteProviders 承载，不重复拼插件格。
          id: 'manual:mixed', name: 'Mixed', strategy: 'order',
          sources: [
            { providerId: 'openai' },
            { providerId: 'acp-plugin:dsh:dsh' },
          ],
        },
      ],
      routes: [
        {
          id: 'src:neon', name: 'Gemini 4 Neon', strategy: 'expiring',
          parent: { id: 'auto:antigravity', name: 'Antigravity' },
          candidates: [
            { agentKind: 'acp', providerId: 'acp-plugin:antigravity:agy', model: 'gemini-4-neon' },
            { agentKind: 'acp', providerId: 'acp-plugin:antigravity:agy', model: 'gemini-4-neon', agentDeviceId: 'share:dash-agy' },
          ],
        },
        {
          id: 'src:mixed', name: 'Mixed Model', strategy: 'order',
          parent: { id: 'manual:mixed', name: 'Mixed' },
          candidates: [
            { agentKind: 'codex', providerId: 'openai', model: 'gpt-6-luna' },
            { agentKind: 'acp', providerId: 'acp-plugin:dsh:dsh', model: 'gemini-4-neon' },
          ],
        },
      ],
    };
    const listed = withSourceRoutePluginEngines([localAgy, sharedAgy, otherPlugin], acpConfig, null, (name, n) => `${name} (${n})`);
    expect(listed.engines.map((e) => e.providerId)).toEqual(['sroute:auto:antigravity', 'acp-plugin:dsh:dsh']);
    expect(listed.engines[0]?.name).toBe('Antigravity (2)');
    expect(listed.engines[0]?.reportsUsage).toBeUndefined();
    expect(listed.hit('sroute:auto:antigravity', 'gemini-4-neon')).toMatchObject({
      route: { id: 'src:neon' },
      candidate: { agentKind: 'acp', providerId: 'acp-plugin:antigravity:agy', model: 'gemini-4-neon' },
    });
    expect(listed.shownAs('acp-plugin:antigravity:agy', null, 'share:dash-agy')).toBe('sroute:auto:antigravity');
    expect(listed.shownAs(null, 'src:neon')).toBe('sroute:auto:antigravity');
  });

  it('keeps a merged ACP route visible and selectable when the first member is unavailable or suspended while another member is available', () => {
    const unavailableFirst: PluginEngineChoice = {
      key: 'antigravity:agy', providerId: 'acp-plugin:antigravity:agy', ghostId: 'antigravity', harnessId: 'agy',
      name: 'Antigravity', availability: { state: 'unavailable', reason: 'not-signed-in' }, suspended: true,
      models: [{ id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['high'] }],
      permissionModes: [], defaultPermissionMode: 'ask',
    };
    const availableSecond: PluginEngineChoice = {
      ...unavailableFirst,
      availability: { state: 'available' },
      suspended: undefined,
      deviceId: 'share:dash-agy',
      deviceName: '来自 dash 的分享',
    };
    const acpConfig: ModelGroupsConfig = {
      sourceRoutes: [{
        id: 'manual:agy', name: 'Antigravity Pool', strategy: 'order',
        sources: [
          { providerId: 'acp-plugin:antigravity:agy' },
          { providerId: 'acp-plugin:antigravity:agy', agentDeviceId: 'share:dash-agy' },
        ],
      }],
      routes: [{
        id: 'src:neon', name: 'Gemini 4 Neon', strategy: 'order',
        parent: { id: 'manual:agy', name: 'Antigravity Pool' },
        candidates: [
          { agentKind: 'acp', providerId: 'acp-plugin:antigravity:agy', model: 'gemini-4-neon' },
          { agentKind: 'acp', providerId: 'acp-plugin:antigravity:agy', model: 'gemini-4-neon', agentDeviceId: 'share:dash-agy' },
        ],
      }],
    };
    const partial = withSourceRoutePluginEngines([unavailableFirst, availableSecond], acpConfig);
    expect(partial.engines[0]?.availability.state).toBe('available');
    expect(visiblePluginEngineChoices(partial.engines).map((e) => e.providerId)).toEqual(['sroute:manual:agy']);
    expect(partial.hit('sroute:manual:agy', 'gemini-4-neon')?.candidate).toMatchObject({
      agentKind: 'acp', providerId: 'acp-plugin:antigravity:agy', agentDeviceId: 'share:dash-agy',
    });

    const bothDown = withSourceRoutePluginEngines(
      [unavailableFirst, { ...availableSecond, availability: { state: 'unavailable' } }],
      acpConfig,
    );
    expect(bothDown.engines[0]?.availability.state).toBe('unavailable');
    expect(visiblePluginEngineChoices(bothDown.engines)).toEqual([]);
  });

  // 2026-11-27 回归：用户在供应商路由里把某个来源取消勾选(source.off=true)后，
  // 该来源必须恢复在选择器里独立显示且不再经 shownAs / hidesRemote / implicitSourceRouteSelection 跳回智能路由。
  it('restores a turned-off source as an independent provider and does not route it back into the source route', () => {
    const shareDeviceId = 'share:yan-1';
    const remoteMap = new Map([[shareDeviceId, [provider('openai', ['gpt-6-luna'])]]]);
    const pausedConfig: ModelGroupsConfig = {
      sourceRoutes: [{
        id: 'auto:openai',
        name: 'OpenAI',
        strategy: 'expiring',
        auto: true,
        sources: [
          { providerId: 'openai' },
          { providerId: 'byok-1', off: true },
          { providerId: 'openai', agentDeviceId: shareDeviceId, off: true },
        ],
      }],
      routes: [{
        id: 'src:luna',
        name: 'GPT-6-LUNA',
        strategy: 'expiring',
        parent: { id: 'auto:openai', name: 'OpenAI' },
        candidates: [
          { agentKind: 'codex', providerId: 'openai', model: 'gpt-6-luna' },
          { agentKind: 'codex', providerId: 'byok-1', model: 'byok/gpt-6-luna', off: true },
          { agentKind: 'codex', providerId: 'openai', model: 'gpt-6-luna', agentDeviceId: shareDeviceId, off: true },
        ],
      }],
    };
    const listed = withSourceRouteProviders(PROVIDERS, pausedConfig, undefined, remoteMap, (name, count) => `${name} (${count})`);
    // 取消参与的本机 byok-1 与分享 openai 均独立保留，合并条目只计入仍启用的 1 个来源。
    expect(listed.providers.map((item) => item.id)).toEqual(['sroute:auto:openai', 'xd', 'byok-1']);
    expect(listed.providers[0]?.name).toBe('OpenAI (1)');
    expect(listed.shownAs('byok-1')).toBeNull();
    expect(listed.shownAs('openai', null, shareDeviceId)).toBeNull();
    expect(listed.hidesRemote(shareDeviceId, 'openai')).toBe(false);
    // 仍启用的 openai 照常映射并走隐式路由；已取消参与的成员不再跳回智能路由。
    expect(listed.shownAs('openai')).toBe('sroute:auto:openai');
    expect(implicitSourceRouteSelection(pausedConfig, { providerId: 'openai', model: 'gpt-6-luna' })).toEqual({ type: 'route', id: 'src:luna' });
    expect(implicitSourceRouteSelection(pausedConfig, { providerId: 'byok-1', model: 'byok/gpt-6-luna' })).toBeNull();
    expect(implicitSourceRouteSelection(pausedConfig, { providerId: 'openai', model: 'gpt-6-luna', agentDeviceId: shareDeviceId })).toBeNull();
  });

  // 2026-11-27 回归：
  // 1) 已解除托管 / 未绑定智能路由的进行中任务(keepMember: true)运行在某个合并成员上时，必须保留该具体成员单列，
  //    不能隐藏它或强行映射回 sroute:，否则远程/分享来源点「全部」后会消失；
  // 2) 托管中的任务落在带不同 wire 前缀的成员(byok-1 的 byok/gpt-6-luna)上时，合并条目应映射回代表模型 id(gpt-6-luna)
  //    并不把 byok-1 漏回左侧栏。
  it('keeps detached concrete members visible and maps cross-prefix managed member wire ids', () => {
    const shareDeviceId = 'share:yan-1';
    const remoteMap = new Map<string, readonly ProviderView[]>([[shareDeviceId, [provider('openai', ['gpt-6-luna'])]]]);
    const sharedConfig: ModelGroupsConfig = {
      sourceRoutes: [{
        id: 'auto:openai',
        name: 'OpenAI',
        strategy: 'expiring',
        auto: true,
        sources: [{ providerId: 'openai' }, { providerId: 'byok-1' }, { providerId: 'openai', agentDeviceId: shareDeviceId }],
      }],
      routes: [{
        id: 'src:luna',
        name: 'GPT-6-LUNA',
        strategy: 'expiring',
        parent: { id: 'auto:openai', name: 'OpenAI' },
        candidates: [
          { agentKind: 'codex', providerId: 'openai', model: 'gpt-6-luna' },
          { agentKind: 'codex', providerId: 'byok-1', model: 'byok/gpt-6-luna' },
          { agentKind: 'codex', providerId: 'openai', model: 'gpt-6-luna', agentDeviceId: shareDeviceId },
        ],
      }],
    };
    // 已解除托管运行在远端分享上：该分享保持可见、不隐藏，也不误映射成 sroute:auto:openai。
    const detachedRemote = withSourceRouteProviders(
      PROVIDERS,
      sharedConfig,
      { providerId: 'openai', modelId: 'gpt-6-luna', agentDeviceId: shareDeviceId, keepMember: true },
      remoteMap,
    );
    expect(detachedRemote.hidesRemote(shareDeviceId, 'openai')).toBe(false);
    expect(detachedRemote.shownAs('openai', null, shareDeviceId)).toBeNull();
    // 仍在托管中且运行在带前缀的 byok-1 上：byok-1 不漏出，代表模型映射回 gpt-6-luna。
    const managedPrefixed = withSourceRouteProviders(
      PROVIDERS,
      sharedConfig,
      { providerId: 'byok-1', modelId: 'byok/gpt-6-luna', keepMember: false },
      remoteMap,
    );
    expect(managedPrefixed.providers.map((item) => item.id)).toEqual(['sroute:auto:openai', 'xd']);
    expect(managedPrefixed.shownAs('byok-1', 'src:luna')).toBe('sroute:auto:openai');
    expect(managedPrefixed.shownModelId('byok-1', 'byok/gpt-6-luna', 'src:luna')).toBe('gpt-6-luna');
    expect(managedPrefixed.shownModelId('byok-1', 'byok/gpt-6-luna', null)).toBe('gpt-6-luna');
  });

  // 2026-11-28 Auto 展示层按本机用量优先级上浮高频模型；非 Auto（如按顺序）保持原有目录顺序。
  it('floats higher-priority models to the top under Auto (expiring) merged routes only', () => {
    const multiProviders = [
      provider('openai', ['gpt-5-mini', 'gpt-6-astra', 'gpt-6-sol']),
      provider('byok-1', ['byok/gpt-5-mini', 'byok/gpt-6-astra', 'byok/gpt-6-sol']),
    ];
    const makeCfg = (strategy: 'expiring' | 'order'): ModelGroupsConfig => ({
      autoModelPriorities: { 'gpt-6-sol': 1, 'gpt-6-astra': 0.5 },
      sourceRoutes: [{
        id: 'auto:openai',
        name: 'OpenAI',
        strategy,
        auto: true,
        sources: [{ providerId: 'openai' }, { providerId: 'byok-1' }],
      }],
      routes: [
        {
          id: 'src:mini', name: 'GPT-5-mini', strategy, parent: { id: 'auto:openai', name: 'OpenAI' },
          candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-5-mini' }],
        },
        {
          id: 'src:astra', name: 'GPT-6-Astra', strategy, parent: { id: 'auto:openai', name: 'OpenAI' },
          candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-6-astra' }],
        },
        {
          id: 'src:sol', name: 'GPT-6-Sol', strategy, parent: { id: 'auto:openai', name: 'OpenAI' },
          candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-6-sol' }],
        },
      ],
    });
    const autoListed = withSourceRouteProviders(multiProviders, makeCfg('expiring'));
    expect(autoListed.providers[0]?.models.codex?.map((m) => m.id)).toEqual(['gpt-6-sol', 'gpt-6-astra', 'gpt-5-mini']);
    const orderListed = withSourceRouteProviders(multiProviders, makeCfg('order'));
    expect(orderListed.providers[0]?.models.codex?.map((m) => m.id)).toEqual(['gpt-5-mini', 'gpt-6-astra', 'gpt-6-sol']);
  });

  // 测试价值
  // - 生产入口与可观察结果：withSourceRouteProviders / isModelVisible / withSourceRoutePluginEngines(keepMember)。
  // - Bug／规则依据：2026-11-28 排查合并路由在首成员隐藏/停用时整体消失、sroute: 模型忽略真实成员可见性覆盖、
  //   以及已解除托管的 ACP 插件引擎被强行收进 sroute: 的问题。
  // - 现有覆盖缺口：此前用例中所有成员均为 connected 且未隐藏，未测首成员 hidden/suspended、成员级可见性与 ACP keepMember。
  // - 最小失败输入：首成员 hidden=true/suspended=true 而次成员正常；成员模型 defaultEnabled=false 但在该成员上被显式启用；
  //   ACP 会话 keepMember=true 运行在某成员上。
  // - tier：unit（纯函数，Node 环境）。
  it('does not inherit hidden/suspended from first member, evaluates member visibility, and respects ACP keepMember', () => {
    const hiddenFirst = {
      ...provider('openai', ['gpt-6-luna']),
      hidden: true,
      suspended: true,
      subscriptionAccountPool: 'openai' as const,
      models: { codex: [{ id: 'gpt-6-luna', name: 'gpt-6-luna', defaultEnabled: false, efforts: [] }] },
    } as unknown as ProviderView;
    const healthySecond = {
      ...provider('byok-1', ['byok/gpt-6-luna']),
      models: { codex: [{ id: 'byok/gpt-6-luna', name: 'byok/gpt-6-luna', defaultEnabled: false, efforts: [] }] },
    } as unknown as ProviderView;
    const listed = withSourceRouteProviders([hiddenFirst, healthySecond], config());
    const merged = listed.providers.find((item) => item.id === 'sroute:auto:openai')!;
    expect(merged.hidden).toBeUndefined();
    expect(merged.suspended).toBeUndefined();
    expect(merged.subscriptionAccountPool).toBeUndefined();
    expect(merged.connected).toBe(true);
    expect(listed.hit('sroute:auto:openai', 'byok/gpt-6-luna')?.candidate.providerId).toBe('byok-1');
    expect(listed.usageMember('sroute:auto:openai')?.provider.id).toBe('byok-1');
    // 任一真实成员显式启用该模型时，合并行可见；全部成员关闭时隐藏。
    expect(
      listed.isModelVisible('sroute:auto:openai', 'byok/gpt-6-luna', 'codex', (member) => member.providerId === 'byok-1'),
    ).toBe(true);
    expect(
      listed.isModelVisible('sroute:auto:openai', 'byok/gpt-6-luna', 'codex', () => false),
    ).toBe(false);

    const localAgy: PluginEngineChoice = {
      key: 'antigravity:agy', providerId: 'acp-plugin:antigravity:agy', ghostId: 'antigravity', harnessId: 'agy',
      name: 'Antigravity', availability: { state: 'available' },
      models: [{ id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['high'] }],
      permissionModes: [], defaultPermissionMode: 'ask',
    };
    const sharedAgy: PluginEngineChoice = { ...localAgy, deviceId: 'share:dash-agy', deviceName: 'dash' };
    const acpConfig: ModelGroupsConfig = {
      sourceRoutes: [{
        id: 'auto:antigravity', name: 'Antigravity', strategy: 'expiring', auto: true,
        sources: [
          { providerId: 'acp-plugin:antigravity:agy' },
          { providerId: 'acp-plugin:antigravity:agy', agentDeviceId: 'share:dash-agy' },
        ],
      }],
      routes: [{
        id: 'src:neon', name: 'Gemini 4 Neon', strategy: 'expiring',
        parent: { id: 'auto:antigravity', name: 'Antigravity' },
        candidates: [
          { agentKind: 'acp', providerId: 'acp-plugin:antigravity:agy', model: 'gemini-4-neon' },
          { agentKind: 'acp', providerId: 'acp-plugin:antigravity:agy', model: 'gemini-4-neon', agentDeviceId: 'share:dash-agy' },
        ],
      }],
    };
    const detachedAcp = withSourceRoutePluginEngines(
      [localAgy, sharedAgy],
      acpConfig,
      { providerId: 'acp-plugin:antigravity:agy', modelId: 'gemini-4-neon', deviceId: 'share:dash-agy', keepMember: true },
    );
    expect(detachedAcp.engines.some((item) => item.providerId === 'acp-plugin:antigravity:agy' && item.deviceId === 'share:dash-agy')).toBe(true);
    expect(detachedAcp.shownAs('acp-plugin:antigravity:agy', null, 'share:dash-agy')).toBeNull();
  });
});

// 测试价值
// - 生产入口与可观察结果：resolveModelSelectorRoutingMode / resolveModelSelectorDeviceGroups /
//   buildPanelModelGroups / resolveModelSelectorTriggerRouting / resolveStoredSourceRouteIdentity /
//   filterRemoteDeviceModelGroupsConfig。
// - Bug／规则依据：model-groups.md §3.1、§3.5、§6.3；2026-11-28 整理模型选择器智能路由逻辑时发现：
//   1) 远程设备「其他电脑」格混入远端供应商路由展开项与不可远程调用的路由；
//   2) 远控无 remoteAgent 时 sourceRouteCatalogHostId 落成 undefined 导致跨机成员查错宿主；
//   3) 面板未启用合并路由时仍错把 route.parent 从「智能路由」格剥掉；
//   4) 远程设备路由 ID 与本机展开路由冲突时触发器误判为本机供应商路由；
//   5) 种子收藏可能把虚拟 sroute: 写入本机收藏。
// - 现有覆盖缺口：此前无针对模型选择器智能路由编排层的纯函数单测。
// - 最小失败输入：远程电脑只有展开路由 + 非远程调用路由；deviceIdProp 非空但 remoteAgent 缺省；
//   onAttach 无 onUnifiedSelect；active 带 deviceId；sroute: 仅含远端候选。
// - tier：unit（纯函数，Node 环境）。
describe('modelSelectorSmartRouting', () => {
  it('filters remote device routes to user-defined remote-invocable modes while keeping hours targets and active selection', () => {
    const remoteConfig: ModelGroupsConfig = {
      sourceRoutes: [{
        id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', auto: true,
        sources: [{ providerId: 'openai' }],
      }],
      routes: [
        // 展开供应商路由：绝不进「其他电脑」模式格。
        {
          id: 'src:gpt', name: 'GPT-6', strategy: 'expiring',
          parent: { id: 'auto:openai', name: 'OpenAI' },
          candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-6' }],
        },
        // 本机允许远程调用的路由：保留。
        {
          id: 'r-ok', name: 'Remote OK', strategy: 'order',
          candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-6' }],
        },
        // 仅含未开远程调用供应商的路由：过滤掉。
        {
          id: 'r-private', name: 'Private Only', strategy: 'order',
          candidates: [{ agentKind: 'codex', providerId: 'local-only', model: 'gpt-6' }],
        },
        // 仅含它机成员的路由：过滤掉。
        {
          id: 'r-hop', name: 'Second Hop', strategy: 'order',
          candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-6', agentDeviceId: 'third-pc' }],
        },
        // 自身候选不可达，但时段例外指向可达路由 r-ok：保留。
        {
          id: 'r-hours', name: 'Night Redirect', strategy: 'order',
          candidates: [{ agentKind: 'codex', providerId: 'local-only', model: 'gpt-6' }],
          exceptions: [{ when: { type: 'hours', from: 22, to: 8 }, use: { type: 'route', routeId: 'r-ok' } }],
        },
      ],
    };
    expect(userDefinedModelGroupRoutes(remoteConfig).map((r) => r.id)).toEqual(['r-ok', 'r-private', 'r-hop', 'r-hours']);
    const filtered = filterRemoteDeviceModelGroupsConfig(remoteConfig, {
      remoteInvocableProviderIds: new Set(['openai']),
    });
    expect(filtered.routes.map((r) => r.id)).toEqual(['r-ok', 'r-hours']);

    const choices = resolveModelSelectorDeviceGroups({
      devices: [
        { deviceId: 'mac-b', name: 'Mac B', config: remoteConfig },
        { deviceId: 'mac-c', name: 'Mac C', config: { routes: [remoteConfig.routes[0]!] } },
      ],
      remoteAgentGroups: [
        { deviceId: 'mac-b', providers: [provider('openai', ['gpt-6'])] },
        { deviceId: 'mac-c', providers: [provider('openai', ['gpt-6'])] },
      ],
      active: { type: 'route', id: 'r-private', deviceId: 'mac-b' },
    });
    // mac-c 只有展开路由，整台被剔除；mac-b 保留可达路由及当前已选中的 r-private。
    expect(choices.map((d) => d.deviceId)).toEqual(['mac-b']);
    expect(choices[0]?.config.routes.map((r) => r.id)).toEqual(['r-ok', 'r-private', 'r-hours']);
  });

  it('keeps routing mode, catalog host fallback, panel sanitization, trigger projection, and stored identity consistent', () => {
    const cfg = config();
    // 远控会话无 remoteAgent 时，跨机目录宿主必须回退到 deviceIdProp。
    const controlledSession = resolveModelSelectorRoutingMode({
      modelGroups: { config: cfg, active: null, onSelect: vi.fn(), onPickMerged: vi.fn() },
      hasUnifiedSelect: false,
      providersOverride: false,
      sshCatalog: false,
      currentProviderId: 'openai',
      modelId: 'gpt-6-luna',
      remoteAgentDeviceId: null,
      deviceIdProp: 'host-mac',
    });
    expect(controlledSession.mergedSourceRoutesEnabled).toBe(true);
    expect(controlledSession.sourceRouteCatalogHostId).toBe('host-mac');
    expect(controlledSession.keepCurrentMember).toBe(true);

    // onAttach 但缺少 onUnifiedSelect（旧端退化）时，不启用合并供应商路由，也不剥离 route.parent。
    const degradedDraft = resolveModelSelectorRoutingMode({
      modelGroups: { config: cfg, active: null, onSelect: vi.fn(), onAttach: vi.fn() },
      hasUnifiedSelect: false,
      providersOverride: false,
      sshCatalog: false,
      currentProviderId: 'openai',
      modelId: 'gpt-6-luna',
      remoteAgentDeviceId: null,
    });
    expect(degradedDraft.mergedSourceRoutesEnabled).toBe(false);
    const panelGroups = buildPanelModelGroups({
      modelGroups: { config: cfg, active: null, onSelect: vi.fn(), onAttach: vi.fn() },
      mergedSourceRoutesEnabled: degradedDraft.mergedSourceRoutesEnabled,
      devices: [],
    });
    expect(panelGroups?.config.routes.map((r) => r.id)).toEqual(['src:luna']);

    // 选中远程设备的路由时（active.deviceId 非空），即使 ID 与本机展开路由相同也不误认作本机供应商路由。
    const remoteChoiceTrigger = resolveModelSelectorTriggerRouting({
      modelGroups: {
        config: cfg,
        active: { type: 'route', id: 'src:luna', deviceId: 'mac-b' },
        onSelect: vi.fn(),
        onAttach: vi.fn(),
        devices: [{
          deviceId: 'mac-b',
          name: 'Mac B',
          config: { routes: [{ id: 'src:luna', name: 'Remote Mode', strategy: 'order', candidates: [] }] },
        }],
      },
      hasUnifiedSelect: true,
      providersOverride: false,
      sshCatalog: false,
      checkSavedSource: false,
      currentProviderId: 'openai',
      modelId: 'gpt-6-luna',
      agentDeviceId: null,
      t: ((key: string) => key) as unknown as import('i18next').TFunction,
    });
    expect(remoteChoiceTrigger.activeSourceRouteName).toBeNull();
    expect(remoteChoiceTrigger.shownModelGroupRow?.name).toBe('Remote Mode · Mac B');

    // resolveStoredSourceRouteIdentity 还原真实本机成员；仅含远端候选时返回 null，避免虚拟 sroute: 落盘。
    const shareOnlyConfig: ModelGroupsConfig = {
      sourceRoutes: [{
        id: 'manual:share-only', name: 'Share Pool', strategy: 'order',
        sources: [{ providerId: 'openai', agentDeviceId: 'share:s1' }],
      }],
      routes: [{
        id: 'src:share-luna', name: 'GPT-6-LUNA', strategy: 'order',
        parent: { id: 'manual:share-only', name: 'Share Pool' },
        candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-6-luna', agentDeviceId: 'share:s1' }],
      }],
    };
    const localMerged = withSourceRouteProviders(PROVIDERS, cfg);
    expect(resolveStoredSourceRouteIdentity(localMerged, 'sroute:auto:openai', 'gpt-6-luna')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-6-luna',
    });
    const shareOnlyMerged = withSourceRouteProviders(
      [],
      shareOnlyConfig,
      undefined,
      new Map([['share:s1', [provider('openai', ['gpt-6-luna'])]]]),
    );
    expect(resolveStoredSourceRouteIdentity(shareOnlyMerged, 'sroute:manual:share-only', 'gpt-6-luna')).toBeNull();
  });
});

// 测试价值
// - 生产入口与可观察结果：refreshModelGroups / saveModelGroups——在途 get 晚于一次保存返回时，不把缓存盖成旧快照。
// - Bug 依据：2026-11-27 排查智能路由选「按权重」丢来源/路由时发现 refreshModelGroups 无代次保护，晚到的旧 get 会导致紧接着的 saveModelGroups 按旧快照覆盖磁盘。
// - 现有覆盖缺口：modelGroupsClient.ts 此前无并发 refresh/save 竞态单测。
// - 最小失败输入：保存期间挂起的旧读取返回后，主进程才有一条新发现的远程路由。下一次编辑必须同时保留已保存来源和新目录（PR #13547）。
// - tier：unit（纯 Node + 假 electronAPI，无 jsdom 开销）。
describe('modelGroupsClient refresh/save race', () => {
  it('reloads newly discovered routes without overwriting saved edits after an overlapping refresh', async () => {
    const initial: ModelGroupsConfig = {
      routes: [{ id: 'r1', name: 'Route 1', strategy: 'expiring', candidates: [] }],
    };
    const agyCandidate = {
      agentKind: 'acp' as const,
      providerId: 'acp-plugin:_root__cindy-antigravity-acp:agy',
      model: 'gemini-4-neon',
      agentDeviceId: 'share:dash-agy',
    };
    let resolveStaleGet!: (value: ModelGroupsConfig) => void;
    let persisted = initial;
    const discoveredRoute = {
      id: 'auto:antigravity',
      name: 'Antigravity',
      strategy: 'expiring' as const,
      auto: true as const,
      sources: [
        { providerId: agyCandidate.providerId },
        { providerId: agyCandidate.providerId, agentDeviceId: agyCandidate.agentDeviceId },
      ],
    };
    const get = vi.fn(async (): Promise<ModelGroupsConfig> => ({ ...persisted, sourceRoutes: [discoveredRoute] }))
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => new Promise<ModelGroupsConfig>((resolve) => { resolveStaleGet = resolve; }));
    const set = vi.fn(async (next: ModelGroupsConfig) => { persisted = next; return next; });
    const prevWindow = (globalThis as { window?: unknown }).window;
    Object.assign(globalThis, { window: { electronAPI: { modelGroups: { get, set } } } });
    try {
      await refreshModelGroups();
      const staleRefresh = refreshModelGroups();
      await saveModelGroups((latest) => ({
        ...latest,
        routes: latest.routes.map((route) => (route.id === 'r1' ? { ...route, candidates: [agyCandidate] } : route)),
      }));
      resolveStaleGet(initial);
      await staleRefresh;
      const afterStrategy = await saveModelGroups((latest) => ({
        ...latest,
        routes: latest.routes.map((route) => (route.id === 'r1' ? { ...route, strategy: 'weighted' } : route)),
      }));
      expect(afterStrategy.routes[0]?.strategy).toBe('weighted');
      expect(afterStrategy.routes[0]?.candidates).toEqual([agyCandidate]);
      expect(afterStrategy.sourceRoutes).toEqual([discoveredRoute]);
      expect(get).toHaveBeenCalledTimes(3);
    } finally {
      if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else Object.assign(globalThis, { window: prevWindow });
    }
  });
});
