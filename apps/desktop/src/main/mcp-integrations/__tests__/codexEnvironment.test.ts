import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Logger, McpProvider } from '@cindy/maker-core';
import {
  getActiveCodexBridgeServerNames,
  getCodexExtraSpawnConfig,
  registerCodexMcpThreadContext,
  setCodexEnvironmentShutdownHook,
  shutdownCodexEnvironment,
  unregisterCodexMcpThreadContext,
} from '../codexEnvironment.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '../codexBuiltinToolPolicy.js';

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function testProvider(): McpProvider {
  return {
    name: 'cindy_test',
    toClaudeSdkConfig: () => ({
      type: 'sdk',
      name: 'cindy_test',
      instance: new McpServer({ name: 'cindy_test', version: '1.0.0' }),
    }),
  };
}

function slackProvider(isBound: () => boolean): McpProvider {
  return {
    name: 'cindy_slack',
    isEnabled: isBound,
    toClaudeSdkConfig: () => ({
      type: 'sdk',
      name: 'cindy_slack',
      instance: new McpServer({ name: 'cindy_slack', version: '1.0.0' }),
    }),
  };
}

/** server 名是不安全对象 key 的远程 provider（自定义 MCP id 正则允许 `__proto__`）。 */
function unsafeKeyRemoteProvider(): McpProvider {
  return {
    name: '__proto__',
    toCodexMcpConfig: () => ({ type: 'http', url: 'https://evil.example/mcp' }),
  };
}

/** 远程 HTTP MCP provider(无 in-process SDK server),带自定义 header。 */
function remoteHttpProvider(): McpProvider {
  return {
    name: 'themis',
    toCodexMcpConfig: () => ({
      type: 'http',
      url: 'https://themis.example/mcp',
      envHttpHeaders: { 'xd-themis-sk': 'CUSTOM_MCP_THEMIS_HDR_XD_2DTHEMIS_2DSK' },
    }),
    getExtraEnv: () => ({ CUSTOM_MCP_THEMIS_HDR_XD_2DTHEMIS_2DSK: 'sk-123' }),
  };
}

function extractUrl(args: string[]): URL {
  const value = args.find((arg) => arg.startsWith('mcp_servers.cindy_test.url='));
  if (!value) throw new Error('missing cindy_test URL arg');
  const raw = value.slice('mcp_servers.cindy_test.url='.length);
  return new URL(raw.replace(/^"|"$/g, ''));
}

describe('codexEnvironment', () => {
  afterEach(async () => {
    setCodexEnvironmentShutdownHook(null);
    await shutdownCodexEnvironment();
  });

  it('reuses one bridge and exposes unbound MCP server URLs', async () => {
    const logger = noopLogger();
    const providers = [testProvider()];

    const first = await getCodexExtraSpawnConfig({
      mcpProviders: providers,
      logger,
    });
    const second = await getCodexExtraSpawnConfig({
      mcpProviders: providers,
      logger,
    });

    const firstUrl = extractUrl(first.extraArgs);
    const secondUrl = extractUrl(second.extraArgs);

    expect(first).toBe(second);
    expect(first.bridge).toBe(second.bridge);
    expect(first.extraEnv).toEqual(second.extraEnv);
    expect(firstUrl.origin).toBe(secondUrl.origin);
    expect(firstUrl.pathname).toBe('/mcp/cindy_test');
    expect(secondUrl.pathname).toBe('/mcp/cindy_test');

    expect(first.buildSessionMcpConfig).toBeTypeOf('function');
    const boundConfig = first.buildSessionMcpConfig!('instance-1');
    const boundUrl = new URL(boundConfig['mcp_servers.cindy_test.url'] as string);
    expect(boundUrl.origin).toBe(firstUrl.origin);
    expect(boundUrl.pathname).toBe('/mcp/cindy_test');
    expect(boundUrl.searchParams.get('instance')).toBe('instance-1');
    expect(boundUrl.searchParams.has('session')).toBe(false);

    const replacementUrl = new URL(
      first.buildSessionMcpConfig!('instance-2')['mcp_servers.cindy_test.url'] as string,
    );
    expect(replacementUrl.searchParams.get('instance')).toBe('instance-2');
    expect(replacementUrl.toString()).not.toBe(boundUrl.toString());
  });

  it('freezes policy within one session instance but replaces it on thread rebinding', async () => {
    const cfg = await getCodexExtraSpawnConfig({
      mcpProviders: [testProvider()],
      logger: noopLogger(),
    });
    const register = vi.spyOn(cfg.bridge!, 'registerThreadContext');
    const unregister = vi.spyOn(cfg.bridge!, 'unregisterThreadContext');

    registerCodexMcpThreadContext('thread-1', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-old',
      workingDir: '/project',
      vendorOptions: { [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['cindy-ssh'] },
      mcpCallerKind: 'descendant',
      mcpCallerAttested: true,
    });
    registerCodexMcpThreadContext('thread-1', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-old',
      workingDir: '/project',
      vendorOptions: { [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: [] },
    });

    expect(register).toHaveBeenLastCalledWith(
      'thread-1',
      expect.objectContaining({
        mcpCallerKind: 'descendant',
        mcpCallerAttested: true,
        vendorOptions: expect.objectContaining({
          [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['cindy-ssh'],
        }),
      }),
    );

    registerCodexMcpThreadContext('thread-1', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-new',
      workingDir: '/project',
      vendorOptions: { [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: [] },
      mcpCallerKind: 'descendant',
      mcpCallerAttested: true,
    });
    expect(register).toHaveBeenLastCalledWith(
      'thread-1',
      expect.objectContaining({
        sessionInstanceId: 'instance-new',
        mcpCallerKind: 'descendant',
        mcpCallerAttested: true,
        vendorOptions: expect.objectContaining({
          [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: [],
        }),
      }),
    );

    unregisterCodexMcpThreadContext('thread-1', 'instance-old');
    expect(unregister).not.toHaveBeenCalled();
    unregisterCodexMcpThreadContext('thread-1', 'instance-new');
    expect(unregister).toHaveBeenCalledWith('thread-1', 'instance-new');
  });

  it('does not carry provenance into a new session instance and preserves explicit unknown/false', async () => {
    const cfg = await getCodexExtraSpawnConfig({
      mcpProviders: [testProvider()],
      logger: noopLogger(),
    });
    const register = vi.spyOn(cfg.bridge!, 'registerThreadContext');

    registerCodexMcpThreadContext('thread-provenance', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-old',
      workingDir: '/project',
      mcpCallerKind: 'descendant',
      mcpCallerAttested: true,
    });
    registerCodexMcpThreadContext('thread-provenance', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-new',
      workingDir: '/project',
    });
    expect(register).toHaveBeenLastCalledWith(
      'thread-provenance',
      expect.objectContaining({
        sessionInstanceId: 'instance-new',
        mcpCallerKind: undefined,
        mcpCallerAttested: undefined,
      }),
    );

    registerCodexMcpThreadContext('thread-provenance', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-new',
      workingDir: '/project',
      mcpCallerKind: 'unknown',
      mcpCallerAttested: false,
    });
    registerCodexMcpThreadContext('thread-provenance', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-new',
      workingDir: '/project',
    });
    expect(register).toHaveBeenLastCalledWith(
      'thread-provenance',
      expect.objectContaining({
        mcpCallerKind: 'unknown',
        mcpCallerAttested: false,
      }),
    );
  });

  it('clears provenance on unregister so a reused thread starts unknown', async () => {
    const cfg = await getCodexExtraSpawnConfig({
      mcpProviders: [testProvider()],
      logger: noopLogger(),
    });
    const register = vi.spyOn(cfg.bridge!, 'registerThreadContext');
    const unregister = vi.spyOn(cfg.bridge!, 'unregisterThreadContext');

    registerCodexMcpThreadContext('thread-reused', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-old',
      workingDir: '/project',
      mcpCallerKind: 'root',
      mcpCallerAttested: true,
    });
    unregisterCodexMcpThreadContext('thread-reused', 'instance-old');
    registerCodexMcpThreadContext('thread-reused', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-new',
      workingDir: '/project',
    });

    expect(unregister).toHaveBeenCalledWith('thread-reused', 'instance-old');
    expect(register).toHaveBeenLastCalledWith(
      'thread-reused',
      expect.objectContaining({
        sessionInstanceId: 'instance-new',
        mcpCallerKind: undefined,
        mcpCallerAttested: undefined,
      }),
    );
  });

  it('does not let an old unregister clear a new provenance generation without vendor policy', async () => {
    const cfg = await getCodexExtraSpawnConfig({
      mcpProviders: [testProvider()],
      logger: noopLogger(),
    });
    const register = vi.spyOn(cfg.bridge!, 'registerThreadContext');
    const unregister = vi.spyOn(cfg.bridge!, 'unregisterThreadContext');

    registerCodexMcpThreadContext('thread-generation', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-old',
      workingDir: '/project',
      mcpCallerKind: 'descendant',
      mcpCallerAttested: true,
    });
    registerCodexMcpThreadContext('thread-generation', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-new',
      workingDir: '/project',
      mcpCallerKind: 'root',
      mcpCallerAttested: true,
    });

    unregisterCodexMcpThreadContext('thread-generation', 'instance-old');
    expect(unregister).not.toHaveBeenCalled();
    registerCodexMcpThreadContext('thread-generation', {
      agentKind: 'codex',
      sessionInstanceId: 'instance-new',
      workingDir: '/project',
    });
    expect(register).toHaveBeenLastCalledWith(
      'thread-generation',
      expect.objectContaining({
        mcpCallerKind: 'root',
        mcpCallerAttested: true,
      }),
    );
  });

  it('Slack 在 bridge 启动后完成绑定时，清缓存会按最新 provider gate 重建', async () => {
    let bound = false;
    const providers = [testProvider(), slackProvider(() => bound)];
    const logger = noopLogger();

    const beforeBind = await getCodexExtraSpawnConfig({ mcpProviders: providers, logger });
    expect(beforeBind.extraArgs.some((arg) => arg.startsWith('mcp_servers.cindy_slack.'))).toBe(false);

    // Codex 的 provider 集合冻结在首个 cached spawn config；仅改变绑定态还不会出现。
    bound = true;
    const stillFrozen = await getCodexExtraSpawnConfig({ mcpProviders: providers, logger });
    expect(stillFrozen).toBe(beforeBind);
    expect(stillFrozen.extraArgs.some((arg) => arg.startsWith('mcp_servers.cindy_slack.'))).toBe(false);

    // hook-control 收到 bound gate 翻转后会走同一失效出口，再次构建即可看到工具。
    await shutdownCodexEnvironment();
    const afterBind = await getCodexExtraSpawnConfig({ mcpProviders: providers, logger });
    expect(afterBind.extraArgs.some((arg) => arg.startsWith('mcp_servers.cindy_slack.'))).toBe(true);
  });

  it('serializes remote HTTP custom headers as env_http_headers -c overrides (no bridge)', async () => {
    const cfg = await getCodexExtraSpawnConfig({
      mcpProviders: [remoteHttpProvider()],
      logger: noopLogger(),
    });

    // 纯远程 MCP，不需要 in-process bridge。
    expect(cfg.bridge).toBeNull();
    // header 值走 env，env var 名进 -c，实际值进 extraEnv（不暴露在 process args）。
    expect(cfg.extraArgs).toContain(
      'mcp_servers.themis.env_http_headers.xd-themis-sk="CUSTOM_MCP_THEMIS_HDR_XD_2DTHEMIS_2DSK"',
    );
    expect(cfg.extraEnv).toMatchObject({
      CUSTOM_MCP_THEMIS_HDR_XD_2DTHEMIS_2DSK: 'sk-123',
    });
    // 密钥明文绝不出现在 spawn 参数里。
    expect(cfg.extraArgs.some((a) => a.includes('sk-123'))).toBe(false);
  });

  // server 名可能来自用户可控来源（自定义 MCP id、插件身份卡）。普通 `{}` 上
  // `map['__proto__'] = cfg` 命中的是原型 setter：该 server 不出现在 Object.entries 里，
  // 于是在 Codex 侧静默消失，同一份配置却在 Claude 侧正常工作。
  it('keeps an unsafe object-key server name visible instead of hitting the prototype setter', async () => {
    const cfg = await getCodexExtraSpawnConfig({
      mcpProviders: [unsafeKeyRemoteProvider(), remoteHttpProvider()],
      logger: noopLogger(),
    });

    expect(cfg.extraArgs).toContain('mcp_servers.__proto__.url="https://evil.example/mcp"');
    // 同批次的正常 provider 不受影响，原型也没有被污染。
    expect(cfg.extraArgs).toContain('mcp_servers.themis.url="https://themis.example/mcp"');
    expect(Object.getPrototypeOf({} as Record<string, unknown>)).toBe(Object.prototype);
  });

  it('exposes the active bridge server-name snapshot and clears it on shutdown (R2 P2)', async () => {
    // stale-bridge 钳制的数据源:活跃 bridge 的 server 集合 (启动时冻结),
    // 远端 flag 钳制 / drift 判定用它区分「bridge 缺 cindy_memory 的窗口」
    // 与「无 bridge (lazy 重建在即)」。
    expect(getActiveCodexBridgeServerNames()).toBeNull(); // 未启动

    await getCodexExtraSpawnConfig({ mcpProviders: [testProvider()], logger: noopLogger() });
    expect(getActiveCodexBridgeServerNames()).toEqual(['cindy_test']);

    await shutdownCodexEnvironment();
    expect(getActiveCodexBridgeServerNames()).toBeNull(); // shutdown 后清空
  });

  it('invokes the shutdown hook after the bridge stops, on every shutdown path (R22 P1)', async () => {
    // 远端失效钩子折进 shutdownCodexEnvironment 内部:任何调用点 (插件开关 /
    // custom MCP CRUD / contacts / 账号切换) 都自动覆盖, 不靠逐点挂接。
    const hook = vi.fn();
    setCodexEnvironmentShutdownHook(hook);
    await getCodexExtraSpawnConfig({ mcpProviders: [testProvider()], logger: noopLogger() });
    expect(hook).not.toHaveBeenCalled(); // 未 shutdown 不调

    await shutdownCodexEnvironment();
    expect(hook).toHaveBeenCalledTimes(1);

    // 未启动过时 (cached 为空) shutdown 是 no-op, 不调 hook。
    await shutdownCodexEnvironment();
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
