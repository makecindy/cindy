import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { TerminalClient } from './contracts.js';
import type { ProviderTerminalFrame } from './models/claude-terminal.js';

/** The controller keeps using its protected login lease while the foreground
 * vendor CLI runs on the selected server. Input never becomes a task message. */
export async function runProviderTerminal(client: TerminalClient, id: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
  const exchange = async (callback: Record<string, unknown>) => {
    const payload = { command: 'submit', id, callback };
    try { return (await client.invoke<{ state: ProviderTerminalFrame }>('terminal:provider-login', [payload])).state; }
    finally { delete callback.data; }
  };
  const abort = new AbortController();
  let cursor = 0, failure: unknown, writes = Promise.resolve(), code = 1;
  const fail = (error: unknown) => { failure = error; abort.abort(); };
  const send = (data: string) => {
    if (abort.signal.aborted) return;
    if (data.includes('\u001d')) { abort.abort(); return; }
    process.stdin.pause();
    writes = writes.then(async () => { for (const part of data.match(/[\s\S]{1,32768}/gu) ?? []) await exchange({ op: 'write', data: part, requestId: randomUUID() }); })
      .then(() => { if (!abort.signal.aborted) process.stdin.resume(); }).catch(fail);
  };
  const resize = () => { void exchange({ op: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }).catch(fail); };
  const stop = () => abort.abort();
  const wasRaw = process.stdin.isRaw;
  process.stdin.setEncoding('utf8'); process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('data', send); process.stdout.on('resize', resize); process.once('SIGTERM', stop);
  try {
    resize();
    while (!abort.signal.aborted) {
      const frame = await exchange({ op: 'read', after: cursor });
      for (const chunk of frame.chunks ?? []) { if (!process.stdout.write(chunk.data)) await once(process.stdout, 'drain'); cursor = chunk.sequence; }
      if (frame.exit || frame.state.status !== 'pending') { code = frame.state.status === 'success' ? 0 : 1; break; }
      if (!frame.more) await pause(80, undefined, { signal: abort.signal }).catch(() => {});
    }
  } finally {
    process.stdin.off('data', send); process.stdout.off('resize', resize); process.off('SIGTERM', stop);
    process.stdin.setRawMode(wasRaw); process.stdin.pause(); await writes;
    await client.invoke('terminal:provider-login', [{ command: 'cancel', id }]).catch(() => {});
    process.stdout.write('\u001b[?1049l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?2004l\u001b[0m\u001b[?25h\r\n');
  }
  if (failure) throw failure;
  return code;
}
