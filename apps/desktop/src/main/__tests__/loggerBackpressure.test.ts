import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => 'test', getPath: () => '' },
}));

import { createLogger, initLogger, writeCcDebugLine } from '../logger.js';

it('bounds outstanding writes across session eviction and stops opening streams while saturated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-log-backpressure-'));
  const streams: Writable[] = [];
  const completions: Array<() => void> = [];
  const records: string[] = [];
  const open = vi.spyOn(fs, 'createWriteStream').mockImplementation((file) => {
    const agent = String(file).endsWith('.ndjson');
    const stream = new Writable({
      write(chunk, _encoding, done) {
        if (agent) { records.push(String(chunk)); completions.push(done); }
        else done();
      },
    });
    streams.push(stream);
    return stream as fs.WriteStream;
  });
  try {
    initLogger({ isDev: false, level: 'trace', logDir: root });
    const line = 'x'.repeat(32 * 1024);
    let accepted = 0;
    for (let i = 0; i < 256; i++) {
      if (writeCcDebugLine(line, `session-${i}`)) accepted++;
    }
    expect(accepted).toBeGreaterThan(32); // Includes streams retired from the LRU.
    expect(accepted).toBeLessThan(128);
    expect(records.reduce((sum, record) => sum + Buffer.byteLength(record), 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    const opened = open.mock.calls.length;
    for (let i = 0; i < 256; i++) expect(writeCcDebugLine(line, `more-${i}`)).toBe(false);
    expect(open).toHaveBeenCalledTimes(opened);
    // Synchronous producers cannot retry; the next accepted record reports loss.
    createLogger('maker').info(line);
    for (const complete of completions.splice(0)) complete();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writeCcDebugLine('recovered', 'recovery')).toBe(true);
    expect(JSON.parse(records.at(-1)!)).toMatchObject({ msg: 'recovered', droppedRecords: 1 });
  } finally {
    for (const complete of completions.splice(0)) complete();
    for (const stream of streams) stream.destroy();
    open.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
