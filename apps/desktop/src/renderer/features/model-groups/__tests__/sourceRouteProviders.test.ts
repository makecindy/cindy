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
