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
 * 外部 HTTP MCP:
 *  - host 解析 provider 的 env 引用，把 header 真值重映射到 Pi 专用 env 名；
 *    CINDY_PI_MCP_BRIDGE 只携带 env 引用，extension 再直连用户显式配置的 URL。
 *  - 认证值不从 host assembly 回传 renderer，也不进入 process args 或日志。
 *
 * 生命周期:environment 懒启动单例。本地 bridge 挂了时仍保留有效 remote servers；
 * 两类 server 都不可用才返回 null，让 pi 跑纯内置工具。
 */

import { createHmac, randomBytes } from 'node:crypto';

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
  REMOTE_COLLAB_SERVER_NAMES,
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
  bridge: CodexHttpBridge | null;
  serverNames: string[];
  remoteServers: NonNullable<PiExtraSpawnConfig['mcpBridge']>['servers'];
  mcpEnv: Record<string, string>;
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
// 轮 40-w4-t10 MEDIUM:关停门闩 —— shutdownPiEnvironment 期间 ensureBridge
// 不得重启 bridge(否则「界面以为已关/旧会话收口, 实际又冒出新 bridge」)。
let environmentShuttingDown = false;
// 轮 41 CRITICAL:session token 由「每次 randomBytes」改为「进程级 key + sessionId
// 确定性派生」—— 修复"正常对话期间突然 kill"根因:旧实现每次重建 spawn env 都生成
// 新 token → CINDY_PI_MCP_BRIDGE 变 → envHash 必变 → daemon ensure(restart:true)
// 判定 envHash mismatch → kill + respawn。断链重连(SSH 抖动)一次就杀一次 pi,
// 「断链保活 / 纯 attach」语义完全失效。
// 派生 token:同一进程内同 session 重连 → 同 token → envHash 稳定 → attach 保活;
// 进程重启 → key 变 → 新 token → pi 也随重启重建, 一致。安全性保持 R5 C-2:
// HMAC 单向, 泄漏一个 session 的 token 推不出 key、伪造不了其它 session。
const PI_BRIDGE_SESSION_KEY = randomBytes(32);
const REMOTE_MCP_STARTUP_TIMEOUT_MS = 10_000;
const REMOTE_MCP_REQUEST_TIMEOUT_MS = 600_000;

function cloneRemoteServers(
  servers: StartedPiBridge['remoteServers'],
): StartedPiBridge['remoteServers'] {
  return servers.map((server) => ({
    ...server,
    ...(server.remote
      ? { remote: { ...server.remote, headerEnvVars: { ...server.remote.headerEnvVars } } }
      : {}),
  }));
}

function isLoopbackMcpHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function isAllowedRemoteMcpUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackMcpHostname(url.hostname);
}

function shutdownGeneration(started: StartedPiBridge): Promise<void> {
  if (!started.shutdownPromise) {
    started.shutdownPromise = (started.bridge?.shutdown() ?? Promise.resolve())
      .then(() => {
        generations.delete(started);
      })
      .catch((err) => {
        // 轮 40-w4-t14 MEDIUM:shutdown 失败不得静默吞掉 —— bridge 进程/端口
        // 可能仍活着, 直接删 generation 会让调用方误以为已回收, 下次 ensureBridge
        // 又新建一份形成资源叠加。失败保留 generation(带错误标记), 由后续
        // shutdownPiEnvironment 的强制收口或诊断路径处理。
        // 轮 40-w4-t16 MEDIUM(修复的修复):失败后必须**清空 shutdownPromise** ——
        // 否则 promise 已 settled(reject), 后续 shutdownGeneration 复用同一
        // promise 永远不重试, 该 generation 残留到进程结束。
        started.shutdownPromise = null;
        console.error(
          '[pi-env] bridge shutdown failed — generation retained for retry/diagnosis',
          { generation: started.generation, error: err instanceof Error ? err.message : String(err) },
        );
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

  const { bridge, serverNames, remoteServers, mcpEnv } = started;
  const sessionId = sessionCtx?.sessionId?.trim();
  let disposed = false;
  const disposeLease = (): void => {
    if (disposed) return;
    disposed = true;
    releaseGeneration(started);
  };

  // collab 全局禁用时与 CC/Codex 同闸门:剥掉 orca 类协同 server(cindy_orca /
  // orca_worker_bridge),避免禁用后 pi 仍能建队/发消息(R5 配置审计 H-7)。
  // 只按名字剥协同 server —— cindy_memory / ghost / 外部 HTTP MCP 与 collab
  // 无关,照常注入(CC 的 selectRemoteInjectableServerNames 同语义)。
  const collabEnabled = createPluginRegistry().isEnabled('collab');
  const collabGated = (servers: NonNullable<PiExtraSpawnConfig['mcpBridge']>['servers']) =>
    collabEnabled
      ? servers
      : servers.filter((server) => !REMOTE_COLLAB_SERVER_NAMES.has(server.name));

  // 匿名会话:不注册身份、URL 不带 query。工具 handler 拿不到 ctx 时回落业务
  // 错误码(如 LEAD_NOT_SUPPORTED)—— 与改动前一致,不打 401。
  if (!sessionId) {
    return {
      mcpBridge: {
        token: bridge?.token ?? '',
        servers: collabGated([
          ...(bridge ? serverNames.map((name) => ({ name, url: bridge.url(name) })) : []),
          ...cloneRemoteServers(remoteServers),
        ]),
      },
      mcpEnv: { ...mcpEnv },
      disposeSessionCtx: disposeLease,
    };
  }

  // 纯外部 HTTP generation 不需要 localhost bridge 的 session 路由；仍持 lease，
  // 让配置变更后的旧活动会话继续使用其启动时快照。
  if (!bridge) {
    return {
      mcpBridge: { token: '', servers: collabGated(cloneRemoteServers(remoteServers)) },
      mcpEnv: { ...mcpEnv },
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
  // PiAgent 传入的是该 session 专属的可变副本。这里必须保留同一引用：start_team
  // 成功后 MakerSession.setVendorOptions 会原地写入 Lead 身份，既有 HTTP MCP handler
  // 要在下一次 create_worker 调用时立即看到。复制对象会把 bridge 永久冻结在启动态。
  const vendorOptions = sessionCtx?.vendorOptions ?? {};
  vendorOptions[CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY] = disabledPluginIds;
  const liziCtx: LiziMcpSessionContext = {
    agentKind: 'pi',
    sessionId,
    ...(sessionCtx?.sessionInstanceId
      ? { sessionInstanceId: sessionCtx.sessionInstanceId }
      : {}),
    workingDir: sessionCtx?.workingDir ?? '',
    vendorOptions,
    mcpCallerKind: sessionCtx?.mcpCallerKind ?? 'unknown',
    mcpCallerAttested: sessionCtx?.mcpCallerAttested === true,
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
  // per-session bridge token:与主 token 同权但按会话隔离 —— 该 token 会随
  // spawn env 进入 pi 进程(远端场景落入 env-file),单个会话凭证面泄漏不殃及
  // 其它会话与本地 codex 主 token(R5 安全审计 C-2)。必须与 registerSessionCtx
  // 成对注册:token 仅当 URL query 命中本 session 时才被 bridge 接受。
  // 轮 41 CRITICAL:确定性派生(进程级 key + sessionId HMAC, 64 hex 与旧形状一致)
  // —— 同 session 断链重连/恢复复用同一 token, envHash 稳定, daemon 纯 attach
  // 保活生效;桌面重启 → key 变 → 新 token → pi 重建, 两两一致。
  const sessionToken = createHmac('sha256', PI_BRIDGE_SESSION_KEY)
    .update(sessionId)
    .digest('hex');
  let tokenGeneration: number | undefined;
  try {
    tokenGeneration = bridge.registerSessionToken(sessionId, sessionToken);
  } catch (error) {
    bridge.unregisterSessionCtx(sessionId, liziCtx);
    disposeLease();
    throw error;
  }
  try {
    const servers = collabGated([
      ...serverNames.map((name) => ({
        name,
        url: withMcpRouteIdentity(bridge.url(name), {
          sessionId,
          sessionInstanceId: sessionCtx?.sessionInstanceId,
        }),
      })),
      ...cloneRemoteServers(remoteServers),
    ]);
    return {
      mcpBridge: { token: sessionToken, servers },
      mcpEnv: { ...mcpEnv },
      // expectedCtx 代际比较由 bridge.unregisterSessionCtx 内部按引用做:同
      // session 覆盖注册后,旧 close 的迟到 dispose 不误删新 ctx。token 注销
      // 同理(expectedToken 比较),成对清理。
      disposeSessionCtx: () => {
        try {
          bridge.unregisterSessionCtx(sessionId, liziCtx);
        } finally {
          try {
            bridge.unregisterSessionToken(sessionId, sessionToken, tokenGeneration);
          } finally {
            disposeLease();
          }
        }
      },
    };
  } catch (err) {
    // 注册后构造失败必须回滚,否则调用方拿不到 dispose,ctx 永久残留(该 id 的
    // `?session=` 路由一直有效)。
    bridge.unregisterSessionCtx(sessionId, liziCtx);
    bridge.unregisterSessionToken(sessionId, sessionToken, tokenGeneration);
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
  // 轮 40-w4-t10 MEDIUM:先置关停门闩再收口 —— 关停期间 ensureBridge fail-closed。
  environmentShuttingDown = true;
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
  environmentShuttingDown = false;
}

/**
 * @internal 测试钩子:重置模块级单例状态(ensureBridge 的 startPromise /
 * activeGeneration / generations)。仅在测试文件里调用 —— 生产代码不依赖。
 */
export function resetPiEnvironmentForTest(): void {
  startPromise = null;
  activeGeneration = null;
  nextGeneration = 0;
  generations.clear();
  environmentShuttingDown = false;
}

/** bridge 单例懒启动(首个会话触发,失败下次重试)。 */
async function ensureBridge(providers: McpProvider[], logger: MakerLogger): Promise<StartedPiBridge | null> {
  // 轮 40-w4-t10 MEDIUM:关停期间 fail-closed —— 不重启 bridge。
  if (environmentShuttingDown) return null;
  for (;;) {
    if (!startPromise) {
      const epoch = environmentEpoch;
      const pending = doStart(providers, logger.child('pi-environment'))
        .then((raw) => {
          // 轮 26 HIGH-2:30s 超时已把 startPromise 清空(调用方拿到 null 返回),
          // 这里若仍注册 generation 会与下次 doStart 双 bridge + 端口泄漏。
          // 对称 .catch 的守卫:stale 结果直接 shutdown 丢弃。
          if (startPromise !== pending) {
            void raw?.bridge?.shutdown().catch(() => {});
            return null;
          }
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
    // 轮 24 LOW-6:startPromise 挂起(listen 永不回调等罕见 OS 异常)时不能死等
    // —— 30s 超时后清空 startPromise 返回 null(本次会话无 MCP, 下次会话重试)。
    // 轮 40-w4 HIGH:成功路径必须先 clearTimeout —— 否则 pending 正常 resolve
    // 后 timer 30s 迟到仍清空 startPromise, 下次会话重建 bridge, 旧 generation
    // 不退休泄漏(重复端口/MCP maps)。
    const started = await Promise.race([
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => {
          if (startPromise === pending) startPromise = null;
          resolve(null);
        }, 30_000);
        timer.unref?.();
        // pending settle(成功/失败)即取消超时 —— 成功路径 startPromise 保留
        // 该已完成的 pending(缓存命中), 超时不再触发。
        void pending.then(() => clearTimeout(timer), () => clearTimeout(timer));
      }),
      pending,
    ]);
    if (!started) return null;
    if (!started.retired) return started;
    if (startPromise === pending) startPromise = null;
  }
}

async function doStart(
  providers: McpProvider[],
  logger: MakerLogger,
): Promise<Pick<StartedPiBridge, 'bridge' | 'serverNames' | 'remoteServers' | 'mcpEnv'> | null> {
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
        mcpCallerKind: active.mcpCallerKind,
        mcpCallerAttested: active.mcpCallerAttested,
        ...(active.sessionInstanceId
          ? { sessionInstanceId: active.sessionInstanceId }
          : {}),
        getSessionContext: ctx.getSessionContext,
      };
    },
  };

  const serverFactories: Record<string, () => McpServer> = Object.create(null);
  const pluginIdByServerName: Record<string, string> = Object.create(null);
  const remoteServers: NonNullable<PiExtraSpawnConfig['mcpBridge']>['servers'] = [];
  const mcpEnv: Record<string, string> = Object.create(null);
  let nextRemoteSecret = 0;
  for (const provider of providers) {
    // 空 workdir 快照下,普通工具的项目级 gate 已在 mcp-providers 的 isEnabled 里对
    // pi 延迟(deferOrdinaryGate),此处 isEnabled 只剔掉结构性不可用(如未登录/无 source)
    // 的 provider;项目级启停改由 bridge 按会话 workdir 冻结策略在每次 tools/call 复核。
    if (provider.isEnabled && !provider.isEnabled(ctx)) continue;

    let codexConfig: ReturnType<NonNullable<McpProvider['toCodexMcpConfig']>> | undefined;
    try {
      codexConfig = provider.toCodexMcpConfig?.(ctx);
    } catch {
      logger.warn('pi bridge: skipping provider whose MCP config could not be built', {
        providerName: provider.name,
      });
      continue;
    }
    if (codexConfig?.type === 'http') {
      let providerEnv: Record<string, string> | null | undefined;
      try {
        providerEnv = await provider.getExtraEnv?.(ctx);
      } catch {
        logger.warn('pi bridge: skipping remote HTTP MCP provider whose environment could not be built', {
          providerName: provider.name,
        });
        continue;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(codexConfig.url);
      } catch {
        logger.warn('pi bridge: skipping remote HTTP MCP provider with invalid URL', {
          providerName: provider.name,
        });
        continue;
      }
      // 自定义 MCP 的 host allowlist 是用户显式保存的 endpoint；不复用 SSH 入站 bridge
      // 的 server-name allowlist。公网/局域网必须 HTTPS，HTTP 仅放行明确 loopback，避免
      // bearer / API-key 与 MCP 内容在链路上明文。明文 allowlist 与 Pi spawn 的
      // mergeLoopbackNoProxy 完全一致，避免 127/8 中其它地址经 HTTP_PROXY 泄密；同时
      // 拒绝 URL 内嵌凭证和非 web 协议。
      if (!isAllowedRemoteMcpUrl(parsedUrl)) {
        logger.warn('pi bridge: skipping remote HTTP MCP provider outside the URL security boundary', {
          providerName: provider.name,
        });
        continue;
      }

      const resolvedHeaders = new Headers();
      let invalidReason: 'missing-bearer' | 'missing-header' | 'invalid-header' | null = null;
      if (codexConfig.bearerTokenEnvVar) {
        const token = providerEnv?.[codexConfig.bearerTokenEnvVar];
        if (!token) invalidReason = 'missing-bearer';
        else resolvedHeaders.set('authorization', `Bearer ${token}`);
      }
      if (!invalidReason) {
        for (const [headerName, envName] of Object.entries(codexConfig.envHttpHeaders ?? {})) {
          if (!providerEnv || !Object.prototype.hasOwnProperty.call(providerEnv, envName)) {
            invalidReason = 'missing-header';
            break;
          }
          try {
            // Headers validates both the field name and CR/LF in its secret value. Explicit
            // Authorization headers intentionally override bearer, matching CustomMcpProvider.
            resolvedHeaders.set(headerName, providerEnv[envName]!);
          } catch {
            invalidReason = 'invalid-header';
            break;
          }
        }
      }
      if (invalidReason) {
        logger.warn('pi bridge: skipping remote HTTP MCP provider with incomplete authentication', {
          providerName: provider.name,
          reason: invalidReason,
        });
        continue;
      }

      const headerEnvVars: Record<string, string> = Object.create(null);
      for (const [headerName, value] of resolvedHeaders.entries()) {
        const envName = `CINDY_PI_REMOTE_MCP_SECRET_${nextRemoteSecret++}`;
        headerEnvVars[headerName] = envName;
        mcpEnv[envName] = value;
      }
      remoteServers.push({
        name: provider.name,
        url: parsedUrl.href,
        remote: {
          headerEnvVars,
          // Pi RPC 的 ready 请求预算是 30s；extension 会并行探测全部 server，故任一
          // 黑洞 provider 最多占 10s。探测成功后工具调用仍保留长请求预算。
          startupTimeoutMs: REMOTE_MCP_STARTUP_TIMEOUT_MS,
          requestTimeoutMs: REMOTE_MCP_REQUEST_TIMEOUT_MS,
        },
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
  if (names.length === 0 && remoteServers.length === 0) {
    logger.warn('pi bridge: no MCP providers available; pi runs with builtin tools only');
    return null;
  }

  // pluginIdByServerName 让 bridge 对策略工具启用 per-call gate:按会话 ctx 里冻结的
  // disabled 列表(getPiExtraSpawnConfig 注入)阻断项目停用的工具(codex review)。
  let bridge: CodexHttpBridge | null = null;
  if (names.length > 0) {
    try {
      bridge = await startCodexHttpBridge({ serverFactories, pluginIdByServerName, logger });
    } catch (err) {
      // 轮 40-w4-t16 MEDIUM(日志盲区):不带 err 会让端口冲突/factory 异常/
      // 初始化 bug 折叠成同一种「start failed」, 诊断拿不到根因。
      logger.error('pi bridge: local MCP bridge start failed', {
        providers: names.length,
        error: err instanceof Error ? err.message : String(err),
      });
      if (remoteServers.length === 0) return null;
    }
  }
  const serverNames = bridge ? names : [];
  logger.info('pi MCP environment ready', {
    localServers: serverNames.length,
    remoteServers: remoteServers.length,
    ...(bridge ? { port: bridge.port } : {}),
  });
  return { bridge, serverNames, remoteServers, mcpEnv };
}
