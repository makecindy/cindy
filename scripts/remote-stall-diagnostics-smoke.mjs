// Real Electron + loopback WebSockets + production INFO writer/collector.
// Faults affect only this process and unique temporary userData. No cloud upload.
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-stall-evidence-'));
const { build } = require('esbuild');
const result = await build({ bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false,
  stdin: { resolveDir: root, contents: `
import { app } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { DeviceLinkClient } from './packages/device-link/src/client.ts';
import { StallDiagnostics, diagnosticRef } from './packages/device-link/src/stallDiagnostics.ts';
import { RemoteInvokeTiming, observeRemoteInvoke } from './apps/desktop/src/main/device-link/remoteInvokeTiming.ts';
import { initLogger, createLogger, getLogDir } from './apps/desktop/src/main/logger.ts';
import { collectLogs } from './apps/desktop/src/main/log-upload/collect.ts';
const dir = app.commandLine.getSwitchValue('evidence-dir');
app.setPath('userData', path.join(dir, 'userData'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async test => { const deadline = Date.now() + 20_000; while (!test()) { if (Date.now() > deadline) throw Error('fixture deadline'); await pause(10); } };
let host, viewer, relay, direct;
const sockets = new Set();
const hostId = 'aaaaaaaa-0000-0000-0000-000000000001';
const viewerId = 'bbbbbbbb-0000-0000-0000-000000000002';
app.whenReady().then(async () => {
  initLogger({ isDev: false, logDir: path.join(dir, 'logs') });
  const log = createLogger('device-link');
  const executionLog = createLogger('device-link:execution-diagnostics');
  const diagnostics = new StallDiagnostics(message => executionLog.info(message));
  const peers = new Map(); let holdPrefix = false, prefixFrames = [], pressure = 0;
  const prefixId = 'cccccccc-0000-0000-0000-000000000003';
  relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => relay.once('listening', resolve));
  relay.on('connection', socket => {
    sockets.add(socket); let source;
    socket.on('message', raw => {
      const e = JSON.parse(String(raw));
      if (e.kind === 'hello') { source = e.payload.deviceName; peers.set(source, socket);
        socket.send(JSON.stringify({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: source, userId: 'fixture' } }));
      } else if (e.kind === 'ping') socket.send(JSON.stringify({ v: 1, kind: 'pong' }));
      else if (holdPrefix && e.id === prefixId) prefixFrames.push({ ...e, src: source });
      else peers.get(e.dst)?.send(JSON.stringify({ ...e, src: source }));
    });
  });
  const url = 'ws://127.0.0.1:' + relay.address().port;
  const make = name => new DeviceLinkClient({ getWsUrl: () => url, getToken: async () => 'fixture',
    getHello: () => ({ deviceName: name, platform: 'darwin', appVersion: 'smoke', remoteControlEnabled: true, busy: false }),
    createWebSocket: u => { const ws = new WebSocket(u); sockets.add(ws);
      if (name === hostId) { const getBuffer = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount').get;
        Object.defineProperty(ws, 'bufferedAmount', { get: () => pressure || getBuffer.call(ws) }); }
      return ws; }, logger: log,
    timing: { pingIntervalMs: 60_000, requestTimeoutMs: 20_000, transportRetryIntervalMs: 500 } });
  host = make(hostId); viewer = make(viewerId);
  let releaseBurst; const burstGate = new Promise(resolve => { releaseBurst = resolve; });
  const executions = [];
  host.onFrame(e => {
    if (e.kind === 'link-open') host.sendLinkAccept(e.src, e.id, { appVersion: 'smoke', allowlistHash: 'fixture' });
    if (e.kind !== 'invoke') return;
    const work = async () => {
      const timing = new RemoteInvokeTiming();
      const finish = observeRemoteInvoke(timing, fields => diagnostics.record('execution', {
        request: diagnosticRef(e.id), src: diagnosticRef(e.src), channel: 'local-db:sessions:list', ...fields }));
      const action = e.payload.args?.[0];
      const value = await timing.measure('handler', async () => {
        if (action === 'burst') await burstGate;
        if (action === 'slow') await pause(5_100);
        if (action === 'large') { pressure = 600_000; setTimeout(() => { pressure = 0; }, 1300); return 'PRIVATE_LARGE'.repeat(30_000); }
        return action;
      });
      finish(); host.sendInvokeResult(e.src, e.id, { ok: true, result: value });
    };
    const run = work(); executions.push(run); void run.catch(() => {});
  });
  host.start(); viewer.start(); await until(() => host.getStatus() === 'online' && viewer.getStatus() === 'online');
  await viewer.openLink(hostId, { controllerName: 'Fixture', protocolVersion: 1, appVersion: 'smoke' });
  const invoke = action => viewer.invoke(hostId, { channel: 'local-db:sessions:list', args: [action] }, undefined, { diagnosticSource: 'renderer' });
  const burst = Array.from({ length: 140 }, () => invoke('burst'));
  await assert.rejects(invoke('burst'), error => error.code === 'BACKPRESSURE');
  releaseBurst(); await Promise.all(burst);
  assert.equal((await invoke('slow')).result, 'slow');
  assert.equal((await invoke('large')).result.length, 390_000);
  // Retain a large, already-written relay head. A later direct result arrives
  // first and cannot be cumulatively ACKed. Both data paths use real sockets.
  holdPrefix = true;
  host.sendInvokeResult(viewerId, prefixId, { ok: true, result: 'PRIVATE_PREFIX'.repeat(50_000) });
  await until(() => prefixFrames.length > 0);
  direct = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => direct.once('listening', resolve));
  const accepted = new Promise(resolve => direct.once('connection', resolve));
  const viewerSocket = new WebSocket('ws://127.0.0.1:' + direct.address().port); sockets.add(viewerSocket);
  const hostSocket = await accepted; sockets.add(hostSocket);
  await new Promise(resolve => viewerSocket.once('open', resolve));
  const releasePrefix = () => { holdPrefix = false; for (const e of prefixFrames) peers.get(e.dst)?.send(JSON.stringify(e)); prefixFrames = []; };
  const hostPath = host.attachDirectPath(viewerId, { send: text => hostSocket.send(text), close: () => { releasePrefix(); hostSocket.close(); } });
  const viewerPath = viewer.attachDirectPath(hostId, { send: text => viewerSocket.send(text), close: () => viewerSocket.close() });
  hostSocket.on('message', raw => hostPath.receive(String(raw))); hostSocket.on('close', () => hostPath.closed());
  viewerSocket.on('message', raw => viewerPath.receive(String(raw))); viewerSocket.on('close', () => viewerPath.closed());
  assert.equal((await invoke('gap-tail')).result, 'gap-tail');
  assert.equal(host.getPeerPath(viewerId), 'relay');
  await Promise.all(executions); host.stop(); viewer.stop(); diagnostics.flush();
  await pause(150); // Let the production bounded writer drain before reading.
  const collected = await collectLogs({ logDir: getLogDir(), listDir: fs.readdir,
    openFile: async file => { try { const h = await fs.open(file, 'r'); return {
      size: async () => (await h.stat()).size,
      read: async (offset, length) => { const b = Buffer.alloc(length); const r = await h.read(b, 0, length, offset); return b.subarray(0, r.bytesRead); },
      close: () => h.close() }; } catch { return null; } }, now: Date.now, homeDir: dir,
    yieldToEventLoop: async () => {}, joinPath: path.join }, { reason: 'manual', anchors: [] });
  await fs.writeFile(path.join(dir, 'collected.json'), JSON.stringify(collected, null, 2));
  const records = collected.records.filter(row => row.msg.startsWith('device-link diagnostic '));
  const events = new Map();
  for (const record of records) { assert.ok(record.msg.length < 2000); const part = JSON.parse(record.msg.slice('device-link diagnostic '.length));
    const key = part.instance + ':' + part.event; const event = events.get(key) ?? {};
    for (const [key, value] of Object.entries(part)) { if (key.includes('.')) { const [parent, child] = key.split('.'); (event[parent] ??= {})[child] = value; } else event[key] = value; }
    events.set(key, event); }
  const rows = [...events.values()];
  assert.ok(rows.some(e => e.stage === 'admission' && e.reason === 'full' && e.active === 12 && e.queued === 128));
  assert.ok(rows.some(e => e.stage === 'execution' && e.outcome === 'waiting' && e.activeStage === 'handler'));
  assert.ok(rows.some(e => e.stage === 'send' && e.outcome === 'queued' && e.transport.socketBytes === 600_000));
  assert.ok(rows.some(e => e.stage === 'send' && e.outcome === 'acked' && e.queueToAckMs >= 1_000 && e.bytes > 256 * 1024));
  assert.ok(rows.some(e => e.stage === 'path' && e.reason === 'ack-timeout'
    && e.transport.head.some(h => h.path === 'relay') && e.transport.head.some(h => h.path === 'direct')));
  assert.ok(rows.some(e => e.stage === 'receive' && e.orderedWaitMs >= 250));
  assert.ok(!JSON.stringify(collected).includes('PRIVATE_'));
  const summary = { passed: ['admission flood', 'slow host handler', 'large reply socket backlog', 'direct tail behind relay prefix'],
    evidence: path.join(dir, 'collected.json'), records: records.length, stats: collected.stats };
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(summary, null, 2));
}).then(() => { for (const socket of sockets) socket.terminate(); relay?.close(); direct?.close(); app.quit(); })
.catch(error => { console.error(error); host?.stop(); viewer?.stop(); for (const socket of sockets) socket.terminate(); relay?.close(); direct?.close(); app.exit(1); });
` } });
await writeFile(path.join(dir, 'main.cjs'), result.outputFiles[0].text);
const env = { ...process.env, LOG_LEVEL: 'info' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(dir, 'main.cjs'), `--evidence-dir=${dir}`], { env, stdio: ['ignore', 'inherit', 'inherit'] });
const timer = setTimeout(() => child.kill(), 60_000);
try { await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`diagnostics smoke exited ${code}; evidence retained at ${dir}`))); }); }
finally { clearTimeout(timer); }

console.log(await readFile(path.join(dir, 'result.json'), 'utf8'));
