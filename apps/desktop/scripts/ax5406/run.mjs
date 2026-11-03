/** Explicit Windows-only Chromium stress experiment. Does not start the Cindy application.
 * node apps/desktop/scripts/ax5406/run.mjs --seconds=120 --seed=5406 --scenario=mixed --ax=on --containment=on
 * Exit: 0 = completed without crash, 10 = exact reported build/RVA signature, 2 = other/inconclusive.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectDump } from './inspect-dump.mjs';
const require = createRequire(import.meta.url);
if (process.platform !== 'win32') throw new Error('This native UIA experiment currently requires Windows');
const opts = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(seconds|seed|scenario|ax|containment|query|scroll|rows|batch|rewrite|component-build|target|trace|policy|workload|mounting|anchoring|settlement|threaded|source|stream-probe|accessibility)=(.+)$/.exec(arg);
  if (!match) throw new Error(`Unknown option: ${arg}`);
  return [match[1], match[2]];
}));
const config = { seconds: Number(opts.seconds ?? 120), seed: Number(opts.seed ?? 5406),
  scenario: opts.scenario ?? 'stream', ax: opts.ax ?? 'on', containment: opts.containment ?? 'on',
  accessibility: opts.accessibility ?? 'off', query: opts.query ?? 'cdp', scroll: opts.scroll ?? 'on', rows: Number(opts.rows ?? 80),
  batch: Number(opts.batch ?? 8), rewrite: opts.rewrite ?? 'on', target: opts.target ?? 'all', trace: opts.trace ?? 'off',
  policy: opts.policy ?? 'production', workload: opts.workload ?? 'steady', mounting: opts.mounting ?? 'viewport', anchoring: opts.anchoring ?? 'on', settlement: opts.settlement ?? 'into-view', threaded: opts.threaded ?? 'on', source: opts.source ?? 'worktree', streamProbe: opts['stream-probe'] ?? 'off' };
if (!['head', 'worktree'].includes(config.source) || !['on','off'].includes(config.streamProbe)) throw new Error('Invalid source/probe');
if (!['on', 'off'].includes(config.accessibility) || !['on', 'off'].includes(config.threaded) || !['into-view', 'scroll-to', 'two-raf'].includes(config.settlement) || !['on', 'off', 'search'].includes(config.anchoring) || !['viewport', 'full'].includes(config.mounting) || !Number.isInteger(config.seconds) || config.seconds < 5 || config.seconds > 600 ||
  !Number.isInteger(config.seed) || config.seed <= 0 || config.seed > 0xffffffff ||
  !['minimal', 'stream', 'detach', 'visibility', 'inline', 'mixed', 'component'].includes(config.scenario) ||
  !['production', 'auto', 'active'].includes(config.policy) || !['steady', 'cycle', 'visual', 'scroll-tests', 'scroll-race', 'stream-tests'].includes(config.workload) ||
  !['on', 'off'].includes(config.trace) || !['on', 'off'].includes(config.ax) || !['on', 'off'].includes(config.containment) ||
  !['cdp', 'native', 'both', 'none'].includes(config.query) || !['on', 'off'].includes(config.scroll) ||
  !['all', 'assistant', 'user', 'tail'].includes(config.target) ||
  !['on', 'off'].includes(config.rewrite) || !Number.isInteger(config.rows) || config.rows < 1 || config.rows > 1000 ||
  !Number.isInteger(config.batch) || config.batch < 1 || config.batch > 32) throw new Error('Invalid experiment configuration');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-ax5406-'));
config.output = root;
config.sourceHashes = {};
for (const name of ['fixture.html', 'fixture.js', 'main.cjs', 'uia.ps1', 'component.jsx', 'component.html', 'build-component.mjs', 'visual.cjs', 'scroll-tests.cjs', 'scroll-race.cjs', 'stream-tests.cjs']) {
  config.sourceHashes[name] = createHash('sha256').update(await fs.readFile(new URL(name, import.meta.url))).digest('hex');
}
await fs.mkdir(path.join(root, 'profile'));
await fs.mkdir(path.join(root, 'dumps'));
if (config.scenario === 'component') {
  if (opts['component-build']) {
    config.componentFile = path.resolve(opts['component-build'], 'component/component.html');
    await fs.access(config.componentFile);
    await fs.copyFile(path.resolve(opts['component-build'], 'component-sources.json'), path.join(root, 'component-sources.json'));
    const buildConfig = JSON.parse(await fs.readFile(path.resolve(opts['component-build'], 'config.json'), 'utf8'));
    if ((buildConfig.source ?? 'worktree') !== config.source) throw new Error('Component build source mismatch');
    config.componentBuildSourceHashes = buildConfig.componentBuildSourceHashes || buildConfig.sourceHashes;
  } else {
    const { buildComponent } = await import('./build-component.mjs');
    config.componentFile = await buildComponent(root, config.source);
  }
}
await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
console.log(`AX5406_ARTIFACTS=${root}`);
const runtime = require('electron');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/i.test(key)) delete env[key];
const output = await fs.open(path.join(root, 'electron.log'), 'w');
const child = spawn(runtime, [fileURLToPath(new URL('./main.cjs', import.meta.url)), path.join(root, 'config.json')],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const done = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
child.stdout.on('data', data => { void output.write(data); });
child.stderr.on('data', data => { void output.write(data); });
let timedOut = false;
const stop = () => {
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
};
const timer = setTimeout(() => { timedOut = true; stop(); }, (config.seconds + 40) * 1000);
process.once('SIGINT', stop);
let exitCode;
try {
  exitCode = await done;
} finally {
  clearTimeout(timer);
  process.removeListener('SIGINT', stop);
  stop();
  await output.close();
}
const report = JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8').catch(() => '{}'));
report.processExitCode = exitCode;
report.timedOut = timedOut;
report.runtime = runtime;
if (timedOut) report.status = 'harness-timeout';
if (!report.crash && !(report.stats?.mutations > 0)) report.status = 'workload-unverified';
if (config.scenario === 'component') {
  report.componentVerified = !!(report.stats?.renderedRows > 0 && report.stats?.commits > 1 &&
    !report.stats?.errors?.length && report.stats?.layout?.display === 'flex' && report.stats?.layout?.overflowY === 'auto');
  if (!report.crash && !report.componentVerified) report.status = 'component-unverified';
}
if (!report.crash && config.ax === 'on' && ['cdp', 'both'].includes(config.query) &&
  !(report.cdpQueries > 0 && report.maxInlineTextBoxes > 0)) report.status = 'cdp-inline-text-unverified';
if (config.ax === 'on' && ['native', 'both'].includes(config.query) && !(report.native?.ranges > 0) && !report.crash) report.status = 'native-query-unverified';
report.dumps = [];
for (const file of await fs.readdir(path.join(root, 'dumps'), { recursive: true })) {
  if (file.endsWith('.dmp')) report.dumps.push(inspectDump(path.join(root, 'dumps', file)));
}
if (report.crash && report.dumps.some(dump => dump.matchesReported5406)) report.status = 'matched-5406';
// Only discard this run's generated profile after the owned Electron process has exited.
const profile = path.resolve(root, 'profile');
if (path.dirname(profile) !== path.resolve(root)) throw new Error('Unexpected cleanup path');
try { await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); }
catch (err) { report.profileCleanupError = String(err); }
await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
// Artifacts intentionally retained for this investigation; no real profile was touched.
console.log(JSON.stringify({ status: report.status, elapsedMs: Date.parse(report.finishedAt) - Date.parse(report.startedAt),
  stats: report.stats, cdpQueries: report.cdpQueries, native: report.native,
  dumpSignatures: report.dumps.map(({ exceptionCode, faultModule, matchesReported5406 }) =>
    ({ exceptionCode, faultModule, matchesReported5406 })), report: path.join(root, 'report.json') }));
process.exitCode = report.status === 'completed-no-crash' ? 0 : report.status === 'matched-5406' ? 10 : 2;
