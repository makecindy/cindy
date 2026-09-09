/**
 * pi-manager CLI entry point — the daemon binary spawned on remote SSH machines.
 *
 * Usage:
 *   pi-manager daemon --socket <path>     # start a manager daemon listening on the socket
 *   pi-manager bridge --socket <path>     # pipe stdin/stdout to/from a session socket
 *   pi-manager --version                  # print version + protocolVersion JSON
 *   pi-manager --help                     # usage
 *
 * Bundled via `pnpm --filter @cindy/maker-pi-manager bundle` → dist/pi-manager.mjs
 * (esbuild --bundle --platform=node, single self-contained ESM file).
 *
 * Structure mirrors packages/maker-cc-manager/src/bin/cc-mgr.ts deliberately —
 * the daemon/bridge/selfDetach skeleton is copied (not shared) to keep cc-mgr
 * byte-identical and untouched. The session model differs entirely: this daemon
 * holds `pi --mode rpc` child processes (bash -c), not SDK Query objects.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { ManagerServer } from '../server.js';
import { PiSessionRegistry, scrubCredentialText } from '../session-registry.js';
import {
  METHODS,
  NOTIFICATIONS,
  PI_MANAGER_BUNDLE_VERSION,
  PROTOCOL_VERSION,
  type PiEnsureParams,
  type PiEnsureResult,
  type PiKillParams,
  type PiListResult,
} from '../protocol.js';

const MANAGER_VERSION = PI_MANAGER_BUNDLE_VERSION;

interface ParsedArgs {
  command: 'daemon' | 'bridge' | 'version' | 'help';
  socket?: string;
  detach?: boolean;
  inner?: boolean;
  logFile?: string;
  /** pi session socket to bridge (bridge subcommand). */
  bridgeSock?: string;
  /** 空闲回收超时(秒), 默认 1800 —— 可缩短便于验证(自审轮 10 B-1)。 */
  idleTimeoutSeconds?: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
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
      const [flag, inlineValue] = splitFlag(rest[i]);
      if (flag === '--socket' || flag === '-s') {
        socket = inlineValue ?? rest[i + 1];
        if (inlineValue === undefined) i++;
      } else {
        console.error(`pi-manager bridge: unknown option "${rest[i]}"`);
        process.exit(2);
      }
    }
    if (!socket) {
      console.error('pi-manager bridge: --socket <path> is required');
      process.exit(2);
    }
    return { command: 'bridge', bridgeSock: socket };
  }
  if (rest[0] === 'daemon') {
    let socket: string | undefined;
    let detach = false;
    let inner = false;
    let logFile: string | undefined;
    let idleTimeoutSeconds: number | undefined;
    for (let i = 1; i < rest.length; i++) {
      const [flag, inlineValue] = splitFlag(rest[i]);
      if (flag === '--socket' || flag === '-s') {
        socket = inlineValue ?? rest[i + 1];
        if (inlineValue === undefined) i++;
      } else if (flag === '--detach') {
        detach = true;
      } else if (flag === '--inner') {
        inner = true;
      } else if (flag === '--log-file') {
        logFile = inlineValue ?? rest[i + 1];
        if (inlineValue === undefined) i++;
      } else if (flag === '--idle-timeout') {
        const raw = (inlineValue ?? rest[i + 1] ?? '').trim();
        // 轮 24-I1 LOW:严格十进制整数字符串 —— parseInt 接受 '1e3'/'10abc'/
        // '1.5' 等部分数字串, 解析结果与配置意图不一致(会话被更早/更晚回收)。
        if (!/^(0|[1-9]\d*)$/.test(raw)) {
          console.error('pi-manager daemon: --idle-timeout must be a non-negative integer (seconds)');
          process.exit(2);
        }
        idleTimeoutSeconds = Number(raw);
        if (inlineValue === undefined) i++;
      } else {
        // 未知 flag 报错而非静默忽略:防 --socket=/path 这类等号写法的
        // 用户困惑(轮 4 LOW #11)。
        console.error(`pi-manager daemon: unknown option "${rest[i]}"`);
        process.exit(2);
      }
    }
    if (!socket) {
      console.error('pi-manager daemon: --socket <path> is required');
      process.exit(2);
    }
    if (detach && !logFile) {
      console.error('pi-manager daemon: --log-file <path> is required with --detach');
      process.exit(2);
    }
    return { command: 'daemon', socket, detach, inner, logFile, idleTimeoutSeconds };
  }
  console.error(`pi-manager: unknown command "${rest[0]}"`);
  return { command: 'help' };
}

/** 拆 --key=value 等号形式;无等号返回 [flag, undefined]。 */
export function splitFlag(arg: string): [string, string | undefined] {
  if (arg.startsWith('--') || arg.startsWith('-')) {
    const eq = arg.indexOf('=');
    if (eq > 0) return [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  return [arg, undefined];
}

function printHelp(): void {
  console.error(
    [
      'pi-manager — Cindy pi remote daemon',
      '',
      'Commands:',
      '  pi-manager daemon --socket <path>             Run daemon in the foreground',
      '  pi-manager daemon --socket <path> --detach \\  Re-spawn self as detached',
      '         --log-file <path>                      background process, print PID',
      '                                            to stdout, exit. The grandchild',
      '                                            becomes the actual daemon.',
      '  pi-manager bridge --socket <path>             Pipe stdin/stdout to/from the',
      '                                            session unix socket (replaces',
      '                                            `nc -U` for hosts without nc).',
      '  pi-manager --version                          Print version info as JSON',
      '  pi-manager --help                             Print this message',
      '',
      `Manager version: ${MANAGER_VERSION}`,
      `Protocol version: ${PROTOCOL_VERSION}`,
    ].join('\n'),
  );
}

/**
 * Self-detach: re-spawn this process as a detached grandchild, then exit.
 * The grandchild is reparented to init/launchd and survives the parent ssh
 * session's termination — libuv handles unix setsid / Windows DETACHED_PROCESS
 * internally, avoiding shell-side `setsid`/`nohup` tricks.
 */
function selfDetachAndExit(socketPath: string, logFile: string): void {
  // log fd 显式 0o600(默认 umask 022 会给 0644 世界可读, log 含 sessionId —
  // 深挖轮 5 M-2)。
  const logFd = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [process.argv[1], 'daemon', '--socket', socketPath, '--inner'],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    },
  );
  child.unref();
  fs.closeSync(logFd);
  if (!child.pid) {
    process.stderr.write('[pi-mgr] selfDetachAndExit: spawn returned no PID — grandchild failed to start\n');
    process.exit(1);
  }
  // Print PID then exit only after flush (SSH pipe stdout is async — exiting
  // before flush drops the line, caller writes empty pidfile, double-daemon).
  process.stdout.write(`${child.pid}\n`, () => {
    process.exit(0);
  });
}

export function printVersion(): void {
  process.stdout.write(
    JSON.stringify({
      managerVersion: MANAGER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    }) + '\n',
  );
}

/**
 * bridge: pipe this process's stdin/stdout to a session unix socket. This is
 * how the desktop reaches pi's stdio through SSH execStream — no nc dependency.
 * stdin EOF half-closes the socket, waiting for the daemon to flush the last
 * frame before exit.
 */
function runBridge(sockPath: string): void {
  const sock = net.createConnection(sockPath);
  // 连接超时:session socket 不存在(ensure 与 bridge 之间被 kill)时挂死
  // 不可接受 —— 10s 后退出, 由上层 handshake timeout 兜底(自审轮 6 L-2)。
  const connectTimer = setTimeout(() => {
    console.error(`[pi-mgr] bridge connect timed out: ${sockPath}`);
    sock.destroy();
    process.exit(1);
  }, 10_000);
  sock.on('connect', () => {
    clearTimeout(connectTimer);
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });
  sock.on('error', (err) => {
    // 与 connect 分支一致的 timer 清理(轮 4 LOW #5 —— 进程虽退出, 风格一致性)。
    clearTimeout(connectTimer);
    console.error(`[pi-mgr] bridge error: ${err.message}`);
    process.exit(1);
  });
  process.stdin.on('end', () => {
    sock.end();
  });
  sock.on('close', () => {
    flushAndExit();
  });
}

/** Flush stdout before exit so the final NDJSON frame is not dropped. */
function flushAndExit(code = 0): void {
  process.stdout.write('', () => {
    process.exit(code);
  });
}

function installCrashGuards(): void {
  // 轮 24-I4 MEDIUM:记录结构化 crash 现场(name + message + scrub 过的 stack
  // 前 N 行)—— 只有 message 无法定位异常来自哪条代码路径(多路径同 message
  // 时排障只能复现)。stack 过 scrubCredentialText 防凭证泄漏, 限行数/长度。
  const crashDetail = (err: unknown): string => {
    const e = err instanceof Error ? err : new Error(String(err));
    const stack = e.stack
      ? e.stack.split('\n').slice(0, 8).join('\n')
      : '(no stack)';
    return scrubCredentialText(`${e.name}: ${e.message}\n${stack}`).slice(0, 2000);
  };
  process.on('uncaughtException', (err) => {
    console.error('[pi-mgr] uncaughtException (daemon stays alive):', crashDetail(err));
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[pi-mgr] unhandledRejection (daemon stays alive):', crashDetail(reason));
  });
}

/**
 * 剥离远端 SSH 环境里可能残留的凭证键 —— daemon 继承 SSH shell env,
 * spawn pi 时 `{ ...process.env }` 会把它们传下去。cc-manager 有同款
 * stripSensitiveAnthropicEnv; pi 用 CINDY_PI_* + 通用凭证键(自审轮 5 HIGH-1)。
 */
const SENSITIVE_ENV_KEY_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_CODE_',
  'CINDY_PI_',
  'OPENAI_',
  'CODEX_',
  'GOOGLE_',
  'GEMINI_',
  'AZURE_',
  'MISTRAL_',
  'DEEPSEEK_',
  'REPLICATE_',
  'GROQ_',
  'TOGETHER_',
  'COHERE_',
  'AWS_',
  // 轮 11 LOW-5:常见 provider 前缀扩展(后缀/等值匹配兜底大部分, 这里补齐
  // 命名不合常规的键如 BRAVE_KEY)。
  'GITHUB_',
  'GITLAB_',
  'HF_',
  'TAVILY_',
  'BRAVE_',
  'XAI_',
  'OPENROUTER_',
  'PERPLEXITY_',
  'VOYAGE_',
  // 轮 30 LOW:补齐常见 provider 前缀(轮 11 补充后的剩余盲区)。
  'ANYSCALE_',
  'FIREWORKS_',
  'NVIDIA_',
] as const;

/** 通用凭证键后缀:任何以这些结尾的 env 键都可能是凭证(深挖轮 5 L-3)。 */
const SENSITIVE_ENV_KEY_SUFFIXES = [
  '_API_KEY',
  '_SECRET',
  '_TOKEN',
  '_AUTH',
  '_PASSWORD',
  '_PASSWD',
] as const;

/** 裸键名等值匹配:无前缀下划线的凭证键(轮 4 MEDIUM #7 —— 之前漏过 API_KEY/TOKEN)。 */
const SENSITIVE_ENV_KEY_EXACT = new Set<string>([
  'API_KEY',
  'SECRET',
  'TOKEN',
  'AUTH',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'ACCESS_TOKEN',
  'AUTH_TOKEN',
  'API_TOKEN',
]);

export function stripSensitiveEnv(): string[] {
  const stripped: string[] = [];
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    if (
      SENSITIVE_ENV_KEY_PREFIXES.some((p) => upper.startsWith(p))
      || SENSITIVE_ENV_KEY_SUFFIXES.some((s) => upper.endsWith(s))
      || SENSITIVE_ENV_KEY_EXACT.has(upper)
    ) {
      delete process.env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

async function runDaemon(
  socketPath: string,
  registryBase: string,
  idleTimeoutSeconds?: number,
): Promise<void> {
  installCrashGuards();
  // daemon 化后脱离 SSH 会话 CWD(轮 4 LOW #3):防持有临时挂载点引用
  // (如 /tmp/ssh-xxx 独立挂载, 阻止 umount)。失败(如 Windows)忽略。
  try { process.chdir('/'); } catch { /* non-posix, ignore */ }
  const stripped = stripSensitiveEnv();
  if (stripped.length > 0) {
    console.error('[pi-mgr] stripped sensitive env keys at boot:', stripped.join(', '));
  }

  const daemonDir = registryBase;
  const sockDir = path.join(daemonDir, 'socks');
  const envDir = path.join(daemonDir, 'env');
  const server = new ManagerServer({
    socketPath,
    managerVersion: MANAGER_VERSION,
  });
  const registry = new PiSessionRegistry({
    sockDir,
    envDir,
    // 空闲回收超时可配置(秒):默认 1800s, 缩短便于真机验证(自审轮 10 B-1)。
    ...(idleTimeoutSeconds !== undefined
      ? { idleTimeoutMs: idleTimeoutSeconds * 1000 }
      : {}),
    onSessionClosed: (sessionId, reason, detail) => {
      // Broadcast to all connected clients.
      const notification = {
        type: 'notification',
        method: NOTIFICATIONS.SESSION_CLOSED,
        params: { sessionId, reason, ...(detail !== undefined ? { detail } : {}) },
      } as const;
      server.notifyAll(notification);
    },
  });

  server.setHandler(METHODS.PI_ENSURE, async (params) => {
    const p = (params ?? {}) as Partial<PiEnsureParams>;
    if (typeof p.sessionId !== 'string' || typeof p.cmd !== 'string' || typeof p.envHash !== 'string'
      || typeof p.env !== 'object' || p.env === null) {
      throw makeError('INVALID_PARAMS', 'pi/ensure requires sessionId, cmd, env, envHash');
    }
    const result = await registry.ensure(
      p.sessionId,
      p.cmd,
      p.env as Record<string, string>,
      p.envHash,
      p.restart === true,
    );
    return result satisfies PiEnsureResult;
  });

  server.setHandler(METHODS.PI_KILL, async (params) => {
    const p = (params ?? {}) as Partial<PiKillParams>;
    if (typeof p.sessionId !== 'string') {
      throw makeError('INVALID_PARAMS', 'pi/kill requires sessionId');
    }
    await registry.kill(p.sessionId);
    return {};
  });

  server.setHandler(METHODS.PI_LIST, async () => {
    const result: PiListResult = { sessions: registry.list() };
    return result;
  });

  server.setHandler(METHODS.PI_SHUTDOWN, async () => {
    // 立即置 shuttingDown(同步段, 响应发出前):50ms 窗口内的新 ensure 会被
    // 拒绝, 不会出现「响应 success 后 daemon 还在 spawn 新 pi」(自审轮 6 H-2)。
    registry.beginShutdown();
    // Fire-and-forget: respond first, then shutdown in background.
    // 轮 40-w4-t3 CRITICAL:shutdownAll 可能抛 SESSION_KILL_SURVIVED(杀不死的
    // 进程已保留 entry 不 teardown)—— 后台路径必须 catch + log + 非零退出,
    // 否则「先 ACK 成功再静默残留」, 上层以为已关闭但进程仍持凭证存活。
    setTimeout(() => {
      void (async () => {
        try {
          await registry.shutdownAll('killed');
        } catch (err) {
          console.error(
            '[pi-mgr] pi/shutdown: sessions survived SIGKILL — refusing clean exit; credentials may leak',
            err instanceof Error ? err.message : String(err),
          );
          process.exit(1);
          return;
        }
        registry.close();
        await server.stop();
        process.exit(0);
      })();
    }, 50);
    return {};
  });

  // pidfile 由 spawn wrapper 写入, daemon 退出时清理(自审轮 4 M-2 —— 否则
  // 残留 stale pid, 虽被 socket 检查兜底但状态不干净)。
  const pidFile = path.join(daemonDir, 'pi-manager.pid');
  // 双信号守卫:SIGINT+SIGTERM 并发只跑一次 shutdown(深挖轮 5 L-5)。
  let shutdownStarted = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      await registry.shutdownAll('killed');
      registry.close();
      await server.stop();
      try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
      process.exit(0);
    } catch (err) {
      // shutdownAll 意外 throw(罕见)不得挂半关停态 —— socket 仍听但数据
      // 不一致比退出更糟, 记日志后强退(轮 4 MEDIUM #2)。
      console.error('[pi-mgr] shutdown failed, forcing exit:', String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // SIGHUP/SIGQUIT 同样走优雅关停(轮 4 MEDIUM #1):管理员 kill -HUP 或
  // -QUIT 时若直接终止, 所有 pi 子进程成孤儿 + pidfile/env-file 残留。
  process.on('SIGHUP', () => void shutdown());
  process.on('SIGQUIT', () => void shutdown());

  await server.start();
  console.error(`[pi-mgr] daemon ready (version ${MANAGER_VERSION}, protocol ${PROTOCOL_VERSION})`);
  // Keep the process alive — server keeps the event loop busy via the socket.
}

function makeError(code: 'INVALID_PARAMS', message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case 'help':
      printHelp();
      process.exit(0);
      break;
    case 'version':
      printVersion();
      process.exit(0);
      break;
    case 'bridge':
      runBridge(args.bridgeSock!);
      break;
    case 'daemon': {
      if (args.detach && !args.inner) {
        selfDetachAndExit(args.socket!, args.logFile!);
        return;
      }
      // Daemon state dir: alongside the manager socket (<socket dir>/..).
      // The remote layout is $HOME/.xdt-server/v1/pi-manager/ with the
      // manager socket at <dir>/pi-manager.sock — socks/env live under it.
      const registryBase = args.socket ? path.dirname(args.socket) : '.';
      await runDaemon(args.socket!, registryBase, args.idleTimeoutSeconds);
      break;
    }
  }
}

// 仅作为 CLI 入口执行时运行 main()(轮 17 H-1:导出纯函数供单测后, import
// 不应触发 main —— 用 ESM 入口检测而非裸调用)。
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
