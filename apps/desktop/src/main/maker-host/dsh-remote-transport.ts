/** DSH JSONL transport over a single SSH exec channel.
 *
 * The launch envelope (config, bridge source and API key) is sent through
 * stdin before any JSON-RPC frame.  It is deliberately not placed in argv,
 * the remote environment of the SSH daemon, or a persistent config file.
 */
import { StringDecoder } from 'node:string_decoder';

import type { DshTransport, DshTransportCloseInfo } from '@cindy/maker-core';
import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { redactCredentialText } from './pi-remote-transport.js';

interface Logger {
  warn(msg: string, ctx?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface SshDshTransportOptions {
  remoteHost: RemoteHost;
  workingDir: string;
  configYaml: string;
  bridgeSource: string;
  apiKey: string;
  sessionRoot: string;
  logger: Logger;
  handshakeTimeoutMs?: number;
}

const MAX_JSONL_BUFFER_CHARS = 16 * 1024 * 1024;
const MAX_PENDING_WRITES = 256;

/** Fixed wrapper: only caller data enters stdin, never shell source or argv. */
const DSH_REMOTE_WRAPPER = String.raw`set -eu
ROOT="$HOME/.xdt-server/v1/dsh"
NODE="$HOME/.xdt-server/v1/node/bin/node"
BIN="$ROOT/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js"
[ -x "$NODE" ] || { printf '%s\n' 'CINDY_DSH_ERROR bundled node is missing' >&2; exit 72; }
[ -f "$BIN" ] || { printf '%s\n' 'CINDY_DSH_ERROR runtime is not installed' >&2; exit 73; }
umask 077
mkdir -p "$ROOT/runs"
RUN_DIR="$(mktemp -d "$ROOT/runs/session.XXXXXXXX")"
cleanup() { rm -rf "$RUN_DIR"; }
trap cleanup EXIT HUP INT TERM
IFS= read -r CONFIG_B64
IFS= read -r BRIDGE_B64
IFS= read -r API_KEY_B64
IFS= read -r DSH_CWD_B64
IFS= read -r SESSION_ROOT_B64
printf '%s' "$CONFIG_B64" | base64 -d > "$RUN_DIR/cordis.yml"
printf '%s' "$BRIDGE_B64" | base64 -d > "$RUN_DIR/cindy-dsh-bridge.mjs"
API_KEY="$(printf '%s' "$API_KEY_B64" | base64 -d)"
DSH_CWD="$(printf '%s' "$DSH_CWD_B64" | base64 -d)"
DSH_SESSION_ROOT="$(printf '%s' "$SESSION_ROOT_B64" | base64 -d)"
export DEEPSEEK_API_KEY="$API_KEY" DSH_CWD DSH_SESSION_ROOT="$DSH_SESSION_ROOT"
cd "$DSH_CWD"
exec "$NODE" "$BIN" "$RUN_DIR/cordis.yml"`;

function envelopeLine(value: string): string {
  // Values are one physical line so the remote wrapper can consume exactly
  // five headers before transparently relaying JSONL.
  return Buffer.from(value, 'utf8').toString('base64');
}

export async function createSshDshTransport(opts: SshDshTransportOptions): Promise<DshTransport> {
  const logger = opts.logger.child('dsh-ssh-transport');
  const channel = await opts.remoteHost.execStream(`bash -c ${shellQuote(DSH_REMOTE_WRAPPER)}`, {
    timeoutMs: opts.handshakeTimeoutMs ?? 15_000,
  });
  let closed = false;
  let stdoutBuffer = '';
  const decoder = new StringDecoder('utf8');
  const lines = new Set<(line: string) => void>();
  const stderr = new Set<(line: string) => void>();
  const closes = new Set<(info: DshTransportCloseInfo) => void>();
  const pending: Array<{ line: string; resolve: () => void; reject: (error: Error) => void }> = [];
  let waitingDrain = false;

  const fireClose = (info: DshTransportCloseInfo): void => {
    if (closed) return;
    closed = true;
    stdoutBuffer += decoder.end();
    if (stdoutBuffer.trim()) for (const handler of lines) handler(stdoutBuffer.replace(/\r$/, ''));
    stdoutBuffer = '';
    const error = new Error(`dsh SSH transport closed: ${info.reason}`);
    for (const item of pending.splice(0)) item.reject(error);
    for (const handler of closes) { try { handler(info); } catch { /* observer isolation */ } }
  };
  const drain = (): void => {
    if (closed || waitingDrain) return;
    const item = pending[0];
    if (!item) return;
    try {
      if (!channel.write(`${item.line}\n`)) {
        waitingDrain = true;
        return;
      }
      pending.shift(); item.resolve(); drain();
    } catch (error) {
      pending.shift(); item.reject(error instanceof Error ? error : new Error(String(error))); drain();
    }
  };
  channel.onDrain(() => { waitingDrain = false; drain(); });
  channel.onStdoutBytes((chunk) => {
    stdoutBuffer += decoder.write(chunk);
    if (stdoutBuffer.length > MAX_JSONL_BUFFER_CHARS) {
      fireClose({ code: null, signal: null, reason: 'dsh SSH stdout exceeded 16MB without a newline' });
      try { channel.kill(); } catch { /* best effort */ }
      return;
    }
    for (;;) {
      const index = stdoutBuffer.indexOf('\n');
      if (index < 0) break;
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      for (const handler of lines) handler(line);
    }
  });
  channel.onStderr((chunk) => {
    const safe = redactCredentialText(chunk).slice(0, 2000);
    if (safe.trim()) logger.warn('dsh remote stderr', { line: safe });
    for (const handler of stderr) handler(safe);
  });
  channel.onError((error) => fireClose({ code: null, signal: null, reason: `dsh SSH channel error: ${redactCredentialText(error.message)}` }));
  channel.onClose(({ code, signal }) => fireClose({ code, signal: signal as NodeJS.Signals | null, reason: `dsh remote process exited (code=${code}, signal=${signal})` }));

  // These five writes complete the private launch envelope. JSON-RPC writes
  // are not permitted until the envelope has drained, preserving framing.
  for (const header of [opts.configYaml, opts.bridgeSource, opts.apiKey, opts.workingDir, opts.sessionRoot].map(envelopeLine)) {
    if (!channel.write(`${header}\n`)) {
      await new Promise<void>((resolve, reject) => {
        const off = channel.onDrain(() => { off(); resolve(); });
        channel.onError((error) => { off(); reject(error); });
      });
    }
  }

  return {
    writeLine(line) {
      if (closed) return Promise.reject(new Error('dsh SSH transport already closed'));
      if (pending.length >= MAX_PENDING_WRITES) {
        fireClose({ code: null, signal: null, reason: 'dsh SSH write queue exceeded 256 entries' });
        try { channel.kill(); } catch { /* best effort */ }
        return Promise.reject(new Error('dsh SSH write queue overflow'));
      }
      return new Promise<void>((resolve, reject) => { pending.push({ line, resolve, reject }); drain(); });
    },
    onLine(handler) { lines.add(handler); return () => lines.delete(handler); },
    onStderr(handler) { stderr.add(handler); return () => stderr.delete(handler); },
    onClose(handler) { closes.add(handler); return () => closes.delete(handler); },
    async close(reason = 'dsh SSH transport close()') { if (!closed) { fireClose({ code: null, signal: null, reason }); try { channel.kill(); } catch { /* best effort */ } } },
    get pid() { return undefined; },
    isClosed() { return closed; },
  };
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
