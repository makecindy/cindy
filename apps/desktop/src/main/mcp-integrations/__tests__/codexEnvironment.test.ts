import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Logger, McpProvider } from '@cindy/maker-core';
import {
  getCodexExtraSpawnConfig,
  registerCodexMcpThreadContext,
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
  });

  it('preserves a thread disabled-tool policy across context re-registration', async () => {
    const cfg = await getCodexExtraSpawnConfig({
      mcpProviders: [testProvider()],
      logger: noopLogger(),
    });
    const register = vi.spyOn(cfg.bridge!, 'registerThreadContext');

    registerCodexMcpThreadContext('thread-1', {
      agentKind: 'codex',
      workingDir: '/project',
      vendorOptions: { [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['cindy-ssh'] },
    });
    registerCodexMcpThreadContext('thread-1', {
      agentKind: 'codex',
      workingDir: '/project',
      vendorOptions: { [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: [] },
    });

    expect(register).toHaveBeenLastCalledWith(
      'thread-1',
      expect.objectContaining({
        vendorOptions: expect.objectContaining({
          [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['cindy-ssh'],
        }),
      }),
    );
    unregisterCodexMcpThreadContext('thread-1');
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
});
