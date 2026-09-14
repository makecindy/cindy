/**
 * cc-mgr CLI entry point — the daemon binary spawned on remote SSH machines.
 *
 * Usage:
 *   cc-mgr daemon --socket <path>     # start a manager daemon listening on the socket
 *   cc-mgr --version                   # print version + protocolVersion JSON
 *   cc-mgr --help                      # usage
 *
 * Bundled via `pnpm --filter @cindy/maker-cc-manager bundle` → dist/cc-mgr.mjs
 * (esbuild --bundle --platform=node, ~500KB including SDK).
 *
 * The bundled file gets shipped to remote via bootstrap-script.ts (Phase 4).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { ManagerServer } from '../server.js';
import { SessionRegistry, type SdkQueryFactoryOptions, type SdkQueryLike } from '../session-registry.js';
import { wireSdkHandlers } from '../sdk-handlers.js';
import { ensureRemoteClaudeConfigDir } from '../remote-claude-env.js';
import {
  CC_MGR_BUNDLE_VERSION,
  PROTOCOL_VERSION,
  SERVER_METHODS,
  type ApprovalRequestParams,
  type ApprovalRequestResult,
  type OAuthRefreshParams,
  type OAuthRefreshResult,
  type SubagentModelAccessParams,
  type SubagentModelAccessResult,
} from '../protocol.js';

const MANAGER_VERSION = CC_MGR_BUNDLE_VERSION;

/**
 * Strip Anthropic / Claude auth env keys from this daemon's process.env so
 * the SDK's spawn merge (`{ ...process.env, ...userEnv }`) cannot leak a
 * remote-host-side stale token over the desktop-supplied env.
 *
 * Mirrors `packages/maker-core/src/agents/claude-code/env-builder.ts` —
 * SENSITIVE_ANTHROPIC_ENV_KEYS is the single source of truth on the desktop
 * side; this list MUST stay in sync. Can't `import` cross-package because
 * cc-mgr ships standalone to remote machines (bundled via esbuild, no
 * runtime resolve of maker-core).
 *
 * Why duplicate is acceptable: the list is short, append-only, and any
 * future addition is gated by maker-core review — bundler will pick up the
 * change next desktop release, daemon code gets revisited then.
 *
 * Background: on remote hosts where the user has previously logged in with
 * `claude` CLI (or set ANTHROPIC_API_KEY in shell rc / systemd unit), those
 * envs sit in this daemon's process.env (we inherit shell env via SSH exec).
 * Desktop sends an `env` dict per query/start that overrides specific keys,
 * but SDK does `{ ...process.env, ...userEnv }` — any auth key we don't
 * overwrite leaks. Strip them at boot so the SDK only sees what desktop
 * explicitly sent.
 */
const SENSITIVE_ANTHROPIC_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  // 订阅身份元数据(与 OAUTH_TOKEN 配套):远端 SSH shell 的残留值经
  // { ...process.env, ...userEnv } 合并会给 desktop 递来的凭证挂上错误
  // scopes/档位 —— 与 desktop 侧 env-builder 同步剥离(sync with
  // packages/maker-core/src/agents/claude-code/env-builder.ts)。
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'CLAUDE_CONFIG_DIR',
] as const;

function stripSensitiveAnthropicEnv(): string[] {
  const stripped: string[] = [];
  for (const key of SENSITIVE_ANTHROPIC_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      delete process.env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

/**
 * Prepend the bundled-node directory to `process.env.PATH` so SDK-spawned
 * `claude` shim (`#!/usr/bin/env node` shebang) can resolve a node interpreter
 * even on hosts without a system-wide node install.
 *
 * Background: cc-manager runs SDK `query()`, which spawns the
 * `pathToClaudeCodeExecutable` shim (e.g. `node_modules/.bin/claude` →
 * `cli.js`). Shim's shebang is `env node`; `env` walks PATH at execve time —
 * if PATH doesn't have node, execve fails with "node: command not found",
 * surfacing as a SDK_ERROR back to the client.
 *
 * We daemon-start as `$NODE_BIN cc-mgr.mjs daemon ...` (bundled node), so
 * `process.execPath` IS the bundled-node binary itself; its dirname is the
 * node bin dir we need. Prepending here means every child of this process
 * (the SDK-spawned shim) inherits a PATH that finds node first, before any
 * potentially-stale system node — same precedence as the bootstrap script's
 * own `export PATH="$NODE_DIR/bin:$PATH"`.
 *
 * Robustness: no-op if the entry point is somehow not under a bin dir (e.g.
 * dev-mode `node src/bin/cc-mgr.ts` from a node install where dirname already
 * looks normal — still fine, the prepend is just redundant).
 */
function ensureBundledNodeOnPath(): void {
  const nodeBinDir = path.dirname(process.execPath);
  const current = process.env.PATH ?? '';
  // Don't double-prepend if already first (idempotent for nested re-init).
  if (current.split(path.delimiter)[0] === nodeBinDir) return;
  process.env.PATH = current ? `${nodeBinDir}${path.delimiter}${current}` : nodeBinDir;
}

interface ParsedArgs {
  command: 'daemon' | 'version' | 'help' | 'bridge';
  socket?: string;
  /**
   * Self-detach mode: when set, this process re-spawns itself as a detached
   * grandchild and exits immediately. The grandchild becomes a true background
   * daemon, reparented to init/launchd. Avoids depending on shell-side
   * `setsid` / `nohup` / subshell tricks (setsid command is Linux-only via
   * util-linux; mac/BSD don't have it). Modeled on Codex's Rust `pre_exec()
   * + libc::setsid()` approach — Node's `child_process.spawn({detached: true})`
   * is the cross-platform equivalent (libuv internally calls setsid on unix).
   */
  detach?: boolean;
  /** When daemon spawns its detached child, this flag tells the child it's
   *  the real daemon (skip another fork). */
  inner?: boolean;
  /** Where to redirect daemon stdout/stderr after detach. Required with --detach. */
  logFile?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv = [node, script, ...rest]
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    return { command: 'help' };
  }
  if (rest[0] === '--version' || rest[0] === '-v') {
    return { command: 'version' };
  }
  if (rest[0] === 'bridge') {
    let socket: string | undefined;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--socket' || rest[i] === '-s') {
        socket = rest[i + 1];
        i++;
      }
    }
    if (!socket) {
      console.error('cc-mgr bridge: --socket <path> is required');
      process.exit(2);
    }
    return { command: 'bridge', socket };
  }
  if (rest[0] === 'daemon') {
    let socket: string | undefined;
    let detach = false;
    let inner = false;
    let logFile: string | undefined;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--socket' || rest[i] === '-s') {
        socket = rest[i + 1];
        i++;
      } else if (rest[i] === '--detach') {
        detach = true;
      } else if (rest[i] === '--inner') {
        inner = true;
      } else if (rest[i] === '--log-file') {
        logFile = rest[i + 1];
        i++;
      }
    }
    if (!socket) {
      console.error('cc-mgr daemon: --socket <path> is required');
      process.exit(2);
    }
    if (detach && !logFile) {
      console.error('cc-mgr daemon: --log-file <path> is required with --detach');
      process.exit(2);
    }
    return { command: 'daemon', socket, detach, inner, logFile };
  }
  console.error(`cc-mgr: unknown command "${rest[0]}"`);
  return { command: 'help' };
}

function printHelp(): void {
  console.error(
    [
      'cc-mgr — Cindy Claude Code remote daemon',
      '',
      'Commands:',
      '  cc-mgr daemon --socket <path>             Run daemon in the foreground',
      '  cc-mgr daemon --socket <path> --detach \\  Re-spawn self as detached',
      '         --log-file <path>                  background process, print PID',
      '                                            to stdout, exit. The grandchild',
      '                                            becomes the actual daemon.',
      '  cc-mgr bridge --socket <path>             Pipe stdin/stdout to/from the',
      '                                            unix socket (replaces `nc -U`',
      '                                            for hosts without OpenBSD nc).',
      '  cc-mgr --version                          Print version info as JSON',
      '  cc-mgr --help                             Print this message',
      '',
      `Manager version: ${MANAGER_VERSION}`,
      `Protocol version: ${PROTOCOL_VERSION}`,
    ].join('\n'),
  );
}

/**
 * Self-detach: re-spawn this process as a detached grandchild, then exit.
 * The grandchild is reparented to init/launchd and survives the parent ssh
 * session's termination — exactly what `setsid + nohup + subshell` tries to
 * achieve in shell, but done in cross-platform Node (libuv handles unix
 * setsid / Windows DETACHED_PROCESS internally).
 *
 * stdio: ['ignore', logFd, logFd] — child has no parent fds, won't keep ssh
 * channel open. `detached: true` puts child in its own process group so
 * sshd's SIGHUP to the session doesn't propagate.
 *
 * Writes the grandchild's PID to stdout (one line) for the caller to capture
 * into a pidfile, then exits 0.
 */
function selfDetachAndExit(socketPath: string, logFile: string): void {
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [process.argv[1], 'daemon', '--socket', socketPath, '--inner'],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    },
  );
  child.unref();
  // Close our own copy of the fd — child inherited its own duplicate.
  fs.closeSync(logFd);
  // pid 早 fail guard: spawn() 失败 (ENOMEM / 权限 / binary 坏) 时 child.pid 是
  // undefined。如果不 guard, 后面 `${child.pid}` 写出字面 "undefined", shell 把
  // 它存进 pidfile, ensureDaemonRunning probe 看 `kill -0 undefined` 失败, 走
  // 10s timeout 报 "daemon did not become ready" — 真实原因 (spawn 失败) 被
  // 完全掩盖, 用户排障非常痛苦。早 fail + diagnostic 让上层 ssh exec stderr
  // 立即看到原因。
  if (!child.pid) {
    process.stderr.write('[cc-mgr] selfDetachAndExit: spawn returned no PID — grandchild failed to start\n');
    process.exit(1);
  }
  // Print PID to stdout so the spawning shell can save it. One line, no
  // trailing extras (caller does `PID=$(... --detach ...); echo $PID > pidfile`).
  //
  // round-17 fix #1 (P2): SSH pipe stdout 是 async, 不等 flush 就 process.exit
  // 会丢掉这行 PID — 远端 shell 拿到空 → 写空 pidfile → 后续 probe 当 daemon
  // dead → 又启一个 daemon → grandchild 还在跑 → 双 daemon 抢 sock。
  // write 的 callback 在 chunk 真正 flush 到 OS pipe 后才触发, 用它 gate exit
  // 跟 bridge runBridge 的 flushAndExit 同款语义。
  process.stdout.write(`${child.pid}\n`, () => {
    process.exit(0);
  });
}

function printVersion(): void {
  // JSON on stdout — bootstrap-script.ts / installer.ts parses this.
  process.stdout.write(
    JSON.stringify({
      managerVersion: MANAGER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    }) + '\n',
  );
}

async function runDaemon(socketPath: string): Promise<void> {
  // Install last-resort crash guards before anything that can throw async —
  // SDK has internal sockets / streams we don't own, any one of them emitting
  // an unhandled 'error' would crash the whole daemon. See installCrashGuards
  // for the EPIPE history.
  installCrashGuards();

  // Fix env.PATH so SDK-spawned `claude` shim's #!/usr/bin/env node shebang
  // can locate the bundled node interpreter regardless of host system PATH.
  // Must run before `import('@anthropic-ai/claude-agent-sdk')` though SDK
  // doesn't spawn during import (only on `query()` call) — putting it here
  // is equally correct, just easier to see in one place.
  ensureBundledNodeOnPath();

  // Strip remote-host auth env (round-16 fix #4 P2): SDK does
  // `{ ...process.env, ...userEnv }` on spawn — desktop-sent env only
  // overrides keys it explicitly sets, but a remote-host stale
  // CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
  // would leak into the spawned cc CLI and authenticate as the wrong
  // account (or fail with 401). Strip before any SDK call.
  const stripped = stripSensitiveAnthropicEnv();
  if (stripped.length > 0) {
    console.error('[cc-mgr] stripped sensitive env keys at boot:', stripped.join(', '));
  }
  // Keep all Cindy-managed Claude state outside the user's repository and
  // outside the host's global ~/.claude directory. query/start independently
  // overwrites the per-session env with the same daemon-owned path.
  process.env.CLAUDE_CONFIG_DIR = ensureRemoteClaudeConfigDir();

  // Lazy import the SDK so --version doesn't pay the SDK load cost.
  const sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  const sdkQuery = sdkModule.query;

  // (Slack empty-cursor hook retired 2026-07-15: it only matched the legacy
  //  slack-official MCP server's mcp__slack__* tool names; the scrub now lives
  //  inside the cindy-slack ghost's slack_call_tool.)

  const sdkQueryFactory = (opts: SdkQueryFactoryOptions): SdkQueryLike => {
    const { inputStream, cwd, model, env, mcpServers, permissionMode, systemPrompt, additionalDirectories, allowedTools, disallowedTools, tools, resume, extraOptions, hooks, canUseTool, getOAuthToken } = opts;
    // SDK's `query` accepts `prompt: string | AsyncIterable<SDKUserMessage>`.
    // We pass our inputQueue (push-based AsyncIterable) so the SDK consumes
    // user messages on demand. SDK's options.* fields are typed strictly —
    // we cast to satisfy the call site, the SDK does its own validation.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const q = sdkQuery({
      prompt: inputStream as any,
      options: {
        cwd,
        model,
        env,
        ...(mcpServers ? { mcpServers: mcpServers as any } : {}),
        ...(permissionMode ? { permissionMode: permissionMode as any } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt: systemPrompt as any } : {}),
        ...(additionalDirectories ? { additionalDirectories } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(disallowedTools ? { disallowedTools } : {}),
        ...(tools !== undefined ? { tools: tools as any } : {}),
        ...(resume ? { resume } : {}),
        ...(canUseTool ? { canUseTool: canUseTool as any } : {}),
        // SDK Options 类型未声明 getOAuthToken 但运行时支持(oauth_token_refresh
        // control 分支)—— 与 desktop 本地分支同一注入方式,经 spread 绕过类型检查。
        ...(getOAuthToken ? { getOAuthToken: getOAuthToken as any } : {}),
        ...(extraOptions ?? {}),
        // Daemon-owned hooks must win over JSON extraOptions. They enforce
        // host routing before Claude's permission mode and setting rules.
        ...(hooks ? { hooks: hooks as any } : {}),
      } as any,
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return q as unknown as SdkQueryLike;
  };

  const server = new ManagerServer({
    socketPath,
    managerVersion: MANAGER_VERSION,
    logger: {
      debug: (msg, ctx) => console.error('[cc-mgr][debug]', msg, ctx ?? ''),
      info: (msg, ctx) => console.error('[cc-mgr][info]', msg, ctx ?? ''),
      warn: (msg, ctx) => console.error('[cc-mgr][warn]', msg, ctx ?? ''),
      error: (msg, ctx) => console.error('[cc-mgr][error]', msg, ctx ?? ''),
    },
  });

  // Registry needs server + handlers wired to forward approval requests via reverse-RPC.
  // Create registry first (with onApprovalRequest pointing at server), then wire handlers.
  // Order: registry constructor only stores the callback — it's invoked later during
  // SDK canUseTool, by which point wireSdkHandlers has already populated the ctx map.
  let getAttachedClientCtx: ((sessionId: string) => import('../server.js').ClientCtx | undefined) | undefined;

  const registry = new SessionRegistry({
    sdkQueryFactory,
    onApprovalRequest: async (sessionId: string, params: ApprovalRequestParams): Promise<ApprovalRequestResult> => {
      const ctx = getAttachedClientCtx?.(sessionId);
      if (!ctx) {
        throw new Error('no attached client for session ' + sessionId);
      }
      return await server.sendRequest<ApprovalRequestResult>(
        ctx,
        SERVER_METHODS.APPROVAL_REQUEST,
        params,
        { timeoutMs: 120_000 },
      );
    },
    onSubagentModelAccessRequest: async (
      sessionId: string,
      params: SubagentModelAccessParams,
    ): Promise<SubagentModelAccessResult> => {
      const ctx = getAttachedClientCtx?.(sessionId);
      if (!ctx) return { status: 'unknown' };
      return await server.sendRequest<SubagentModelAccessResult>(
        ctx,
        SERVER_METHODS.SUBAGENT_MODEL_ACCESS,
        params,
        { timeoutMs: 15_000 },
      );
    },
    onOAuthRefresh: async (sessionId: string, params: OAuthRefreshParams): Promise<OAuthRefreshResult> => {
      const ctx = getAttachedClientCtx?.(sessionId);
      if (!ctx) {
        throw new Error('no attached client for session ' + sessionId);
      }
      // 30s:desktop 侧 getFreshSubscriptionToken 是一次 token 端点网络刷新;超时 /
      // UNKNOWN_METHOD(旧 desktop)由 registry 的 catch 落成 null → SDK 报鉴权错误。
      return await server.sendRequest<OAuthRefreshResult>(
        ctx,
        SERVER_METHODS.OAUTH_REFRESH,
        params,
        { timeoutMs: 30_000 },
      );
    },
    logger: {
      debug: (msg, ctx) => console.error('[cc-mgr][debug]', msg, ctx ?? ''),
      info: (msg, ctx) => console.error('[cc-mgr][info]', msg, ctx ?? ''),
      warn: (msg, ctx) => console.error('[cc-mgr][warn]', msg, ctx ?? ''),
      error: (msg, ctx) => console.error('[cc-mgr][error]', msg, ctx ?? ''),
    },
  });

  const handlers = wireSdkHandlers(server, registry);
  getAttachedClientCtx = handlers.getAttachedClientCtx;
  server.onClientClose((ctx) => handlers.onClientDisconnected(ctx));

  await server.start();
  console.error(`[cc-mgr] daemon ready at ${socketPath} (version ${MANAGER_VERSION})`);

  // Wait forever (SIGINT/SIGTERM stops us).
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.error(`[cc-mgr] received ${signal}, shutting down`);
    // U1: notify every still-attached client that their session is being
    // torn down BEFORE closing the socket. RemoteQuery (desktop side) sees
    // SESSION_CLOSED → ends its iterator → translator emits an aborted-turn
    // event → renderer unblocks isStreaming. Without this the client just
    // sees the ssh stream go silent and stays "thinking..." forever.
    //
    // server.stop() closes the socket, so this MUST run before stop()
    // (notifyClosed writes a JSON-RPC notification through the socket).
    try {
      registry.shutdownAll(`daemon received ${signal}`);
    } catch (err) {
      console.error('[cc-mgr] shutdownAll threw (continuing)', (err as Error)?.message);
    }
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Last-resort process-level handlers — keep daemon alive across non-fatal
 * errors that some downstream socket / stream didn't `.on('error', ...)` for.
 *
 * Historical reason: empirically observed `Error: write EPIPE` crashing the
 * whole daemon (Node default behavior for an unhandled 'error' event = throw
 * → uncaught exception → process exits). Source of the EPIPE was a socket we
 * don't directly own (SDK-internal cc CLI child-process stdio / Anthropic
 * fetch socket / etc.), so we can't attach error listeners on it. Even if we
 * could, defense-in-depth: production daemons should NEVER die from a
 * transient I/O error. Log + keep running; orphan state gets reaped on next
 * client connect / session cleanup.
 *
 * Intentionally does NOT call process.exit — that would re-introduce the
 * original crash behavior.
 */
function installCrashGuards(): void {
  process.on('uncaughtException', (err) => {
    console.error('[cc-mgr] uncaughtException — daemon staying alive', err.stack ?? err.message);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error('[cc-mgr] unhandledRejection — daemon staying alive', msg);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case 'help':
      printHelp();
      process.exit(0);
      return;
    case 'version':
      printVersion();
      process.exit(0);
      return;
    case 'bridge':
      runBridge(args.socket!);
      return;
    case 'daemon':
      // --detach (no --inner): parent that re-spawns itself as a detached
      // grandchild then exits 0. Caller (ssh bash) captures the grandchild PID
      // from stdout and writes the pidfile.
      // --inner OR no --detach: the actual daemon — run server in foreground.
      if (args.detach && !args.inner) {
        // round-17 fix #1 follow-up (codex pre-push review): selfDetachAndExit
        // 改成 callback exit 后 sig 是 void(非 never), 不 return 会 fall through
        // 到下面 runDaemon — 父 process 启动 server.start() bind sock, 跟 detached
        // grandchild bind 同一 sock 形成 EADDRINUSE race。显式 return 阻断 fall
        // through, callback 触发的 process.exit(0) 仍然按时退出。
        selfDetachAndExit(args.socket!, args.logFile!);
        return;
      }
      await runDaemon(args.socket!);
      return;
  }
}

/**
 * `cc-mgr bridge --socket <path>` — replace `nc -U` with a portable bridge
 * that uses bundled Node's `net` module. Minimal Linux / BusyBox hosts often
 * lack OpenBSD nc (-U flag); BusyBox nc doesn't support unix sockets at all.
 * Bundled node ships with us as part of the cc-manager install pipeline, so
 * this command is always available wherever cc-mgr.mjs is.
 *
 * Behavior:
 *   stdin  → socket (client → daemon RPC frames)
 *   socket → stdout (daemon → client RPC frames / notifications)
 *   socket close / error → process.exit(0 / 1)
 *   stdin EOF → socket.end (graceful shutdown)
 *
 * Exit codes match nc-style semantics: 0 normal close, non-zero on connect /
 * runtime error so the desktop side's ExecStreamHandle.onError fires.
 */
function runBridge(socketPath: string): void {
  const sock = net.createConnection(socketPath);

  // 退出前必须确保 stdout/stderr 已 flush 到 OS pipe,否则 sock.pipe(stdout)
  // 写到 stdout writable buffer 的最后一帧 NDJSON RPC response 会随 process.exit
  // 一起丢,desktop 侧收半帧 → JSON parse 失败 / pending RPC 永不 resolve →
  // streaming cleanup race。Node writable stream 的 write(cb) 是 FIFO 排队的:
  // 空写 '' 的 callback 在前面所有 chunk flush 完才触发,我们用它当 flush barrier。
  // 先 unpipe stdin 防止退出窗口里 stdin 又 push 到已死的 sock。
  const flushAndExit = (code: number): void => {
    try {
      process.stdin.unpipe(sock);
    } catch {
      /* unpipe 失败说明从未 pipe 上 (sock 连接前 error), 忽略 */
    }
    process.stdout.write('', () => {
      process.stderr.write('', () => {
        process.exit(code);
      });
    });
  };

  sock.on('connect', () => {
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });
  sock.on('error', (err) => {
    process.stderr.write(`[cc-mgr bridge] socket error: ${err.message}\n`);
    flushAndExit(1);
  });
  sock.on('close', () => {
    flushAndExit(0);
  });
  // stdin EOF (远端 ssh channel 关掉 stdin) → 半关闭 socket, 等 daemon flush 完
  // 它那侧的响应再彻底关。避免过早 destroy 让 in-flight response 丢。
  process.stdin.on('end', () => {
    sock.end();
  });
  // stdin 自己出错 (extremely rare in interactive ssh exec) → 也终结桥, 不要
  // 让 process 卡在不可恢复的半死状态。
  process.stdin.on('error', () => {
    try {
      sock.destroy();
    } catch {
      /* */
    }
    flushAndExit(1);
  });
}

void main().catch((err) => {
  console.error('[cc-mgr] fatal:', (err as Error).message);
  process.exit(1);
});
