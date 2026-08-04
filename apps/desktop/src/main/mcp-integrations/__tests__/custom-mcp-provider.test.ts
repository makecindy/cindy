/**
 * CustomMcpProvider —— toClaudeSdkConfig / toCodexMcpConfig / getExtraEnv 在
 * http/sse、有无 token 下的输出。
 */

import { describe, expect, it } from 'vitest';

import type { McpProviderContext } from '@cindy/maker-core';
import type { CustomMcpConfig, RemoteCustomMcpConfig } from '../../../shared/customMcp.js';
import { CustomMcpProvider } from '../custom-mcp-provider.js';

const ctx: McpProviderContext = { agentKind: 'claude-code', workingDir: '/tmp' };

function make(
  config: Partial<RemoteCustomMcpConfig>,
  token: string | null = null,
): CustomMcpProvider {
  const full: RemoteCustomMcpConfig = {
    id: 'mytools',
    name: 'My Tools',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: {},
    ...config,
  };
  return new CustomMcpProvider(full, () => token);
}

describe('CustomMcpProvider', () => {
  it('name = config id', () => {
    expect(make({}).name).toBe('mytools');
  });

  it('toClaudeSdkConfig returns native http config without token', () => {
    expect(make({ transport: 'http' }).toClaudeSdkConfig(ctx)).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    });
  });

  it('passes stdio command, args, encrypted env reader output, and cwd to both agents', () => {
    const config: CustomMcpConfig = {
      id: 'stdio',
      name: 'stdio',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      cwd: 'C:\\work',
    };
    const provider = new CustomMcpProvider(
      config,
      () => null,
      () => ({ API_KEY: 'secret' }),
    );
    expect(provider.toClaudeSdkConfig(ctx)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { API_KEY: 'secret' },
      cwd: 'C:\\work',
    });
    expect(provider.toCodexMcpConfig(ctx)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { API_KEY: 'secret' },
      cwd: 'C:\\work',
    });
  });

  it('does not expose local stdio MCPs to remote Claude sessions', () => {
    const config: CustomMcpConfig = {
      id: 'stdio',
      name: 'stdio',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: 'C:\\work',
    };
    const provider = new CustomMcpProvider(config, () => null, () => ({ API_KEY: 'secret' }));

    expect(
      provider.toClaudeSdkConfig({
        ...ctx,
        remoteHostId: 'ssh-host',
      }),
    ).toBeNull();
  });

  it('keeps stdio env paired with the config snapshot until providers refresh', () => {
    const config: CustomMcpConfig = {
      id: 'stdio',
      name: 'stdio',
      transport: 'stdio',
      command: 'node',
      args: [],
      cwd: '',
    };
    let env = { API_KEY: 'old' };
    const provider = new CustomMcpProvider(
      config,
      () => null,
      () => env,
    );
    env = { API_KEY: 'new' };

    expect(provider.toCodexMcpConfig(ctx)).toMatchObject({ env: { API_KEY: 'old' } });
  });

  it('toClaudeSdkConfig returns sse config with user headers', () => {
    expect(make({ transport: 'sse', headers: { 'X-Foo': 'bar' } }).toClaudeSdkConfig(ctx)).toEqual({
      type: 'sse',
      url: 'https://example.com/mcp',
      headers: { 'X-Foo': 'bar' },
    });
  });

  it('toClaudeSdkConfig injects Authorization: Bearer when token present', () => {
    const cfg = make({ headers: { 'X-Foo': 'bar' } }, 'secret') as CustomMcpProvider;
    expect(cfg.toClaudeSdkConfig(ctx)).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-Foo': 'bar', Authorization: 'Bearer secret' },
    });
  });

  it('does not override a user-provided Authorization header', () => {
    const out = make({ headers: { Authorization: 'Bearer mine' } }, 'secret').toClaudeSdkConfig(
      ctx,
    ) as { headers: Record<string, string> };
    expect(out.headers.Authorization).toBe('Bearer mine');
  });

  it('toCodexMcpConfig returns null for sse transport (Codex only supports Streamable HTTP)', () => {
    expect(make({ transport: 'sse' }).toCodexMcpConfig(ctx)).toBeNull();
  });

  it('toCodexMcpConfig is http with no bearer env when no token (http transport)', () => {
    expect(make({ transport: 'http' }).toCodexMcpConfig(ctx)).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    });
  });

  it('toCodexMcpConfig percent-encodes backslashes so Codex TOML -c args are not corrupted', () => {
    // URL.href preserves backslashes in query strings; TOML treats them as escape chars
    // inside quoted strings, producing malformed config or a different URL in Codex.
    const p = make({ url: 'https://example.com/mcp?x=\\&y=1' });
    const config = p.toCodexMcpConfig(ctx);
    if (!config || config.type !== 'http') throw new Error('expected HTTP config');
    expect(config.url).not.toContain('\\');
    expect(config.url).toContain('%5C');
  });

  it('toCodexMcpConfig points bearerTokenEnvVar + getExtraEnv supplies it when token present', () => {
    const p = make({}, 'secret');
    const codex = p.toCodexMcpConfig(ctx);
    expect(codex).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      bearerTokenEnvVar: 'CUSTOM_MCP_MYTOOLS_TOKEN',
    });
    expect(p.getExtraEnv(ctx)).toEqual({ CUSTOM_MCP_MYTOOLS_TOKEN: 'secret' });
  });

  it('getExtraEnv returns null with no token', () => {
    expect(make({}).getExtraEnv(ctx)).toBeNull();
  });

  it('token env var is injective: ids differing only by - vs _ do not collide', () => {
    const dash = make({ id: 'foo-bar' }, 'tok-dash').getExtraEnv(ctx) as Record<string, string>;
    const under = make({ id: 'foo_bar' }, 'tok-under').getExtraEnv(ctx) as Record<string, string>;
    const dashVar = Object.keys(dash)[0];
    const underVar = Object.keys(under)[0];
    // 关键回归:归一化前 `foo-bar` 与 `foo_bar` 会撞同一个 CUSTOM_MCP_FOO_BAR_TOKEN。
    expect(dashVar).not.toBe(underVar);
    // 且 codex 端 bearerTokenEnvVar 与 getExtraEnv 的键保持一致。
    expect(make({ id: 'foo-bar' }, 'tok-dash').toCodexMcpConfig(ctx)).toMatchObject({
      bearerTokenEnvVar: dashVar,
    });
  });

  // ── Codex 自定义 header 透传 (env_http_headers) ──────────────────────────────

  it('toCodexMcpConfig maps custom headers to env var refs (values go via env, not args)', () => {
    const p = make({ headers: { 'xd-themis-sk': 'sk-123', 'xd-themis-user': 'alice' } });
    expect(p.toCodexMcpConfig(ctx)).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      envHttpHeaders: {
        'xd-themis-sk': 'CUSTOM_MCP_MYTOOLS_HDR_XD_2DTHEMIS_2DSK',
        'xd-themis-user': 'CUSTOM_MCP_MYTOOLS_HDR_XD_2DTHEMIS_2DUSER',
      },
    });
  });

  it('getExtraEnv supplies each custom header value under its header env var', () => {
    const p = make({ headers: { 'xd-themis-sk': 'sk-123', 'xd-themis-user': 'alice' } });
    expect(p.getExtraEnv(ctx)).toEqual({
      CUSTOM_MCP_MYTOOLS_HDR_XD_2DTHEMIS_2DSK: 'sk-123',
      CUSTOM_MCP_MYTOOLS_HDR_XD_2DTHEMIS_2DUSER: 'alice',
    });
  });

  it('custom headers + bearer token coexist (env_http_headers + bearer_token_env_var)', () => {
    const p = make({ headers: { 'X-Api-Key': 'k' } }, 'secret');
    expect(p.toCodexMcpConfig(ctx)).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      bearerTokenEnvVar: 'CUSTOM_MCP_MYTOOLS_TOKEN',
      envHttpHeaders: { 'X-Api-Key': 'CUSTOM_MCP_MYTOOLS_HDR_X_2DAPI_2DKEY' },
    });
    expect(p.getExtraEnv(ctx)).toEqual({
      CUSTOM_MCP_MYTOOLS_TOKEN: 'secret',
      CUSTOM_MCP_MYTOOLS_HDR_X_2DAPI_2DKEY: 'k',
    });
  });

  it('a user-provided Authorization header suppresses the bearer token (mirrors Claude)', () => {
    const p = make({ headers: { authorization: 'Bearer mine' } }, 'secret');
    const codex = p.toCodexMcpConfig(ctx);
    if (!codex || codex.type !== 'http') throw new Error('expected HTTP config');
    // 不叠加 bearer_token_env_var,Authorization 走 env_http_headers。
    expect(codex.bearerTokenEnvVar).toBeUndefined();
    expect(codex.envHttpHeaders).toEqual({
      authorization: 'CUSTOM_MCP_MYTOOLS_HDR_AUTHORIZATION',
    });
    expect(p.getExtraEnv(ctx)).toEqual({
      CUSTOM_MCP_MYTOOLS_HDR_AUTHORIZATION: 'Bearer mine',
    });
  });

  it('sse transport injects neither headers nor token into Codex env', () => {
    const p = make({ transport: 'sse', headers: { 'X-Foo': 'bar' } }, 'secret');
    expect(p.toCodexMcpConfig(ctx)).toBeNull();
    expect(p.getExtraEnv(ctx)).toBeNull();
  });

  it('header env var is injective across header names differing only by - vs _', () => {
    const dash = make({ headers: { 'x-a': '1' } }).getExtraEnv(ctx) as Record<string, string>;
    const under = make({ headers: { x_a: '1' } }).getExtraEnv(ctx) as Record<string, string>;
    expect(Object.keys(dash)[0]).not.toBe(Object.keys(under)[0]);
  });
});
