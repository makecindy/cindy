import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// §3.2, unit. A single isolated Node process runs the desktop factory and actual
// fatal process logger. Vitest owns its own rejection listeners in the parent.
it('preserves desktop settlement order and one fatal rejection per throwing delivery, including a newer generation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-runtime-settlement-'));
  try {
    const fixture = fileURLToPath(new URL('./fixtures/runtime-settlement-process.mjs', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', fixture, dir]);
    const logFiles = (await readdir(dir)).filter(name => /^main-.*\.log$/.test(name));
    const log = (await Promise.all(logFiles.map(name => readFile(path.join(dir, name), 'utf8')))).join('\n');
    expect(log.split('\n').filter(line => line.includes('[FATAL] [process] unhandledRejection:'))
      .map(line => line.split('unhandledRejection: Error: ')[1])).toEqual(['history-error', 'broadcast-error', 'advanced-error']);
    expect(JSON.parse(stdout)).toEqual([
      'success', 'apply-first', 'returned-void', 'info',
      'history-error', 'apply-first', 'returned-void', 'warn', 'projection', 'history',
      'broadcast-error', 'apply-first', 'returned-void', 'warn', 'projection', 'history', 'broadcast',
      'advanced-error', 'apply-first', 'returned-void', 'warn', 'projection', 'history', 'apply-second', 'info',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
