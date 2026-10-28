import { StringDecoder } from 'node:string_decoder';
import type { Client, ClientChannel } from 'ssh2';

export const MAX_PTY_INPUT_BUFFER_BYTES = 256 * 1024;

export interface PtyShellOptions {
  cols: number;
  rows: number;
  signal: AbortSignal;
  onData: (chunk: string) => void;
  onExit: (exit: { code: number | null; signal: string | null }) => void;
}

export interface PtyShell {
  write(data: string): void;
  close(): void;
}

/** Interactive shell request, deliberately separate from exec(cmd, { pty }). */
export function openPtyShell(
  client: Client,
  options: PtyShellOptions,
  isCurrent: () => boolean,
): Promise<PtyShell> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ended = false;
    let channel: ClientChannel | undefined;
    let exit = { code: null as number | null, signal: null as string | null };
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', cancel);
      client.off('close', cancel);
    };
    const finish = () => {
      if (ended) return;
      ended = true;
      cleanup();
      if (settled && channel) {
        const tail = stdout.end() + stderr.end();
        if (tail) options.onData(tail);
        options.onExit(exit);
      } else {
        settled = true;
        reject(new Error('SSH terminal setup interrupted.'));
      }
    };
    const cancel = () => {
      if (ended) return;
      finish();
      try { channel?.close(); } catch { /* transport already closed */ }
    };
    const timer = setTimeout(cancel, 20_000);
    timer.unref?.();
    options.signal.addEventListener('abort', cancel, { once: true });
    client.once('close', cancel);
    if (options.signal.aborted || !isCurrent()) { cancel(); return; }
    try {
      client.shell({ term: 'xterm-256color', cols: options.cols, rows: options.rows }, (err, stream) => {
        if (ended || options.signal.aborted || !isCurrent()) {
          try { stream?.close(); } catch { /* late channel must not escape */ }
          cancel();
          return;
        }
        if (err || !stream) { cancel(); return; }
        channel = stream;
        settled = true;
        clearTimeout(timer);
        stream.on('data', (data: Buffer) => {
          if (!isCurrent()) { cancel(); return; }
          if (!ended) options.onData(stdout.write(data));
        });
        stream.stderr.on('data', (data: Buffer) => {
          if (!isCurrent()) { cancel(); return; }
          if (!ended) options.onData(stderr.write(data));
        });
        stream.on('exit', (code: number | null, signal?: string) => {
          exit = { code: Number.isInteger(code) ? code : null, signal: signal ?? null };
        });
        stream.once('close', finish);
        stream.on('error', cancel); // server errors can echo input; never forward them
        resolve({
          write(data) {
            if (!isCurrent()) { cancel(); return; }
            if (ended) return;
            // Bound the ssh2 writable queue when a server stops consuming input.
            if (stream.writableLength + Buffer.byteLength(data) > MAX_PTY_INPUT_BUFFER_BYTES) {
              cancel();
              throw new Error('SSH terminal input buffer full.');
            }
            stream.write(data);
          },
          close: cancel,
        });
      });
    } catch { cancel(); }
  });
}
