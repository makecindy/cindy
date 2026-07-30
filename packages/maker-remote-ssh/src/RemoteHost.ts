/**
 * RemoteHost — one SSH connection to one remote machine.
 *
 * State machine:
 *   disconnected → connecting → authenticating → ready
 *                                                  ↓
 *                          (socket loss / keepalive timeout)
 *                                                  ↓
 *                     reconnecting (exp backoff, capped) → ready | failed
 *
 * Phase A: lifecycle (connect/disconnect/keepalive/reconnect).
 * Phase B: exec / execStream channels for one-shot commands and
 *          streaming spawns (Claude/Codex on remote, bootstrap.sh).
 *
 * NOT YET (Phase C): shell PTY tab, sftp, session ingest.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Client, type ConnectConfig, type ClientChannel, type TcpConnectionDetails } from 'ssh2';

import type { HostConfig, HostSnapshot, RemoteStatus } from './types.js';
import { resolveAuth } from './credentials.js';
import { type HostKeyStore, hostKeyFingerprint, hostKeyId, decideHostKey } from './hostKeys.js';

export interface RemoteHostDeps {
  logger: {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
  /**
   * Persisted trusted host-key fingerprints (TOFU). When omitted, connects
   * fail closed — we refuse rather than silently trust an unverified key.
   * ConnectionPool injects one built from its `knownHostsPath`.
   */
  hostKeys?: HostKeyStore;
}

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const KEEPALIVE_COUNT_MAX = 3;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1_000;

export type StatusListener = (snapshot: HostSnapshot) => void;

export interface ExecOpts {
  /** stdin payload; channel is `end()`-ed after the write. */
  /** Stdin payload — string for text scripts, Buffer for binary bundles (e.g. cc-manager .mjs upload). */
  input?: string | Buffer;
  /** kill the channel after this many ms. Default 60_000. */
  timeoutMs?: number;
  /** environment vars sent to remote (subject to sshd `AcceptEnv`). */
  env?: Record<string, string>;
  /**
   * Caller-controlled label used in timeout / error messages — the raw
   * `cmd` is deliberately NEVER echoed (cmd may carry secrets via inline
   * env vars or wrapper scripts). Falls back to literal `"exec"`.
   */
  label?: string;
  /**
   * Per-stream byte cap enforced **while reading the channel** — the moment
   * stdout or stderr crosses the cap, buffering stops and the remote command
   * is torn down (TERM + close), resolving with `truncated: true`. Without
   * this, an arbitrary command (`cat` on a multi-GB log, `yes`) accumulates
   * unbounded strings in the Electron main process until timeout. Callers
   * running untrusted / model-authored commands (cindy_ssh MCP) MUST set it.
   * Default: unlimited (legacy behavior for short trusted probes).
   */
  maxOutputBytes?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  /** true when `maxOutputBytes` kicked in — output is partial and the command was torn down early. */
  truncated?: boolean;
}

export interface ExecStreamOpts {
  pty?: boolean;
  env?: Record<string, string>;
}

// ── Remote TCP forwarding (OpenSSH `ssh -R` 等价物) ─────────────────────────
//
// 用途: 让远端进程 (codex daemon / claude CLI) 把 HTTPS_PROXY 指向远端
// 127.0.0.1 上的一个端口, 该端口的连接经**同一条 SSH 连接**的多路复用通道
// 转回本机, 再 pipe 到用户自己的本地 Proxy (如 127.0.0.1:7890)。Cindy 不提供
// Proxy, 只提供这条隧道。
//
// 为什么复用同一条 ssh2 Client 而不起第二条连接: SSH 协议按 channel id 解
// 复用, forwardIn 的 tcp-forward channel 与 exec channel 在同一条连接上互
// 不干扰 —— 消息不会"打乱"。多路复用是 SSH 的原生能力。
//
// 端口策略: 用**固定首选端口**而不是 port 0, 这样断线重连后隧道口不变,
// 远端 daemon env (HTTPS_PROXY=http://127.0.0.1:<port>) 不用跟着重写。
// 首选端口被占用时向后探测少量候选; 真换端口时通过 onRearmed 通知上层
// (上层在下次 session start 时重写远端 env marker 并重启 daemon, 自愈)。

/** 首选远端绑定端口基数; 被占用时向后探测 PORT_SCAN_SPAN 个候选。 */
export const DEFAULT_REMOTE_FORWARD_PORT_BASE = 17893;
const REMOTE_FORWARD_PORT_SCAN_SPAN = 8;

export interface RemoteForwardSpec {
  /** 本机 (运行 Cindy 的机器) 转发目标 — 用户本地 Proxy 的监听地址。 */
  localHost: string;
  localPort: number;
  /** 远端 127.0.0.1 首选绑定端口; 缺省 DEFAULT_REMOTE_FORWARD_PORT_BASE。 */
  preferredRemotePort?: number;
  /** 断线重连后端口被重绑到不同值时回调一次 (首次绑定不回调)。 */
  onRearmed?: (remotePort: number) => void;
}

export interface RemoteForward {
  /** 当前实际绑定的远端端口 (重连后可能变化)。 */
  readonly remotePort: number;
  /** 停止转发并释放登记。幂等。 */
  close(): Promise<void>;
}

interface ForwardRecord {
  spec: RemoteForwardSpec;
  remotePort: number;
  /** forwardIn 已在当前 live client 上注册成功。 */
  armed: boolean;
  /** 进行中的 arm, 去重 ensureRemoteForward 与 rearmForwards 的并发竞争。 */
  arming?: Promise<void>;
  /** 本地 Proxy 连接失败的节流日志状态。 */
  lastLocalErrorAt: number;
  localErrorCount: number;
  /** 上次实际打日志时的 localErrorCount — suppressedCount 报「距上次日志被吞掉
   *  几条」而不是单调总计数 (review: PR #715 copilot R3)。 */
  lastLocalErrorLoggedCount: number;
}

/**
 * arm 在飞期间连接被换 (断线/重连), forwardIn 的迟到成功落在旧 client 上。
 * armForward 以此错误收尾; ensureRemoteForward / rearmForwards 识别后立即
 * 在当前连接重试一次, 而不是把隧道误标 active 或等下次 reconnect。
 */
class StaleForwardArmError extends Error {}

function forwardKey(spec: Pick<RemoteForwardSpec, 'localHost' | 'localPort'>): string {
  return `${spec.localHost}:${spec.localPort}`;
}

export interface ExecStreamHandle {
  write(data: string | Buffer): void;
  end(data?: string | Buffer): void;
  /** UTF-8 解码后的文本流; 二进制 transport (codex app-server proxy 的 WS frame)
   *  必须改用 `onStdoutBytes`, 否则 toString 会破坏字节。 */
  onStdout(cb: (chunk: string) => void): () => void;
  /** 原始字节流; 用于在 ssh channel 上跑二进制协议 (e.g. WebSocket frames). */
  onStdoutBytes(cb: (chunk: Buffer) => void): () => void;
  onStderr(cb: (chunk: string) => void): () => void;
  onClose(cb: (info: { code: number | null; signal: string | null }) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
  /**
   * Try to terminate the remote process. ssh2's `channel.signal()` is
   * subject to OpenSSH server config (`AcceptEnv` / `PermitSignal`); many
   * servers reject it silently. As a fallback we also close the channel,
   * which sends SIGHUP via SSH session teardown.
   */
  kill(signal?: string): void;
}

/**
 * Heuristic — does this ssh2 error message indicate an auth failure
 * (as opposed to network / DNS / handshake)? Auth failures are
 * deterministic: retrying with the same credentials will produce the same
 * outcome, so we use this to short-circuit the auto-reconnect loop AND
 * to swap in an actionable "fix your auth" message in place of the
 * opaque "All configured authentication methods failed".
 *
 * Match list comes from ssh2 source + observed messages from common
 * sshd implementations. False positives here just suppress retries
 * (acceptable); false negatives let the loop spin (already capped at 5).
 */
export function isAuthFailure(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('all configured authentication') ||
    lower.includes('authentication failed') ||
    lower.includes('auth failed') ||
    lower.includes('permission denied') ||
    lower.includes('no matching authentication') ||
    // authFailureHint() 的改写产物也必须被识别:connect() 失败时 lastError /
    // reject message 已被换成友好文案,后续判定(reconnect 跳过、IPC 分类、
    // cindy_ssh 错误码)都跑在改写后的字符串上。不识别会把确定性的认证失败
    // 降级成"可重试的连接失败"。与 authFailureHint 的三种文案一一对应,
    // 改 hint 措辞时必须同步这里(有 invariant 单测拦截)。
    lower.includes('has no key the remote accepts') ||
    lower.includes('was rejected by the remote')
  );
}

/**
 * Build a one-line user-facing message for an auth failure. Subtitle in
 * the host row + toast both show this verbatim — keep it under ~120 chars
 * so it doesn't ellipsize. CLI command text stays English (shell commands
 * are English) but a future improvement could split this into structured
 * fields for full i18n.
 */
export function authFailureHint(cfg: HostConfig): string {
  const portArg = cfg.port && cfg.port !== 22 ? `-p ${cfg.port} ` : '';
  if (cfg.authMethod === 'agent') {
    return `SSH agent has no key the remote accepts. Run \`ssh-copy-id ${portArg}${cfg.user}@${cfg.hostname}\` from your terminal to install your pubkey, or re-add this host with "Identity file" auth.`;
  }
  if (cfg.authMethod === 'key') {
    const file = cfg.identityFile ?? '(unset)';
    return `Identity file ${file} was rejected by the remote. Verify the file is the right key for ${cfg.user}@${cfg.hostname}, or run \`ssh-copy-id ${portArg}-i ${file}.pub ${cfg.user}@${cfg.hostname}\` to install it.`;
  }
  return `Authentication failed connecting as ${cfg.user}@${cfg.hostname}.`;
}

function wrapChannel(channel: ClientChannel): ExecStreamHandle {
  const stdoutListeners = new Set<(s: string) => void>();
  const stdoutBytesListeners = new Set<(b: Buffer) => void>();
  const stderrListeners = new Set<(s: string) => void>();
  const closeListeners = new Set<(i: { code: number | null; signal: string | null }) => void>();
  const errorListeners = new Set<(e: Error) => void>();

  channel.on('data', (chunk: Buffer) => {
    // Bytes 路径优先 (二进制协议如 WS frame), 然后 text 路径 — 同一 chunk 可能两边
    // 都有 listener (虽然实际不该混用)。
    if (stdoutBytesListeners.size > 0) {
      for (const cb of stdoutBytesListeners) cb(chunk);
    }
    if (stdoutListeners.size > 0) {
      const s = chunk.toString('utf8');
      for (const cb of stdoutListeners) cb(s);
    }
  });
  channel.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    for (const cb of stderrListeners) cb(s);
  });
  channel.on('close', (code: number | null, signal: string | null) => {
    for (const cb of closeListeners) cb({ code, signal });
  });
  channel.on('error', (err: Error) => {
    for (const cb of errorListeners) cb(err);
  });

  return {
    write: (data) => { channel.write(data); },
    end: (data) => { if (data != null) channel.end(data); else channel.end(); },
    onStdout: (cb) => { stdoutListeners.add(cb); return () => { stdoutListeners.delete(cb); }; },
    onStdoutBytes: (cb) => { stdoutBytesListeners.add(cb); return () => { stdoutBytesListeners.delete(cb); }; },
    onStderr: (cb) => { stderrListeners.add(cb); return () => { stderrListeners.delete(cb); }; },
    onClose: (cb) => { closeListeners.add(cb); return () => { closeListeners.delete(cb); }; },
    onError: (cb) => { errorListeners.add(cb); return () => { errorListeners.delete(cb); }; },
    kill: (signal = 'TERM') => {
      try { channel.signal(signal); } catch { /* server may reject */ }
      try { channel.close(); } catch { /* already gone */ }
    },
  };
}

export class RemoteHost {
  readonly id: string;
  private cfg: HostConfig;
  private status: RemoteStatus = 'disconnected';
  private lastError: string | undefined;
  /**
   * Human-readable label for the credential that succeeded on the most
   * recent successful connect, e.g. "ssh-agent" or "key:id_ed25519".
   * Surfaced to the UI so the user can verify *which* key actually got
   * them in — important when an identityFile is set but agent fallback
   * means the named key isn't actually being used (or vice versa).
   */
  private lastAuthLabel: string | undefined;
  private statusChangedAt = Date.now();
  private client: Client | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** true = user explicitly asked to disconnect; suppress auto-reconnect. */
  private userDisconnected = false;
  private events = new EventEmitter();
  private readonly log: RemoteHostDeps['logger'];
  private readonly hostKeys?: HostKeyStore;
  /**
   * Set by the host-key verifier when it rejects a connect, so onError can
   * surface an actionable message instead of ssh2's opaque handshake error.
   * Reset at the start of every connect attempt.
   */
  private hostKeyError: string | null = null;
  /**
   * 已登记的 remote forwarding 愿望清单 (key = localHost:localPort)。
   * 连接断开不清空 — 重连成功后 doConnect 会逐个 re-arm, 尽量绑回原端口。
   */
  private forwards = new Map<string, ForwardRecord>();
  /** 'tcp connection' 是按 client 实例挂的, 每次 doConnect 新建 client 都要重挂。 */
  private forwardListenerClient: Client | null = null;

  constructor(config: HostConfig, deps: RemoteHostDeps) {
    this.id = config.id;
    this.cfg = config;
    this.log = deps.logger;
    this.hostKeys = deps.hostKeys;
  }

  get config(): HostConfig {
    return this.cfg;
  }

  getStatus(): RemoteStatus {
    return this.status;
  }

  /**
   * Replace config (e.g. user edited hostname/port). Caller is responsible
   * for reconnecting — we don't auto-bounce because the caller might have
   * already disconnected first, and bouncing here would re-trigger auth.
   *
   * Emits a `status` event with the new snapshot so renderer's host-list
   * mirror updates without a separate IPC round-trip.
   */
  updateConfig(next: HostConfig): void {
    if (next.id !== this.cfg.id) {
      throw new Error(`RemoteHost.updateConfig: id mismatch (${next.id} != ${this.cfg.id})`);
    }
    this.cfg = next;
    this.events.emit('status', this.snapshot());
  }

  snapshot(): HostSnapshot {
    return {
      config: this.cfg,
      status: this.status,
      lastError: this.lastError,
      lastAuthLabel: this.lastAuthLabel,
      statusChangedAt: this.statusChangedAt,
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.events.on('status', listener);
    return () => this.events.off('status', listener);
  }

  /**
   * Open the connection. Idempotent — if already ready/connecting, returns
   * the in-flight promise. Throws on definitive failure (auth, network).
   */
  async connect(): Promise<void> {
    if (this.status === 'ready') return;
    if (this.status === 'connecting' || this.status === 'authenticating') {
      // Wait for the in-flight attempt to settle (success or fail). After
      // the await `this.status` is mutated; TS still has the pre-await
      // narrowing, so we re-read through `getStatus()`.
      await this.waitForTerminal();
      if (this.getStatus() === 'ready') return;
      throw new Error(this.lastError ?? 'connect failed');
    }

    // 'reconnecting' / 'disconnected' / 'failed' 都走立即新建连接路径。
    // 关键: 'reconnecting' 状态下 reconnectTimer 仍在跑, 它稍后还会再调一次
    // doConnect() 覆盖我们刚建好的 SSH client, 产生泄漏的旧连接 + 乱序的
    // status/channel 事件。必须在 doConnect() 前显式清掉 timer 才安全。
    this.clearReconnectTimer();
    this.userDisconnected = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  /**
   * Close the connection. Idempotent. Suppresses auto-reconnect until
   * next explicit `connect()` call.
   */
  async disconnect(): Promise<void> {
    this.userDisconnected = true;
    this.clearReconnectTimer();
    this.markForwardsDisarmed();
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // swallow — `end` on a half-dead client occasionally throws
      }
      this.client = null;
    }
    this.setStatus('disconnected');
  }

  // ── channels (Phase B) ──────────────────────────────────────────────────

  /**
   * Run a one-shot command and collect stdout/stderr/exit. Use for short,
   * non-interactive commands (version probes, install scripts).
   *
   * `input`, when set, is written to stdin then the channel is closed.
   * `timeoutMs` defaults to 60 s — long enough for `npm install`. Caller
   * should raise it for known-slow ops (e.g. agent install on a clean box).
   *
   * Error messages NEVER include the cmd string — callers routinely pass
   * commands containing secrets (e.g. `ANTHROPIC_API_KEY=...` env injection
   * via wrapper scripts). Leaking cmd into an error would land it in
   * xdt-maker logs via the unified IPC error path. Use `label` for caller-
   * controlled context in error messages.
   */
  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const client = this.requireReady();
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const label = opts?.label ?? 'exec';

    return await new Promise<ExecResult>((resolve, reject) => {
      client.exec(cmd, { env: opts?.env }, (err, channel) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';
        let exitCode: number | null = null;
        let signal: string | null = null;
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { channel.signal('TERM'); } catch { /* server may reject SIGTERM */ }
          try { channel.close(); } catch { /* already gone */ }
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        // maxOutputBytes:边读边计数,越界即停止缓冲并 teardown 远端命令,
        // 防止任意命令把无上限输出攒进 main 进程内存。teardown 后照常等
        // 'close' 事件 resolve(truncated 标记),与超时路径共用 TERM+close
        // 兜底(channel.signal 可能被 sshd 静默拒绝,close 触发 SIGHUP)。
        const maxOutputBytes = opts?.maxOutputBytes;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;
        const teardownOnCap = (): void => {
          if (truncated) return;
          truncated = true;
          try { channel.signal('TERM'); } catch { /* server may reject SIGTERM */ }
          try { channel.close(); } catch { /* already gone */ }
        };
        const takeCapped = (chunk: Buffer, usedBytes: number): Buffer | null => {
          if (maxOutputBytes == null) return chunk;
          if (usedBytes >= maxOutputBytes) { teardownOnCap(); return null; }
          if (usedBytes + chunk.length <= maxOutputBytes) return chunk;
          teardownOnCap();
          return chunk.subarray(0, maxOutputBytes - usedBytes);
        };

        channel.on('data', (chunk: Buffer) => {
          const kept = takeCapped(chunk, stdoutBytes);
          if (!kept) return;
          stdoutBytes += kept.length;
          stdout += kept.toString('utf8');
        });
        channel.stderr.on('data', (chunk: Buffer) => {
          const kept = takeCapped(chunk, stderrBytes);
          if (!kept) return;
          stderrBytes += kept.length;
          stderr += kept.toString('utf8');
        });
        channel.on('close', (code: number | null, sig: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          exitCode = code;
          signal = sig;
          resolve({ stdout, stderr, exitCode, signal, ...(truncated ? { truncated: true } : {}) });
        });
        channel.on('error', (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        });

        if (opts?.input != null) {
          channel.write(opts.input);
          channel.end();
        }
      });
    });
  }

  /**
   * Open a streaming exec channel. Caller drives stdin (for interactive
   * tools like Claude Code's `--input-format stream-json`) and consumes
   * stdout / stderr via callbacks. Lifecycle ends on `close` or `kill()`.
   *
   * No timeout — caller owns lifetime. Streams stay open across long
   * agent sessions.
   */
  async execStream(cmd: string, opts?: ExecStreamOpts): Promise<ExecStreamHandle> {
    const client = this.requireReady();
    return await new Promise<ExecStreamHandle>((resolve, reject) => {
      const execOpts: { pty?: boolean | object; env?: Record<string, string> } = {};
      if (opts?.pty) execOpts.pty = true;
      if (opts?.env) execOpts.env = opts.env;

      client.exec(cmd, execOpts, (err, channel) => {
        if (err) return reject(err);
        resolve(wrapChannel(channel));
      });
    });
  }

  // ── remote TCP forwarding (ssh -R) ────────────────────────────────────────

  /**
   * 登记并 (若已连接) 立即建立一条 remote forwarding: 远端 127.0.0.1:<port>
   * 进来的 TCP 连接经本 SSH 连接转回, pipe 到本机 spec.localHost:localPort。
   *
   * 幂等: 同 (localHost, localPort) 重复调用返回同一条 forward。
   * 未连接时只登记愿望, 下次 connect 成功后自动 arm (doConnect → rearmForwards)。
   *
   * 安全约束: 远端只绑 127.0.0.1 — 隧道口仅远端本机进程可达, 不对远端所在
   * 网络暴露 (即不要 GatewayPorts 语义)。本地目标由调用方 (用户 pref) 显式
   * 指定, 通常是 127.0.0.1 上的 Proxy 端口。
   */
  async ensureRemoteForward(spec: RemoteForwardSpec): Promise<RemoteForward> {
    // 引号与空白同样拒 (与 desktop IPC / prefs-store 校验对齐, review:
    // PR #715 copilot R8): localHost 是 net.connect 的目的地, 含引号的值
    // 会晚到 connect 时才以难懂的错误失败, 入口直接给清晰校验错误。
    if (
      !spec.localHost ||
      /\s/.test(spec.localHost) ||
      spec.localHost.includes("'") ||
      spec.localHost.includes('"')
    ) {
      throw new Error(`ensureRemoteForward: invalid localHost "${spec.localHost}"`);
    }
    if (!Number.isInteger(spec.localPort) || spec.localPort < 1 || spec.localPort > 65535) {
      throw new Error(`ensureRemoteForward: invalid localPort ${spec.localPort}`);
    }
    // preferredRemotePort 同样入口校验 (review: PR #715 copilot R7): 0 会静默
    // 变成「远端绑 ephemeral 端口」语义, 越界值则晚到 arm 才失败, 都难排查。
    if (
      spec.preferredRemotePort !== undefined &&
      (!Number.isInteger(spec.preferredRemotePort) ||
        spec.preferredRemotePort < 1 ||
        spec.preferredRemotePort > 65535)
    ) {
      throw new Error(`ensureRemoteForward: invalid preferredRemotePort ${spec.preferredRemotePort}`);
    }
    const key = forwardKey(spec);
    const existing = this.forwards.get(key);
    if (existing) {
      // 已登记但未 arm (连接刚建好 / 上次 arm 失败) — 趁 ready 补一次。
      if (!existing.armed && this.status === 'ready') {
        await this.armWithStaleRetry(existing);
      }
      return this.forwardHandle(key, existing);
    }

    const record: ForwardRecord = {
      spec,
      remotePort: spec.preferredRemotePort ?? DEFAULT_REMOTE_FORWARD_PORT_BASE,
      armed: false,
      lastLocalErrorAt: 0,
      localErrorCount: 0,
      lastLocalErrorLoggedCount: 0,
    };
    this.forwards.set(key, record);
    if (this.status === 'ready') {
      await this.armWithStaleRetry(record);
    }
    return this.forwardHandle(key, record);
  }

  /**
   * arm + 旧连接迟到回调的一次即时重试 (见 StaleForwardArmError)。
   * 其余错误原样抛出给调用方 (session 路径 fail-closed / ready-hook 记状态)。
   */
  private async armWithStaleRetry(record: ForwardRecord): Promise<void> {
    try {
      await this.armForwardDeduped(record);
    } catch (err) {
      if (err instanceof StaleForwardArmError && this.status === 'ready') {
        await this.armForwardDeduped(record);
        return;
      }
      throw err;
    }
  }

  /**
   * 当前登记的 forward 列表 (诊断 / snapshot 用)。armed=false 表示愿望已
   * 登记但当前没在转发 (未连接 / arm 失败待重连)。
   */
  listRemoteForwards(): Array<{ localHost: string; localPort: number; remotePort: number; armed: boolean }> {
    return Array.from(this.forwards.values()).map((r) => ({
      localHost: r.spec.localHost,
      localPort: r.spec.localPort,
      remotePort: r.remotePort,
      armed: r.armed,
    }));
  }

  /**
   * 关闭指定本地目标的单条 forward (无该登记时 no-op)。与 closeAll 不同
   * 不会在 ensure 语义下误触发 arm — 用于「目标变了, 先拆旧的」
   * (review: PR #715 R5: pref 的 localHost/localPort 被编辑后, 旧目标的
   * forward 会残留并随重连 re-arm, 远端多暴露一个隧道口)。
   */
  async closeRemoteForward(localHost: string, localPort: number): Promise<void> {
    const key = `${localHost}:${localPort}`;
    const record = this.forwards.get(key);
    if (!record) return;
    await this.forwardHandle(key, record).close();
  }

  /** 关闭并清除所有已登记 forward (pref 关闭路径)。连接断开时是纯本地清理。 */
  async closeAllRemoteForwards(): Promise<void> {
    const keys = Array.from(this.forwards.keys());
    for (const key of keys) {
      const record = this.forwards.get(key);
      if (!record) continue;
      await this.forwardHandle(key, record).close();
    }
  }

  private forwardHandle(key: string, record: ForwardRecord): RemoteForward {
    return {
      get remotePort() {
        return record.remotePort;
      },
      close: async () => {
        if (!this.forwards.delete(key)) return;
        record.armed = false;
        // 连接活着就显式 unforward; 断线时服务端侧随连接消失, 无需操作。
        if (this.status === 'ready' && this.client) {
          // 与 forwardIn 对称的看门狗 (review: PR #715 五轮审核 P2): 半开连接
          // 上 ssh2 global request 回调可能丢失, 裸 await 会把 Settings 的
          // 关闭 proxy / 更新 host 流程永久挂住。超时后照常返回 — record 已
          // 摘除, 服务端残留随连接死亡消失。
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              this.log.warn('unforwardIn timed out — proceeding (server remnant dies with connection)', {
                id: this.id,
                port: record.remotePort,
              });
              resolve();
            }, 5_000);
            timer.unref?.();
            try {
              this.client!.unforwardIn('127.0.0.1', record.remotePort, () => {
                clearTimeout(timer);
                resolve();
              });
            } catch {
              clearTimeout(timer);
              resolve();
            }
          });
        }
      },
    };
  }

  /**
   * 在当前 client 上注册 forwardIn。端口冲突 / sshd 拒绝时按候选序列重试,
   * 全部失败抛错 (调用方决定是登记愿望待重试还是直接失败)。
   *
   * 候选顺序: 先试上次实际绑定的端口 (record.remotePort) — 重连后隧道口
   * 尽量不变, 远端进程 env (HTTPS_PROXY=http://127.0.0.1:<port>) 不用跟着
   * 重写; 再按首选基数顺延。每次 forwardIn 带 10s 看门狗: 连接在请求在飞
   * 时断开的话, ssh2 对 outstanding global request 的回调不保证触发,
   * 裸 await 会永久挂起。
   */
  private async armForward(record: ForwardRecord): Promise<void> {
    const client = this.requireReady();
    this.attachForwardListener(client);

    const base = record.spec.preferredRemotePort ?? DEFAULT_REMOTE_FORWARD_PORT_BASE;
    const candidates = [record.remotePort];
    for (let i = 0; i < REMOTE_FORWARD_PORT_SCAN_SPAN; i++) {
      if (!candidates.includes(base + i)) candidates.push(base + i);
    }
    const errors: string[] = [];
    for (const port of candidates) {
      const bound = await new Promise<number | null>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          errors.push(`${port}: forwardIn timed out after 10s`);
          resolve(null);
        }, 10_000);
        timer.unref?.();
        try {
          client.forwardIn('127.0.0.1', port, (err, boundPort) => {
            clearTimeout(timer);
            if (settled) {
              // 看门狗已判失败, 迟到的成功会在服务端留下没有 record 的野
              // 监听 (端口被占 + 连接被默默转走) — 立刻拆除。
              if (!err) {
                this.log.warn('late forwardIn success after watchdog timeout — unbinding', {
                  id: this.id,
                  port: boundPort || port,
                });
                try {
                  client.unforwardIn('127.0.0.1', boundPort || port, () => { /* best-effort */ });
                } catch { /* client may be dead */ }
              }
              return;
            }
            settled = true;
            if (err) {
              errors.push(`${port}: ${err.message}`);
              resolve(null);
            } else {
              resolve(boundPort || port);
            }
          });
        } catch (err) {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          errors.push(`${port}: ${(err as Error).message}`);
          resolve(null);
        }
      });
      if (bound == null) continue;
      // close() 可能发生在 arm 在飞期间: record 已被摘除的话, 刚绑上的
      // 端口同样是野监听 — 立即 unforward, 以失败收尾 (armForwardDeduped
      // 的调用方都已 catch)。
      if (this.forwards.get(forwardKey(record.spec)) !== record) {
        this.log.warn('forward closed while arming — unbinding just-bound port', {
          id: this.id,
          port: bound,
        });
        // 与 forwardHandle.close() 相同的 5s 看门狗: 半开连接上 unforwardIn
        // 回调可能丢失, 这里挂住会把 ensureRemoteForward 的调用方
        // (Settings 关闭 proxy / 更新 host) 一起拖死 (worker 核验补充)。
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), 5_000);
          timer.unref?.();
          try {
            client.unforwardIn('127.0.0.1', bound, () => {
              clearTimeout(timer);
              resolve();
            });
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
        throw new Error(`remote forward to ${forwardKey(record.spec)} was closed while arming`);
      }
      // 连接代际校验 (review: PR #715 五轮审核 P1): arm 在飞期间发生了
      // 断线/重连的话, this.client 已换成新连接, 这个绑定落在旧 (将死) 连接
      // 上 — 若不拦截, record 会被误标 armed, rearmForwards 见 armed 直接
      // 跳过, 隧道「以为建好了实际新连接上没有」。旧 client 上 best-effort
      // 拆除 (多半已死), 以专门错误收尾让调用方立即在当前连接重试。
      if (this.client !== client) {
        this.log.warn('forwardIn resolved on a stale connection — unbinding and re-arming', {
          id: this.id,
          port: bound,
        });
        try {
          client.unforwardIn('127.0.0.1', bound, () => { /* best-effort; client likely dead */ });
        } catch { /* dead */ }
        throw new StaleForwardArmError(
          `remote forward to ${forwardKey(record.spec)} armed on a stale connection`,
        );
      }
      record.remotePort = bound;
      record.armed = true;
      this.log.info('ssh remote forward armed', {
        id: this.id,
        remotePort: bound,
        localTarget: forwardKey(record.spec),
      });
      return;
    }
    throw new Error(
      `remote port forwarding failed on ${this.id} (tried 127.0.0.1:${candidates.join(',')}). ` +
      `The remote sshd may disallow remote forwarding (AllowTcpForwarding) or the ports are busy. ` +
      errors.slice(0, 3).join('; '),
    );
  }

  /** connect 成功后重挂所有已登记 forward; 端口变了通知上层。 */
  private async rearmForwards(): Promise<void> {
    for (const record of this.forwards.values()) {
      const prevPort = record.remotePort;
      record.armed = false;
      // 旧连接的迟到 arm 回调会以 StaleForwardArmError 收尾 — 当前连接还没
      // arm, 立即重试一次 (record.arming 已被 finally 清掉, 可重新发起)。
      // 其余错误 (端口占用 / sshd 拒绝) 不重试, 等下次 reconnect 或 session
      // 路径的 ensureRemoteForward 显式触发。
      let armed = false;
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 2 && !armed; attempt++) {
        try {
          await this.armForwardDeduped(record);
          armed = true;
        } catch (err) {
          lastErr = err as Error;
          if (!(err instanceof StaleForwardArmError)) break;
        }
      }
      if (!armed) {
        // arm 失败不阻断连接 — 记日志, 下次 reconnect 再试; session 路径
        // (ensureRemoteForward on ready host) 会显式重试并拿到错误。
        this.log.warn('ssh remote forward re-arm failed', {
          id: this.id,
          localTarget: forwardKey(record.spec),
          error: lastErr?.message,
        });
        continue;
      }
      if (record.remotePort !== prevPort) {
        this.log.warn('ssh remote forward re-bound to a different port', {
          id: this.id,
          prevPort,
          remotePort: record.remotePort,
        });
        try {
          record.spec.onRearmed?.(record.remotePort);
        } catch { /* listener must not throw */ }
      }
    }
  }

  /** 同一条 forward 的并发 arm 共享一个 in-flight promise。 */
  private armForwardDeduped(record: ForwardRecord): Promise<void> {
    if (record.armed) return Promise.resolve();
    if (!record.arming) {
      // finally 只在引用仍是自己时清 — markForwardsDisarmed 可能在在飞期间
      // 清掉旧引用, 新 arm 已重新赋值; 无条件清会误删新 promise 再造竞争。
      const p = this.armForward(record).finally(() => {
        if (record.arming === p) record.arming = undefined;
      });
      record.arming = p;
    }
    return record.arming;
  }

  /** 每个 client 实例挂一次 'tcp connection' 分发器。 */
  private attachForwardListener(client: Client): void {
    if (this.forwardListenerClient === client) return;
    this.forwardListenerClient = client;
    client.on('tcp connection', (details: TcpConnectionDetails, accept, reject) => {
      this.handleForwardedConnection(details, accept, reject);
    });
  }

  private handleForwardedConnection(
    details: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void,
  ): void {
    // fail-closed (PR #715 copilot): 远端 sshd 若配了 permissive GatewayPorts,
    // 隧道口可能绑在非 loopback 接口 — 远端网络的任意机器都能经隧道借用
    // 本机的本地 Proxy。只接受 loopback 来源的转发连接 (远端 daemon 与
    // sshd 同机, 合法来源恒为 loopback; IPv6 / IPv4-mapped 形式都认)。
    if (
      details.srcIP !== '127.0.0.1'
      && details.srcIP !== '::1'
      && details.srcIP !== '::ffff:127.0.0.1'
    ) {
      this.log.warn('ssh remote forward: rejecting non-loopback forwarded connection', {
        id: this.id,
        srcIP: details.srcIP,
        destPort: details.destPort,
      });
      reject();
      return;
    }
    let record: ForwardRecord | undefined;
    for (const r of this.forwards.values()) {
      if (r.armed && r.remotePort === details.destPort) {
        record = r;
        break;
      }
    }
    if (!record) {
      reject();
      return;
    }
    const rec = record;
    const channel = accept();
    const sock = net.connect({ host: rec.spec.localHost, port: rec.spec.localPort });

    sock.on('error', (err) => {
      // 本地 Proxy 没起 / 拒连 — 远端 agent 会看到连接立刻被断, 错误在
      // agent 侧浮现 (proxy connect failed)。这里只做节流日志。
      rec.localErrorCount += 1;
      const now = Date.now();
      if (now - rec.lastLocalErrorAt > 30_000) {
        rec.lastLocalErrorAt = now;
        // 距上次日志被吞掉的条数, 不含本次 (localErrorCount 已含本次, -1 扣除;
        // 否则首条日志就会误报 suppressed=1, review: PR #715 greptile R4)。
        const suppressed = rec.localErrorCount - rec.lastLocalErrorLoggedCount - 1;
        rec.lastLocalErrorLoggedCount = rec.localErrorCount;
        this.log.warn('ssh remote forward: local target unreachable', {
          id: this.id,
          localTarget: forwardKey(rec.spec),
          error: err.message,
          suppressedCount: suppressed,
        });
      }
      // error 后 socket 必须销毁 (review: PR #715 copilot R3) — 只关 channel
      // 不 destroy 会把本地侧留成半开, Proxy 进程上积 CLOSE_WAIT。
      sock.destroy();
      try { channel.close(); } catch { /* already gone */ }
    });
    channel.on('error', () => {
      sock.destroy();
    });
    // 远端关掉转发 channel → 本地到 Proxy 的 socket 同步销毁; 否则本地
    // Proxy 侧会积一堆半开连接 (pipe 的 end 只处理正常 EOF, 不覆盖 destroy)。
    channel.on('close', () => {
      sock.destroy();
    });
    sock.on('close', () => {
      try { channel.close(); } catch { /* already gone */ }
    });
    channel.pipe(sock);
    sock.pipe(channel);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Guard for channel ops. */
  private requireReady(): Client {
    if (this.status !== 'ready' || !this.client) {
      throw new Error(`remote host "${this.id}" is not ready (status=${this.status})`);
    }
    return this.client;
  }

  /**
   * ssh2 `hostVerifier` — TOFU against the injected store. Returns true to
   * accept the handshake, false to reject it (ssh2 then emits an error which
   * onError maps to `hostKeyError`). Fails closed: a missing store or a read
   * error refuses the connect rather than trusting an unverified key.
   */
  private async verifyHostKey(hostKey: Buffer): Promise<boolean> {
    const store = this.hostKeys;
    if (!store) {
      this.hostKeyError =
        'SSH host key verification is not configured; refusing to connect without it.';
      this.log.error('ssh host key store missing — refusing connect', { id: this.id });
      return false;
    }
    // Discard any stale in-memory cache so a user who repaired known-hosts.json
    // (e.g. removed a stale entry after a legitimate server re-key) sees the
    // update on reconnect without restarting the app.
    store.reload();
    const presented = hostKeyFingerprint(hostKey);
    const storeKey = hostKeyId(this.cfg.hostname, this.cfg.port);
    let stored: string | null;
    try {
      stored = await store.get(storeKey);
    } catch (err) {
      this.hostKeyError = `failed to read trusted host keys: ${(err as Error).message}`;
      this.log.error('ssh known-hosts read failed — refusing connect', {
        id: this.id,
        error: (err as Error).message,
      });
      return false;
    }

    const decision = decideHostKey(stored, presented);
    if (decision === 'match') return true;
    if (decision === 'trust-new') {
      try {
        await store.set(storeKey, presented);
      } catch (err) {
        // Cannot persist the trusted fingerprint — refuse the connection.
        // Proceeding without persistence means the next reconnect would
        // re-enter trust-new and silently accept any key, defeating TOFU.
        this.hostKeyError = `failed to persist trusted host key: ${(err as Error).message}`;
        this.log.error('ssh known-hosts write failed — refusing connect', {
          id: this.id,
          error: (err as Error).message,
        });
        return false;
      }
      this.log.info('ssh host key trusted on first use', {
        id: this.id,
        host: storeKey,
        fingerprint: presented,
      });
      return true;
    }
    // mismatch
    this.hostKeyError =
      `Remote host key for ${storeKey} changed (${presented}) and no longer matches the ` +
      `previously trusted key. This can mean the server was reinstalled — or a ` +
      `man-in-the-middle. Connection refused. If you trust the change, remove the stale ` +
      `entry from maker's known hosts and reconnect.`;
    this.log.error('ssh host key mismatch — refusing connect', {
      id: this.id,
      host: storeKey,
      presented,
      trusted: stored,
    });
    return false;
  }

  private async doConnect(): Promise<void> {
    this.setStatus('connecting');
    this.hostKeyError = null;

    let auth;
    try {
      auth = await resolveAuth(this.cfg);
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = msg;
      this.setStatus('failed');
      throw err;
    }

    const client = new Client();
    this.client = client;

    const connectConfig: ConnectConfig = {
      host: this.cfg.hostname,
      port: this.cfg.port,
      username: this.cfg.user,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      // TOFU host key check — without this ssh2 trusts any presented key (MITM).
      hostVerifier: (hostKey: Buffer, verify: (valid: boolean) => void): void => {
        void this.verifyHostKey(hostKey).then(verify, () => verify(false));
      },
      ...(auth.agent ? { agent: auth.agent } : {}),
      ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
      ...(auth.passphrase ? { passphrase: auth.passphrase } : {}),
    };

    this.log.debug('ssh connecting', {
      id: this.id,
      hostname: this.cfg.hostname,
      port: this.cfg.port,
      auth: auth.label,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const onReady = () => {
        if (settled) return;
        settled = true;
        this.lastError = undefined;
        this.lastAuthLabel = auth.label;
        this.reconnectAttempts = 0;
        this.setStatus('ready');
        this.log.info('ssh ready', { id: this.id, auth: auth.label });
        // 后台重挂已登记的 remote forwards; 不阻塞 connect 返回 (session
        // 路径会自己 await ensureRemoteForward 拿到 arm 错误)。
        void this.rearmForwards();
        resolve();
      };

      const onError = (err: Error) => {
        if (settled) {
          // Post-ready error — feed into reconnect path, not the connect promise.
          this.handlePostReadyError(err);
          return;
        }
        settled = true;
        // A rejected host key surfaces here as an opaque ssh2 handshake error;
        // prefer the actionable MITM/re-key message the verifier stashed.
        // Otherwise swap opaque "All configured authentication methods failed"
        // for a hint pointing at ssh-copy-id / identity file. The host row
        // subtitle + connect-failure toast both surface this verbatim.
        this.lastError = this.hostKeyError
          ? this.hostKeyError
          : isAuthFailure(err.message)
            ? authFailureHint(this.cfg)
            : err.message;
        this.client = null;
        this.setStatus('failed');
        this.log.warn('ssh connect failed', { id: this.id, error: err.message });
        // Reject with the friendly message so IPC layer's toast also gets
        // the actionable copy (it pulls from `.message`).
        const rejectErr = new Error(this.lastError);
        // Preserve original for tests / debugging that key off message text.
        (rejectErr as Error & { cause?: unknown }).cause = err;
        reject(rejectErr);
      };

      const onClose = () => {
        if (!settled) {
          settled = true;
          const msg = this.lastError ?? 'connection closed before ready';
          this.lastError = msg;
          this.client = null;
          this.setStatus('failed');
          reject(new Error(msg));
          return;
        }
        // Post-ready close — schedule reconnect unless user-initiated.
        this.handlePostReadyClose();
      };

      // ssh2 emits 'handshake' before 'ready' — repurpose to advance state
      // so renderer can show "authenticating" instead of staying on
      // "connecting" throughout auth.
      client.on('handshake', () => this.setStatus('authenticating'));
      client.on('ready', onReady);
      client.on('error', onError);
      client.on('close', onClose);

      try {
        client.connect(connectConfig);
      } catch (err) {
        onError(err as Error);
      }
    });
  }

  private handlePostReadyError(err: Error): void {
    this.lastError = err.message;
    this.log.warn('ssh post-ready error', { id: this.id, error: err.message });
    // 'close' will follow — reconnect is handled there to avoid double-scheduling.
  }

  private handlePostReadyClose(): void {
    this.client = null;
    this.markForwardsDisarmed();
    if (this.userDisconnected) {
      this.setStatus('disconnected');
      return;
    }
    // Auth failures are deterministic — retrying with the same agent / key
    // produces the same outcome. Fail fast so the user sees the actionable
    // hint immediately instead of waiting 30+ s for the backoff to give up.
    // Auto-reconnect's intended target is transient network failures
    // (DNS hiccup, keepalive timeout) — those benefit from retry.
    if (this.lastError && isAuthFailure(this.lastError)) {
      this.log.info('ssh skipping reconnect (auth failure is deterministic)', {
        id: this.id,
      });
      this.setStatus('failed');
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('failed');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts += 1;
    // Exponential backoff capped at 30s. attempt=1 → 1s, 2 → 2s, 3 → 4s, ...
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      30_000,
    );
    this.setStatus('reconnecting');
    this.log.info('ssh scheduling reconnect', {
      id: this.id,
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.doConnect().catch((err) => {
        // doConnect already set status=failed and recorded lastError.
        // If we still have attempts left, schedule again.
        if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS && !this.userDisconnected) {
          this.scheduleReconnect();
        } else {
          this.log.error('ssh reconnect exhausted', { id: this.id, error: (err as Error).message });
        }
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** 连接断了后服务端侧的转发监听随之消失; 愿望保留, 等下次 ready 重挂。 */
  private markForwardsDisarmed(): void {
    for (const record of this.forwards.values()) {
      record.armed = false;
      // 在飞 arm 是在旧连接上发起的 — 清掉引用让新连接的 rearm 重新发起,
      // 旧 promise 的迟到成功由 armForward 的连接代际校验拦截
      // (StaleForwardArmError), 不会误标 armed。
      record.arming = undefined;
    }
    // 分发器挂在旧 client 上 — 清掉引用, 否则 RemoteHost 长期持有死 client
    // (抑制 GC + 多次重连后旧 client 上 listener 堆积, review: PR #715
    // copilot R3)。新 client 首次 arm 时 attachForwardListener 会重新挂。
    this.forwardListenerClient = null;
  }

  private setStatus(next: RemoteStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.statusChangedAt = Date.now();
    this.events.emit('status', this.snapshot());
  }

  /** Wait until status leaves {connecting, authenticating}. */
  private waitForTerminal(): Promise<void> {
    return new Promise((resolve) => {
      const off = this.onStatus((snap) => {
        if (snap.status !== 'connecting' && snap.status !== 'authenticating') {
          off();
          resolve();
        }
      });
    });
  }
}
