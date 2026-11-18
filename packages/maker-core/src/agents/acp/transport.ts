import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AcpTransport } from './client.js';

/** An allowlist avoids inheriting any provider API/ADC or routing credentials. */
export function personalSubscriptionEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (source[key]) env[key] = source[key];
  }
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  return env;
}
export function spawnAcp(binary: string, args: string[], cwd: string, options: { profileStorage?: boolean } = {}): AcpTransport {
  const env = personalSubscriptionEnv(globalThis.process.env);
  // The pinned CLI uses its app-data token file on this code path instead of
  // the shared native credential store. Enable it only for isolated profiles.
  if (options.profileStorage) env.WSL_DISTRO_NAME = 'Cindy';
  const process = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const listeners = new Set<(line: string) => void>(); const closed = new Set<() => void>();
  let ended = false; let tail = ''; const decoder = new StringDecoder('utf8');
  let closing: Promise<void> | undefined;
  const end = () => { if (!ended) { ended = true; for (const l of closed) l(); } };
  process.on('error', end); process.on('exit', end);
  process.stdout.on('data', (chunk: Buffer) => {
    tail += decoder.write(chunk);
    if (Buffer.byteLength(tail) > 8 * 1024 * 1024) { process.kill(); end(); return; }
    let index: number;
    while ((index = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, index); tail = tail.slice(index + 1);
      if (line.trim()) for (const l of listeners) l(line);
    }
  });
  return {
    write(line) { if (ended) throw new Error('ACP_CLOSED'); process.stdin.write(line); },
    onLine(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    onClose(l) { closed.add(l); if (ended) queueMicrotask(l); return () => { closed.delete(l); }; },
    async close() {
      if ((ended && process.pid === undefined) || process.exitCode !== null || process.signalCode !== null) return;
      closing ??= new Promise<void>((resolve, reject) => {
        const onExit = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          process.removeListener('exit', onExit);
          reject(new Error('ACP_PROCESS_EXIT_UNCONFIRMED'));
        }, 5000);
        process.once('exit', onExit);
        process.kill('SIGTERM');
      }).finally(() => { closing = undefined; });
      await closing;
    },
  };
}
