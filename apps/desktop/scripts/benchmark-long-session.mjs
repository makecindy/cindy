/** Repeatable production-store probe, with synthetic persistence/IPC.
 * node apps/desktop/scripts/benchmark-long-session.mjs [maintenance-cycles=3720]
 * Uses an isolated Node worker, never a running Cindy profile or model account.
 * Logical hours are accelerated timer time, NOT wall-clock soak or Electron RSS.
 */
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startVitest } from 'vitest/node';

const cycles = Number(process.argv[2] ?? 3720);
if (!Number.isSafeInteger(cycles) || cycles < 1) throw new Error('Expected a positive maintenance cycle count');
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
process.env.CINDY_LONG_SESSION_MEASURE = '1';
process.env.CINDY_LONG_SESSION_CYCLES = String(cycles);
const measurements = [];
const ctx = await startVitest('test', ['src/renderer/__tests__/localHistoryViewUserEcho.test.ts'], {
  watch: false, testNamePattern: 'completed history plus eight worker|many maintenance', testTimeout: 120000,
  pool: 'forks', maxWorkers: 1,
  poolOptions: { forks: { execArgv: ['--expose-gc', '--no-experimental-webstorage'] } },
  onConsoleLog(log) {
    const match = /LONG_SESSION_(MEMORY|SOAK) (\{.*\})/.exec(log);
    if (!match) return false;
    measurements.push({ kind: match[1], ...JSON.parse(match[2]) });
  },
});
try {
  if (!ctx || ctx.state.getFiles().some(file => file.result?.state !== 'pass')
    || measurements.filter(row => row.kind === 'MEMORY').length !== 9
    || measurements.filter(row => row.kind === 'SOAK').length !== 1) {
    throw new Error('Long-session benchmark did not complete successfully');
  }
  const output = await mkdtemp(path.join(tmpdir(), 'cindy-long-session-'));
  const report = path.join(output, 'report.json');
  await writeFile(report, JSON.stringify({ node: process.version, platform: process.platform,
    scope: 'Node production-store harness; synthetic IPC; forced-GC heap; accelerated timers; no Electron rendering or real agents',
    measurements }, null, 2));
  console.log(`LONG_SESSION_REPORT=${report}`);
} finally {
  await ctx?.close();
}
