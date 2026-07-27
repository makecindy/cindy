/**
 * codexEnvironment — 把 Cindy MCP providers 暴露成 codex spawn 时用的
 * extraArgs (-c flags) + extraEnv (LIZI_MCP_TOKEN)。
 *
 * Lazy + cached：第一次 CodexAgent.getHost() 调用时启动 HTTP bridge，整个
 * main 进程共享一份。app.before-quit 调 shutdownCodexEnvironment 收 bridge。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger, McpProvider, McpProviderContext } from '@cindy/maker-core';
import { getLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';
import { pluginIdForKnownProviderName } from '../maker-host/plugins/builtin-plugins.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from './codexBuiltinToolPolicy.js';

import {
  startCodexHttpBridge,
  type CodexHttpBridge,
} from './codexHttpBridge.js';

const TOKEN_ENV = 'LIZI_MCP_TOKEN';
const MCP_TIMEOUT_SEC = 10 * 60;

/**
 * 把一个 header 名渲染成 codex `-c` override 里合法的 TOML dotted-key 段。
 *
 * 常见 HTTP header(`X-Api-Key`、`xd-themis-sk` 等)只含 [A-Za-z0-9_-],正好是
 * TOML 裸键允许字符,直接原样输出。含点号等特殊字符的少见 header 用 TOML 引号键
 * 包裹并转义 `\` 与 `"`,避免点号被误解析成嵌套表。
 */
function tomlDottedKeySegment(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface CodexExtraSpawnConfig {
  /** 拼到 codex spawn 的 extraArgs 里：-c 'mcp_servers.xxx.url=...' 等 */
  extraArgs: string[];
  /** 拼到 codex spawn 的 env 里：{ LIZI_MCP_TOKEN: <token> } */
  extraEnv: Record<string, string>;
  /** 暴露 bridge 给诊断 / 测试用，业务侧通常不直接用；只有纯远程 MCP 时为 null。 */
  bridge: CodexHttpBridge | null;
}

export interface GetCodexExtraSpawnConfigOptions {
  mcpProviders: McpProvider[];
  logger: Logger;
}

let cached: Promise<CodexExtraSpawnConfig> | null = null;
let activeBridge: CodexHttpBridge | null = null;
const disabledPluginIdsByThread = new Map<string, unknown>();

/**
 * 懒启动 + 缓存。多个 codex session 并发首次调用共享同一个 in-flight Promise，
 * 不会重复 spawn HTTP server。失败时 cached=null 让下次调用能重试 (但真失败
 * 基本是端口/权限问题，重试也会再失败，主要是不阻塞冷启动)。
 *
 * 跟 AppServerHost.startPromise 同款模式 (host.ts:170-209)。
 */
export function getCodexExtraSpawnConfig(
  opts: GetCodexExtraSpawnConfigOptions,
): Promise<CodexExtraSpawnConfig> {
  if (cached) return cached;
  cached = doStart(opts).catch((err) => {
    // 失败要 reset 让下次能再试 (不然一次失败永远拿不回来)
    cached = null;
    throw err;
  });
  return cached;
}

/** before-quit 调一次。**先**等 codexAgent.dispose() 杀完子进程**再**调这个 (见 plan)。 */
export async function shutdownCodexEnvironment(): Promise<void> {
  const cur = cached;
  if (!cur) return;
  cached = null;
  let bridge: CodexHttpBridge | null = null;
  try {
    const cfg = await cur;
    bridge = cfg.bridge;
    await bridge?.shutdown();
  } catch {
    /* 启动本身失败的 cached promise — shutdown 无 op */
  } finally {
    if (!bridge || activeBridge === bridge) activeBridge = null;
  }
}

export function registerCodexMcpThreadContext(
  threadId: string,
  ctx: LiziMcpSessionContext,
): void {
  const requestedPolicy = ctx.vendorOptions?.[CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY];
  if (!disabledPluginIdsByThread.has(threadId)) {
    disabledPluginIdsByThread.set(threadId, requestedPolicy);
  }
  activeBridge?.registerThreadContext(threadId, {
    ...ctx,
    vendorOptions: {
      ...ctx.vendorOptions,
      [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: disabledPluginIdsByThread.get(threadId),
    },
  });
}

export function unregisterCodexMcpThreadContext(threadId: string): void {
  disabledPluginIdsByThread.delete(threadId);
  activeBridge?.unregisterThreadContext(threadId);
}

async function doStart(
  opts: GetCodexExtraSpawnConfigOptions,
): Promise<CodexExtraSpawnConfig> {
  const log = opts.logger.child('codex-environment');

  // 从 providers 提取 McpServer factory。每个 provider 的 toClaudeSdkConfig
  // 返回 { type: 'sdk', name, instance: McpServer } —— Claude SDK 的格式。
  // 注意: MCP SDK 的 McpServer/Protocol 实例只能 connect 一个 transport；
  // Codex app-server 是长生命周期、多 thread/session 复用的，所以 HTTP bridge
  // 必须为每个 streamable-http session 创建新的 McpServer 实例。
  // server factory 阶段没有 Codex thread id，只能使用全局空 ctx。控制类工具
  // 必须通过 getSessionContext 在 tool-call 时读取 HTTP bridge 根据
  // JSON-RPC params._meta.threadId 注入的真实 ctx，不能信任工具参数自报
  // session / worker 身份。
  const ctx: McpProviderContext = {
    agentKind: 'codex',
    workingDir: '',
    vendorOptions: {},
    getSessionContext: () => {
      const active = getLiziMcpSessionContext();
      if (active?.agentKind !== 'codex' && active?.agentKind !== 'claude-code') return undefined;
      return {
        agentKind: active.agentKind,
        workingDir: active.workingDir,
        vendorOptions: active.vendorOptions,
        sessionId: active.sessionId,
        getSessionContext: ctx.getSessionContext,
      };
    },
  };
  // null-prototype：server 名可能来自用户可控来源（自定义 MCP id、插件身份卡），而
  // `__proto__` 这类名字在普通 `{}` 上命中的是原型 setter —— 该 server 不会出现在
  // Object.keys / Object.entries 里，于是在 Codex 侧静默消失，同一份配置却在 Claude 侧
  // 正常工作。registry 已从源头隔离这类 id，这里是对称的纵深防御（Claude 侧的
  // buildMcpServers 同样用 null-prototype）。
  const serverFactories: Record<string, () => McpServer> = Object.create(null);
  const pluginIdByServerName: Record<string, string> = Object.create(null);
  const remoteHttpServers: Record<
    string,
    { url: string; bearerTokenEnvVar?: string; envHttpHeaders?: Record<string, string> }
  > = Object.create(null);
  const extraEnv: Record<string, string> = {};
  for (const provider of opts.mcpProviders) {
    if (provider.isEnabled && !provider.isEnabled(ctx)) continue;

    const providerEnv = await provider.getExtraEnv?.(ctx);
    if (providerEnv) Object.assign(extraEnv, providerEnv);

    const codexConfig = provider.toCodexMcpConfig?.(ctx);
    if (codexConfig?.type === 'http') {
      if (codexConfig.bearerTokenEnvVar && !extraEnv[codexConfig.bearerTokenEnvVar]) {
        log.warn('skipping remote HTTP MCP provider - missing bearer token env', {
          providerName: provider.name,
          envVar: codexConfig.bearerTokenEnvVar,
        });
      } else {
        remoteHttpServers[provider.name] = {
          url: codexConfig.url,
          ...(codexConfig.bearerTokenEnvVar ? { bearerTokenEnvVar: codexConfig.bearerTokenEnvVar } : {}),
          ...(codexConfig.envHttpHeaders && Object.keys(codexConfig.envHttpHeaders).length > 0
            ? { envHttpHeaders: codexConfig.envHttpHeaders }
            : {}),
        };
      }
      continue;
    }

    const toClaudeSdkConfig = provider.toClaudeSdkConfig;
    if (!toClaudeSdkConfig) continue;

    const createServer = (): McpServer => {
      const cfg = toClaudeSdkConfig(ctx) as
        | { type?: string; name?: string; instance?: unknown }
        | null;
      if (cfg?.type !== 'sdk' || !cfg.instance) {
        throw new Error(
          `provider ${provider.name} did not return an SDK McpServer instance`,
        );
      }
      return cfg.instance as McpServer;
    };

    let firstInstance: McpServer | null;
    try {
      firstInstance = createServer();
    } catch (err) {
      log.warn('skipping provider - toClaudeSdkConfig did not return SDK instance', {
        providerName: provider.name,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    serverFactories[provider.name] = () => {
      if (firstInstance) {
        const instance = firstInstance;
        firstInstance = null;
        return instance;
      }
      return createServer();
    };
    const pluginId = pluginIdForKnownProviderName(provider.name);
    if (pluginId) pluginIdByServerName[provider.name] = pluginId;
  }

  if (Object.keys(serverFactories).length === 0 && Object.keys(remoteHttpServers).length === 0) {
    throw new Error('codexEnvironment: no MCP server instances available from providers');
  }

  // 只有存在 in-process SDK server 时才起 HTTP bridge；纯远程 MCP (如 Slack 官方)
  // 不需要 bridge，bridge 保持 null。
  const bridge = Object.keys(serverFactories).length > 0
    ? await startCodexHttpBridge({
        serverFactories,
        pluginIdByServerName,
        logger: opts.logger,
      })
    : null;
  activeBridge = bridge;

  const extraArgs: string[] = [];
  // 远程 MCP server：直接把 codex 指向远端 URL，token 走 env (bearer_token_env_var)。
  for (const [name, cfg] of Object.entries(remoteHttpServers)) {
    extraArgs.push('-c', `mcp_servers.${name}.url="${cfg.url}"`);
    if (cfg.bearerTokenEnvVar) {
      extraArgs.push('-c', `mcp_servers.${name}.bearer_token_env_var="${cfg.bearerTokenEnvVar}"`);
    }
    // 自定义 header：值走 env（env_http_headers 映射 header 名 → env var 名），
    // 密钥类 header 不暴露在 process args；env var 的实际值由 provider.getExtraEnv 注入。
    for (const [headerName, envVar] of Object.entries(cfg.envHttpHeaders ?? {})) {
      extraArgs.push(
        '-c',
        `mcp_servers.${name}.env_http_headers.${tomlDottedKeySegment(headerName)}="${envVar}"`,
      );
    }
    extraArgs.push('-c', `mcp_servers.${name}.startup_timeout_sec=${MCP_TIMEOUT_SEC}`);
    extraArgs.push('-c', `mcp_servers.${name}.tool_timeout_sec=${MCP_TIMEOUT_SEC}`);
  }
  for (const name of Object.keys(serverFactories)) {
    const url = bridge!.url(name);
    // TOML 字符串值必须带双引号 (codex `-c` 解析时按 TOML literal)；
    // bearer_token_env_var 让 codex 从 env 读 token，不暴露在 process args。
    extraArgs.push('-c', `mcp_servers.${name}.url="${url}"`);
    extraArgs.push('-c', `mcp_servers.${name}.bearer_token_env_var="${TOKEN_ENV}"`);
    extraArgs.push('-c', `mcp_servers.${name}.startup_timeout_sec=${MCP_TIMEOUT_SEC}`);
    extraArgs.push('-c', `mcp_servers.${name}.tool_timeout_sec=${MCP_TIMEOUT_SEC}`);
  }

  log.info('codex MCP bridge wired', {
    port: bridge?.port ?? null,
    servers: [...Object.keys(serverFactories), ...Object.keys(remoteHttpServers)],
    remoteHttpServers: Object.keys(remoteHttpServers),
    extraArgsCount: extraArgs.length,
  });

  return {
    extraArgs,
    extraEnv: {
      ...extraEnv,
      ...(bridge ? { [TOKEN_ENV]: bridge.token } : {}),
    },
    bridge,
  };
}
