/**
 * 测试价值
 * - 生产入口与可观察结果：writeModelGroupsConfig / readModelGroupsConfig——模式详情里的开关存下后，主进程读回的配置。
 * - 规则依据：docs/product-rules/model-groups.md §4.5 每个模式的「出问题时自动换来源」默认开，只存关掉的状态。
 * - 现有覆盖缺口：配置文件的写入没有测试。
 * - 最小失败输入：关掉开关后读回仍是开着；或关掉再打开后仍存着 false。
 * - tier：unit，真实文件读写，不启动 Electron。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ file: '' }));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../ownerContext.js', () => ({ ownerScopedPath: () => paths.file }));

import { modelGroupAutoSwitchOn, type ModelGroupRoute, type ModelGroupsConfig } from '../../../shared/modelGroups.js';
import type { PluginEngineView } from '../../../shared/pluginEngines.js';
import { createModelGroupRuntime } from '../runtimeCore.js';
import { readModelGroupsConfig, writeModelGroupsConfig } from '../store.js';

const ROUTE = { id: 'r1', name: 'R', strategy: 'order' as const, candidates: [{ agentKind: 'codex' as const, providerId: 'a', model: 'gpt' }] };

const REMOTE_AGY = (providerId: string): PluginEngineView => ({
  key: providerId.slice('acp-plugin:'.length),
  providerId,
  ghostId: 'cindy-antigravity-acp',
  harnessId: 'agy',
  name: 'Antigravity',
  availability: { state: 'available' },
  models: [{ id: 'gemini-4-neon', displayName: 'Gemini 4 Neon' }],
  permissionModes: [],
  defaultPermissionMode: 'ask',
  remoteUse: { supported: true, enabled: true, shareSupported: true },
});

afterEach(() => {
  if (paths.file) fs.rmSync(path.dirname(paths.file), { recursive: true, force: true });
});

describe('model groups store', () => {
  it('keeps one mode\'s auto switch off once the user turns it off, and clears it when turned back on', () => {
    paths.file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-store-')), 'model-groups.json');
    const save = (change: (latest: ModelGroupsConfig) => ModelGroupsConfig) => writeModelGroupsConfig(change(readModelGroupsConfig()));
    const editRoute = (patch: (r: ModelGroupRoute) => ModelGroupRoute) => save((latest) => ({ ...latest, routes: latest.routes.map(patch) }));
    save(() => ({ routes: [ROUTE, { ...ROUTE, id: 'r2' }] }));
    expect(readModelGroupsConfig().routes.map(modelGroupAutoSwitchOn)).toEqual([true, true]);
    // The mode page turns it off the way ModelGroupsSection does, for r1 only.
    editRoute((r) => (r.id === 'r1' ? { ...r, autoSwitch: false } : r));
    expect(readModelGroupsConfig().routes.map(modelGroupAutoSwitchOn)).toEqual([false, true]);
    // Editing the mode keeps the user's choice.
    editRoute((r) => (r.id === 'r1' ? { ...r, name: 'R2' } : r));
    expect(readModelGroupsConfig().routes[0]).toMatchObject({ name: 'R2', autoSwitch: false });
    // Turned back on: nothing is stored for it.
    editRoute(({ autoSwitch: _was, ...rest }) => rest);
    expect(readModelGroupsConfig().routes.map(modelGroupAutoSwitchOn)).toEqual([true, true]);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(paths.file, 'utf8')))).not.toContain('autoSwitch');
  });

  // 2026-11-26 审查发现：给自动合成的路由加的例外只存在内存里，写盘时被漏掉；只加了例外时整个文件还会被删掉。
  // 失效后果：例外一保存就消失。最小输入：只有一条自动路由的图片例外。
  it('keeps the exceptions of an automatic provider route on disk', () => {
    paths.file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-store-')), 'model-groups.json');
    const vision = { when: { type: 'image' as const }, use: 'vision' as const };
    writeModelGroupsConfig({ routes: [], autoExceptions: { 'auto:openai': [vision] } });
    expect(readModelGroupsConfig().autoExceptions).toEqual({ 'auto:openai': [vision] });
    expect(JSON.parse(fs.readFileSync(paths.file, 'utf8')).autoExceptions).toEqual({ 'auto:openai': [vision] });
  });

  // 测试价值
  // - 生产入口与可观察结果：createModelGroupRuntime().refreshAutoModelGroupRoutes + writeModelGroupsConfig / readModelGroupsConfig。
  // - Bug 依据：2026-11-27 用户反馈自动合并的共享 Antigravity 路由选「按权重」后消失——TTL 后台刷新时远端插件引擎读取失败或
  //   设备名单降级会覆盖清空已读到的 remotePluginEngines，导致紧接着 set({ autoStrategy }) 返回的 sourceRoutes 不再包含 auto:antigravity；
  //   同时 readWorkerAgentLocations 返回 favoriteSource.providerId 而非 providerIds，导致对插件分享仍发 remoteViews、对供应商分享仍发 remotePluginEngines。
  // - 现有覆盖缺口：sourceRoutes.test.ts 只测纯函数，未覆盖 runtimeCore 远程刷新缓存保留与降级语义。
  // - 最小失败输入：1 个分享 Antigravity + 1 台其他电脑 Antigravity + 1 个内置供应商分享，首次刷新成功后模拟一次失败/降级刷新，再写入 autoStrategy['auto:antigravity']='weighted'。
  // - tier：unit（内存 fake 端口 + 临时文件，无真实等待）。
  it('retains auto:antigravity across transient remotePluginEngines failures and degraded locations, and filters share probes via favoriteSource', async () => {
    paths.file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-store-')), 'model-groups.json');
    let clock = 100_000;
    let mode: 'ok' | 'plugin-fail' | 'degraded' = 'ok';
    const remoteViews = vi.fn(async () => ({ views: [], stale: false }));
    const remotePluginEngines = vi.fn(async (deviceId: string) => {
      if (mode === 'plugin-fail' && deviceId === 'share:agy-1') throw new Error('timeout');
      if (deviceId === 'share:agy-1') return [REMOTE_AGY('acp-plugin:_root__cindy-antigravity-acp:agy')];
      if (deviceId === 'peer-mac') return [REMOTE_AGY('acp-plugin:_ns__local__agy-acp:agy')];
      return [];
    });
    const locations = vi.fn(async () => ({
      status: (mode === 'degraded' ? 'degraded' : 'complete') as 'complete' | 'degraded',
      locations: [
        ...(mode === 'degraded' ? [] : [{ agentDeviceId: 'peer-mac' }]),
        { agentDeviceId: 'share:agy-1', favoriteSource: { providerId: 'acp-plugin:_root__cindy-antigravity-acp:agy' } },
        { agentDeviceId: 'share:anthropic-1', favoriteSource: { providerId: 'anthropic' } },
      ],
    }));
    const runtime = createModelGroupRuntime({
      scope: () => paths.file,
      localViews: async () => [],
      pluginEngines: () => [],
      localAgents: () => ['codex', 'claude-code', 'pi'],
      harnessInstalled: async () => true,
      quotaWindows: async () => new Map(),
      locations,
      remoteViews,
      remotePluginEngines,
      readSession: async () => null,
      isShared: () => false,
      hasGoal: async () => false,
      now: () => clock,
    });

    const flushRemote = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    await runtime.refreshAutoModelGroupRoutes({ waitRemote: true });
    expect(readModelGroupsConfig().sourceRoutes?.map((route) => route.id)).toContain('auto:antigravity');
    // favoriteSource.providerId 命中过滤：插件分享不发 remoteViews，内置供应商分享不发 remotePluginEngines。
    expect(remoteViews).not.toHaveBeenCalledWith('share:agy-1');
    expect(remotePluginEngines).not.toHaveBeenCalledWith('share:anthropic-1');

    // 60s 后 TTL 过期触发一次远端插件引擎读取失败，不应清空已读到的共享 Antigravity；紧接着切「按权重」仍保留 auto:antigravity。
    clock += 65_000;
    mode = 'plugin-fail';
    await runtime.refreshAutoModelGroupRoutes({ waitRemote: true });
    await flushRemote();
    expect(locations).toHaveBeenCalledTimes(2);
    expect(remotePluginEngines).toHaveBeenCalledTimes(4);
    const afterFail = writeModelGroupsConfig({
      ...readModelGroupsConfig(),
      autoStrategy: { 'auto:antigravity': 'weighted' },
    });
    expect(afterFail.sourceRoutes?.find((route) => route.id === 'auto:antigravity')?.strategy).toBe('weighted');

    // 同账号设备名单降级(status: 'degraded')时，保留上次已读到的 peer-mac 条目。
    clock += 65_000;
    mode = 'degraded';
    await runtime.refreshAutoModelGroupRoutes({ waitRemote: true });
    await flushRemote();
    expect(locations).toHaveBeenCalledTimes(3);
    expect(readModelGroupsConfig().sourceRoutes?.find((route) => route.id === 'auto:antigravity')?.strategy).toBe('weighted');
  });

  // PR #13547 回归：启动期连续两次位置名单为空，随后设备上线。只覆盖一次空名单的用例看不出第二次误启 60 秒 TTL。
  it('discovers remote catalogs after consecutive empty location reads at startup', async () => {
    paths.file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-store-')), 'model-groups.json');
    let clock = 100_000;
    let ready = false;
    const locations = vi.fn(async () => ({
      status: 'complete' as const,
      locations: ready ? [
        { agentDeviceId: 'peer-mac' },
        { agentDeviceId: 'share:agy-1', favoriteSource: { providerId: 'acp-plugin:_root__cindy-antigravity-acp:agy' } },
      ] : [],
    }));
    const runtime = createModelGroupRuntime({
      scope: () => paths.file,
      localViews: async () => [],
      pluginEngines: () => [],
      localAgents: () => ['codex', 'claude-code', 'pi'],
      harnessInstalled: async () => true,
      quotaWindows: async () => new Map(),
      locations,
      remotePluginEngines: async (deviceId) => (
        deviceId === 'share:agy-1'
          ? [REMOTE_AGY('acp-plugin:_root__cindy-antigravity-acp:agy')]
          : [REMOTE_AGY('acp-plugin:_ns__local__agy-acp:agy')]
      ),
      readSession: async () => null,
      isShared: () => false,
      hasGoal: async () => false,
      now: () => clock,
    });

    await runtime.refreshAutoModelGroupRoutes({ waitRemote: true });
    clock += 10_000;
    await runtime.refreshAutoModelGroupRoutes({ waitRemote: true });
    expect(readModelGroupsConfig().sourceRoutes ?? []).toEqual([]);
    await runtime.refreshAutoModelGroupRoutes({ waitRemote: true });
    expect(locations).toHaveBeenCalledTimes(2);

    ready = true;
    clock += 10_000;
    await runtime.refreshAutoModelGroupRoutes({ waitRemote: true });
    expect(readModelGroupsConfig().sourceRoutes?.map((route) => route.id) ?? []).toContain('auto:antigravity');
  });
});
