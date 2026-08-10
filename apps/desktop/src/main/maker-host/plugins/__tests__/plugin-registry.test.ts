/**
 * PluginRegistry 单测：多层启用判定逻辑。
 *
 * 覆盖：
 *   - 优先级：machine > project > user > product
 *   - essential plugin 覆盖(始终 true，并从 listPlugins 隐藏)
 *   - 未知 plugin id → fail-open(返回 true)
 *   - setProjectEnabled 拒绝 essential plugin
 *   - listPlugins 只返回非 essential plugin
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLiziMcpProviders } from '@cindy/mcps';
import { SettingsReader } from '../settings-reader.js';
import { PluginRegistry } from '../plugin-registry.js';
import {
  BUILTIN_LIZI_MCP_IDS,
  PROVIDER_NAME_TO_PLUGIN_ID,
  pluginIdForKnownProviderName,
  pluginIdForProviderName,
} from '../builtin-plugins.js';
import type { KnownProviderName } from '../builtin-plugins.js';
import { ESSENTIAL_PLUGIN_IDS, HOSTED_ELSEWHERE_PLUGIN_IDS } from '../types.js';

function makeLogger() {
  return { warn: vi.fn() };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-plugin-test-'));
}

function writeProjectSettings(workingDir: string, builtinTools: Record<string, boolean>) {
  const obj = {
    xdtMaker: {
      builtinTools: Object.fromEntries(
        Object.entries(builtinTools).map(([id, enabled]) => [id, { enabled }]),
      ),
    },
  };
  const settingsDir = path.join(workingDir, '.claude');
  const filePath = path.join(settingsDir, 'settings.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
}

function createRegistry(userDataPath = tmpDir()): PluginRegistry {
  const logger = makeLogger();
  const settingsReader = new SettingsReader({ logger, userDataPath });
  return new PluginRegistry({ settingsReader });
}

function knownProviderNames(): KnownProviderName[] {
  return Object.keys(PROVIDER_NAME_TO_PLUGIN_ID) as KnownProviderName[];
}

function realBuiltinProviderNames(): KnownProviderName[] {
  const providers = createLiziMcpProviders({
    android: {} as never,
    iosSimulator: {} as never,
    browser: {} as never,
    computer: {} as never,
    feishuBot: {} as never,
    wechatBot: {} as never,
    slackHook: {} as never,
    scheduler: {} as never,
    ssh: {} as never,
    memory: {} as never,
    contacts: {} as never,
    xdtHelper: {} as never,
    orca: {} as never,
    lsp: {} as never,
  });
  return providers.map((provider) => provider.name as KnownProviderName);
}

describe('PluginRegistry — scoped priority', () => {
  let workingDir: string;
  let registry: PluginRegistry;

  beforeEach(() => {
    workingDir = tmpDir();
    registry = createRegistry(workingDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(workingDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  });

  // ── 第 3 层：内置默认值 ────────────────────────────────────────────────

  it('returns true by default (tier 3)', () => {
    expect(registry.isEnabled('feishu_bot')).toBe(true);
    expect(registry.isEnabled('ssh')).toBe(true);
  });

  it('keeps direct computer control disabled by default', async () => {
    expect(registry.isEnabled('computer')).toBe(false);
    expect(registry.isEnabled('computer', workingDir)).toBe(false);

    const state = await registry.getEnableState('computer', workingDir);
    expect(state.effectiveEnabled).toBe(false);
    expect(state.projectOverride).toBeNull();
  });

  it('keeps Android automation disabled by default', async () => {
    expect(registry.isEnabled('android')).toBe(false);
    expect(registry.isEnabled('android', workingDir)).toBe(false);

    const state = await registry.getEnableState('android', workingDir);
    expect(state.effectiveEnabled).toBe(false);
    expect(state.projectOverride).toBeNull();
  });

  it('enables the embedded iOS Simulator by default but respects an explicit project disable', async () => {
    expect(registry.isEnabled('ios-simulator')).toBe(true);
    expect(registry.isEnabled('ios-simulator', workingDir)).toBe(true);
    await expect(registry.getEnableState('ios-simulator', workingDir)).resolves.toMatchObject({
      effectiveEnabled: true,
      productDefaultEnabled: true,
      projectOverride: null,
      userOverride: null,
    });

    writeProjectSettings(workingDir, { 'ios-simulator': false });
    registry = createRegistry();

    expect(registry.isEnabled('ios-simulator', workingDir)).toBe(false);
    await expect(registry.getEnableState('ios-simulator', workingDir)).resolves.toMatchObject({
      effectiveEnabled: false,
      productDefaultEnabled: true,
      projectOverride: { enabled: false, workingDir },
    });
  });

  it('returns true by default with workingDir', () => {
    expect(registry.isEnabled('ssh', workingDir)).toBe(true);
  });

  // ── 第 2 层：项目设置 ──────────────────────────────────────────────────

  it('project override sets enabled to false', () => {
    writeProjectSettings(workingDir, { ssh: false });
    registry = createRegistry(workingDir);

    expect(registry.isEnabled('ssh', workingDir)).toBe(false);
    expect(registry.isEnabled('feishu_bot', workingDir)).toBe(true); // 未设置
  });

  it('project override: explicit true', () => {
    writeProjectSettings(workingDir, { ssh: true });
    registry = createRegistry(workingDir);

    expect(registry.isEnabled('ssh', workingDir)).toBe(true);
  });

  it('uses a user default across projects and no-project conversations', async () => {
    const otherWorkingDir = tmpDir();
    try {
      await registry.setEnabled('ssh', false);
      registry = createRegistry(workingDir);

      expect(registry.isEnabled('ssh')).toBe(false);
      expect(registry.isEnabled('ssh', workingDir)).toBe(false);
      expect(registry.isEnabled('ssh', otherWorkingDir)).toBe(false);
      await expect(registry.getEnableState('ssh', workingDir)).resolves.toMatchObject({
        effectiveEnabled: false,
        userOverride: { enabled: false },
        projectOverride: null,
      });
    } finally {
      fs.rmSync(otherWorkingDir, { recursive: true, force: true });
    }
  });

  it('project override wins over user default and clearing it follows the user default', async () => {
    await registry.setEnabled('ssh', false);
    await registry.setProjectEnabled('ssh', workingDir, true);

    await expect(registry.getEnableState('ssh', workingDir)).resolves.toMatchObject({
      effectiveEnabled: true,
      userOverride: { enabled: false },
      projectOverride: { enabled: true, workingDir },
    });

    await registry.clearProjectEnabled('ssh', workingDir);
    await expect(registry.getEnableState('ssh', workingDir)).resolves.toMatchObject({
      effectiveEnabled: false,
      userOverride: { enabled: false },
      projectOverride: null,
    });
  });

  it('preserves an explicit project override that matches a mutable user default', async () => {
    await registry.setEnabled('ssh', false);
    await registry.setProjectEnabled('ssh', workingDir, false);

    await registry.setEnabled('ssh', true);
    await expect(registry.getEnableState('ssh', workingDir)).resolves.toMatchObject({
      effectiveEnabled: false,
      userOverride: { enabled: true },
      projectOverride: { enabled: false, workingDir },
    });
  });

  it('preserves an explicit user default that matches the product default', async () => {
    await registry.setEnabled('ssh', true);

    await expect(registry.getEnableState('ssh')).resolves.toMatchObject({
      effectiveEnabled: true,
      productDefaultEnabled: true,
      userOverride: { enabled: true },
    });

    await registry.clearEnabled('ssh');
    await expect(registry.getEnableState('ssh')).resolves.toMatchObject({
      effectiveEnabled: true,
      productDefaultEnabled: true,
      userOverride: null,
    });
  });

  it('clearing a user default falls back to the product default', async () => {
    await registry.setEnabled('ssh', false);
    await registry.clearEnabled('ssh');

    await expect(registry.getEnableState('ssh')).resolves.toMatchObject({
      effectiveEnabled: true,
      productDefaultEnabled: true,
      userOverride: null,
    });
  });

  it('freezes only disabled ordinary plugins into a new runtime policy', async () => {
    await registry.setEnabled('ssh', false);
    await registry.setEnabled('computer', true);
    writeProjectSettings(workingDir, { collab: false, feishu_bot: false, ssh: true });

    const disabled = registry.getDisabledRuntimePluginIds(workingDir);
    expect(disabled).toContain('feishu_bot');
    expect(disabled).not.toContain('collab');
    expect(disabled).not.toContain('ssh');
    expect(disabled).not.toContain('computer');
    expect(disabled).not.toContain('ios-simulator');
    for (const essentialId of ESSENTIAL_PLUGIN_IDS) {
      expect(disabled).not.toContain(essentialId);
    }
  });

  it('project override does not enable a global default-disabled plugin', () => {
    writeProjectSettings(workingDir, { computer: true });
    registry = createRegistry(workingDir);

    expect(registry.isEnabled('computer', workingDir)).toBe(false);
  });

  it('project override does not enable Android automation without a global opt-in', () => {
    writeProjectSettings(workingDir, { android: true });
    registry = createRegistry(workingDir);

    expect(registry.isEnabled('android', workingDir)).toBe(false);
  });

  it('global Android automation enablement applies across working dirs', async () => {
    const otherWorkingDir = tmpDir();
    try {
      await registry.setEnabled('android', true);

      registry = createRegistry(workingDir);
      expect(registry.isEnabled('android', workingDir)).toBe(true);
      expect(registry.isEnabled('android', otherWorkingDir)).toBe(true);
      await expect(registry.getEnableState('android', otherWorkingDir)).resolves.toMatchObject({
        effectiveEnabled: true,
        projectOverride: null,
        globalOverride: { enabled: true },
      });
    } finally {
      fs.rmSync(otherWorkingDir, { recursive: true, force: true });
    }
  });

  it('setProjectEnabled writes explicit true for a default-disabled plugin', async () => {
    await registry.setProjectEnabled('computer', workingDir, true);

    expect(registry.isEnabled('computer', workingDir)).toBe(true);
    registry = createRegistry(workingDir);
    expect(registry.isEnabled('computer', workingDir)).toBe(true);
    await expect(registry.getEnableState('computer', workingDir)).resolves.toMatchObject({
      effectiveEnabled: true,
      projectOverride: null,
      globalOverride: { enabled: true },
    });
  });

  it('global plugin enablement applies across working dirs', async () => {
    const otherWorkingDir = tmpDir();
    try {
      await registry.setEnabled('computer', true);

      registry = createRegistry(workingDir);
      expect(registry.isEnabled('computer', workingDir)).toBe(true);
      expect(registry.isEnabled('computer', otherWorkingDir)).toBe(true);
      await expect(registry.getEnableState('computer', otherWorkingDir)).resolves.toMatchObject({
        effectiveEnabled: true,
        projectOverride: null,
        globalOverride: { enabled: true },
      });
    } finally {
      fs.rmSync(otherWorkingDir, { recursive: true, force: true });
    }
  });

  it('setProjectEnabled clears override when a plugin returns to its default state', async () => {
    await registry.setProjectEnabled('ssh', workingDir, false);
    await expect(registry.getEnableState('ssh', workingDir)).resolves.toMatchObject({
      effectiveEnabled: false,
      projectOverride: { enabled: false, workingDir },
    });

    await registry.setProjectEnabled('ssh', workingDir, true);
    await expect(registry.getEnableState('ssh', workingDir)).resolves.toEqual({
      effectiveEnabled: true,
      productDefaultEnabled: true,
      projectOverride: null,
      userOverride: null,
      globalOverride: null,
    });
  });

  it('project settings only apply when workingDir is provided', () => {
    writeProjectSettings(workingDir, { ssh: false });
    registry = createRegistry(workingDir);

    expect(registry.isEnabled('ssh')).toBe(true);
  });

  // ── 第 1 层：essential ────────────────────────────────────────────────

  it('essential plugins are always enabled regardless of project settings', () => {
    for (const id of ESSENTIAL_PLUGIN_IDS) {
      writeProjectSettings(workingDir, { [id]: false });
      registry = createRegistry(workingDir);

      expect(registry.isEnabled(id)).toBe(true);
      expect(registry.isEnabled(id, workingDir)).toBe(true);
    }
  });

  it('essential plugins cannot be toggled via setProjectEnabled', async () => {
    for (const id of ESSENTIAL_PLUGIN_IDS) {
      const ok = await registry.setProjectEnabled(id, workingDir, false);
      expect(ok).toBe(false);
    }
  });

  // ── 未知 plugin id ────────────────────────────────────────────────────

  it('unknown plugin id returns true (fail-open)', () => {
    expect(registry.isEnabled('completely_unknown_plugin')).toBe(true);
    expect(registry.isEnabled('completely_unknown_plugin', workingDir)).toBe(true);
  });

  // ── setProjectEnabled ─────────────────────────────────────────────────

  it('setProjectEnabled persists and returns true for non-essential plugins', async () => {
    const ok = await registry.setProjectEnabled('ssh', workingDir, false);
    expect(ok).toBe(true);
    expect(registry.isEnabled('ssh', workingDir)).toBe(false);
  });

  // ── listPlugins ───────────────────────────────────────────────────────

  it('listPlugins returns project-scoped builtin plugins (essential + hosted-elsewhere hidden)', async () => {
    const list = await registry.listPlugins(workingDir);
    const visiblePluginIds = registry
      .getPlugins()
      .filter(
        (plugin) =>
          !ESSENTIAL_PLUGIN_IDS.has(plugin.id) && !HOSTED_ELSEWHERE_PLUGIN_IDS.has(plugin.id),
      )
      .map((plugin) => plugin.id);

    expect(list.map((item) => item.id).sort()).toEqual([...visiblePluginIds].sort());
    for (const item of list) {
      expect(ESSENTIAL_PLUGIN_IDS.has(item.id)).toBe(false);
      // hosted-elsewhere plugins (e.g. browser →「电脑使用」) are also omitted.
      expect(HOSTED_ELSEWHERE_PLUGIN_IDS.has(item.id)).toBe(false);
    }
  });

  it('listPlugins exposes browser in the user-default scope', async () => {
    const list = await registry.listPlugins();

    expect(list.find((item) => item.id === 'browser')).toMatchObject({
      id: 'browser',
      effectiveEnabled: true,
      productDefaultEnabled: true,
    });
    expect(list.find((item) => item.id === 'android')).toBeUndefined();
    expect(list.find((item) => item.id === 'computer')).toBeUndefined();
    expect(list.find((item) => item.id === 'contacts')).toBeUndefined();
  });

  it('listPlugins: non-essential defaults to true', async () => {
    const list = await registry.listPlugins();
    const ssh = list.find((p) => p.id === 'ssh');
    if (!ssh) throw new Error('Expected ssh plugin to be listed');

    expect(ssh.effectiveEnabled).toBe(true);
    expect(ssh.projectOverride).toBeUndefined();
  });

  it('listPlugins: project override reflected when workingDir provided', async () => {
    writeProjectSettings(workingDir, { ssh: false });
    registry = createRegistry();

    const list = await registry.listPlugins(workingDir);
    const ssh = list.find((p) => p.id === 'ssh');
    if (!ssh) throw new Error('Expected ssh plugin to be listed');

    expect(ssh.effectiveEnabled).toBe(false);
    expect(ssh.projectOverride).toEqual({ enabled: false, workingDir });
  });

  // ── getEnableState ────────────────────────────────────────────────────

  it('getEnableState for non-essential with no overrides', async () => {
    const state = await registry.getEnableState('ssh');
    expect(state.effectiveEnabled).toBe(true);
    expect(state.projectOverride).toBeNull();
  });

  it('getEnableState for essential always returns true', async () => {
    writeProjectSettings(workingDir, { memory: false });
    registry = createRegistry();

    const state = await registry.getEnableState('memory');
    expect(state.effectiveEnabled).toBe(true);
    expect(state.projectOverride).toBeNull();
  });

  it('getEnableState reads a HOSTED_ELSEWHERE plugin (browser) that listPlugins hides', async () => {
    // Regression: `browser` lives under Settings →「电脑使用」and is hidden from
    // listPlugins(), so ComputerUseSection must read its state via getEnableState
    // by id. Previously it used list().find() → always undefined → the toggle
    // wrongly reset to enabled on every remount after a project disabled it.
    writeProjectSettings(workingDir, { browser: false });
    registry = createRegistry();

    const list = await registry.listPlugins(workingDir);
    expect(list.find((p) => p.id === 'browser')).toBeUndefined(); // hidden from the generic list

    const state = await registry.getEnableState('browser', workingDir); // ...but readable by id
    expect(state.effectiveEnabled).toBe(false);
    expect(state.projectOverride).toEqual({ enabled: false, workingDir });
  });

  // ── Plugin ID 与 provider name 映射 ───────────────────────────────────

  it('getPlugins returns registered builtin descriptors', () => {
    const plugins = registry.getPlugins();
    const pluginIds = plugins.map((plugin) => plugin.id);
    const mappedPluginIds = new Set(Object.values(PROVIDER_NAME_TO_PLUGIN_ID));

    expect(new Set(pluginIds).size).toBe(pluginIds.length);
    for (const mappedId of mappedPluginIds) {
      expect(pluginIds).toContain(mappedId);
    }
    expect(plugins.every((p) => p.source === 'builtin')).toBe(true);
    expect(plugins.every((p) => p.version === '1.0.0')).toBe(true);
  });
});

// ── 集成：isEnabled 包装(模拟 mcp-providers.ts gate) ──────────────────────

describe('isEnabled wrap integration (provider → registry gate)', () => {
  let workingDir: string;
  let registry: PluginRegistry;

  beforeEach(() => {
    workingDir = tmpDir();
    registry = createRegistry();
  });

  afterEach(() => {
    try {
      fs.rmSync(workingDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  });

  function wrapIsEnabled(providerName: string, workingDir?: string): boolean {
    const pluginId = pluginIdForProviderName(providerName);
    return registry.isEnabled(pluginId, workingDir);
  }

  it('provider cindy_ssh disabled via project override → isEnabled false', () => {
    writeProjectSettings(workingDir, { ssh: false });
    registry = createRegistry();

    expect(wrapIsEnabled('cindy_ssh', workingDir)).toBe(false);
  });

  it('does not map a custom MCP id that matches a built-in plugin id', () => {
    expect(pluginIdForKnownProviderName('ssh')).toBeNull();
    expect(pluginIdForKnownProviderName('cindy_ssh')).toBe('ssh');
  });

  it('provider cindy_feishu_bot → feishu_bot mapping works', () => {
    writeProjectSettings(workingDir, { feishu_bot: false });
    registry = createRegistry();

    expect(wrapIsEnabled('cindy_feishu_bot', workingDir)).toBe(false);
  });

  it('essential providers stay enabled even when project says false', () => {
    writeProjectSettings(workingDir, { memory: false, scheduler: false, xdt_helper: false });
    registry = createRegistry();

    expect(wrapIsEnabled('cindy_memory', workingDir)).toBe(true);
    expect(wrapIsEnabled('cindy_scheduler', workingDir)).toBe(true);
    expect(wrapIsEnabled('cindy_helper', workingDir)).toBe(true);
  });

  it('all real builtin provider names resolve to known plugin ids (no fail-open)', () => {
    // 通过项目设置禁用所有非 essential plugin，用来验证 provider 映射不会走 fail-open。
    const tools: Record<string, boolean> = {};
    for (const pn of realBuiltinProviderNames()) {
      const pid = pluginIdForProviderName(pn);
      if (!ESSENTIAL_PLUGIN_IDS.has(pid)) {
        tools[pid] = false;
      }
    }
    writeProjectSettings(workingDir, tools);
    registry = createRegistry();

    for (const pn of realBuiltinProviderNames()) {
      const pid = pluginIdForProviderName(pn);
      const expected = ESSENTIAL_PLUGIN_IDS.has(pid);
      expect(wrapIsEnabled(pn, workingDir)).toBe(expected);
    }
  });

  it('PROVIDER_NAME_TO_PLUGIN_ID covers the real builtin MCP provider list', () => {
    const realProviderNames = realBuiltinProviderNames();

    expect(new Set(knownProviderNames())).toEqual(new Set(realProviderNames));
    expect(realProviderNames).toHaveLength(BUILTIN_LIZI_MCP_IDS.length);

    for (const name of realProviderNames) {
      expect(PROVIDER_NAME_TO_PLUGIN_ID[name]).toBeDefined();
      const mappedId = PROVIDER_NAME_TO_PLUGIN_ID[name];
      expect(registry.getPlugins().map((p) => p.id)).toContain(mappedId);
    }
  });

  it('all active builtin MCP providers use the cindy namespace', () => {
    expect(realBuiltinProviderNames().every((name) => name.startsWith('cindy_'))).toBe(true);
  });
});
