/**
 * custom-mcp-registry —— 自定义 MCP 注入内置 provider 数组时的撞名防御。
 *
 * 背景: host 把用户自定义 MCP **追加**在内置 provider 之后, 而两个装配点
 * (claude buildMcpServers / codex codexEnvironment) 都按 `name` 建 key。若允许撞名,
 * 一个 id 取作 `cindy_browser` 的自定义远程端点会顶替内置 server, 并继承 MCP 审批
 * 策略里对该 server 名的信任(策略只看 serverName) —— 第三方端点的所有工具被静默放行。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpProvider } from '@cindy/maker-core';
import type { CustomMcpConfig } from '../../../shared/customMcp.js';
import { detectMcpDuplicates, resolveMcpDuplicateChoices } from '../../maker-host/mcp-duplicate-detection.js';
import type { McpDuplicateChoice } from '../../../shared/customMcp.js';

const storeMock = vi.hoisted(() => ({ listCustomMcpServers: vi.fn(), owner: {} as object | null }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => storeMock.owner }));

// This suite uses isolated SQLite fixtures; OS encryption is covered by the store suite.
vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>();
  return { ...actual, safeStorage: {
    ...actual.safeStorage,
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  } };
});

vi.mock('../../maker-host/custom-mcp-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../maker-host/custom-mcp-store.js')>(
    '../../maker-host/custom-mcp-store.js',
  );
  return {
    ...actual,
    // 只把读库这一步换成 mock；校验 / 判定逻辑用真实实现，避免名单在测试里漂移。
    listCustomMcpServers: storeMock.listCustomMcpServers,
  };
});

vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomMcpToken: () => null,
}));

import {
  getBuiltinMcpServerNames,
  listRegistrableCustomMcpServers,
  refreshCustomMcpProviders,
  registerCustomMcpArrays,
  resetCustomMcpRegistry,
} from '../custom-mcp-registry.js';

function config(id: string): CustomMcpConfig {
  return {
    id,
    name: `custom ${id}`,
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: {},
  };
}

function builtin(name: string): McpProvider {
  return { name, toClaudeSdkConfig: () => ({ type: 'sdk' }) };
}

beforeEach(() => {
  resetCustomMcpRegistry();
  storeMock.owner = {};
  storeMock.listCustomMcpServers.mockReset();
});

describe('refreshCustomMcpProviders', () => {
  // 2026-11-10, unit: Maker's initial refresh ran before DB takeover. A missing
  // DB must defer, then the existing onReady refresh must publish saved MCPs.
  it('defers before DB readiness and publishes saved providers when onReady refreshes', async () => {
    const arr: McpProvider[] = [builtin('built_in')];
    registerCustomMcpArrays(arr);
    storeMock.owner = null;
    storeMock.listCustomMcpServers.mockResolvedValue([config('saved')]);
    await refreshCustomMcpProviders();
    expect(storeMock.listCustomMcpServers).not.toHaveBeenCalled();
    expect(arr.map(p => p.name)).toEqual(['built_in']);
    storeMock.owner = {};
    await refreshCustomMcpProviders();
    await refreshCustomMcpProviders();
    expect(arr.map(p => p.name)).toEqual(['built_in', 'saved']);
  });

  it('discards a slow DB read from a replaced owner instead of publishing it into the new registry', async () => {
    const arr: McpProvider[] = [builtin('built_in')];
    registerCustomMcpArrays(arr);
    let release!: (rows: CustomMcpConfig[]) => void;
    storeMock.listCustomMcpServers.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const refresh = refreshCustomMcpProviders();
    storeMock.owner = {};
    release([config('old_owner')]);
    await refresh;
    expect(arr.map(p => p.name)).toEqual(['built_in']);
  });

  // PR #9055: duplicate diagnostics must use registration's real admission rules.
  // Unit: one native endpoint and legacy invalid rows; prior registry tests did not
  // exercise source choices, so they missed disabling the only usable connection.
  it('only offers registrable persisted connections as duplicate sources', async () => {
    const arr: McpProvider[] = [builtin('cindy_browser')];
    registerCustomMcpArrays(arr);
    const saved = [config('safe_one'), config('__proto__'), config('codex_apps'),
      config('cindy_browser'), { ...config('bad_header'), headers: { 'X-Test': 'line\nbreak' } }];
    storeMock.listCustomMcpServers.mockResolvedValue(saved);
    await refreshCustomMcpProviders();
    const report = await detectMcpDuplicates({
      home: '/fixture', listCustom: listRegistrableCustomMcpServers, builtinNames: getBuiltinMcpServerNames,
      readJson: async () => ({ mcpServers: { native_tools: { type: 'http', url: saved[0]!.url } } }),
      workspaceSettingsFiles: async () => [], readToken: () => null, readChoices: () => ({}),
    }, { env: {} });
    expect(report.connections.map(pair => pair.cindyId)).toEqual(['safe_one']);
    expect(arr.map(provider => provider.name)).toEqual(['cindy_browser', 'safe_one']);
    expect(saved).toHaveLength(5);
  });

  it.each(['cindy', 'claude'] as const)('does not apply the saved %s choice after a custom ID becomes reserved', async choice => {
    const arr: McpProvider[] = [];
    registerCustomMcpArrays(arr);
    storeMock.listCustomMcpServers.mockResolvedValue([config('mytools')]);
    await refreshCustomMcpProviders();
    const choices: Record<string, McpDuplicateChoice> = {};
    const deps = {
      home: '/fixture', listCustom: listRegistrableCustomMcpServers, builtinNames: getBuiltinMcpServerNames,
      readJson: async () => ({ mcpServers: { native_tools: { type: 'http', url: config('mytools').url } } }),
      workspaceSettingsFiles: async () => [], readToken: () => null, readChoices: () => choices,
    };
    const original = await detectMcpDuplicates(deps, { env: {} });
    choices[original.connections[0]!.id] = choice;
    const selected = resolveMcpDuplicateChoices(await detectMcpDuplicates(deps, { env: {} }));
    expect(selected).toEqual(choice === 'cindy'
      ? { skipHostServers: [], denyNativeServers: ['native_tools'] }
      : { skipHostServers: ['mytools'], denyNativeServers: [] });
    registerCustomMcpArrays([builtin('mytools')]);
    await refreshCustomMcpProviders();
    const changed = await detectMcpDuplicates(deps, { env: {} });
    expect(changed.connections).toEqual([]);
    expect(resolveMcpDuplicateChoices(changed)).toEqual({ skipHostServers: [], denyNativeServers: [] });
  });
  it('appends custom providers that do not collide', async () => {
    const arr: McpProvider[] = [builtin('cindy_browser')];
    registerCustomMcpArrays(arr);
    storeMock.listCustomMcpServers.mockResolvedValue([config('mytools')]);

    await refreshCustomMcpProviders();

    expect(arr.map((p) => p.name)).toEqual(['cindy_browser', 'mytools']);
  });

  it('refreshes every registered agent array with one duplicate-free custom provider batch', async () => {
    const claude: McpProvider[] = [builtin('cindy_browser')];
    const codex: McpProvider[] = [builtin('cindy_browser')];
    const pi: McpProvider[] = [builtin('cindy_browser')];
    registerCustomMcpArrays(claude, codex, pi);
    storeMock.listCustomMcpServers.mockResolvedValue([config('one'), config('two')]);

    await refreshCustomMcpProviders();
    await refreshCustomMcpProviders();

    for (const arr of [claude, codex, pi]) {
      expect(arr.map((p) => p.name)).toEqual(['cindy_browser', 'one', 'two']);
    }
  });

  it('skips a custom MCP whose id collides with a builtin server name', async () => {
    const arr: McpProvider[] = [builtin('cindy_browser'), builtin('cindy_helper')];
    registerCustomMcpArrays(arr);
    storeMock.listCustomMcpServers.mockResolvedValue([
      config('cindy_browser'),
      config('safe_one'),
    ]);

    await refreshCustomMcpProviders();

    // 撞名那个整个不装；不撞名的照常注入。
    expect(arr.map((p) => p.name)).toEqual(['cindy_browser', 'cindy_helper', 'safe_one']);
    expect(arr[0]?.toClaudeSdkConfig?.({ agentKind: 'claude-code', workingDir: '/tmp' })).toEqual({
      type: 'sdk',
    });
  });

  // 保留名 / 不安全 key 的校验是后加的，旧版本存下来的行不会被重新校验（refresh 直接
  // 读库建 provider）。这类 id 当对象 key 用会踩原型 setter，在按 `{}` 建表的装配点静默
  // 消失，造成「Claude 里能用、Codex 里不见」的分叉，所以两端一律不装。
  it('quarantines persisted ids that are unsafe as object keys', async () => {
    const arr: McpProvider[] = [builtin('cindy_browser')];
    registerCustomMcpArrays(arr);
    storeMock.listCustomMcpServers.mockResolvedValue([
      config('__proto__'),
      config('constructor'),
      config('prototype'),
      config('safe_one'),
    ]);

    await refreshCustomMcpProviders();

    expect(arr.map((p) => p.name)).toEqual(['cindy_browser', 'safe_one']);
    // 没有污染原型：普通对象仍然干净。
    expect(Object.getPrototypeOf({} as Record<string, unknown>)).toBe(Object.prototype);
  });

  // P1: stored native-name collisions bypassed provider-only reserved names.
  // Exercise refresh with the real validator, including repeated refresh.
  it('quarantines a persisted native Apps collision without mutating stored configs', async () => {
    const arr: McpProvider[] = [];
    registerCustomMcpArrays(arr);
    const saved = [config('codex_apps'), config('safe_one')];
    storeMock.listCustomMcpServers.mockResolvedValue(saved);
    await refreshCustomMcpProviders();
    await refreshCustomMcpProviders();
    expect(arr.map((p) => p.name)).toEqual(['safe_one']);
    expect(saved.map((entry) => entry.id)).toEqual(['codex_apps', 'safe_one']);
  });

  it('quarantines persisted configs with invalid custom headers', async () => {
    const arr: McpProvider[] = [builtin('cindy_browser')];
    registerCustomMcpArrays(arr);
    storeMock.listCustomMcpServers.mockResolvedValue([
      { ...config('bad_header'), headers: { 'X-Feishu-Name': '中文' } },
      config('safe_one'),
    ]);

    await refreshCustomMcpProviders();

    expect(arr.map((p) => p.name)).toEqual(['cindy_browser', 'safe_one']);
  });

  it('still allows ids that merely resemble a builtin name', async () => {
    const arr: McpProvider[] = [builtin('cindy_browser')];
    registerCustomMcpArrays(arr);
    storeMock.listCustomMcpServers.mockResolvedValue([config('cindy_browser_x')]);

    await refreshCustomMcpProviders();

    expect(arr.map((p) => p.name)).toEqual(['cindy_browser', 'cindy_browser_x']);
  });

  it('re-evaluates collisions on every refresh instead of leaking old custom providers', async () => {
    const arr: McpProvider[] = [builtin('cindy_browser')];
    registerCustomMcpArrays(arr);

    storeMock.listCustomMcpServers.mockResolvedValue([config('mytools')]);
    await refreshCustomMcpProviders();
    expect(arr.map((p) => p.name)).toEqual(['cindy_browser', 'mytools']);

    storeMock.listCustomMcpServers.mockResolvedValue([config('cindy_browser')]);
    await refreshCustomMcpProviders();
    expect(arr.map((p) => p.name)).toEqual(['cindy_browser']);
  });
});

describe('getBuiltinMcpServerNames', () => {
  it('reports builtin names only, so reserved ids track provider changes automatically', async () => {
    const arr: McpProvider[] = [builtin('cindy_browser'), builtin('cindy_ssh')];
    registerCustomMcpArrays(arr);
    storeMock.listCustomMcpServers.mockResolvedValue([config('mytools')]);
    await refreshCustomMcpProviders();

    expect(getBuiltinMcpServerNames().sort()).toEqual(['cindy_browser', 'cindy_ssh']);
  });

  it('returns nothing when no provider array is registered', () => {
    expect(getBuiltinMcpServerNames()).toEqual([]);
  });
});
