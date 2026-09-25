// One command, no accounts/devices or manual fault injection. Run with Node >=22.12.
import { spawn, fork } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateTestProcess } from './shared/terminate-test-process.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const reportDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-peer-acceptance-'));
const scratch = await mkdtemp(path.join(os.tmpdir(), 'cindy-peer-fixtures-'));
console.log(`Artifacts: ${reportDir}`);
const report = {
  startedAt: new Date().toISOString(), stages: [],
  limitations: ['Local TURN/loopback only; deployed TURN, WAN NAT and network switching are not exercised.',
    'Mobile business logic and shared WebRTC runtime are tested; native iOS/Android WebView and physical devices are not exercised.',
    'OSS fallback is verified with test adapters, not a production OSS account.'],
};
let turn;
let interrupted = false;
const children = new Set();
const abort = () => { for (const child of children) terminateTestProcess(child); };
process.once('SIGINT', () => { interrupted = true; abort(); process.exitCode = 130; });
process.once('SIGTERM', () => { interrupted = true; abort(); process.exitCode = 143; });
async function run(name, command, args, { cwd = root, env = {}, timeout = 300_000 } = {}) {
  if (interrupted) throw new Error('Acceptance run interrupted');
  const start = Date.now();
  console.log(`[peer acceptance] ${name}`);
  const logfile = path.join(reportDir, `${name}.log`);
  const stream = createWriteStream(logfile, { mode: 0o600 });
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; terminateTestProcess(child); }, timeout);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  children.delete(child);
  await new Promise(resolve => stream.end(resolve));
  const stage = { name, ...result, timedOut, ms: Date.now() - start, log: logfile,
    status: result.code === 0 && !timedOut ? 'passed' : 'failed' };
  if (name.startsWith('browser-')) {
    stage.results = (await readFile(logfile, 'utf8')).split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  report.stages.push(stage);
  if (stage.status === 'failed') throw new Error(`${name} failed; see ${logfile}`);
  return logfile;
}
try {
  const candidates = [process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    require('playwright-core').chromium.executablePath()].filter(Boolean);
  let chrome;
  for (const candidate of candidates) { try { await access(candidate); chrome = candidate; break; } catch {} }
  if (!chrome) {
    const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
    await run('install-chromium', process.execPath, [cli, 'install', 'chromium']);
    chrome = require('playwright-core').chromium.executablePath();
  }
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await run('process-cleanup', process.execPath, ['--test', 'scripts/__tests__/terminate-test-process.test.mjs']);
  await run('webview-source', process.execPath, ['scripts/file-peer-runtime.mjs', '--check']);
  await run('shared-policy', pnpm, ['--filter', '@cindy/device-link', 'test']);
  await run('desktop-business', pnpm, ['--filter', 'desktop', 'test',
    'src/main/__tests__/deviceLinkIpc.test.ts',
    'src/main/device-link/__tests__/mirrorCacheIpcBoundary.test.ts',
    'src/main/device-link/__tests__/filePeer.test.ts',
    'src/main/device-link/__tests__/peerAttachmentStore.test.ts',
    'src/main/device-link/__tests__/outboundMedia.test.ts',
    'src/main/device-link/__tests__/outboundMediaCompress.test.ts',
    'src/main/device-link/__tests__/fileAccess.test.ts',
    'src/main/__tests__/normalizeAttachmentsOss.test.ts',
    'src/main/remote-desktop/__tests__/clipboardTransfer.test.ts',
    'src/main/device-link/__tests__/dispatchSendSafety.test.ts',
    'src/main/device-link/__tests__/dispatchWeakNetwork.test.ts']);
  await run('mobile-business', pnpm, ['--filter', 'mobile', 'exec', 'vitest', 'run',
    'src/__tests__/fileWebViewTermination.test.tsx',
    'src/__tests__/mobileAttachmentUpload.test.ts', 'src/__tests__/mobileLocalAttachmentUpload.test.ts',
    'src/__tests__/attachments.test.ts', 'src/__tests__/durableOutboxFiles.test.ts',
    'src/__tests__/peerFileRegistry.test.ts']);
  for (const [name, args] of [
    ['shared-types', ['--filter', '@cindy/device-link', 'build']],
    ['desktop-types', ['--filter', 'desktop', 'typecheck']],
    ['mobile-types', ['--filter', 'mobile', 'exec', 'tsc', '--noEmit']],
  ]) await run(name, pnpm, args);
  await run('browser-direct', process.execPath, ['scripts/file-peer-smoke.mjs', chrome, '--large']);
  await run('browser-benchmark', process.execPath, ['scripts/file-peer-smoke.mjs', chrome, '--benchmark']);
  await run('browser-faults', process.execPath, ['scripts/peer-transfer-fault-smoke.mjs', chrome]);
  // Isolated, pinned development fixture; never added to shipping dependencies.
  await run('install-turn-fixture', process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--prefix', scratch, '--ignore-scripts', '--no-audit', '--no-fund', 'node-turn@0.0.6']);
  turn = fork(path.join(root, 'scripts/peer-transfer-turn-fixture.cjs'),
    [path.join(scratch, 'node_modules/node-turn')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.add(turn);
  const ice = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TURN startup timed out')), 10_000);
    turn.once('message', value => { clearTimeout(timer); resolve(value); });
    turn.once('exit', () => { clearTimeout(timer); reject(new Error('TURN exited')); });
    turn.once('error', error => { clearTimeout(timer); reject(error); });
  });
  await run('browser-relay', process.execPath, ['scripts/file-peer-smoke.mjs', chrome, '--large'],
    { env: { CINDY_PEER_TEST_ICE: JSON.stringify([ice]) } });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode ||= 1;
} finally {
  abort();
  await rm(scratch, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(reportDir, 'report.md'), [
    `Peer transfer acceptance: ${report.status}`, '',
    ...report.stages.map(stage => `- ${stage.name}: ${stage.status} (${stage.ms} ms), ${stage.log}`),
    '', ...(report.error ? [report.error, ''] : []), 'Coverage limits:', ...report.limitations.map(s => `- ${s}`), '',
  ].join('\n'));
  console.log(`Report: ${path.join(reportDir, 'report.md')}`);
}
