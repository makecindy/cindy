/**
 * codexHttpBridge — 把 in-process Cindy MCP server 实例通过 streamable-HTTP
 * 暴露给 codex app-server 子进程。
 *
 * 架构：
 *   Electron main 进程 ↔ http.Server @ 127.0.0.1:<random-port>
 *                          ├ /mcp/lizi_feishu → FeishuMcpServer factory
 *                          └ /mcp/cindy_memory → MemoryMcpServer factory
 *
 * 鉴权：bearer token (随机 32 字节 hex)，token 通过 LIZI_MCP_TOKEN env 传给
 * codex 子进程，codex config 用 bearer_token_env_var 引用。
 *
 * Lifecycle：跟 main 进程同生命周期，lazy 启动 (在 codexEnvironment 里 cached)，
 * before-quit 调 shutdown 收 server。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { runWithLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';

import type { Logger } from '@cindy/maker-core';
import {
  createCodexMcpThreadContextStore,
  isSameCodexMcpSessionContext,
} from './codexMcpThreadContextStore.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from './codexBuiltinToolPolicy.js';

const SERVER_HEADER = 'Lizi_MCPS/1.0';
const MCP_PATH_PREFIX = '/mcp/';
const SHUTDOWN_TIMEOUT_MS = 5_000;
/**
 * 协同 MCP 的远端 server 名单 — codex/cc 两条远端注入路径共享的唯一真源
 * (remote-ssh/codex-remote-mcp.ts 与 maker-host/cc-remote-mcp.ts 都引用它,
 * 不要各自另立常量)。协同注入随 collab 全局开关走, 与 Maker Memory 的
 * cindy_memory 注入 (随 Maker Memory 开关走) 互相独立。
 */
export const REMOTE_COLLAB_SERVER_NAMES: ReadonlySet<string> = new Set([
  'cindy_orca',
  'orca_worker_bridge',
]);
/**
 * Maker Memory 的远端 server 名。SSH remote 会话的记忆读写经 bridge 回到
 * 本机 store (per hostId+远端路径 分区, 见 maker-core buildMemoryScopeKey)。
 */
export const REMOTE_MEMORY_SERVER_NAME = 'cindy_memory';
/**
 * 远端 (SSH remote-forward) 允许暴露的 server 全集 — additionalBearerTokens
 * (persistent token) 认证的请求只能访问这些 server, 鉴权层按它 scope。
 * 只放协同 (cindy_orca / orca_worker_bridge) 与 Maker Memory (cindy_memory,
 * 2026-07 放行: 工具面固定、只触达本机 maker-memory 目录, 与协同同威胁模型);
 * 拿到 persistent token 的远端进程仍不得经 bridge 初始化 cindy_ssh 等其余
 * 本机 server。
 */
export const REMOTE_ALLOWED_SERVER_NAMES: ReadonlySet<string> = new Set([
  ...REMOTE_COLLAB_SERVER_NAMES,
  REMOTE_MEMORY_SERVER_NAME,
]);

/**
 * 「gate 集合 → 远端注入名单」的唯一合成规则:协同段 = available ∩ 协同白名单
 * (collab 开时);memory 段 = cindy_memory (memory 开且 available 含它时)。
 * cc 注入 (cc-remote-mcp) / codex ensure (codex-remote-mcp) / codex drift 的
 * desired 集合 (available 传白名单全集, 保留「provider 恒注册」假设) 三处
 * 必须同走本函数 — drift 与 ensure 的集合靠构造同源, 不靠注释人肉维持
 * (simplify R4)。新增远端 server 时:加常量 + 在这里加一个 gate 分支。
 */
export function selectRemoteInjectableServerNames(
  available: readonly string[],
  gates: { collabEnabled: boolean; memoryEnabled: boolean },
): string[] {
  return [
    ...(gates.collabEnabled ? available.filter((n) => REMOTE_COLLAB_SERVER_NAMES.has(n)) : []),
    ...(gates.memoryEnabled && available.includes(REMOTE_MEMORY_SERVER_NAME)
      ? [REMOTE_MEMORY_SERVER_NAME]
      : []),
  ];
}

/**
 * 远端 MCP 注入代际指纹的唯一公式 (sha256 前 12 hex)。cc 的 per-session
 * applied 指纹与 codex 的 desired/applied 指纹共用 — 成分或格式要变只改
 * 这里, drift 判定与 ensure 落盘天然同构 (simplify R4)。
 */
export function computeRemoteMcpFingerprint(opts: {
  token: string;
  bridgeInstanceId: string;
  remotePort: number;
  serverNames: readonly string[];
  /** Remote Claude query identity; omitted for the shared remote Codex daemon. */
  sessionInstanceId?: string;
}): string {
  const instancePart = opts.sessionInstanceId
    ? `|session-instance:${opts.sessionInstanceId}`
    : '';
  return createHash('sha256')
    .update(
      `${opts.token}|${opts.bridgeInstanceId}|${opts.remotePort}|${[...opts.serverNames].sort().join(',')}${instancePart}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, 12);
}

/** Append the opaque host-owned identity used to route one harness MCP client. */
export function withMcpRouteIdentity(
  rawUrl: string,
  identity: { sessionId?: string; sessionInstanceId?: string },
): string {
  const url = new URL(rawUrl);
  if (identity.sessionId) url.searchParams.set('session', identity.sessionId);
  if (identity.sessionInstanceId) {
    url.searchParams.set('instance', identity.sessionInstanceId);
  }
  return url.toString();
}
/**
 * init request body 上限 (1MB)。codex MCP init payload 实际 < 1KB,
 * 1MB 给极端情况留余量。超限直接 413 拒绝 — 防巨大 body 在 JSON.parse
 * 同步阶段卡 event loop 几秒。
 *
 * 注意: 这只限 init request (无 mcp-session-id 那条路径)。已初始化的
 * POST request 会先解析 JSON 读取 `_meta.threadId` 后交给 transport。
 */
const INIT_BODY_MAX_BYTES = 1 * 1024 * 1024;
export interface CodexHttpBridge {
  port: number;
  token: string;
  /**
   * 本实例的代际 id (每次启动随机生成)。bridge 重建后旧实例签发的
   * mcp-session-id 全部失效 — 远端常驻 daemon 的漂移检测据此触发
   * re-bootstrap (写进受管段指纹), cc 侧据此清空 forcedFresh 集合。
   */
  instanceId: string;
  /** 拼出 codex 端 config 用的 URL，例如 http://127.0.0.1:54321/mcp/lizi_feishu */
  url(serverName: string): string;
  registerThreadContext(threadId: string, ctx: LiziMcpSessionContext): void;
  unregisterThreadContext(threadId: string, expectedSessionInstanceId?: string): void;
  /**
   * sessionId → session ctx 直绑通道 (远端 Claude Code 用)。
   * cc 远端经 SSH remote-forward 直连本 bridge,但其 MCP 请求的 _meta 里没有
   * codex 那样的 threadId —— 改为持久 bearer token (additionalBearerTokens)
   * 鉴权 + URL query `?session=<sessionId>` 路由:query 命中注册表即以此 ctx
   * 执行,不依赖请求体路由。persistent token 跨 app 重启稳定,远端 daemon
   * env 固定也能用;ctx 随 query 生命周期注册/注销,不落盘。
   */
  registerSessionCtx(sessionId: string, ctx: LiziMcpSessionContext): void;
  /**
   * session 结束/重建时注销;对未注册的 id 幂等。
   * expectedCtx 传入时做代际比较:Map 当前值已不是本次注册对象 (同
   * session 重建覆盖了新 ctx) 则不动 — 旧 query 的迟到 cleanup 不得
   * 误删新 query 刚注册的 ctx。
   */
  unregisterSessionCtx(sessionId: string, expectedCtx?: LiziMcpSessionContext): void;
  /**
   * per-session bearer token (pi 会话用)。与主 token 同权但按会话隔离:
   * pi 每个会话在 spawn 前生成独立 token,经 env-file 交给远端进程 —— 单个
   * 会话的 env-file 泄漏只暴露该会话的 bridge 权限,不殃及其它会话与本地
   * codex 主 token(R5 安全审计 C-2)。必须与 registerSessionCtx 成对注册,
   * 且仅当 URL query 命中对应 session 时才接受该 token。
   */
  registerSessionToken(sessionId: string, token: string): number;
  /**
   * session 结束/重建时注销;对未注册的 id 幂等。expectedToken 传入时做
   * 代际比较,避免同 session 重建后旧 token 的迟到注销误删新 token。
   * generation(轮 41)为注册时返回的代次 —— 派生 token 同 session 重建时值相同,
   * 仅靠 expectedToken 无法区分新旧,必须连同代次一起比较。
   */
  unregisterSessionToken(sessionId: string, expectedToken?: string, generation?: number): void;
  shutdown(): Promise<void>;
}

export interface StartCodexHttpBridgeOptions {
  /**
   * 各 MCP server factory，按 codex config 用的名字 keyed (例如 lizi_feishu / cindy_memory)。
   * MCP SDK 的 McpServer/Protocol 实例只能 connect 一个 transport，所以每个
   * streamable-http session 必须拿到独立实例。
   */
  serverFactories: Record<string, () => McpServer>;
  /** Built-in plugin id for each policy-controlled MCP server. */
  pluginIdByServerName?: Record<string, string>;
  /**
   * 除主 token (per-run 随机, 经 LIZI_MCP_TOKEN env 给本地 codex 子进程) 之外
   * 额外接受的 bearer token。用于远端常驻 codex daemon 经 SSH remote-forward
   * 直连本 bridge 的场景:daemon env 在 spawn 时固定,需要跨 app 重启稳定的
   * persistent token,不能跟 per-run 主 token 一起轮换。
   * 函数形式读取:token 允许晚于 bridge 启动才生成/落盘。
   */
  additionalBearerTokens?: () => readonly string[];
  logger: Logger;
}

export async function startCodexHttpBridge(
  opts: StartCodexHttpBridgeOptions,
): Promise<CodexHttpBridge> {
  const log = opts.logger.child('@cindy/mcps-http-bridge');
  const token = randomBytes(32).toString('hex');

  const serverNames = Object.keys(opts.serverFactories);
  if (serverNames.length === 0) {
    throw new Error('startCodexHttpBridge: at least one MCP server is required');
  }

  // sessionId → transport，按 server 隔离 (不同 server 的 session 互不影响)。
  // codex 客户端走 streamable-http 协议，第一条 init request 拿到 mcp-session-id
  // header，后续请求带这个 header 路由到同一个 transport。
  const transportsByServer = new Map<string, Map<string, SessionTransport>>();
  for (const name of serverNames) {
    transportsByServer.set(name, new Map());
  }
  const threadContextStore = createCodexMcpThreadContextStore();
  // sessionId → ctx (远端 cc 的身份通道, 经 ?session= query 路由, 见 interface 注释)。
  const sessionCtxById = new Map<string, LiziMcpSessionContext>();
  // sessionId → per-session bearer token 注册代次(pi 会话, 见 interface 注释)。
  // 轮 41:token 槽带**注册代次** —— pi 会话 token 改为确定性派生(进程级 key +
  // sessionId HMAC)后,同 session 重建时新旧 token **值相同**, expectedToken 比较
  // 无法区分「旧实例迟到 dispose」与「新实例刚注册」; 代次比较保证 dispose 只删
  // 自己那一代注册的槽, 否则断链重连(覆盖注册 + 旧 close 迟到)会把新实例还在
  // 用的 token 注销 → pi 的 bridge 请求全部 401。
  const sessionTokenBySessionId = new Map<string, { token: string; generation: number }>();
  let nextTokenGeneration = 0;

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Server', SERVER_HEADER);

    try {
      // 防御：bind 已经在 127.0.0.1，理论上不会有外网请求；保留检查作为
      // depth-in-defense (req.socket.remoteAddress 偶尔是 ::ffff:127.0.0.1)。
      const remote = req.socket.remoteAddress ?? '';
      if (!isLocalhost(remote)) {
        res.statusCode = 403;
        res.end();
        log.warn('rejected non-localhost request', { remote, url: req.url });
        return;
      }

      // bearer token 鉴权:主 token (per-run, 本地 codex 子进程) / 额外 token
      // (persistent, 远端常驻 codex daemon 与远端 cc 共用) / per-session token
      // (pi 会话, 按 ?session= 隔离, 见 interface 注释)。主 token 与 pi
      // per-session token 全通;额外 token 只允许访问 REMOTE_ALLOWED_SERVER_NAMES
      // 白名单 (协同 + cindy_memory; 远端进程拿到 token 也不得初始化其余本机 server)。
      // URL 解析提前:per-session token 匹配需要 session query,纯解析无副作用。
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const sessionQuery = url.searchParams.get('session');
      const auth = req.headers['authorization'];
      const presented =
        typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const isPrimaryToken = presented !== null && presented === token;
      const isScopedRemoteToken =
        !isPrimaryToken &&
        presented !== null &&
        (opts.additionalBearerTokens?.().includes(presented) ?? false);
      const isPiSessionToken = presented !== null && sessionQuery !== null
        && sessionTokenBySessionId.get(sessionQuery)?.token === presented;
      // 轮 24 HIGH-3 TOCTOU 收口:带 ?session= 的请求**即使主 token**也必须
      // 命中该 session 的注册 token 才放行 —— 否则「ctx 已注册但 token 未
      // 注册」的窗口里,任何拿到主 token 的本地进程可借任意 sessionId 绑定
      // 目标会话的 ctx 执行工具。本地 codex 子进程不带 ?session=,走主 token
      // 放行(不受影响)。
      // 轮 41 修正:该收口**只针对主 token** —— persistent token
      // (additionalBearerTokens)是显式配置给远端 cc daemon 的凭证,本地进程
      // 拿不到,且远端 cc 走 legacy ?session= 路由从不注册 pi session token;
      // 一并要求命中 token 槽会把 remote cc 的 ?session= 路径全部打成 401
      // (codexHttpBridge.test 4 个 legacy 兼容测试回归)。persistent token 借
      // sessionId 的越权面仍被下方 sessionCtxById 注册校验 + instance 匹配挡住。
      if (!isPrimaryToken && !isScopedRemoteToken && !isPiSessionToken) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.end();
        log.warn('rejected unauthenticated request', { url: req.url });
        return;
      }
      if (isPrimaryToken && sessionQuery !== null
        && sessionTokenBySessionId.get(sessionQuery)?.token !== presented) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.end();
        log.warn('rejected unscoped-token request claiming unregistered session', {
          path: url.pathname,
          session: prefixId(sessionQuery),
        });
        return;
      }

      // 路由 /mcp/<name>
      // 远端 cc 身份路由:?session=<id> 命中注册表即取该 ctx (见 interface
      // 注释)。声称了 session 但未注册 → 401 fail-closed:sessionId 是明文
      // 路由参数,未命中说明 query 已注销或id 系伪造,不能按无 ctx 放行。
      // 不带 ?session= 的 (本地 codex 子进程) 走请求体 threadId 路由。
      const instanceQuery = url.searchParams.get('instance');
      let sessionTokenCtx: LiziMcpSessionContext | undefined;
      if (sessionQuery !== null) {
        const registeredCtx = sessionCtxById.get(sessionQuery);
        if (!registeredCtx) {
          res.statusCode = 401;
          res.end();
          // 不落完整 url:query 里的明文 sessionId 无诊断价值,只记路径与
          // 截断标识。
          log.warn('rejected request with unregistered session query', {
            path: url.pathname,
            session: prefixId(sessionQuery),
          });
          return;
        }
        if (
          instanceQuery !== null &&
          registeredCtx.sessionInstanceId !== instanceQuery
        ) {
          res.statusCode = 401;
          res.end();
          log.warn('rejected request with mismatched session instance query', {
            path: url.pathname,
            session: prefixId(sessionQuery),
          });
          return;
        }
        // Legacy URLs keep ordinary session-aware tools working, but the
        // permission-sensitive Full Access shortcut must not accept a context
        // whose concrete Session instance was never carried by the request.
        sessionTokenCtx = instanceQuery === null
          ? withoutSessionInstanceId(registeredCtx)
          : registeredCtx;
      }
      if (!url.pathname.startsWith(MCP_PATH_PREFIX)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const serverName = decodeMcpServerName(url.pathname);
      if (!serverName) {
        res.statusCode = 404;
        res.end();
        return;
      }
      // scoped (persistent) token 仅限远端白名单 server (协同 + cindy_memory):
      // 同一 remote-forward 能摸到完整 /mcp/<name> 路由, 不得经它初始化
      // cindy_ssh 等其余本机 server — codex-connector P1。
      if (isScopedRemoteToken && !REMOTE_ALLOWED_SERVER_NAMES.has(serverName)) {
        res.statusCode = 403;
        res.end();
        log.warn('rejected scoped remote token for non-collab server', { serverName });
        return;
      }
      const createMcpServer = opts.serverFactories[serverName];
      const transports = transportsByServer.get(serverName);
      if (!createMcpServer || !transports) {
        res.statusCode = 404;
        res.end();
        log.warn('unknown MCP server name', { serverName });
        return;
      }

      await dispatchToTransport({
        req,
        res,
        createMcpServer,
        transports,
        serverName,
        log,
        threadContextStore,
        pluginId: opts.pluginIdByServerName?.[serverName],
        sessionTokenCtx,
        threadInstanceQuery: sessionQuery === null ? instanceQuery : null,
      });
    } catch (err) {
      log.error('request handler threw', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        url: req.url,
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        // 显式 text/plain:错误文本不给浏览器 sniff 成 HTML 的机会(CodeQL js/xss-through-exception)
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(err instanceof Error ? err.message : 'Internal server error');
      }
    }
  });

  // streamable-http 是长连接 SSE 流；默认 5s keep-alive 会切断 codex 连接。
  httpServer.keepAliveTimeout = 0;
  // headersTimeout 必须 > keepAliveTimeout (Node 限制)，0 表示无限。
  httpServer.headersTimeout = 0;
  // request body 不限大小 (codex MCP request 偶尔很大，例如附图 base64)。
  httpServer.requestTimeout = 0;

  // listen 异步：必须真在 listen 状态后才 return，否则 codex spawn 时拿到 url 但连不上
  // 轮 40-w4-t3 HIGH:listen 永不回调(罕见 OS 异常)会让 doStart 永久挂起 ——
  // ensureBridge 30s 超时只清 startPromise, 旧 doStart 闭包仍悬挂且不可取消,
  // 多次会话叠加多个悬挂启动。这里加 watchdog:超时后移除 listener + close
  // server + reject, 让 doStart 走正常失败路径(下次会话重试), 不泄漏 listen。
  await new Promise<void>((resolve, reject) => {
    let watchdog: NodeJS.Timeout | undefined;
    const onError = (err: Error): void => {
      if (watchdog) clearTimeout(watchdog);
      httpServer.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      if (watchdog) clearTimeout(watchdog);
      httpServer.removeListener('error', onError);
      resolve();
    };
    watchdog = setTimeout(() => {
      httpServer.removeListener('error', onError);
      httpServer.removeListener('listening', onListening);
      try { httpServer.close(); } catch { /* already closed */ }
      reject(new Error('http bridge listen timed out after 30s'));
    }, 30_000);
    watchdog.unref?.();
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    // 0 = OS 内核原子分配空闲端口 (临时端口范围 49152-65535)
    httpServer.listen(0, '127.0.0.1');
  });

  // listener 级 error: 极罕见 (端口被外力释放等)，发生即 fatal，不自动恢复
  httpServer.on('error', (err) => {
    log.error('http server listener error (bridge unrecoverable)', {
      message: err.message,
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const port = addr.port;

  log.info('http bridge listening', {
    port,
    servers: serverNames,
  });

  // 跟踪所有连接，shutdown 时主动 destroy (server.close 只停接受新连接)
  const liveSockets = new Set<import('node:net').Socket>();
  httpServer.on('connection', (socket) => {
    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));
  });

  const shutdown = async (): Promise<void> => {
    log.info('shutting down http bridge', {
      activeSockets: liveSockets.size,
      activeTransports: countTransports(transportsByServer),
    });

    // 1. 关所有 mcp transport (会断 codex 端的长连接)
    for (const transports of transportsByServer.values()) {
      for (const session of transports.values()) {
        try {
          await session.transport.close();
        } catch (e) {
          log.warn('transport close threw', { message: (e as Error).message });
        }
      }
      transports.clear();
    }

    // 2. 停 server 接受新连接 + 主动 destroy 现存 socket
    for (const sock of liveSockets) {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    }
    liveSockets.clear();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log.warn('shutdown timed out, forcing resolve');
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
      httpServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    log.info('http bridge shut down');
  };

  return {
    port,
    token,
    instanceId: randomBytes(8).toString('hex'),
    url: (serverName) => `http://127.0.0.1:${port}${MCP_PATH_PREFIX}${encodeURIComponent(serverName)}`,
    registerThreadContext: threadContextStore.registerThreadContext,
    unregisterThreadContext: threadContextStore.unregisterThreadContext,
    registerSessionCtx: (sessionId, ctx) => {
      sessionCtxById.set(sessionId, ctx);
    },
    unregisterSessionCtx: (sessionId, expectedCtx) => {
      if (expectedCtx !== undefined && sessionCtxById.get(sessionId) !== expectedCtx) {
        return;
      }
      sessionCtxById.delete(sessionId);
    },
    registerSessionToken: (sessionId, sessionToken) => {
      const generation = nextTokenGeneration++;
      sessionTokenBySessionId.set(sessionId, { token: sessionToken, generation });
      return generation;
    },
    unregisterSessionToken: (sessionId, expectedToken, generation) => {
      const entry = sessionTokenBySessionId.get(sessionId);
      if (entry === undefined) return;
      if (expectedToken !== undefined && entry.token !== expectedToken) return;
      if (generation !== undefined && entry.generation !== generation) return;
      sessionTokenBySessionId.delete(sessionId);
    },
    shutdown,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function decodeMcpServerName(pathname: string): string | null {
  if (!pathname.startsWith(MCP_PATH_PREFIX)) return null;
  const rest = pathname.slice(MCP_PATH_PREFIX.length);
  const parts = rest.split('/');
  if (parts.length !== 1 || !parts[0]) return null;
  try {
    return decodeURIComponent(parts[0]);
  } catch {
    return null;
  }
}

function isLocalhost(remote: string): boolean {
  return (
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1'
  );
}

function countTransports(
  byServer: Map<string, Map<string, SessionTransport>>,
): number {
  let n = 0;
  for (const m of byServer.values()) n += m.size;
  return n;
}

interface DispatchOpts {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  createMcpServer: () => McpServer;
  transports: Map<string, SessionTransport>;
  serverName: string;
  log: Logger;
  threadContextStore: ReturnType<typeof createCodexMcpThreadContextStore>;
  pluginId?: string;
  /** per-session token 命中时解析出的 ctx;存在即优先于 _meta.threadId 路由。 */
  sessionTokenCtx?: LiziMcpSessionContext;
  /** Local Codex per-thread URL identity. null means an unbound legacy URL. */
  threadInstanceQuery: string | null;
}

interface SessionTransport {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
}

/**
 * 路由 streamable-http request 到对应 transport：
 *   - 带 mcp-session-id header → 复用现有 transport
 *   - 无 header + POST + initialize body → 新建 transport
 *   - 否则 → 400
 *
 * 这是 streamable-http 协议要求的 stateful session 模式 (避免每个 request
 * 重新 init MCP server 的开销)。
 */
async function dispatchToTransport(opts: DispatchOpts): Promise<void> {
  const {
    req,
    res,
    createMcpServer,
    transports,
    serverName,
    log,
    threadContextStore,
    pluginId,
    sessionTokenCtx,
    threadInstanceQuery,
  } = opts;

  const sessionIdHeader = req.headers['mcp-session-id'];
  const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;

  if (sessionId) {
    const existing = transports.get(sessionId);
    if (!existing) {
      res.statusCode = 404;
      res.end('Unknown session');
      return;
    }
    let parsedBody: unknown;
    // per-session token (远端 cc) 命中即身份,优先于 _meta.threadId (codex) 路由。
    let activeContext: LiziMcpSessionContext | undefined = sessionTokenCtx;
    if (req.method === 'POST') {
      try {
        parsedBody = await readJsonBody(req);
      } catch (e) {
        log.warn('request body read failed', {
          serverName,
          sessionId,
          message: (e as Error).message,
        });
        res.statusCode = 400;
        res.end('Invalid request body');
        return;
      }
      if (!activeContext) {
        const threadId = extractCodexThreadId(parsedBody);
        activeContext = contextForRequestRoute(
          parsedBody,
          threadContextStore,
          threadInstanceQuery,
        );
        let decision:
          | 'no_thread_id'
          | 'thread_unregistered'
          | 'thread_resolved'
          | 'instance_resolved';
        if (!threadId) {
          decision = activeContext ? 'instance_resolved' : 'no_thread_id';
        } else if (activeContext) {
          decision = 'thread_resolved';
        } else {
          decision = 'thread_unregistered';
        }
        log.debug('codex MCP thread context route decision', {
          serverName,
          mcpSessionId: prefixId(sessionId),
          threadId: prefixId(threadId),
          decision,
          registeredThreadCount: threadContextStore.registeredThreadCount(),
        });
      }
    }
    if (
      !sessionTokenCtx &&
      threadInstanceQuery !== null &&
      hasToolCall(parsedBody) &&
      !activeContext
    ) {
      res.statusCode = 401;
      res.end('Session instance mismatch');
      log.warn('rejected Codex MCP tool call with stale session instance route', {
        serverName,
        mcpSessionId: prefixId(sessionId),
      });
      return;
    }
    // per-session token (远端 cc) 命中时身份来自 URL token,tools/call 的
    // policy 边界同样要用这份 ctx,不能回落到 threadId 路由后判 missing。
    const blockedToolCall = pluginId
      ? findBlockedToolCall(
          parsedBody,
          threadContextStore,
          pluginId,
          sessionTokenCtx,
          threadInstanceQuery,
        )
      : undefined;
    if (blockedToolCall && pluginId) {
      log.info('blocked Codex built-in tool call', {
        serverName,
        pluginId,
        reason: blockedToolCall.reason,
        sessionId: prefixId(blockedToolCall.context?.sessionId),
        workingDir: blockedToolCall.context?.workingDir,
      });
      writeBlockedToolCallResponse(res, parsedBody, pluginId, blockedToolCall.reason);
      return;
    }
    if (activeContext) {
      await runWithLiziMcpSessionContext(activeContext, () =>
        existing.transport.handleRequest(req, res, parsedBody),
      );
      return;
    }
    await existing.transport.handleRequest(req, res, parsedBody);
    return;
  }

  // 无 sessionId: 必须是 init request (POST + body 含 initialize method)
  if (req.method !== 'POST') {
    res.statusCode = 400;
    res.end('Missing mcp-session-id');
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, INIT_BODY_MAX_BYTES);
  } catch (e) {
    const msg = (e as Error).message;
    log.warn('init body read failed', { serverName, message: msg });
    if (msg === 'BODY_TOO_LARGE') {
      res.statusCode = 413;
      res.end('Init body too large');
    } else {
      res.statusCode = 400;
      res.end('Invalid init body');
    }
    return;
  }
  if (!isInitializeRequest(body)) {
    res.statusCode = 400;
    res.end('Expected initialize request');
    return;
  }

  // 新 session: 创建 transport + connect 到新的 mcp server (transport 跟 server 1:1
  // 绑定；McpServer/Protocol 实例不允许并发/重复 connect)。
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newId) => {
      transports.set(newId, { transport, mcpServer });
      log.debug('mcp session initialized', { serverName, sessionId: newId });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
      log.debug('mcp session closed', { serverName, sessionId: transport.sessionId });
    }
  };

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    try {
      await transport.close();
    } catch {
      /* ignore cleanup failure; original error is more useful */
    }
    throw err;
  }
}

/** One policy-controlled tools/call that must not reach its MCP transport. */
interface BlockedToolCall {
  reason: 'disabled' | 'missing_thread_context' | 'ambiguous_thread_context';
  context?: LiziMcpSessionContext;
}

function findBlockedToolCall(
  body: unknown,
  threadContextStore: ReturnType<typeof createCodexMcpThreadContextStore>,
  pluginId: string,
  sessionTokenCtx?: LiziMcpSessionContext,
  threadInstanceQuery: string | null = null,
): BlockedToolCall | undefined {
  const messages = Array.isArray(body) ? body : [body];
  const toolCallContexts: LiziMcpSessionContext[] = [];
  let resolvedContext: LiziMcpSessionContext | undefined;
  for (const message of messages) {
    if (!isToolCallMessage(message)) continue;
    // Resolve each tools/call independently. Batch siblings such as MCP
    // notifications may legitimately omit threadId and must not make a
    // disabled call fail open.
    // ?session= 路由 (sessionTokenCtx 非空) 时身份已由 URL query 绑定且
    // fail-closed, 请求体的 _meta.threadId 不得覆盖 policy ctx —— 否则伪造
    // 一个已注册 threadId 就能绕过本 session 冻结的 built-in plugin
    // disabled policy (执行态身份同样是 sessionTokenCtx 强优先)。
    const context =
      sessionTokenCtx ??
      contextForToolCallRoute(message, threadContextStore, threadInstanceQuery);
    // Ordinary built-in providers are initialized globally, so the bridge is
    // their only deterministic per-thread policy boundary. A malformed or
    // stale client must not bypass that boundary by omitting an id or naming
    // a thread that was never registered.
    if (!context) {
      return { reason: 'missing_thread_context' };
    }
    if (resolvedContext && !isSameCodexMcpSessionContext(resolvedContext, context)) {
      return { reason: 'ambiguous_thread_context' };
    }
    resolvedContext ??= context;
    toolCallContexts.push(context);
  }
  for (const context of toolCallContexts) {
    const raw = context?.vendorOptions?.[CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY];
    if (Array.isArray(raw) && raw.some((id) => id === pluginId)) {
      return { reason: 'disabled', context };
    }
  }
  return undefined;
}

/**
 * Resolve a Codex thread only when its registered Session instance matches the
 * per-thread MCP URL. An unbound legacy URL retains the ordinary context after
 * removing the instance capability, so Full Access remains fail closed.
 */
function contextForThreadRoute(
  context: LiziMcpSessionContext | undefined,
  instanceQuery: string | null,
): LiziMcpSessionContext | undefined {
  if (!context) return undefined;
  if (instanceQuery === null) return withoutSessionInstanceId(context);
  return context.sessionInstanceId === instanceQuery ? context : undefined;
}

function contextForRequestRoute(
  body: unknown,
  threadContextStore: ReturnType<typeof createCodexMcpThreadContextStore>,
  instanceQuery: string | null,
): LiziMcpSessionContext | undefined {
  const messages = Array.isArray(body) ? body : [body];
  let resolved: LiziMcpSessionContext | undefined;
  let sawToolCall = false;
  for (const message of messages) {
    if (!isToolCallMessage(message)) continue;
    sawToolCall = true;
    const context = contextForToolCallRoute(message, threadContextStore, instanceQuery);
    if (!context || (resolved && !isSameCodexMcpSessionContext(resolved, context))) {
      return undefined;
    }
    resolved = context;
  }
  if (sawToolCall) return resolved;
  const threadId = extractCodexThreadId(body);
  if (threadId) {
    return contextForThreadRoute(
      threadContextStore.getContextForThreadId(threadId),
      instanceQuery,
    );
  }
  return instanceQuery === null
    ? undefined
    : threadContextStore.getContextForSessionInstanceId(instanceQuery);
}

function contextForToolCallRoute(
  message: unknown,
  threadContextStore: ReturnType<typeof createCodexMcpThreadContextStore>,
  instanceQuery: string | null,
): LiziMcpSessionContext | undefined {
  const threadId = extractCodexThreadIdFromMessage(message);
  if (threadId) {
    // 声明过 threadId 却未注册/已过期时不得回退 instance，避免掩盖串台。
    return contextForThreadRoute(
      threadContextStore.getContextForThreadId(threadId),
      instanceQuery,
    );
  }
  return instanceQuery === null
    ? undefined
    : threadContextStore.getContextForSessionInstanceId(instanceQuery);
}

function hasToolCall(body: unknown): boolean {
  return (Array.isArray(body) ? body : [body]).some(isToolCallMessage);
}

function withoutSessionInstanceId(
  context: LiziMcpSessionContext,
): LiziMcpSessionContext {
  if (!context.sessionInstanceId) return context;
  const { sessionInstanceId: _sessionInstanceId, ...legacyContext } = context;
  void _sessionInstanceId;
  return legacyContext;
}

function writeBlockedToolCallResponse(
  res: http.ServerResponse,
  body: unknown,
  pluginId: string,
  reason: BlockedToolCall['reason'],
): void {
  const message = reason === 'disabled'
    ? `Built-in tool "${pluginId}" is disabled for this session. Enable it in Settings and start a new session to apply the change.`
    : reason === 'ambiguous_thread_context'
      ? `Built-in tool "${pluginId}" received calls from more than one session in a single batch and cannot tell them apart. Retry the calls one session at a time.`
      : `Built-in tool "${pluginId}" could not bind this call to a verified Cindy session. This is a session-routing problem, not a plugin setup problem. Start a new task and try again.`;
  const disabledResult = (id: unknown) => ({
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{
        type: 'text',
        text: message,
      }],
      isError: true,
    },
  });
  const payload = Array.isArray(body)
    ? body
      .filter((message) => message !== null && typeof message === 'object' && 'id' in message)
      .map((message) => disabledResult((message as { id?: unknown }).id))
    : disabledResult((body as { id?: unknown }).id);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    received += buf.length;
    if (received > maxBytes) {
      // 主动 destroy 让客户端立刻知道,不再继续读
      req.destroy();
      throw new Error('BODY_TOO_LARGE');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  // init request 传 1MB 上限; 已初始化 request 不设额外上限,避免破坏
  // Codex/MCP 已允许的大 payload。同步 parse 成本与 SDK 内部解析等价。
  return JSON.parse(text);
}

/**
 * Resolve the single thread context this whole HTTP request should run under
 * (used to wrap the transport in `runWithLiziMcpSessionContext`).
 *
 * Batch siblings such as MCP notifications legitimately omit
 * `params._meta.threadId` — `findBlockedToolCall` already says so, and resolves
 * each `tools/call` independently for exactly that reason. If such a sibling
 * were allowed to collapse the whole batch to `undefined`, a perfectly
 * well-attributed `tools/call` would run with NO AsyncLocalStorage context, and
 * every built-in provider that reads it (cindy_browser's `__mcpSessionId`,
 * cindy_android, …) would silently fall back to host-side UI-focus inference —
 * i.e. the cross-session routing bug, just reachable only via batches. So
 * threadId-less non-tool messages are skipped here.
 *
 * Still conservative where attribution actually matters:
 *   - a `tools/call` WITHOUT a threadId → `undefined`; never run an
 *     unattributed tool call under a sibling's session. (`findBlockedToolCall`
 *     fail-closes this shape too, but only for servers that carry a pluginId,
 *     so the guard has to live here as well.)
 *   - `tools/call`s naming two different threads → `undefined`; genuinely
 *     ambiguous, there is no single correct context to pick. For
 *     policy-controlled servers `findBlockedToolCall` turns that into an
 *     outright rejection (`ambiguous_thread_context`), because running such a
 *     batch contextless is what mis-routes it to the focused UI session.
 *
 * A `tools/call`'s own attribution ALWAYS wins over its siblings', including
 * when the siblings disagree among themselves: nothing a non-tool message
 * carries may degrade a well-attributed call to "no context", because
 * `hasAmbiguousThreadContext` only inspects `tools/call`s and would not reject
 * the request either — it would just run contextless, back to UI focus. Sibling
 * ids therefore matter only when the request carries no tool call at all.
 *
 * Note this does change behaviour for tool-free requests: a threadId-less
 * sibling no longer suppresses a sibling that does carry an id (previously ANY
 * id-less message collapsed the result to `undefined`). Conflicting sibling ids
 * still yield `undefined`. Tool-free requests invoke no tool, so nothing reads
 * the context they run under; resolving it is simply closer to what the client
 * actually declared.
 */
function extractCodexThreadId(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  let fromToolCall: string | undefined;
  let fromSibling: string | undefined;
  let siblingsDisagree = false;
  for (const message of messages) {
    const threadId = extractCodexThreadIdFromMessage(message);
    if (isToolCallMessage(message)) {
      if (!threadId) return undefined;
      if (fromToolCall && fromToolCall !== threadId) return undefined;
      fromToolCall = threadId;
      continue;
    }
    if (!threadId) continue;
    // Recorded, not returned: a sibling disagreement must not short-circuit the
    // scan before a tools/call later in the batch gets to claim the request.
    if (fromSibling && fromSibling !== threadId) siblingsDisagree = true;
    fromSibling = threadId;
  }
  if (fromToolCall) return fromToolCall;
  return siblingsDisagree ? undefined : fromSibling;
}

function isToolCallMessage(message: unknown): boolean {
  return (
    message !== null &&
    typeof message === 'object' &&
    (message as { method?: unknown }).method === 'tools/call'
  );
}

function extractCodexThreadIdFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const params = (message as { params?: unknown }).params;
  if (!params || typeof params !== 'object') return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const threadId = (meta as { threadId?: unknown }).threadId;
  return typeof threadId === 'string' && threadId.trim() ? threadId : undefined;
}

function prefixId(value: string | undefined): string | null {
  return value ? value.slice(0, 8) : null;
}
