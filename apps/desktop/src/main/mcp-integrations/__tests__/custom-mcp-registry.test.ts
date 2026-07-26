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

const storeMock = vi.hoisted(() => ({ listCustomMcpServers: vi.fn() }));

vi.mock('../../maker-host/custom-mcp-store.js', () => ({
  listCustomMcpServers: storeMock.listCustomMcpServers,
  // 只把读库这一步换成 mock；判定逻辑用真实实现，避免名单在测试里漂移。
  isUnsafeMcpServerId: (id: string) => ['__proto__', 'constructor', 'prototype'].includes(id),
}));

vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomMcpToken: () => null,
}));

import {
  getBuiltinMcpServerNames,
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
  storeMock.listCustomMcpServers.mockReset();
});

describe('refreshCustomMcpProviders', () => {
  it('appends custom providers that do not collide', async () => {
    const arr: McpProvider[] = [builtin('cindy_browser')];
    registerCustomMcpArrays(arr);
    storeMock.listCustomMcpServers.mockResolvedValue([config('mytools')]);

    await refreshCustomMcpProviders();

    expect(arr.map((p) => p.name)).toEqual(['cindy_browser', 'mytools']);
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
