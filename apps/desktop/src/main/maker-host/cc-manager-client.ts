/**
 * cc-manager-client — Phase 4.2 SshManagerClient.
 *
 * Desktop main 端跟远端 cc-mgr daemon 通话的 wire layer。把 4 个底层 piece
 * 接起来:
 *   1. `RemoteHost.execStream("nc -U <sock>")` → ExecStreamHandle 双向流
 *   2. ExecStreamHandle → Duplex 适配(stdoutBytes → push / write → handle.write)
 *   3. `new RpcClient(duplex)` → 跑 `protocol/hello` 协议握手
 *   4. `createRemoteQuery({ client, sessionId, startParams })` → 返一个 mimic
 *      SDK Query interface 的 RemoteQuery, ClaudeCodeAgent 当 Query 直接用
 *
 * 不在本文件做:
 *   - cc-mgr.mjs bundle install: 已封在 `cc-manager-install.ts`
 *     (`ensureCcManagerInstalledOrInstall`), Phase 4.3 接 ClaudeCodeAgent 前置 call
 *   - ClaudeCodeAgent 的 transport routing(按 session.remoteHostId 决定 local vs
 *     remote): Phase 4.3 在 maker-core 端处理
 *   - UI 入口(添加远程项目 dialog vendor 选择): Phase 4.4
 *
 * Smoke test 已验证(2026-06-05 cache host):
 *   - daemon nohup setsid 启动 / sock ready / protocol/hello 返 protocolVersion
 *   - OpenBSD nc 支持 `-U` (unix socket) + 双向桥
 *   - daemon 主进程 cmdline 是 `node cc-mgr.mjs daemon --socket ...`
 *   - ssh 启 daemon 时 ssh channel 可能 hang 等 stdio fd 关闭 → 用
 *     `host.exec({ timeoutMs })` + catch 接住, daemon setsid 不跟死
 */

import { Duplex } from 'node:stream';

import {
  RpcClient,
  createRemoteQuery,
  METHODS,
  SERVER_METHODS,
} from '@cindy/maker-cc-manager';
import type {
  RemoteQuery,
  QueryStartParams,
  SessionListResult,
  ApprovalRequestParams,
  ApprovalRequestResult,
  OAuthRefreshParams,
  OAuthRefreshResult,
} from '@cindy/maker-cc-manager';
import {
  REMOTE_CC_MGR_BUNDLE_PATH,
  REMOTE_CC_MGR_DIR,
  REMOTE_CC_MGR_LOG_PATH,
  REMOTE_CC_MGR_PID_PATH,
  REMOTE_CC_MGR_SOCK_PATH,
  REMOTE_XDT_NODE_PATH,
} from '@cindy/maker-remote-ssh';
import type { RemoteHost, ExecStreamHandle } from '@cindy/maker-remote-ssh';

import { createLogger } from '../logger.js';
import { drainPersistQueue } from '../messagePersistBroadcaster.js';

const log = createLogger('cc-manager-client');

/* ============================== 远端路径常量 ============================== */
// 跟 `packages/maker-remote-ssh/src/bootstrap/cc-manager-installer.ts` 保持一致;
// 都用 $HOME shell var 让远端 bash 自己 expand, 不依赖本地知道远端 home。

const REMOTE_DIR = REMOTE_CC_MGR_DIR;
const REMOTE_BUNDLE = REMOTE_CC_MGR_BUNDLE_PATH;
const REMOTE_NODE = REMOTE_XDT_NODE_PATH;
const REMOTE_SOCK = REMOTE_CC_MGR_SOCK_PATH;
const REMOTE_LOG = REMOTE_CC_MGR_LOG_PATH;
const REMOTE_PID = REMOTE_CC_MGR_PID_PATH;

/** daemon 启动后等 sock 出现的最长时间。 */
const DAEMON_READY_TIMEOUT_MS = 10_000;
/**
 * RPC 请求统一 timeout — daemon 活着但 unresponsive (典型: 被 uncaughtException
 * crash guard 救活但 hang 在 handler) 时, request 永远等不到 response, client
 * 卡死 UI 显示 "connecting" 不可恢复。15s 兜底让 user-visible error 快速冒出来。
 */
const RPC_REQUEST_TIMEOUT_MS = 15_000;
/**
 * SESSION_KILL 专用 timeout — daemon 侧 kill 会同步等 consume loop 退出
 * (10s 看门狗 + close() 升级后再等 5s grace, 见 maker-cc-manager
 * session-registry.ts), 正常路径最坏 ~15s, 必须显著宽于通用 RPC 超时。
 */
const KILL_RPC_TIMEOUT_MS = 30_000;
/** ssh 启 daemon 命令的最长等待 — 超时 ssh channel 被强关, daemon 已 setsid 独立。 */
const DAEMON_SPAWN_SSH_TIMEOUT_MS = 5_000;
/** sock 探活 / 等待循环的轮询间隔。 */
const SOCK_POLL_INTERVAL_MS = 200;

/* ============================== ensureDaemon ============================== */

/**
 * 确保远端 cc-mgr daemon 在跑。幂等。
 *
 * - 已 running (sock 在 + pid 进程活): ~80ms 探活返回
 * - 未 running: nohup setsid 起一个, 等 sock 出现
 *
 * 不负责装 cc-mgr.mjs bundle / bundled node — 那是
 * `ensureCcManagerInstalledOrInstall` (cc-manager-install.ts) 的事。如果远端
 * 缺 bundle / node, spawn 会失败, error log 透到 daemon log 文件让用户排查。
 *
 * @throws daemon spawn 超时, sock 没出现 + 拉 log tail 一起 wrap 抛出
 */
export async function ensureDaemonRunning(host: RemoteHost): Promise<void> {
  // 探活: sock 文件存在 + pid 进程活 (sock 可能是孤儿, 必须 cross-check pid)。
  const probe = await host.exec(
    // 注意双引号包 $HOME-含路径: macOS 用户名含空格时 (eg. "/Users/Some User")
    // 不加引号 shell 会拆词, [ -S /Users/Some User/... ] 变 4 token, test 语法直接坏。
    `bash -c 'PID="$(cat "${REMOTE_PID}" 2>/dev/null || true)"; CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"; if [ -S "${REMOTE_SOCK}" ] && [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && printf "%s" "$CMD" | grep -F "cc-mgr.mjs" >/dev/null; then echo RUNNING; else echo MISSING; fi'`,
    { timeoutMs: 5_000, label: 'cc-mgr-probe' },
  );
  if (probe.stdout.includes('RUNNING')) {
    log.debug('cc-mgr daemon already running', { hostId: host.id });
    return;
  }

  log.info('cc-mgr daemon not running, spawning', { hostId: host.id });

  // Daemon spawn — 跨平台 detach 在 daemon 进程内部自己搞定 (cc-mgr.ts:
  // selfDetachAndExit), shell 端零 hack:
  //   1. node 跑 cc-mgr.mjs daemon --detach --log-file --socket
  //   2. 父 node 用 child_process.spawn({detached:true, stdio:'ignore'}) 起
  //      一个 grandchild, unref 之后立即 exit 0, PID 通过 stdout 返回
  //   3. grandchild 被 init/launchd 接管, 成为真正的 daemon
  //   4. ssh exec 直接 return (父 node 已 exit, 没有 stdio fd hang)
  //
  // 抄的是 codex Rust 的 `pre_exec() + libc::setsid()` 思路 — codex 直接调
  // POSIX setsid() libc API 完成 fork-detach, mac/linux 都 work。我们用
  // Node 的 detached:true (libuv 内部 unix 上等价 setsid, Windows 上用
  // DETACHED_PROCESS flag), 同样跨平台。
  //
  // shell 端旧的 nohup/setsid/subshell 全部移除 — 它们解决的是 "bash 起
  // 后台进程怎么 detach" 的 portability 问题, 现在 node 替我们解决了。
  // mkdir + rm sock 仍保留 (防御性)。
  // 所有 $HOME-含路径必须双引号包裹: macOS 账号名含空格时不加引号 shell 会
  // 拆词, mkdir/rm/node 全跑错路径 → daemon 起不来 / sock/pid 文件落到错地方。
  const spawnScript = `
set -e
mkdir -p "${REMOTE_DIR}" && chmod 700 "${REMOTE_DIR}"
rm -f "${REMOTE_SOCK}"
DAEMON_PID="$("${REMOTE_NODE}" "${REMOTE_BUNDLE}" daemon --socket "${REMOTE_SOCK}" --log-file "${REMOTE_LOG}" --detach)"
if [ -z "$DAEMON_PID" ]; then echo "SPAWN_FAILED: daemon exited without printing PID" >&2; exit 1; fi
echo "$DAEMON_PID" > "${REMOTE_PID}"
`;
  try {
    const spawnResult = await host.exec(`bash -c ${shellQuote(spawnScript)}`, {
      timeoutMs: DAEMON_SPAWN_SSH_TIMEOUT_MS,
      label: 'cc-mgr-spawn',
    });
    if (spawnResult.exitCode !== 0) {
      const detail = spawnResult.stderr.trim().slice(0, 300) || '(no stderr)';
      throw new Error(`cc-mgr daemon spawn failed (exit=${spawnResult.exitCode}): ${detail}`);
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    // SSH timeout = channel closed before bash exits (expected: daemon detached,
    // parent process may not flush exit before channel timeout). Continue to
    // sock-wait — if daemon is alive the socket will appear.
    // Actual spawn failures (exit≠0, missing node/bundle) → throw actionable error.
    if (msg.includes('cc-mgr daemon spawn failed')) {
      throw err;
    }
    log.debug('cc-mgr spawn ssh exited (channel closed/timeout, continuing to sock-wait)', {
      hostId: host.id,
      error: msg,
    });
  }

  // 等 sock 出现 (daemon listen 后立刻产生 sock 文件)。
  const start = Date.now();
  while (Date.now() - start < DAEMON_READY_TIMEOUT_MS) {
    const check = await host.exec(
      `bash -c '[ -S "${REMOTE_SOCK}" ] && echo READY || echo WAITING'`,
      { timeoutMs: 3_000, label: 'cc-mgr-sock-check' },
    );
    if (check.stdout.includes('READY')) {
      log.info('cc-mgr daemon ready', {
        hostId: host.id,
        elapsedMs: Date.now() - start,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SOCK_POLL_INTERVAL_MS));
  }

  // 超时 → 拉 daemon 日志尾给用户看
  const logTail = await host
    .exec(`tail -30 "${REMOTE_LOG}" 2>/dev/null || echo "(no log)"`, {
      timeoutMs: 3_000,
      label: 'cc-mgr-log-tail',
    })
    .catch(() => ({ stdout: '(log tail failed)', stderr: '', exitCode: 1, signal: null }));
  throw new Error(
    `cc-mgr daemon did not become ready in ${DAEMON_READY_TIMEOUT_MS}ms; log tail:\n${logTail.stdout.trim().slice(0, 800)}`,
  );
}

/* ============================== Duplex adapter ============================== */

/**
 * 把 `ExecStreamHandle` (event-based) 包成 Node `Duplex` (RpcClient 接的 shape)。
 *
 * - `onStdoutBytes(buf)` → `duplex.push(buf)` (server → client 字节流)
 * - `duplex.write(chunk)` → `handle.write(chunk)` (client → server)
 * - `onClose` → `duplex.push(null)` (EOF 信号)
 * - `onError` → `duplex.destroy(err)`
 * - duplex 被 destroy 反向调 `handle.kill()` 关 ssh channel
 *
 * **NDJSON 协议必须用 `onStdoutBytes` 而非 `onStdout`** — 后者会 UTF-8 解码,
 * 二进制安全性丢失 (这里我们的 NDJSON 全是 ASCII, 实际无差, 但走 bytes 路径更稳)。
 *
 * Backpressure: ExecStreamHandle 没暴露 pause/resume, push 返 false 时只能依赖
 * SSH 自身的 channel window flow control (ssh2 库内部处理)。实测 NDJSON RPC
 * 流量小, 不会触发反压, best-effort 即可。
 */
function bridgeStreamToDuplex(handle: ExecStreamHandle): Duplex {
  const duplex = new Duplex({
    read(): void {
      /* push-driven, 无主动 pull 逻辑 */
    },
    write(chunk: Buffer, _enc, cb): void {
      try {
        handle.write(chunk);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    final(cb): void {
      try {
        handle.end();
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    destroy(err, cb): void {
      try {
        handle.kill();
      } catch {
        /* channel 已死 */
      }
      cb(err);
    },
  });

  handle.onStdoutBytes((buf) => {
    duplex.push(buf);
  });
  handle.onClose(() => {
    duplex.destroy();
  });
  handle.onError((err) => {
    duplex.destroy(err);
  });

  return duplex;
}

/* ============================== openCcManagerSession ============================== */

/**
 * 打开一个 cc-mgr session — 探活/启 daemon + nc 桥 + RPC hello + 创建 RemoteQuery。
 *
 * 返回的 `remoteQuery` 实现了跟 SDK Query 一致的 interface (send / setModel /
 * setPermissionMode / applyFlagSettings / interrupt / close + asyncIterator),
 * ClaudeCodeAgent 可以当 Query 直接用 (Phase 4.3 接)。
 *
 * `dispose()` 关闭顺序: remoteQuery.close (best-effort RPC) → client.dispose
 * (清 listener) → handle.kill (关 SSH channel)。daemon 自己继续活, 下次 open
 * 时复用 (setsid 持久化)。
 *
 * @throws daemon 起不来 / RPC hello 失败 / 协议版本不匹配 (说明远端 bundle 是
 *   旧版, 用户需要重装)
 */
export async function openCcManagerSession(opts: {
  host: RemoteHost;
  sessionId: string;
  startParams: QueryStartParams;
  /**
   * Absolute path of the `claude` shim on the remote host. Injected into
   * `startParams.extraOptions.pathToClaudeCodeExecutable` so daemon's SDK call
   * locates the native CLI binary — bundled SDK can't resolve its own
   * `@anthropic-ai/claude-cli-<plat>-<arch>` optional dep on a different
   * platform than the desktop build. Resolved by `getRemoteClaudeBinaryPath`.
   */
  claudeBinaryPath: string;
  /**
   * Callback invoked when the remote daemon needs a permission/approval decision.
   * Maps to maker-core's InteractionResolver. If not provided, all approvals
   * are denied (same as the old hardcoded acceptEdits behavior).
   */
  onApprovalRequest?: (params: ApprovalRequestParams) => Promise<ApprovalRequestResult>;
  /**
   * 强制 fresh start:daemon 侧 session alive 时也先 kill 再走 start 路径
   * (而非 attach)。用于本机 HTTP MCP bridge 重启 (app 重启) 后首轮注入:
   * 旧 SDK 持有的 mcp-session-id 在新 bridge 已不存在, attach 会让协同
   * MCP 的每次调用 404 且 SDK 不会自动重新 initialize。fresh start 经
   * startParams.resumeSdkSessionId 恢复上下文 (远端 cc CLI session 文件
   * 持久化在远端机器上)。SSH 断线重连 (app 未重启) 不要传:bridge 内存
   * 表还在, attach 是对的。
   */
  forceFreshQuery?: boolean;
  /**
   * Callback invoked when the remote daemon needs a fresh subscription OAuth
   * token (remote cc hit 401 mid-turn). Maps to maker-core's
   * auth.getFreshSubscriptionToken. If not provided, refresh requests answer
   * token=null (SDK surfaces the auth error — pre-refresh behavior).
   */
  onOAuthRefresh?: (params: OAuthRefreshParams) => Promise<OAuthRefreshResult>;
}): Promise<{
  remoteQuery: RemoteQuery;
  dispose: () => Promise<void>;
  detach: () => Promise<void>;
}> {
  await ensureDaemonRunning(opts.host);

  // Merge `pathToClaudeCodeExecutable` into extraOptions, preserving any
  // caller-provided extras. Done here (the wire layer) rather than in maker-core
  // so the IO-free core stays unaware of remote filesystem paths.
  const startParamsWithBinary: QueryStartParams = {
    ...opts.startParams,
    extraOptions: {
      ...(opts.startParams.extraOptions ?? {}),
      pathToClaudeCodeExecutable: opts.claudeBinaryPath,
    },
  };

  // round-15 fix #5 (P2): 弃 `nc -U` — 太多最小 Linux / BusyBox 镜像没装
  // OpenBSD nc (-U 不支持 unix socket),会让 cc-manager 装好但 session 起不来。
  // 改用 bundled node 跑 cc-mgr 自带的 `bridge` 子命令 (cc-mgr.ts:runBridge),
  // 内部 `net.createConnection(sockPath)` + stdin/stdout 双向 pipe。 bundled node
  // 是 cc-manager install pipeline 必装的 (`installRemoteAgent('claude-code')` 拉
  // 下来的同款), 已经在 REMOTE_XDT_NODE_PATH; cc-mgr.mjs 也已经在 REMOTE_BUNDLE,
  // 两个都不依赖远端系统额外软件。比 `nc -U` 多 1 个 node 启动开销 (~30ms),
  // 换"任意 Linux 镜像都能跑"的稳定性。
  const handle = await opts.host.execStream(
    `"${REMOTE_NODE}" "${REMOTE_BUNDLE}" bridge --socket "${REMOTE_SOCK}"`,
  );
  const duplex = bridgeStreamToDuplex(handle);
  const client = new RpcClient(duplex);

  try {
    const hello = await client.hello({ timeoutMs: RPC_REQUEST_TIMEOUT_MS });
    log.debug('cc-mgr hello ok', {
      hostId: opts.host.id,
      protocolVersion: hello.protocolVersion,
      managerVersion: hello.managerVersion,
    });

    // Register approval request handler — daemon sends these when SDK's
    // canUseTool fires and needs desktop to approve/deny.
    client.setRequestHandler(SERVER_METHODS.APPROVAL_REQUEST, async (params) => {
      const p = params as ApprovalRequestParams;
      if (opts.onApprovalRequest) {
        try {
          return await opts.onApprovalRequest(p);
        } catch (err) {
          log.warn('approval request handler rejected', { kind: p.kind, error: (err as Error)?.message });
          return { kind: p.kind, behavior: 'deny', reason: (err as Error)?.message ?? 'handler error' } satisfies ApprovalRequestResult;
        }
      }
      return { kind: p.kind, behavior: 'deny', reason: 'no approval handler registered' } satisfies ApprovalRequestResult;
    });

    // OAuth refresh handler — daemon sends these when the remote cc SDK's
    // getOAuthToken fires (subscription token expired mid-turn). token=null
    // on any failure: the daemon passes it to the SDK, which surfaces the
    // auth error (same as the pre-refresh behavior).
    client.setRequestHandler(SERVER_METHODS.OAUTH_REFRESH, async (params) => {
      const p = params as OAuthRefreshParams;
      if (opts.onOAuthRefresh) {
        try {
          return await opts.onOAuthRefresh(p);
        } catch (err) {
          log.warn('oauth refresh handler rejected', { sessionId: p.sessionId, error: (err as Error)?.message });
          return { token: null } satisfies OAuthRefreshResult;
        }
      }
      return { token: null } satisfies OAuthRefreshResult;
    });

    // start-vs-attach 路由:cc-mgr daemon 是 setsid 持久化的, desktop 关掉 daemon
    // 不死, SessionRegistry 里旧 sessionId 仍活着。重启后用同 sessionId 调
    // query/start 会撞 SESSION_ALREADY_EXISTS。先 list 一遍 daemon 上的 sessions,
    // 命中 alive=true 走 attach (Phase 5 设计的 detach/reattach 路径, 自动 replay
    // ring buffer 里 sinceSeq 之后的事件); 不命中走 start (新会话或 daemon 重启过)。
    //
    // 一次 SESSION_LIST RPC ≈ daemon 内 in-memory Map 遍历, 本地 desktop 看是
    // 1 个额外 RTT (~10ms over ssh), 远比 race 后 fallback 干净。
    const list = await client.request<SessionListResult>(METHODS.SESSION_LIST, {}, {
      timeoutMs: RPC_REQUEST_TIMEOUT_MS,
    });

    const listedSession = list.sessions.find((s) => s.sessionId === opts.sessionId);
    // dead session 处理(对齐 codex 模式):alive → attach live-only,
    // dead/absent → kill + fresh start。**MVP 限制**:断开期间跑完的输出不补回
    // chat(跟 codex remote 行为一致);基于 SDK jsonl 的 read-since-lineNo
    // recovery 是 follow-up,**尚未实现**。
    if (listedSession && !listedSession.alive) {
      // dead 条目的 kill 只是注册表清理, 失败可吞:start 路径对 dead 条目
      // 不撞 SESSION_ALREADY_EXISTS (该错误只对 alive 条目)。
      await client.request(
        METHODS.SESSION_KILL,
        { sessionId: opts.sessionId },
        { timeoutMs: RPC_REQUEST_TIMEOUT_MS },
      ).catch(() => undefined);
      log.info('cc-mgr: dead session killed (fresh start, 对齐 codex 模式)', {
        hostId: opts.host.id,
        sessionId: opts.sessionId,
        daemonLastSeq: listedSession.lastSeq,
      });
    }
    // forceFreshQuery:alive 也 kill + fresh (bridge MCP 重启后首轮注入,
    // 见 opts.forceFreshQuery 注释)。
    const killAliveForFresh = listedSession?.alive === true && opts.forceFreshQuery === true;
    if (killAliveForFresh) {
      // kill 失败不得吞错继续 (greptile P1):旧 session 仍 alive 时 fresh
      // start 必撞 SESSION_ALREADY_EXISTS, 且后续重试沿同一路径永久卡死。
      // 让错误上抛 → open 失败 → forcedFresh 状态不提交 (maker-host 只在
      // open 成功后 add), 下次重试仍带 forceFreshQuery 重试 kill, 瞬时
      // 故障可恢复。
      await client.request(
        METHODS.SESSION_KILL,
        { sessionId: opts.sessionId },
        { timeoutMs: KILL_RPC_TIMEOUT_MS },
      );
      // registry.kill 同步等 consume loop 退出才返回 (interrupt 无效时
      // 升级 query.close() 终止子进程; 仍不退出抛 SESSION_KILL_TIMEOUT
      // 上抛, 绝不谎报已退出 — greptile confidence 3/5)。此处轮询只是
      // belt-and-braces (loop 退出到 list 反映之间无间隙, 通常首轮即
      // break), 保留以兜住 daemon 老版本 (无同步 kill) 的慢退出:
      // 退避 (150ms→1s), 总预算 30s。
      // 超时只能上抛, 不得降级 attach (greptile R22/R23 P1):kill 已 end
      // 输入队列, AsyncQueue.push 在 end 后静默丢弃 (cc-mgr registry 注释
      // 实锤) — attach 仍在退出中的 query 会吞掉用户消息。慢退出场景由
      // 调用方重试自然覆盖 (重试时 query 多已退出);consume loop 永不退出
      // 是 daemon 病态, 任何客户端策略都无法恢复, 错误信息给出可操作
      // 指引 (重启远端 cc-mgr)。fresh 状态不提交, 下次重试仍带
      // forceFreshQuery。
      const killWaitDeadline = Date.now() + 30_000;
      let pollDelayMs = 150;
      for (;;) {
        const after = await client.request<SessionListResult>(METHODS.SESSION_LIST, {}, {
          timeoutMs: RPC_REQUEST_TIMEOUT_MS,
        });
        const stillAlive =
          after.sessions.find((s) => s.sessionId === opts.sessionId)?.alive === true;
        if (!stillAlive) break;
        if (Date.now() > killWaitDeadline) {
          throw new Error(
            `cc-mgr: session ${opts.sessionId} still alive 30s after kill (forced fresh) — ` +
              `the daemon's consume loop did not exit; retry shortly, or restart the remote ` +
              `cc-mgr daemon if it persists (a wedged consume loop cannot be recovered from the client side)`,
          );
        }
        await new Promise((r) => setTimeout(r, pollDelayMs));
        pollDelayMs = Math.min(pollDelayMs * 2, 1_000);
      }
      log.info('cc-mgr: alive session killed for forced fresh start (bridge MCP re-inject)', {
        hostId: opts.host.id,
        sessionId: opts.sessionId,
        daemonLastSeq: listedSession.lastSeq,
      });
    }
    const existing = listedSession?.alive && !killAliveForFresh ? listedSession : undefined;

    // 对齐 codex 模式: alive → attach live-only, dead/absent → fresh start。
    // 不 replay 旧 events,不追踪 cursor。
    const remoteQuery = existing
      ? await createRemoteQuery({
          client,
          sessionId: opts.sessionId,
          // live-only: 只接此刻之后的新 events,不 replay 旧的(对齐 codex
          // app-server subscription 模式)。**MVP**:断开期间的历史不补回
          // (jsonl-as-truth recovery 是 follow-up,尚未实现)。
          attach: { sinceSeq: existing.lastSeq },
          onReplayLossy: (result) => {
            log.warn('cc-mgr: replay buffer lossy during reattach (MVP: 断开期间历史不恢复)', {
              hostId: opts.host.id,
              sessionId: opts.sessionId,
              currentSeq: result.currentSeq,
            });
          },
          rpcTimeoutMs: RPC_REQUEST_TIMEOUT_MS,
        })
      : await createRemoteQuery({
          client,
          sessionId: opts.sessionId,
          startParams: startParamsWithBinary,
          rpcTimeoutMs: RPC_REQUEST_TIMEOUT_MS,
        });

    if (existing) {
      log.info('cc-mgr: reattached to existing session', {
        hostId: opts.host.id,
        sessionId: opts.sessionId,
        daemonLastSeq: existing.lastSeq,
      });
    }

    // Capture the ORIGINAL remoteQuery.close before returning — upstream
    // (maker-host remoteCcQueryFactory) does `Object.assign(remoteQuery,
    // { close: dispose })` so the maker-core layer can dispose the whole
    // ssh transport via a single Query.close() call. If dispose() below
    // referenced `remoteQuery.close()` directly, the mutated property would
    // point back at dispose itself → infinite recursion → "Maximum call stack
    // size exceeded" (and the actual close never runs, daemon session leaks).
    // Bind the captured fn so `this` still resolves correctly.
    const originalRemoteQueryClose = remoteQuery.close.bind(remoteQuery);
    const originalRemoteQueryDetach = remoteQuery.detach.bind(remoteQuery);

    const closeTransport = async (): Promise<void> => {
      client.dispose();
      // round-9 重构: cursor 在 writeChain 里跟 message 同 FIFO 序列化, drain
      // 一次就保证 (该 sessionId 的) cursor + 对应 message 全部落盘。closeTransport
      // 关 SSH channel 前 await drain, 反序列化窗口里不会有 cursor 已推但 message
      // 没存的 hole。drain throws 不可能 (writeChain 内每个 link 自 catch warn)。
      await drainPersistQueue();
      try {
        handle.kill();
      } catch {
        /* channel closed */
      }
    };

    return {
      remoteQuery,
      dispose: async (): Promise<void> => {
        try {
          await originalRemoteQueryClose();
        } catch (e) {
          log.warn('remoteQuery.close threw (best-effort)', {
            hostId: opts.host.id,
            sessionId: opts.sessionId,
            error: String((e as Error)?.message ?? e),
          });
        }
        await closeTransport();
      },
      detach: async (): Promise<void> => {
        try {
          await originalRemoteQueryDetach();
        } catch (e) {
          log.warn('remoteQuery.detach threw (best-effort)', {
            hostId: opts.host.id,
            sessionId: opts.sessionId,
            error: String((e as Error)?.message ?? e),
          });
        }
        await closeTransport();
      },
    };
  } catch (err) {
    // 出错前 cleanup: 不然 client + handle 泄漏
    client.dispose();
    try {
      handle.kill();
    } catch {
      /* */
    }
    throw err;
  }
}

/* ============================== helpers ============================== */

/** POSIX sh 单引号 escape: foo'bar → 'foo'\''bar'。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
