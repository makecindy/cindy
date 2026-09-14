import { readFileSync } from 'node:fs';
import { transpileModule, ScriptTarget } from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { parseDesktopIceReply } from '@cindy/device-link';
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
function between(source: string, start: string, end: string) {
  // Git may check out this TypeScript source with CRLF on Windows.
  source = source.replace(/\r\n/g, '\n');
  const from = source.indexOf(start),
    to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error('Host command source missing');
  return source.slice(from, to);
}
function harness(sourceText = source) {
  const host = { isDestroyed: () => false, send: vi.fn() },
    stopVideo = vi.fn();
  let reply!: (event: object, id: string, value: unknown) => void;
  const deps = {
    host,
    stopVideo,
    parseDesktopIceReply,
    setTimeout,
    clearTimeout,
    captureWindow: { assertSender() {} },
    throwIpcError: () => {
      throw new Error('PERMISSION_DENIED');
    },
    DESKTOP_LOCAL: { COMMAND: 'command', REPLY: 'reply' },
    ipcMain: {
      handle: (_name: string, handler: typeof reply) => {
        reply = handler;
      },
    },
  };
  const code = `let pending:any=null, videoAttempt='attempt';
    ${between(sourceText, 'function requestHost(', 'async function ice(')}
    ${between(sourceText, 'ipcMain.handle(DESKTOP_LOCAL.REPLY,', 'ipcMain.handle(\n    DESKTOP_LOCAL.INPUT,')}
    return requestHost;`;
  const js = transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const request = new Function(...Object.keys(deps), js)(...Object.values(deps));
  return {
    host,
    stopVideo,
    request,
    reply: (id: string, data: unknown, sender = host) => reply({ sender }, id, data),
  };
}
afterEach(() => vi.useRealTimers());
const lineEndings = ['\n', '\r\n'];
it.each(['ice', 'offer'].flatMap((op) => lineEndings.map((lineEnding) => ({ op, lineEnding }))))(
  'limits $op timeout cleanup with $lineEnding source',
  async ({ op, lineEnding }) => {
    vi.useFakeTimers();
    const h = harness(source.replace(/\r?\n/g, lineEnding));
    const result = h.request({ id: 'first', op }, 4000);
    const rejected = expect(result).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
    await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    expect(h.stopVideo).toHaveBeenCalledTimes(op === 'offer' ? 1 : 0);
    const next = h.request({ id: 'next', op: 'offer' }, 10_000);
    expect(() => h.reply('first', 'late')).toThrow('PERMISSION_DENIED');
    h.reply('next', 'answer');
    await expect(next).resolves.toBe('answer');
  },
);
it.each(lineEndings)(
  'rejects concurrent commands and malformed ICE without stopping video (%j source)',
  async (lineEnding) => {
    vi.useFakeTimers();
    const h = harness(source.replace(/\r?\n/g, lineEnding));
    const result = h.request({ id: 'ice', op: 'ice' }, 4000);
    await expect(h.request({ id: 'offer', op: 'offer' }, 4000)).rejects.toThrow(
      'DESKTOP_VIDEO_BUSY',
    );
    expect(h.host.send).toHaveBeenCalledTimes(1);
    h.reply('ice', { attemptId: 'wrong', candidates: [], next: 0, complete: true });
    await expect(result).rejects.toThrow('DESKTOP_VIDEO_STOPPED');
    expect(h.stopVideo).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
