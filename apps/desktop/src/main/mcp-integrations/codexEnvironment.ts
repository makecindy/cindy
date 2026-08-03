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
  withMcpRouteIdentity,
} from './codexHttpBridge.js';
import { getRemoteMcpBridgeToken } from './remoteMcpBridgeToken.js';

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
  /** bridge 上实际挂出的 server 名 (远端注入 config.toml 时按此渲染 mcp_servers 段)。 */
  bridgeServerNames: string[];
  /** 为本地 app-server 的具体 thread 绑定 Session instance 的 URL overrides。 */
  buildSessionMcpConfig?: (sessionInstanceId: string) => Record<string, unknown>;
}

export interface GetCodexExtraSpawnConfigOptions {
  mcpProviders: McpProvider[];
  logger: Logger;
}

let cached: Promise<CodexExtraSpawnConfig> | null = null;
let activeBridge: CodexHttpBridge | null = null;
let activeBridgeServerNames: string[] | null = null;
const disabledPluginPolicyByThread = new Map<
  string,
  { sessionInstanceId?: string; policy: unknown }
>();

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
/**
 * bridge 成功 shutdown 后的失效钩子 (maker-host 注入):远端 session 的 MCP
 * URL / session id 已指向停掉的 bridge, 需要立刻失效 (CC detach + codex
 * strip), 不能等 lazy 重建 (codex-connector R21/R22 P1)。放本模块内部而
 * 非各调用点, 让所有 shutdown 路径 (插件开关 / custom MCP CRUD /
 * contacts / Slack provider / 账号切换 / 未来新增) 自动覆盖。
 * mcp-integrations 不反向依赖 maker-host, 经 setter 注入解耦。
 */
let shutdownHook: (() => void) | null = null;

export function setCodexEnvironmentShutdownHook(fn: (() => void) | null): void {
  shutdownHook = fn;
}

/**
 * 当前活跃 bridge 的实例 id (不触发 lazy 启动;未启动 / 已 shutdown 时
 * null)。live send 的轻量 MCP 漂移判定 (hasPendingRemoteMcpDrift) 用它
 * 区分「bridge 不在 ⇒ 必 ensure」与「比对实例代际」。
 */
export function getActiveCodexBridgeInstanceId(): string | null {
  return activeBridge?.instanceId ?? null;
}

/**
 * 当前活跃 bridge 上实际挂出的 server 名 (不触发 lazy 启动;未启动 / 已
 * shutdown 时 null)。provider 集合在 bridge 启动时冻结 (isEnabled 快照) —
 * Maker Memory 等开关翻转后、bridge 重建前的窗口里, 远端注入 / 漂移判定 /
 * per-session flag 钳制必须以本快照为准, 不能只看 manager 现值, 否则
 * prompt 注入与工具面失配、drift 永不收敛 (review R2 P2)。
 */
export function getActiveCodexBridgeServerNames(): string[] | null {
  // 与 activeBridge 同生共死 (doStart 同步赋值 / shutdown finally 同步清空)。
  // 返回防御性拷贝: 内部数组同时是 drift 判定 / stale-bridge 钳制的数据源,
  // 调用方误改不得污染快照。
  return activeBridgeServerNames ? [...activeBridgeServerNames] : null;
}

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
    if (!bridge || activeBridge === bridge) {
      activeBridge = null;
      activeBridgeServerNames = null;
    }
  }
  // bridge 实际 shutdown 后失效远端 (URL/session id 必然指向已停实例)。
  // cached 为空 (从未启动) 时 early return 不调 — 彼时本就不存在指向
  // bridge 的注入, 无需失效。
  try {
    shutdownHook?.();
  } catch {
    /* 失效失败不阻断 shutdown 主流程 */
  }
}

export function registerCodexMcpThreadContext(
  threadId: string,
  ctx: LiziMcpSessionContext,
): void {
  const requestedPolicy = ctx.vendorOptions?.[CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY];
  const frozen = disabledPluginPolicyByThread.get(threadId);
  if (!frozen || frozen.sessionInstanceId !== ctx.sessionInstanceId) {
    disabledPluginPolicyByThread.set(threadId, {
      ...(ctx.sessionInstanceId ? { sessionInstanceId: ctx.sessionInstanceId } : {}),
      policy: requestedPolicy,
    });
  }
  const effectivePolicy = disabledPluginPolicyByThread.get(threadId)?.policy;
  activeBridge?.registerThreadContext(threadId, {
    ...ctx,
    vendorOptions: {
      ...ctx.vendorOptions,
      [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: effectivePolicy,
    },
  });
}

export function unregisterCodexMcpThreadContext(
  threadId: string,
  expectedSessionInstanceId?: string,
): void {
  const frozen = disabledPluginPolicyByThread.get(threadId);
  if (
    expectedSessionInstanceId !== undefined &&
    frozen !== undefined &&
    frozen.sessionInstanceId !== expectedSessionInstanceId
  ) {
    return;
  }
  disabledPluginPolicyByThread.delete(threadId);
  activeBridge?.unregisterThreadContext(threadId, expectedSessionInstanceId);
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
        // SSH remote 会话的 ctx 字段必须透传 — cindy_memory 用它算 scope key
        // (buildMemoryScopeKey);丢掉的话远端工具会落到本地路径 key 的 store,
        // 与 agent prompt 注入读的 ssh:<hostId>:<path> store 分家 (review R4 P1)。
        ...(active.remoteHostId ? { remoteHostId: active.remoteHostId } : {}),
        vendorOptions: active.vendorOptions,
        sessionId: active.sessionId,
        ...(active.sessionInstanceId
          ? { sessionInstanceId: active.sessionInstanceId }
          : {}),
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
        // 远端常驻 daemon 经 SSH remote-forward 直连本 bridge:接受 persistent
        // token (safeStorage, 跨 app 重启稳定)。函数形式读取,token 首用时惰性
        // 生成也能被后续请求命中。safeStorage 不可用时返回 [],不影响本地。
        additionalBearerTokens: () => {
          const t = getRemoteMcpBridgeToken();
          return t ? [t] : [];
        },
        logger: opts.logger,
      })
    : null;
  const bridgeServerNames = Object.keys(serverFactories);
  activeBridge = bridge;
  activeBridgeServerNames = bridge ? bridgeServerNames : null;

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
  for (const name of bridgeServerNames) {
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
    servers: [...bridgeServerNames, ...Object.keys(remoteHttpServers)],
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
    bridgeServerNames,
    ...(bridge
      ? {
          buildSessionMcpConfig: (sessionInstanceId: string) =>
            Object.fromEntries(
              bridgeServerNames.map((name) => [
                `mcp_servers.${name}.url`,
                withMcpRouteIdentity(bridge.url(name), { sessionInstanceId }),
              ]),
            ),
        }
      : {}),
  };
}
