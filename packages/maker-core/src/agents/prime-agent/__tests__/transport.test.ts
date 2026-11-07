/**
 * Prime Agent transport 单元测试 —— JSONL 分帧合规性。
 *
 * 重点: **只按 \n 切行**。Prime Agent 的 `LineWriter::write` 只 push '\n'
 * (crates/pa-daemon/src/rpc/mod.rs:66-70), 而 Node 的 `readline` 会按
 * U+2028/U+2029 切行 —— 这两个字符在 JSON 字符串里合法, 用 readline 会把一帧
 * 撕成两半。这里直接钉住这个契约。
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_JSONL_BUFFER_CHARS,
  attachJsonlReader,
} from '../transport.js';

function collect(stream: PassThrough): { lines: string[]; oversized: () => number } {
  const lines: string[] = [];
  let oversizedCount = 0;
  attachJsonlReader(
    stream,
    (line) => lines.push(line),
    () => { oversizedCount += 1; },
  );
  return { lines, oversized: () => oversizedCount };
}

describe('attachJsonlReader — LF-only framing', () => {
  it('splits only on \\n', () => {
    const stream = new PassThrough();
    const { lines } = collect(stream);
    stream.write('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('does NOT split on U+2028 / U+2029 (Node readline would)', () => {
    const stream = new PassThrough();
    const { lines } = collect(stream);
    // U+2028 LINE SEPARATOR 与 U+2029 PARAGRAPH SEPARATOR 在 JSON 字符串里合法。
    const frame = JSON.stringify({ type: 'message_update', text: 'line1 line2 line3' });
    stream.write(`${frame}\n`);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      type: 'message_update',
      text: 'line1 line2 line3',
    });
  });

  it('strips a trailing \\r (CRLF tolerance) but keeps interior \\r', () => {
    const stream = new PassThrough();
    const { lines } = collect(stream);
    stream.write('{"a":1}\r\n{"b":"x\ry"}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"b":"x\ry"}']);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const stream = new PassThrough();
    const { lines } = collect(stream);
    const frame = JSON.stringify({ type: 'prompt', message: 'a'.repeat(5000) });
    const bytes = Buffer.from(`${frame}\n`, 'utf8');
    // 逐字节喂, 再按奇数偏移喂一遍, 覆盖多字节字符被切开的情况。
    for (const size of [1, 3, 7, 64, 1024]) {
      lines.length = 0;
      for (let i = 0; i < bytes.length; i += size) {
        stream.write(bytes.subarray(i, i + size));
      }
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toEqual({ type: 'prompt', message: 'a'.repeat(5000) });
    }
  });

  it('does not split a multi-byte UTF-8 character across chunks', () => {
    const stream = new PassThrough();
    const { lines } = collect(stream);
    const frame = JSON.stringify({ type: 'message_update', text: '中文测试𝕏🎉' });
    const bytes = Buffer.from(`${frame}\n`, 'utf8');
    for (let i = 0; i < bytes.length; i += 1) {
      stream.write(bytes.subarray(i, i + 1));
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      type: 'message_update',
      text: '中文测试𝕏🎉',
    });
  });

  it('flushes a trailing frame without a newline on stream end', async () => {
    const stream = new PassThrough();
    const { lines } = collect(stream);
    stream.write('{"a":1}');
    // 'end' 是异步发的(Readable 走 process.nextTick), 必须等它。
    const ended = new Promise<void>((resolve) => stream.once('end', resolve));
    stream.end();
    await ended;
    expect(lines).toEqual(['{"a":1}']);
  });

  it('drops an oversized frame and resumes framing at the next newline', () => {
    const stream = new PassThrough();
    const { lines, oversized } = collect(stream);
    const huge = 'x'.repeat(MAX_JSONL_BUFFER_CHARS + 10);
    stream.write(`${huge}\n{"after":1}\n`);
    expect(oversized()).toBeGreaterThan(0);
    expect(lines).toEqual(['{"after":1}']);
  });

  it('drops a newline-less buffer that grows past the limit, then recovers', () => {
    const stream = new PassThrough();
    const { lines, oversized } = collect(stream);
    // 先喂一个超限且不带 \n 的块(触发 skippingOversizedLine), 再补 \n + 一帧合法数据。
    stream.write('y'.repeat(MAX_JSONL_BUFFER_CHARS + 10));
    stream.write('\n{"recovered":true}\n');
    expect(oversized()).toBeGreaterThan(0);
    expect(lines).toEqual(['{"recovered":true}']);
  });

  it('does not throw on a stream error event', () => {
    const stream = new PassThrough();
    const { lines } = collect(stream);
    // 未处理 'error' 会让 Readable 抛未捕获异常崩进程; transport 层必须吞掉。
    expect(() => stream.emit('error', new Error('EPIPE'))).not.toThrow();
    stream.write('{"ok":1}\n');
    expect(lines).toEqual(['{"ok":1}']);
  });
});

describe('createPrimeAgentStdioTransport', () => {
  it('rejects writes after close() and reports isClosed', async () => {
    const { createPrimeAgentStdioTransport } = await import('../transport.js');
    const logger = {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
      warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
      child: () => logger,
    };
    const transport = createPrimeAgentStdioTransport({
      // 一个必然存在的可执行文件; 我们不会真的跟它对话, 只测 close 语义。
      binaryPath: process.execPath,
      args: ['--version'],
      cwd: process.cwd(),
      env: { ...process.env },
      logger,
      stdinCloseGraceMs: 200,
    });

    expect(transport.isClosed()).toBe(false);
    expect(typeof transport.pid).toBe('number');
    await transport.close();
    expect(transport.isClosed()).toBe(true);
    await expect(transport.writeLine('{"a":1}')).rejects.toThrow(/already closed/);
    // 幂等: 第二次 close 不再抛。
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
