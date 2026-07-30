/**
 * SshDaemonTransport — codex app-server NDJSON transport over an SSH-tunnelled
 * websocket.
 *
 * Wire format (调研 codex-rs/app-server-daemon source):
 *   远端常驻 `codex app-server daemon` (--remote-control), 监听 unix domain socket
 *   `$CODEX_HOME/app-server-control/app-server-control.sock`。socket 上跑标准
 *   websocket (HTTP Upgrade + frames), 每个 ws text frame 一条 NDJSON 行。
 *
 *   `codex app-server proxy --sock <path>` 在远端把 unix socket 字节流原样桥接到
 *   它自己的 stdin/stdout, 我们用 RemoteHost.execStream 把那一对 stdin/stdout 拽
 *   回本地, 再在上面跑客户端侧 ws (HTTP Upgrade 请求 + Receiver/Sender frame 编解码)。
 *
 *   协议层 (JSON-RPC: initialize / thread/start / item/updated / ...) 跟本地
 *   StdioTransport 一字不差; transport 只搬字节, client 完全感知不到差异。
 *
 * Lifecycle:
 *   - Factory 同步 return Transport (state='connecting'), 立即在 background 跑
 *     daemon 探活 → ssh exec proxy → HTTP Upgrade → ws handshake; 期间任何 writeLine
 *     都会被 queue, handshake 完成 (state='open') 后一次性 drain。
 *   - 任何阶段失败 → fire onClose(reason), 之后 writeLine 全 reject。
 *   - close() 主动关 ws → 关 ssh channel; 远端 daemon 寿命独立 (--remote-control
 *     设的 daemon 持续在跑, 后续 session 复用)。
 *
 * 安全:
 *   - daemon 的 unix socket 在 $CODEX_HOME (per-user home) 下, 文件系统隔离;
 *     未额外鉴权 — 跟 codex 官方文档一致。
 *   - 我们不让 ssh channel 走 pty, 字节流是 raw binary, 避免 pty echo / 行缓冲污染。
 */

import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { RemoteHost, ExecStreamHandle } from '@cindy/maker-remote-ssh';
import { REMOTE_INSTALL_ROOT } from '@cindy/maker-remote-ssh';

// ws lib doesn't export Receiver / Sender from its main entry — they live as
// internal classes under ws/lib/. The package's `exports` field also
// blocks subpath require()s ('./lib/receiver' is not whitelisted), so a
// naive `require('ws/lib/receiver')` throws ERR_PACKAGE_PATH_NOT_EXPORTED
// at runtime — even though the files exist on disk.
//
// Workaround: resolve the package root via `require.resolve('ws')` (which
// IS allowed), then require the internal files by absolute path. Absolute
// paths bypass the exports check (it only applies to bare-specifier subpaths).
// Same trick the ws lib's own README recommends for low-level frame use cases.
const wsRequire = createRequire(import.meta.url);
const WS_PACKAGE_DIR = path.dirname(wsRequire.resolve('ws'));
type WsMessageHandler = (data: Buffer | string, isBinary: boolean) => void;
type WsErrorHandler = (err: Error) => void;
type WsConcludeHandler = (code: number, reason: Buffer) => void;
interface WsReceiver {
  write(chunk: Buffer): boolean;
  on(event: 'message', cb: WsMessageHandler): this;
  on(event: 'error', cb: WsErrorHandler): this;
  on(event: 'conclude', cb: WsConcludeHandler): this;
}
interface WsSenderOptions {
  binary: boolean;
  fin: boolean;
  mask: boolean;
  compress: boolean;
}
interface WsSender {
  send(
    data: string | Buffer,
    options: WsSenderOptions,
    cb?: (err?: Error) => void,
  ): void;
  close(code: number, reason: string, mask: boolean, cb?: () => void): void;
}
type WsReceiverCtor = new (opts: { isServer: boolean; binaryType?: string; maxPayload?: number }) => WsReceiver;
/**
 * ws@8 `Sender.sendFrame` calls `cork()` / `uncork()` on the sink when
 * dispatching a 2-chunk frame (mask header + masked payload). Without these
 * methods present, Sender throws `TypeError: this._socket.cork is not a
 * function`. No-op stubs satisfy ws — we don't need real corking because
 * RemoteHost.execStream's stdin is an already-buffered stream.
 */
interface WsSenderSink {
  write(chunk: Buffer, cb?: (err?: Error) => void): void;
  cork(): void;
  uncork(): void;
}
type WsSenderCtor = new (sink: WsSenderSink) => WsSender;
const Receiver: WsReceiverCtor = wsRequire(path.join(WS_PACKAGE_DIR, 'lib/receiver.js')) as WsReceiverCtor;
const Sender: WsSenderCtor = wsRequire(path.join(WS_PACKAGE_DIR, 'lib/sender.js')) as WsSenderCtor;

import type {
  CodexAppServerCloseHandler as CloseHandler,
  CodexAppServerLineHandler as LineHandler,
  CodexAppServerStderrHandler as StderrHandler,
  CodexAppServerTransport as Transport,
  CodexAppServerCloseInfo as TransportCloseInfo,
} from '@cindy/maker-core';

/** Minimal Logger surface we need (matches maker-core's interface shape). */
interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface SshDaemonTransportOptions {
  /** Connected RemoteHost from maker-remote-ssh ConnectionPool. */
  remoteHost: RemoteHost;
  /**
   * Override the remote install root. Default '$HOME/.xdt-server/v1' which
   * matches what `bootstrap/installer.ts` creates. Override only for tests
   * / non-standard layouts.
   *
   * Codex 二进制实际位于 `<installRoot>/codex-home/packages/standalone/current/codex`
   * (isolated CODEX_HOME standalone install via official curl installer.sh —
   * 见 `bootstrap-script.ts` 和 `installer.ts binaryPathFor()`)。daemon
   * 启动也强制走这条路径,不再 fallback 到 PATH 上的 bare `codex`。
   */
  installRoot?: string;
  /**
   * Override the daemon socket path. Default: discovered from `daemon version`.
   * Most callers should leave unset.
   */
  socketPath?: string;
  logger: Logger;
  /**
   * If true (default), run `daemon start --remote-control` when version probe
   * shows the daemon isn't up. Set false to fail fast (debugging).
   */
  autoStartDaemon?: boolean;
  /**
   * Total time we'll wait for ssh exec + HTTP Upgrade response before giving
   * up and tearing the transport down. Default 15 s.
   */
  handshakeTimeoutMs?: number;
  /**
   * daemon 探活前跑的钩子 (async): agent-proxy 的 env marker 对账走这里 —
   * marker 漂移时钩子会重写 marker 并 pkill 旧 daemon, 随后的 version 探活
   * 失败 → bootstrap 新 daemon 吃到新 env。钩子失败会中止 transport 建立,
   * 错误经 fireClose 上浮 (比"隧道没建好就让 daemon 裸连"更诚实)。
   */
  beforeDaemonProbe?: () => Promise<void>;
}

/** Standard WebSocket GUID — appended to client key for Accept hash check. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Compute the Sec-WebSocket-Accept value for a given Sec-WebSocket-Key,
 * per RFC 6455 §4.2.2: base64(sha1(key + WS_GUID)).
 *
 * Exported so the handshake math can be exercised directly without standing
 * up a full SSH transport. Test against the RFC's sample vector.
 */
export function computeWsAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

interface DaemonVersionOutput {
  socketPath?: string;
  socket_path?: string;
  /** Other fields (cliVersion, appServerVersion, backend) we ignore for now. */
  [k: string]: unknown;
}

type State = 'connecting' | 'open' | 'closed';

/**
 * Build a transport synchronously; the heavy lifting (daemon probe, ssh exec,
 * ws handshake) runs in the background and either flips state to 'open' or
 * fires onClose with the failure reason.
 */
export function createSshDaemonTransport(opts: SshDaemonTransportOptions): Transport {
  const logger = opts.logger.child('codex-ssh-daemon-transport');
  const installRoot = opts.installRoot ?? REMOTE_INSTALL_ROOT;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const autoStartDaemon = opts.autoStartDaemon !== false;

  // Wrapper script that runs codex from our **isolated CODEX_HOME** install.
  // Used for every codex invocation in this transport (daemon version / daemon
  // bootstrap / app-server proxy).
  //
  // Why isolated CODEX_HOME:
  //   - codex daemon mode requires the "managed standalone install" layout at
  //     `$CODEX_HOME/packages/standalone/current/codex`. The npm @openai/codex
  //     package does NOT create that layout (see codex-rs/app-server-daemon/
  //     src/managed_install.rs which checks this exact path).
  //   - P1's bootstrap-script.ts runs `install.sh` with
  //     `CODEX_HOME=$HOME/.xdt-server/v1/codex-home` so EVERYTHING (binary,
  //     daemon state, socket, auth) lives under our xdt-server tree, never
  //     touching user's `~/.codex/`. We export the same CODEX_HOME here so
  //     daemon commands find our isolated install (binary, settings, socket).
  //
  // The `_` is $0 (script name placeholder); positional $1+ are the codex
  // subcommand/flags forwarded to `exec "$@"` (shellQuote-safe pass-through).
  //
  // agent-proxy.env: 「Agent 流量走本地 Proxy」隧道开启时由 agent-proxy 的
  // reconcile 写入 (export HTTPS_PROXY=http://127.0.0.1:<forwardPort> 等)。
  // daemon bootstrap / 一次性命令统一 source — codex 的后端流量因此经隧道
  // 流回用户本地 Proxy。文件不存在 = 功能未开启, 直连。
  const codexCmd = (subArgs: string[]): string => {
    // installRoot is interpolated UNQUOTED so the default `$HOME/.xdt-server/v1`
    // gets shell-expanded remotely. We don't know remote $HOME from the client
    // side, and asking up-front is an extra round trip. Caller overrides are
    // treated as bash expressions (e.g. `$HOME/...` or `/abs`); default is
    // fixed + test overrides are caller-controlled, so injection isn't real.
    const wrapper = `
INSTALL_ROOT="${installRoot}"
export CODEX_HOME="$INSTALL_ROOT/codex-home"
CODEX="$CODEX_HOME/packages/standalone/current/codex"
if [ ! -x "$CODEX" ]; then
  printf 'codex not installed at %s — run P1 install flow first\\n' "$CODEX" >&2
  exit 127
fi
if [ -f "$INSTALL_ROOT/agent-proxy.env" ]; then . "$INSTALL_ROOT/agent-proxy.env"; fi
exec "$CODEX" "$@"
`.trim();
    const quotedArgs = subArgs.map(shellQuote).join(' ');
    return `bash -c ${shellQuote(wrapper)} _ ${quotedArgs}`;
  };

  const lineHandlers = new Set<LineHandler>();
  const stderrHandlers = new Set<StderrHandler>();
  const closeHandlers = new Set<CloseHandler>();
  /** Lines buffered between handshake completion and first onLine subscriber. */
  const lineBuffer: string[] = [];
  let lineHandlerArmed = false;
  /** Writes issued before handshake completes — drained on 'open'. */
  const pendingWrites: Array<{ line: string; resolve: () => void; reject: (e: Error) => void }> = [];

  let state: State = 'connecting';
  let channel: ExecStreamHandle | null = null;
  let receiver: WsReceiver | null = null;
  let sender: WsSender | null = null;
  /** During handshake we accumulate HTTP response bytes until \r\n\r\n. */
  let handshakeBuf = Buffer.alloc(0);
  let expectedAccept = '';
  let handshakeDone = false;
  let handshakeTimer: NodeJS.Timeout | null = null;

  const fireClose = (reason: string): void => {
    if (state === 'closed') return;
    state = 'closed';
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
    // Reject any queued writes — they're not going anywhere.
    const err = new Error(`SshDaemonTransport closed: ${reason}`);
    for (const w of pendingWrites.splice(0)) w.reject(err);
    // Best-effort cleanup. channel.kill closes the proxy on the remote, freeing
    // the daemon's accept slot. (daemon itself keeps running for other sessions.)
    try { channel?.kill(); } catch { /* swallow */ }
    channel = null;
    receiver = null;
    sender = null;
    const info: TransportCloseInfo = { reason };
    for (const cb of closeHandlers) {
      try { cb(info); } catch { /* handler should not throw */ }
    }
  };

  const fireLine = (line: string): void => {
    if (!lineHandlerArmed) {
      lineBuffer.push(line);
      return;
    }
    for (const cb of lineHandlers) cb(line);
  };

  const fireStderr = (line: string): void => {
    for (const cb of stderrHandlers) cb(line);
  };

  /** Once handshake completes, we plug remaining bytes (+ all subsequent) into
   *  the ws Receiver. Receiver emits 'message' per frame. */
  const installFrameMode = (): void => {
    if (!channel || !receiver || !sender) return;
    state = 'open';
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }

    receiver.on('message', (data: Buffer | string, isBinary: boolean) => {
      // codex app-server sends NDJSON as text frames; defensive accept binary too.
      const line = typeof data === 'string' ? data : data.toString('utf8');
      // A single ws frame is one JSON-RPC message (no embedded newlines), but
      // be defensive: split if the producer ever batched. The shape contract
      // (1 frame = 1 JSON message) is asserted by codex-rs/app-server-transport.
      if (line.includes('\n')) {
        for (const part of line.split('\n')) {
          if (part) fireLine(part);
        }
      } else if (line) {
        fireLine(line);
      }
      void isBinary; // unused; ws lib API requires positional arg
    });
    receiver.on('error', (err: Error) => {
      logger.error('ws receiver error', { message: err.message });
      fireClose(`ws receiver error: ${err.message}`);
    });
    receiver.on('conclude', (code: number) => {
      logger.info('ws closed by peer', { code });
      fireClose(`peer closed ws (code=${code})`);
    });

    // Drain pendingWrites — these were queued before handshake completion.
    const drained = pendingWrites.splice(0);
    for (const w of drained) {
      sendTextFrame(w.line).then(w.resolve, w.reject);
    }

    logger.info('ws handshake complete; transport open');
  };

  /** Encode + send one NDJSON line as a ws text frame. */
  const sendTextFrame = (line: string): Promise<void> => {
    if (!sender || !channel || state !== 'open') {
      return Promise.reject(new Error(`SshDaemonTransport.writeLine: state=${state}`));
    }
    return new Promise<void>((resolve, reject) => {
      sender!.send(line, { binary: false, fin: true, mask: true, compress: false }, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  /** Feed an incoming byte chunk through the handshake parser. */
  const processHandshakeBytes = (chunk: Buffer): void => {
    handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
    const headerEnd = handshakeBuf.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      // need more bytes; cap to avoid runaway buffering on misbehaving servers
      if (handshakeBuf.length > 64 * 1024) {
        fireClose('handshake response exceeds 64KB without terminator');
      }
      return;
    }
    const headerBytes = handshakeBuf.slice(0, headerEnd);
    const rest = handshakeBuf.slice(headerEnd + 4);
    handshakeBuf = Buffer.alloc(0);
    handshakeDone = true;

    const headerText = headerBytes.toString('utf8');
    const lines = headerText.split('\r\n');
    const statusLine = lines[0] ?? '';
    const statusMatch = /^HTTP\/1\.1\s+(\d+)/.exec(statusLine);
    if (!statusMatch || statusMatch[1] !== '101') {
      fireClose(`unexpected HTTP status from proxy: "${statusLine}"`);
      return;
    }
    // Verify Sec-WebSocket-Accept matches expected. Header lookup is case-insensitive.
    let acceptHeader: string | null = null;
    for (const headerLine of lines.slice(1)) {
      const idx = headerLine.indexOf(':');
      if (idx < 0) continue;
      const name = headerLine.slice(0, idx).trim().toLowerCase();
      if (name === 'sec-websocket-accept') {
        acceptHeader = headerLine.slice(idx + 1).trim();
        break;
      }
    }
    if (acceptHeader !== expectedAccept) {
      fireClose(`Sec-WebSocket-Accept mismatch (expected ${expectedAccept}, got ${acceptHeader ?? 'null'})`);
      return;
    }

    installFrameMode();
    // Whatever bytes arrived after the headers — feed straight to the receiver.
    if (rest.length > 0 && receiver) {
      receiver.write(rest);
    }
  };

  /** Async kickoff: probe daemon, optionally start it, open proxy, do handshake. */
  const bootstrap = async (): Promise<void> => {
    // 0) agent-proxy 对账钩子等 (隧道 + env marker 就绪后再碰 daemon)。
    if (opts.beforeDaemonProbe) {
      await opts.beforeDaemonProbe();
    }

    // 1) Probe daemon. Output is one JSON object on stdout.
    let socketPath = opts.socketPath ?? '';
    if (!socketPath) {
      try {
        socketPath = await discoverSocketPath();
      } catch (err) {
        if (!autoStartDaemon) {
          throw new Error(`daemon not running and autoStartDaemon=false: ${(err as Error).message}`);
        }
        logger.info('daemon version probe failed; attempting start', { reason: (err as Error).message });
        await startDaemon();
        socketPath = await discoverSocketPath();
      }
    }
    logger.info('daemon socket discovered', { socketPath });

    // 2) Open the proxy as a long-lived ssh exec channel.
    // Quote socketPath defensively (POSIX) — daemon may put it in a path with spaces.
    const cmd = codexCmd(['app-server', 'proxy', '--sock', socketPath]);
    const ch = await opts.remoteHost.execStream(cmd);
    channel = ch;

    ch.onStderr((s) => {
      // Proxy 一般不打 stderr; 真打了多半是错误, 升级成 warn 让 host 看到。
      const trimmed = s.trim();
      if (trimmed) {
        logger.warn('proxy stderr', { line: trimmed.slice(0, 500) });
        fireStderr(trimmed);
      }
    });
    ch.onClose((info) => {
      if (state !== 'closed') {
        const reason = info.signal ? `signal=${info.signal}` : `exit code=${info.code ?? 'null'}`;
        fireClose(`proxy channel closed (${reason})`);
      }
    });
    ch.onError((err) => {
      fireClose(`proxy channel error: ${err.message}`);
    });

    // 3) Wire onStdoutBytes — pre-handshake bytes go to processHandshakeBytes;
    // once handshakeDone, route to ws.Receiver.
    ch.onStdoutBytes((chunk) => {
      if (state === 'closed') return;
      if (!handshakeDone) {
        processHandshakeBytes(chunk);
        return;
      }
      if (receiver) receiver.write(chunk);
    });

    // 4) Prepare receiver / sender NOW (no I/O), so handshake completion can
    //    immediately switch to frame mode.
    receiver = new Receiver({
      isServer: false,
      // text frames are decoded to Buffer; we'll toString in the 'message' handler.
      binaryType: 'nodebuffer',
      maxPayload: 16 * 1024 * 1024,
    });
    sender = new Sender({
      // sender.send invokes this for outbound frames; pipe straight to channel.
      write: (chunk: Buffer, cb?: (err?: Error) => void) => {
        try {
          ch.write(chunk);
          if (cb) cb();
        } catch (err) {
          if (cb) cb(err as Error);
        }
      },
      // cork / uncork are no-ops — see WsSenderSink comment for why ws needs them.
      cork: () => { /* noop */ },
      uncork: () => { /* noop */ },
    });

    // 5) Send HTTP Upgrade request. Host header is required by WS RFC; the
    //    daemon doesn't validate Origin (we don't send one — non-browser path).
    const keyBytes = randomBytes(16);
    const key = keyBytes.toString('base64');
    expectedAccept = computeWsAccept(key);
    const req = [
      'GET / HTTP/1.1',
      'Host: localhost',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '', '',
    ].join('\r\n');
    ch.write(req);
    logger.debug('sent ws upgrade request');

    // 6) Arm handshake timeout.
    handshakeTimer = setTimeout(() => {
      if (state === 'connecting') {
        fireClose(`handshake timeout after ${handshakeTimeoutMs}ms`);
      }
    }, handshakeTimeoutMs);
    handshakeTimer.unref?.();
  };

  /** Run `codex app-server daemon version` on the remote, parse socket path. */
  const discoverSocketPath = async (): Promise<string> => {
    const cmd = codexCmd(['app-server', 'daemon', 'version']);
    const result = await opts.remoteHost.exec(cmd, { timeoutMs: 10_000, label: 'codex-daemon-version' });
    if (result.exitCode !== 0) {
      throw new Error(`daemon version exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || '(no stderr)'}`);
    }
    let parsed: DaemonVersionOutput;
    try {
      parsed = JSON.parse(result.stdout) as DaemonVersionOutput;
    } catch (e) {
      throw new Error(`daemon version stdout not JSON: ${(e as Error).message}; raw="${result.stdout.slice(0, 200)}"`);
    }
    // Doc only specifies semantics; key name varies — accept both common forms.
    const sock = parsed.socketPath ?? parsed.socket_path;
    if (typeof sock !== 'string' || !sock) {
      throw new Error(`daemon version JSON missing socketPath: keys=${Object.keys(parsed).join(',')}`);
    }
    return sock;
  };

  /**
   * Bring up the daemon. Uses `daemon bootstrap --remote-control` which is the
   * one CLI command that:
   *   - is safe on first run (creates the persistent settings + starts daemon)
   *   - is idempotent on re-run (overwrites settings + restarts daemon)
   *
   * We only call this when `discoverSocketPath` failed first, so the restart
   * side-effect on an already-running daemon is moot.
   *
   * Caveat (codex source codex-rs/app-server-daemon/src/managed_install.rs:19):
   * `daemon bootstrap` requires the **standalone codex install** from the
   * official curl installer at `$CODEX_HOME/packages/standalone/current/codex`.
   * xdt-maker 的 `bootstrap-script.ts` 现在就是走这条 standalone 路径
   * (isolated CODEX_HOME, 见 binaryPathFor codex 分支)。silent install 链路
   * 会在 maker:send 首条消息发出前自动补齐 standalone install; 若 standalone
   * 缺失或受损, bootstrap 仍会失败并 surface stderr verbatim, 用户可手动跑:
   *   curl -fsSL https://chatgpt.com/codex/install.sh | sh
   *
   * `daemon start` (no `--remote-control`) is the lighter-weight alternative
   * IF the daemon is already bootstrapped; we don't use it because we have no
   * cheap way to distinguish "never bootstrapped" from "bootstrapped but down".
   */
  const startDaemon = async (): Promise<void> => {
    const cmd = codexCmd(['app-server', 'daemon', 'bootstrap', '--remote-control']);
    const result = await opts.remoteHost.exec(cmd, { timeoutMs: 30_000, label: 'codex-daemon-bootstrap' });
    if (result.exitCode !== 0) {
      throw new Error(
        `daemon bootstrap exit=${result.exitCode}: ${result.stderr.trim().slice(0, 400) || '(no stderr)'}`,
      );
    }
  };

  // Kick off async bootstrap; failures funnel through fireClose so callers
  // never see a half-initialized transport.
  bootstrap().catch((err) => {
    logger.error('bootstrap failed', { message: (err as Error).message });
    fireClose(`bootstrap failed: ${(err as Error).message}`);
  });

  return {
    writeLine(line: string): Promise<void> {
      if (state === 'closed') {
        return Promise.reject(new Error('SshDaemonTransport.writeLine after close'));
      }
      if (state === 'connecting') {
        return new Promise<void>((resolve, reject) => {
          pendingWrites.push({ line, resolve, reject });
        });
      }
      return sendTextFrame(line);
    },

    onLine(handler: LineHandler): () => void {
      lineHandlers.add(handler);
      if (!lineHandlerArmed) {
        lineHandlerArmed = true;
        if (lineBuffer.length > 0) {
          const drained = lineBuffer.splice(0);
          for (const line of drained) {
            for (const cb of lineHandlers) cb(line);
          }
        }
      }
      return () => { lineHandlers.delete(handler); };
    },

    onStderr(handler: StderrHandler): () => void {
      stderrHandlers.add(handler);
      return () => { stderrHandlers.delete(handler); };
    },

    onClose(handler: CloseHandler): () => void {
      closeHandlers.add(handler);
      return () => { closeHandlers.delete(handler); };
    },

    async close(reason = 'SshDaemonTransport.close()'): Promise<void> {
      if (state === 'closed') return;
      // Polite close frame (if we have a sender) — gives the daemon a clean
      // EOF on the proxy; not strictly required but cleaner.
      if (sender && state === 'open') {
        try {
          await new Promise<void>((resolve) => {
            sender!.close(1000, 'client closing', true, () => resolve());
            // 不长等 — close 帧丢了也无所谓, channel.kill 兜底。
            setTimeout(resolve, 500).unref?.();
          });
        } catch { /* swallow */ }
      }
      fireClose(reason);
    },
  };
}

/**
 * Conservative POSIX single-quote escape; same shape as ssh-keys.ts shellQuote.
 *
 * Exported so the escape rule (which a typo in could let socket paths or
 * the codex binary path break out of the shell command) has unit coverage.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
