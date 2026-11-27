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
import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { visiblePluginEngineChoices, type PluginEngineChoice } from '@/lib/pluginEngineSelection';
import type { ModelGroupsConfig } from '../../../../shared/modelGroups';
import {
  implicitSourceRouteSelection,
  withSourceRoutePluginEngines,
  withSourceRouteProviders,
} from '../sourceRouteProviders';

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
});
