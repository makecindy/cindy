import { randomBytes } from 'node:crypto';
import type { Client } from 'ssh2';
import type { ExecOpts, ExecResult } from './RemoteHost.js';
import { MAX_PTY_INPUT_BUFFER_BYTES, openPtyShell, type PtyShell } from './ptyShell.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PREAMBLE_CHARS = 64 * 1024;
const slash = String.fromCharCode(92);
const quote = (value: string) => "'" + value.replace(/'/g, "'" + slash + "''") + "'";
// Printable Bash ANSI-C quoting keeps multiline commands on one input line;
// their contents remain visible in the normal bastion command audit.
const bashQuote = (value: string) => "$'" + value
  .split(slash).join(slash + slash).split("'").join(slash + "'")
  .split(String.fromCharCode(10)).join(slash + 'n')
  .split(String.fromCharCode(9)).join(slash + 't')
  .replace(/[\u0000-\u001f\u007f]/g, char => slash + 'x' + char.charCodeAt(0).toString(16).padStart(2, '0')) + "'";

/**
 * No automatic retry of exec: replaying an arbitrary command could repeat a write.
 * Establish a fresh PTY, confirm an actual shell with a nonce, then run once.
 * No remote files or agents are installed. Startup/echo/prompt text is discarded.
 */
export function execPtyShell(
  client: Client, command: string, options: ExecOpts | undefined, isCurrent: () => boolean,
): Promise<ExecResult> {
  // An echoed PTY command and its argv are audited. Never embed reversible
  // stdin there; reject it before opening a shell rather than disclose input.
  if (options?.input) {
    return Promise.reject(new Error('PTY command transport does not support stdin input.'));
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(command)) {
    return Promise.reject(new Error('PTY command contains unsupported control characters.'));
  }
  if (Buffer.byteLength(command) > MAX_PAYLOAD_BYTES) {
    return Promise.reject(new Error('PTY command must be at most 64 KiB.'));
  }
  const env = options?.env ?? {};
  if (Object.keys(env).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    return Promise.reject(new Error('Invalid PTY environment variable name.'));
  }
  const nonce = randomBytes(16).toString('hex');
  const ready = '\x1e' + nonce + '_READY\x1f';
  const start = '\x1e' + nonce + '_START\x1f';
  const exitPrefix = '\x1e' + nonce + '_EXIT:';
  // Never disable echo or batch Enter with the input. Koko's command policy
  // parses server echo on a separate Enter packet (parser.go parseInputState).
  const handshakeEcho = nonce + '_HANDSHAKE_INPUT';
  const commandEcho = nonce + '_COMMAND_INPUT';
  const handshake = 'printf ' + quote(slash + '036' + nonce + '_READY' + slash + '037') +
    ' # ' + handshakeEcho;
  const envArgs = Object.entries(env).map(([key, value]) => bashQuote(key + '=' + value)).join(' ');
  const script = [
    'printf ' + quote(slash + '036' + nonce + '_START' + slash + '037'),
    'c=$1; shift',
    'env "$@" bash -c "$c" </dev/null',
    's=$?',
    'printf ' + quote(slash + '036' + nonce + '_EXIT:%d' + slash + '037') + ' "$s"',
  ].join('; ');
  // Let finish close the shell after the verified footer is received. An outer
  // exit can make the bastion close the channel before buffered output arrives.
  // Quote the user command once as a positional argument, not inside another
  // quoted script. Even 64KiB of quotes fits the bounded PTY write queue.
  const run = 'bash -c ' + quote(script) + ' cindy-pty ' + bashQuote(command) +
    (envArgs ? ' ' + envArgs : '') + ' # ' + commandEcho;
  if (Buffer.byteLength(run) > MAX_PTY_INPUT_BUFFER_BYTES) {
    return Promise.reject(new Error('PTY encoded command and environment exceed the terminal input limit.'));
  }

  return new Promise((resolve, reject) => {
    const abort = new AbortController();
    let shell: PtyShell | undefined;
    let phase: 'handshake-echo' | 'ready' | 'command-echo' | 'start' | 'output' = 'handshake-echo';
    let pending = '';
    let stdout = '';
    let outputBytes = 0;
    let preambleChars = 0;
    let settled = false;
    const cap = options?.maxOutputBytes ?? 16 * 1024 * 1024;
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const finish = (result?: ExecResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.abort();
      shell?.close();
      pending = '';
      if (result) resolve(result);
      else reject(error ?? new Error('PTY command did not return a verified result.'));
    };
    const append = (text: string) => {
      if (!text || settled) return;
      const bytes = Buffer.from(text);
      if (cap > 0 && outputBytes + bytes.length > cap) {
        stdout += bytes.subarray(0, Math.max(0, cap - outputBytes)).toString('utf8');
        finish({ stdout: stdout.replace(/\r\n/g, '\n'), stderr: '', exitCode: null, signal: null, truncated: true, stderrMerged: true });
        return;
      }
      outputBytes += bytes.length;
      stdout += text;
    };
    const timer = setTimeout(() => finish(undefined,
      new Error((options?.label ?? 'exec') + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
    timer.unref?.();
    const onData = (chunk: string) => {
      if (settled) return;
      pending += chunk;
      while (!settled && phase !== 'output') {
        if (phase === 'handshake-echo' || phase === 'command-echo') {
          // Terminal wrapping can pad the echoed marker with spaces/tabs.
          // Normalize only echo matching; command output retains its whitespace.
          const echoed = pending.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\r\n\t ]/g, '');
          const marker = phase === 'handshake-echo' ? handshakeEcho : commandEcho;
          if (!echoed.includes(marker)) {
            if (pending.length > MAX_PREAMBLE_CHARS * 8) finish();
            return;
          }
          pending = '';
          phase = phase === 'handshake-echo' ? 'ready' : 'start';
          try { shell?.write('\r'); } catch { finish(); }
          return;
        }
        const marker = phase === 'ready' ? ready : start;
        const index = pending.indexOf(marker);
        if (index < 0) {
          preambleChars += Math.max(0, pending.length - marker.length);
          pending = pending.slice(-marker.length);
          if (preambleChars > MAX_PREAMBLE_CHARS) finish();
          return;
        }
        pending = pending.slice(index + marker.length);
        if (phase === 'ready') {
          phase = 'command-echo';
          try { shell?.write(run); } catch { finish(); }
        } else { phase = 'output'; }
      }
      if (settled) return;
      const index = pending.indexOf(exitPrefix);
      if (index >= 0) {
        append(pending.slice(0, index));
        pending = pending.slice(index);
        const end = pending.indexOf('\x1f', exitPrefix.length);
        if (end < 0) {
          if (pending.length > exitPrefix.length + 3) finish();
          return;
        }
        const value = pending.slice(exitPrefix.length, end);
        if (!/^\d{1,3}$/.test(value) || Number(value) > 255) { finish(); return; }
        finish({ stdout: stdout.replace(/\r\n/g, '\n'), stderr: '', exitCode: Number(value), signal: null, stderrMerged: true });
      } else {
        const keep = exitPrefix.length - 1;
        if (pending.length > keep) {
          append(pending.slice(0, -keep));
          pending = pending.slice(-keep);
        }
      }
    };
    void openPtyShell(client, {
      cols: 80, rows: 24, signal: abort.signal, onData,
      onExit: () => finish(),
    }, isCurrent).then(handle => {
      shell = handle;
      if (settled) { shell.close(); return; }
      try { shell.write(handshake); } catch { finish(); }
    }).catch(() => finish());
  });
}
