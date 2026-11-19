import { describe, expect, it, vi } from 'vitest';

import { validateGhostManifest, type InstalledGhost } from '../../../shared/ghost.js';
import type { NodeWorkerProcess } from '../nodeRuntimeBroker.js';
import {
  configurePluginHarnessRegistry,
  createPluginHarnessRegistry,
  PLUGIN_HARNESS_REFRESH_COOLDOWN_MS,
  requestPluginHarnessRefresh,
  resetPluginHarnessRefreshForTests,
  type PluginHarnessRegistryDeps,
} from '../pluginHarnesses.js';

/*
 * 测试价值
 * - 生产入口与可观察结果：createPluginHarnessRegistry（生产单例同一实现）的 list / onChange / spawn——
 *   第 3 步模型选择器与 ACP 引擎看到哪些引擎、什么名字和状态，以及能否启动。
 * - Bug／规则依据：docs/plans/acp-plugin-bridge.md「主进程注册表」（只列已启用 + 已批准 + 已声明 +
 *   协议已支持；名称按界面语言；未发布 = unknown；不在列表或不可用即拒绝启动）；
 *   plugin-security-and-authoring.md §5（旧 receipt 缺批准事实不得生效）。
 * - 现有覆盖缺口：新模块。
 * - 最小失败输入：receipt 没有 approvedHarnesses 的已启用插件；已发布 available:false 的引擎。
 * - tier：unit（内存依赖）。实测耗时：< 1s。
 */
const harness = {
  id: 'dsh', name: 'DeepSeek Harness', description: 'Local agent', protocol: 'acp', entry: 'engine.js',
  locales: { 'zh-CN': { name: '深度求索 Harness', description: '本机 Agent' } },
};

function ghost(overrides: Partial<InstalledGhost> = {}, harnesses: unknown[] = [harness], id = 'dsh-plugin'): InstalledGhost {
  const parsed = validateGhostManifest({
    schemaVersion: 3, minCindyVersion: '0.1.61', id, name: 'DSH', version: '1.0.0', entry: 'main.js',
    node: { entry: 'worker.js', protocol: 'json-rpc-stdio', entries: ['engine.js'] }, harnesses,
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    manifest: parsed.manifest, dir: `/plugins/${id}`, enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    approvedHarnesses: ['dsh'], ...overrides,
  };
}

function setup(ghosts: InstalledGhost[], published: Record<string, unknown> = {}, locale = 'en') {
  const process = {} as NodeWorkerProcess;
  let list = ghosts;
  let stored = published;
  let uiLocale = locale;
  const deps: PluginHarnessRegistryDeps = {
    listGhosts: () => list,
    isAvailable: (id) => id !== 'account-only',
    readAvailability: () => stored,
    uiLocale: () => uiLocale,
    spawn: vi.fn(async () => process),
  };
  const registry = createPluginHarnessRegistry(deps);
  return {
    registry, deps, process,
    setGhosts: (next: InstalledGhost[]) => { list = next; },
    publish: (value: Record<string, unknown>) => { stored = value; },
    setLocale: (value: string) => { uiLocale = value; },
  };
}

describe('plugin harness registry', () => {
  it('lists only enabled, approved, declared, receipt-approved engines with a known protocol', () => {
    const { registry } = setup([
      ghost(),
      ghost({ enabled: false }, [harness], 'disabled'),
      ghost({ approval: { state: 'legacy-unapproved' } }, [harness], 'unapproved'),
      ghost({ approvedHarnesses: undefined }, [harness], 'old-receipt'),
      ghost({}, [{ ...harness, protocol: 'acp/2' }], 'future-protocol'),
      ghost({}, [harness], 'account-only'),
    ]);
    expect(registry.list()).toEqual([{
      key: 'dsh-plugin:dsh', ghostId: 'dsh-plugin', harnessId: 'dsh', name: 'DeepSeek Harness',
      description: 'Local agent', protocol: 'acp', availability: { state: 'unknown' },
    }]);
  });

  it('localizes names and reports published availability', () => {
    const { registry } = setup([ghost()], {
      harnesses: [{ id: 'dsh', available: false, reason: 'not-installed', message: 'npm i -g @deepseek-ai/dsh' }],
    }, 'zh-CN');
    expect(registry.list()).toMatchObject([{ name: '深度求索 Harness', description: '本机 Agent',
      availability: { state: 'unavailable', reason: 'not-installed', message: 'npm i -g @deepseek-ai/dsh' } }]);
  });

  // 2026-11-18 用户要求：引擎图标由插件定义；模型列表由插件提供，获取与展示同普通供应商。
  it('carries the plugin icon and the models the plugin publishes for its engine', () => {
    const models = [{ id: 'v4-pro', name: 'DeepSeek-V4-Pro', group: 'DeepSeek' }];
    const { registry } = setup([ghost({ iconDataUrl: 'data:image/png;base64,AAAA' })], {
      harnesses: [{ id: 'dsh', available: true, models }],
    });
    expect(registry.list()).toMatchObject([{ iconDataUrl: 'data:image/png;base64,AAAA', models }]);
  });

  it('asks only engine plugins to refresh when a picker opens, at most once per cooldown', () => {
    resetPluginHarnessRefreshForTests();
    const requestRefresh = vi.fn((ghostId: string) => ghostId !== 'offline-plugin');
    configurePluginHarnessRegistry({
      listGhosts: () => [ghost(), ghost({}, [harness], 'offline-plugin'), ghost({ enabled: false }, [harness], 'disabled')],
      isAvailable: () => true,
      readAvailability: () => ({}),
      uiLocale: () => 'en',
      spawn: vi.fn(),
      requestRefresh,
    });
    requestPluginHarnessRefresh(1_000);
    expect(requestRefresh.mock.calls.map(([id]) => id).sort()).toEqual(['dsh-plugin', 'offline-plugin']);
    // Within the cooldown only the plugin whose page was offline is asked again.
    requestPluginHarnessRefresh(1_000 + PLUGIN_HARNESS_REFRESH_COOLDOWN_MS - 1);
    expect(requestRefresh.mock.calls.slice(2).map(([id]) => id)).toEqual(['offline-plugin']);
    requestPluginHarnessRefresh(1_000 + PLUGIN_HARNESS_REFRESH_COOLDOWN_MS);
    expect(requestRefresh.mock.calls.slice(3).map(([id]) => id).sort()).toEqual(['dsh-plugin', 'offline-plugin']);
  });

  it('notifies listeners only when a reconcile changes the list', () => {
    const r = setup([]);
    const listener = vi.fn();
    const unsubscribe = r.registry.onChange(listener);
    r.registry.reconcile();
    expect(listener).not.toHaveBeenCalled();
    r.setGhosts([ghost()]);
    r.registry.reconcile();
    expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ key: 'dsh-plugin:dsh', availability: { state: 'unknown' } })]);
    r.registry.reconcile();
    expect(listener).toHaveBeenCalledTimes(1);
    r.publish({ harnesses: [{ id: 'dsh', available: true, version: '0.2.2' }] });
    r.registry.reconcile();
    expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ availability: { state: 'available', version: '0.2.2' } })]);
    r.setLocale('zh-CN');
    r.registry.reconcile();
    expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ name: '深度求索 Harness' })]);
    unsubscribe();
    r.setGhosts([]);
    r.registry.reconcile();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(r.registry.list()).toEqual([]);
  });

  it('starts a listed engine and rejects unknown, revoked or unavailable ones', async () => {
    const r = setup([ghost()]);
    await expect(r.registry.spawn('dsh-plugin:dsh')).resolves.toBe(r.process);
    expect(r.deps.spawn).toHaveBeenCalledWith('dsh-plugin', 'dsh');
    await expect(r.registry.spawn('dsh-plugin:other')).rejects.toThrow('not available');
    // Revocation takes effect at spawn time even before the next roster reconcile.
    r.setGhosts([ghost({ enabled: false })]);
    await expect(r.registry.spawn('dsh-plugin:dsh')).rejects.toThrow('not available');
    r.setGhosts([ghost()]);
    r.publish({ harnesses: [{ id: 'dsh', available: false, message: 'Install DSH first' }] });
    await expect(r.registry.spawn('dsh-plugin:dsh')).rejects.toThrow('Install DSH first');
    expect(r.deps.spawn).toHaveBeenCalledTimes(1);
  });
});
