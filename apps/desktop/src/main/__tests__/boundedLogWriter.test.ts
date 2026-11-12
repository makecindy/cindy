import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BoundedLogWriter } from '../bounded-log-writer.js';

describe('log output budgets', () => {
  it('honors drain rather than interpreting false as a rejected write', async () => {
    let complete!: () => void;
    const stream = new Writable({ highWaterMark: 4, write(_chunk, _encoding, cb) { complete = cb; } });
    const writer = new BoundedLogWriter(16);
    expect(writer.write(stream, '1234')).toBe(true);
    expect(writer.write(stream, '5678')).toBe(false);
    expect(stream.writableLength).toBe(4);
    complete();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writer.write(stream, '5678')).toBe(true);
    complete(); stream.destroy();
  });

  it('shares its byte budget with retired streams and releases it on completion', async () => {
    let complete!: () => void;
    const retired = new Writable({ write(_chunk, _encoding, cb) { complete = cb; } });
    const current = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
    const writer = new BoundedLogWriter(8);
    expect(writer.write(retired, '12345678')).toBe(true);
    retired.end();
    expect(writer.write(current, 'next')).toBe(false);
    complete();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writer.write(current, 'next')).toBe(true);
    current.destroy();
  });

  it('also bounds tiny pending records and accounts for failed writes', async () => {
    const completions: Array<(error?: Error | null) => void> = [];
    const streams = Array.from({ length: 3 }, () => new Writable({
      write(_chunk, _encoding, cb) { completions.push(cb); },
    }).on('error', () => undefined));
    const writer = new BoundedLogWriter(1024, 2);
    expect(writer.write(streams[0], 'x')).toBe(true);
    expect(writer.write(streams[1], 'x')).toBe(true);
    expect(writer.write(streams[2], 'x')).toBe(false);
    completions[0](new Error('disk failed'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writer.write(streams[2], 'x')).toBe(true);
    for (const stream of streams) stream.destroy();
  });
});
