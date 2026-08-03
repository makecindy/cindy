/**
 * piEnvironment —— pi agent 的 MCP 环境准备(desktop host 侧)。
 *
 * 与 codexEnvironment 同因:pi 是独立子进程(bun 单二进制),没法消费 in-process
 * JS McpServer instance;把各 provider 的 instance 经 streamable-HTTP bridge
 * (复用 codexHttpBridge —— localhost-only + bearer token)暴露出去,PiAgent 把
 * {token, servers} 经 env 交给 pi 内的 cindy-bridge extension 注册成工具。
 *
 * session 身份(orca / 会话身份类工具能绑定当前 pi 会话):
 *  - bridge 是懒启动单例(所有 pi 会话共享 HTTP server + server 工厂)。
 *  - 带 sessionId 的会话:在 bridge 上 registerSessionCtx + 给该会话的 server URL
 *    打 `?session=<id>&instance=<opaque>` 路由 —— 与远端 Claude Code 的身份通道同机制。工具 handler
 *    经 getLiziMcpSessionContext() 拿到 {agentKind:'pi', sessionId, ...},
 *    start_team/create_worker 据此绑定 Lead(否则回落 LEAD_NOT_SUPPORTED)。
 *  - 匿名会话(无 sessionId):不注册、URL 不带 query,走无 ctx 兜底(行为同改动前)。
 *  - 关键不变量:URL 带 `?session=` 但 bridge 未注册该 id → 401 fail-closed 打死
 *    该会话全部 pi 工具。故"注册"与"打 query"必须成对:register-before-return /
 *    dispose-on-close,二者其一缺失即 401 或 ctx 泄漏。
 *
 * 差异:
 *  - 远程 HTTP 型 MCP(toCodexMcpConfig type='http',如 Slack 官方):P0 先跳过
 *    并记日志 —— pi extension 侧尚未实现远程鉴权头透传;后续补。
 *
 * 生命周期:bridge 懒启动单例。挂了(端口被占等)返回 null,pi 跑纯内置工具。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  McpProvider,
  McpProviderContext,
  PiExtraSpawnConfig,
  PiExtraSpawnConfigContext,
} from '@cindy/maker-core';

import { getLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';

import type { Logger as MakerLogger } from '@cindy/maker-core';

import {
  startCodexHttpBridge,
  type CodexHttpBridge,
  withMcpRouteIdentity,
} from './codexHttpBridge.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from './codexBuiltinToolPolicy.js';
import { pluginIdForKnownProviderName } from '../maker-host/plugins/builtin-plugins.js';
// 直接取 plugins 模块的 registry 单例,不经 maker-host/index.ts —— 后者 import pi-host,
// 从 mcp-integrations 反向 import 会成环。
import { createPluginRegistry } from '../maker-host/plugins/index.js';

interface StartedPiBridge {
  bridge: CodexHttpBridge;
  serverNames: string[];
  generation: number;
  refs: number;
  retired: boolean;
  shutdownPromise: Promise<void> | null;
}

let startPromise: Promise<StartedPiBridge | null> | null = null;
let activeGeneration: StartedPiBridge | null = null;
let environmentEpoch = 0;
let nextGeneration = 0;
const generations = new Set<StartedPiBridge>();

function shutdownGeneration(started: StartedPiBridge): Promise<void> {
  if (!started.shutdownPromise) {
    started.shutdownPromise = started.bridge.shutdown().catch(() => {}).finally(() => {
      generations.delete(started);
    });
  }
  return started.shutdownPromise;
}

function retireGeneration(started: StartedPiBridge): void {
  started.retired = true;
  if (started.refs === 0) void shutdownGeneration(started);
}

function releaseGeneration(started: StartedPiBridge): void {
  if (started.refs > 0) started.refs -= 1;
  if (started.retired && started.refs === 0) void shutdownGeneration(started);
}

/**
 * 为一次 pi startSession 准备 MCP 桥配置。
 *
 * bridge 单例懒启动并缓存;每次调用按传入 sessionCtx 产出 per-session 的
 * server URL(带/不带 `?session=`)并做对应的身份注册。
 */
export async function getPiExtraSpawnConfig(
  providers: McpProvider[],
  logger: MakerLogger,
  sessionCtx?: PiExtraSpawnConfigContext,
): Promise<PiExtraSpawnConfig | null> {
  const started = await ensureBridge(providers, logger);
  if (!started) return null;
  // JS 同步段内完成“确认未退役 + 加 lease”，invalidate 不会插进中间。
  if (started.retired) return getPiExtraSpawnConfig(providers, logger, sessionCtx);
  started.refs += 1;

  const { bridge, serverNames } = started;
  const sessionId = sessionCtx?.sessionId?.trim();
  let disposed = false;
  const disposeLease = (): void => {
    if (disposed) return;
    disposed = true;
    releaseGeneration(started);
  };

  // 匿名会话:不注册身份、URL 不带 query。工具 handler 拿不到 ctx 时回落业务
  // 错误码(如 LEAD_NOT_SUPPORTED)—— 与改动前一致,不打 401。
  if (!sessionId) {
    return {
      mcpBridge: {
        token: bridge.token,
        servers: serverNames.map((name) => ({ name, url: bridge.url(name) })),
      },
      disposeSessionCtx: disposeLease,
    };
  }

  // 带 sessionId:注册身份 ctx,再给该会话的 server URL 打 `?session=` 路由。
  // 项目级普通工具策略在此按会话 workdir 冻结进 vendorOptions(与 Codex 的
  // registerCodexMcpThreadContext 同键同语义):bridge 的 per-call gate 据此阻断本项目
  // 停用的内置工具,后续 Settings 变更不影响已在跑的会话(codex review)。
  const disabledPluginIds = createPluginRegistry().getDisabledRuntimePluginIds(
    sessionCtx?.workingDir ?? '',
  );
  const liziCtx: LiziMcpSessionContext = {
    agentKind: 'pi',
    sessionId,
    ...(sessionCtx?.sessionInstanceId
      ? { sessionInstanceId: sessionCtx.sessionInstanceId }
      : {}),
    workingDir: sessionCtx?.workingDir ?? '',
    vendorOptions: {
      ...sessionCtx?.vendorOptions,
      [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: disabledPluginIds,
    },
  };
  // 同 session 重建(resume/reattach)直接覆盖注册,注册表以 sessionId 为 key,
  // 天然不累积。必须在返回(即 spawn)前完成 —— cindy-bridge extension 一起进程
  // 就会带 `?session=` 发 initialize,注册晚于它即 401。
  try {
    bridge.registerSessionCtx(sessionId, liziCtx);
  } catch (error) {
    disposeLease();
    throw error;
  }
  try {
    const servers = serverNames.map((name) => ({
      name,
      url: withMcpRouteIdentity(bridge.url(name), {
        sessionId,
        sessionInstanceId: sessionCtx?.sessionInstanceId,
      }),
    }));
    return {
      mcpBridge: { token: bridge.token, servers },
      // expectedCtx 代际比较由 bridge.unregisterSessionCtx 内部按引用做:同
      // session 覆盖注册后,旧 close 的迟到 dispose 不误删新 ctx。
      disposeSessionCtx: () => {
        try {
          bridge.unregisterSessionCtx(sessionId, liziCtx);
        } finally {
          disposeLease();
        }
      },
    };
  } catch (err) {
    // 注册后构造失败必须回滚,否则调用方拿不到 dispose,ctx 永久残留(该 id 的
    // `?session=` 路由一直有效)。
    bridge.unregisterSessionCtx(sessionId, liziCtx);
    disposeLease();
    throw err;
  }
}

/**
 * 配置变更只让新会话换代：旧 generation 继续服务已持 lease 的 Pi 会话，最后一个
 * 会话 close 后才关桥。这样撤销/新增工具能作用于新会话，又不会把正在执行的工具
 * 请求从脚下切断。
 */
export function invalidatePiEnvironment(): void {
  environmentEpoch += 1;
  const current = activeGeneration;
  activeGeneration = null;
  startPromise = null;
  if (current) retireGeneration(current);
}

export async function shutdownPiEnvironment(): Promise<void> {
  environmentEpoch += 1;
  const pending = startPromise;
  const current = activeGeneration;
  activeGeneration = null;
  startPromise = null;
  if (current) current.retired = true;
  await pending?.catch(() => null);
  // 退出/换账号是硬边界：Maker 会话也在关闭，强制收掉所有代际，不等 lease。
  await Promise.all([...generations].map((generation) => {
    generation.retired = true;
    return shutdownGeneration(generation);
  }));
}

/** bridge 单例懒启动(首个会话触发,失败下次重试)。 */
async function ensureBridge(providers: McpProvider[], logger: MakerLogger): Promise<StartedPiBridge | null> {
  for (;;) {
    if (!startPromise) {
      const epoch = environmentEpoch;
      const pending = doStart(providers, logger.child('pi-environment'))
        .then((raw) => {
          if (!raw) return null;
          const started: StartedPiBridge = {
            ...raw,
            generation: ++nextGeneration,
            refs: 0,
            retired: epoch !== environmentEpoch,
            shutdownPromise: null,
          };
          generations.add(started);
          if (started.retired) retireGeneration(started);
          else activeGeneration = started;
          return started;
        })
        .catch((err) => {
          logger.error('pi MCP bridge start failed; pi will run with builtin tools only', {
            message: err instanceof Error ? err.message : String(err),
          });
          if (startPromise === pending) startPromise = null;
          return null;
        });
      startPromise = pending;
    }
    const pending = startPromise;
    const started = await pending;
    if (!started) return null;
    if (!started.retired) return started;
    if (startPromise === pending) startPromise = null;
  }
}

async function doStart(
  providers: McpProvider[],
  logger: MakerLogger,
): Promise<Pick<StartedPiBridge, 'bridge' | 'serverNames'> | null> {
  // factory 阶段没有 per-session 信息,控制类工具通过 getSessionContext 在
  // tool-call 时读当前 session ctx —— 该 ctx 由 bridge 的 `?session=` 路由在
  // runWithLiziMcpSessionContext 里注入(见本文件顶部说明)。
  const ctx: McpProviderContext = {
    agentKind: 'pi',
    workingDir: '',
    vendorOptions: {},
    getSessionContext: () => {
      const active = getLiziMcpSessionContext();
      if (
        active?.agentKind !== 'pi' &&
        active?.agentKind !== 'codex' &&
        active?.agentKind !== 'claude-code'
      ) {
        return undefined;
      }
      return {
        agentKind: active.agentKind,
        workingDir: active.workingDir,
        vendorOptions: active.vendorOptions,
        sessionId: active.sessionId,
        ...(active.sessionInstanceId
          ? { sessionInstanceId: active.sessionInstanceId }
          : {}),
        getSessionContext: ctx.getSessionContext,
      };
    },
  };

  const serverFactories: Record<string, () => McpServer> = Object.create(null);
  const pluginIdByServerName: Record<string, string> = Object.create(null);
  for (const provider of providers) {
    // 空 workdir 快照下,普通工具的项目级 gate 已在 mcp-providers 的 isEnabled 里对
    // pi 延迟(deferOrdinaryGate),此处 isEnabled 只剔掉结构性不可用(如未登录/无 source)
    // 的 provider;项目级启停改由 bridge 按会话 workdir 冻结策略在每次 tools/call 复核。
    if (provider.isEnabled && !provider.isEnabled(ctx)) continue;

    const codexConfig = provider.toCodexMcpConfig?.(ctx);
    if (codexConfig?.type === 'http') {
      logger.warn('pi bridge: remote HTTP MCP provider not supported yet; skipping', {
        providerName: provider.name,
      });
      continue;
    }

    const toClaudeSdkConfig = provider.toClaudeSdkConfig;
    if (!toClaudeSdkConfig) continue;

    const createServer = (): McpServer => {
      const cfg = toClaudeSdkConfig(ctx) as { type?: string; instance?: unknown } | null;
      if (cfg?.type !== 'sdk' || !cfg.instance) {
        throw new Error(`provider ${provider.name} did not return an SDK McpServer instance`);
      }
      return cfg.instance as McpServer;
    };

    let firstInstance: McpServer | null;
    try {
      firstInstance = createServer();
    } catch (err) {
      logger.warn('pi bridge: skipping provider (no SDK instance)', {
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
    // 首方内置 provider 才带 plugin 策略;自定义 MCP 不继承(pluginIdForKnownProviderName 返 null)。
    const pluginId = pluginIdForKnownProviderName(provider.name);
    if (pluginId) pluginIdByServerName[provider.name] = pluginId;
  }

  const names = Object.keys(serverFactories);
  if (names.length === 0) {
    logger.warn('pi bridge: no MCP providers available; pi runs with builtin tools only');
    return null;
  }

  // pluginIdByServerName 让 bridge 对策略工具启用 per-call gate:按会话 ctx 里冻结的
  // disabled 列表(getPiExtraSpawnConfig 注入)阻断项目停用的工具(codex review)。
  const bridge = await startCodexHttpBridge({ serverFactories, pluginIdByServerName, logger });
  logger.info('pi MCP bridge ready', { port: bridge.port, servers: names.length });
  return { bridge, serverNames: names };
}
