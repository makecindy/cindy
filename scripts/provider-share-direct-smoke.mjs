// Real Chromium WebRTC with four production DeviceLinkClient instances.
// The relay and allocation fixture authenticates a pre-approved guest and short executor routes.
// Usage: node scripts/provider-share-direct-smoke.mjs <Chrome executable>
// Native mDNS regression: node scripts/provider-share-direct-smoke.mjs --electron-mdns
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium, _electron: electron } = require('playwright-core');
if (process.argv[2] === '--electron-mdns') {
  await electronMdnsSmoke();
} else {
const executablePath = process.argv[2];
if (!executablePath) throw new Error('Pass a Chrome executable');
const output = await build({ stdin: {
  contents: `export { DeviceLinkClient } from './packages/device-link/src/client.ts';
    export { createDirectRtcRuntime } from './packages/device-link/src/directRtcRuntime.ts';
    export { providerShareHostPeer, providerShareGuestPeer } from './packages/device-link/src/providerSharePeer.ts';
    export { parseRemoteAgentRequest } from './packages/device-link/src/remoteAgent.ts';`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)),
}, bundle: true, write: false, format: 'iife', globalName: 'ProviderShareSmoke', platform: 'browser' });

const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: output.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const { DeviceLinkClient, createDirectRtcRuntime, providerShareHostPeer, providerShareGuestPeer,
      parseRemoteAgentRequest } = ProviderShareSmoke;
    const sockets = new Map(), physical = [], rtcSessions = [], errors = [];
    const guest = providerShareGuestPeer('share', 'member', 'guest');
    const owner = providerShareHostPeer('share', 'owner');
    const executor = providerShareHostPeer('share', 'executor');
    let relayOnline = true, granted = false, executorAvailable = true, executed = 0, ownerContent = 0;
    let ownerRoute = null, defaultExecutor = 'executor';
    const wait = async (predicate, label) => {
      const deadline = Date.now() + 20_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timeout ${label}: ${JSON.stringify(errors)}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    function runtime() {
      const rtc = createDirectRtcRuntime();
      return { create(id, events) {
        const session = rtc.create(id, events);
        rtcSessions.push(session);
        return session;
      } };
    }
    function client(id) {
      return new DeviceLinkClient({ directRuntime: runtime(), getWsUrl: () => 'ws://fixture.invalid',
        getToken: async () => 'fixture',
        getHello: () => ({ deviceName: id, platform: 'browser', appVersion: '1', remoteControlEnabled: true, busy: false,
          capabilities: ['provider-share-v1'] }),
        logger: { debug() {}, info() {}, warn: (...args) => errors.push(args.join(' ')),
          error: (...args) => errors.push(args.join(' ')) },
        createWebSocket() {
          const handlers = new Map();
          const ws = { bufferedAmount: 0, on(event, callback) { handlers.set(event, callback); },
            close() { sockets.delete(id); handlers.get('close')?.({ code: 1012, reason: 'restart' }); },
            deliver(env) { handlers.get('message')?.({ toString: () => JSON.stringify(env) }); },
            send(text) {
              if (!relayOnline) return;
              const env = JSON.parse(text);
              physical.push({ from: id, ...env });
              if (env.kind === 'hello') {
                setTimeout(() => ws.deliver({ v: 1, kind: 'hello-ack', payload: {
                  serverProtocolVersion: 1, deviceId: id, userId: id === 'guest' ? 'guest-account' : 'owner-account',
                  capabilities: ['provider-share-v1', 'provider-share-direct-signal-v1'],
                } }), 0);
              } else if (env.kind === 'ping') setTimeout(() => ws.deliver({ v: 1, kind: 'pong' }), 0);
              else {
                const scoped = env.providerShare;
                if (scoped && ((id === 'guest' && env.dst === 'owner')
                  || (id === 'guest' && env.dst === 'executor' && granted)
                  || (id === 'owner' && env.dst === 'guest')
                  || (id === 'executor' && env.dst === 'guest' && granted))) {
                  const source = id === 'guest' ? { role: 'guest', memberId: 'member' } : { role: 'host' };
                  setTimeout(() => sockets.get(env.dst)?.deliver({ ...env, src: id,
                    providerShare: { ...scoped, source } }), 0);
                } else if (!scoped && id === 'owner' && env.dst === 'executor') {
                  setTimeout(() => sockets.get('executor')?.deliver({ ...env, src: id }), 0);
                }
              }
            },
          };
          if (relayOnline) { sockets.set(id, ws); setTimeout(() => handlers.get('open')?.(), 0); }
          else setTimeout(() => handlers.get('close')?.({ code: 1012, reason: 'restart' }), 0);
          return ws;
        }, timing: { transportRetryIntervalMs: 500, requestTimeoutMs: 20_000 },
      });
    }
    const g = client('guest'), m = client('executor'), m2 = client('executor2');
    let o = client('owner');
    function attachOwner(ownerClient) { ownerClient.onFrame(env => {
      if (env.kind === 'link-open') ownerClient.sendLinkAccept(env.src, env.id, {
        appVersion: '1', allowlistHash: 'fixture', capabilities: ['provider-share-v1'],
      });
      if (env.kind === 'invoke') {
        const command = env.payload?.args?.[0];
        if (command?.op === 'allocate') {
          const request = parseRemoteAgentRequest(command);
          const selected = request.preferredExecutorDeviceId ?? ownerRoute ?? defaultExecutor;
          if (selected === 'executor' && executorAvailable) {
            granted = true;
            ownerRoute = selected;
            ownerClient.sendInvokeResult(env.src, env.id, { ok: true, result: { deviceId: selected } });
          } else if (selected === 'executor2' && !request.preferredExecutorDeviceId) {
            ownerRoute = selected;
            ownerClient.sendInvokeResult(env.src, env.id, { ok: true, result: { deviceId: selected } });
          } else ownerClient.sendInvokeResult(env.src, env.id, { ok: true, result: null });
        } else { ownerContent++; ownerClient.sendInvokeResult(env.src, env.id, { ok: false, error: { code: 'DENIED', message: 'owner is control only' } }); }
      }
    }); }
    attachOwner(o);
    m.onFrame(env => {
      if (env.kind === 'link-open' && granted) m.sendLinkAccept(env.src, env.id, {
        appVersion: '1', allowlistHash: 'fixture', capabilities: ['provider-share-v1'],
      });
      if (env.kind === 'invoke' && granted) {
        executed++;
        m.sendInvokeResult(env.src, env.id, { ok: true, result: env.payload?.args?.[0] });
      }
    });
    let stage = 'startup';
    try {
      for (const client of [g, o, m, m2]) client.start();
      await wait(() => [g, o, m, m2].every(client => client.getStatus() === 'online'), 'online');
      await g.openLink(owner, { controllerName: 'Guest', protocolVersion: 1, appVersion: '1', capabilities: ['provider-share-v1'] });
      const allocate = (preferredExecutorDeviceId) => g.invoke(owner, { channel: 'maker:remote-agent:v1', args: [{
        op: 'allocate', agentKind: 'pi', model: 'model-a', sessionId: 'task-1',
        ...(preferredExecutorDeviceId ? { preferredExecutorDeviceId } : {}),
      }] });
      stage = 'initial allocation';
      const allocation = await allocate();
      if (allocation.result?.deviceId !== 'executor') throw new Error('group owner did not assign executor');
      await g.openLink(executor, { controllerName: 'Guest', protocolVersion: 1, appVersion: '1', capabilities: ['provider-share-v1'] });
      await wait(() => g.getPeerPath(executor) === 'direct' && m.getPeerPath(guest) === 'direct', 'G-M direct');
      const large = '三台电脑局域网😀'.repeat(50_000);
      const before = physical.length;
      const direct = await g.invoke(executor, { channel: 'maker:remote-agent:v1', args: [large] });
      const relayBusiness = physical.slice(before).filter(frame => frame.kind === 'invoke' || frame.kind === 'invoke-result');
      if (direct.result !== large || relayBusiness.length || ownerContent) throw new Error('content traversed group owner or relay');
      relayOnline = false;
      for (const ws of sockets.values()) ws.close();
      await wait(() => [g, o, m, m2].every(client => client.getStatus() !== 'online'), 'relay restart');
      const outage = await g.invoke(executor, { channel: 'maker:remote-agent:v1', args: ['during 1012'] });
      if (outage.result !== 'during 1012') throw new Error('direct path did not survive relay restart');
      // A fresh O process has lost its in-memory route and would now prefer M2.
      o.stop();
      ownerRoute = null;
      defaultExecutor = 'executor2';
      relayOnline = true;
      o = client('owner');
      attachOwner(o);
      o.start();
      for (const client of [g, m, m2]) client.connectNow();
      await wait(() => [g, o, m, m2].every(client => client.getStatus() === 'online'), 'relay recovery');
      await g.openLink(owner, { controllerName: 'Guest', protocolVersion: 1, appVersion: '1', capabilities: ['provider-share-v1'] });
      stage = 'allocation after owner restart';
      const renewal = await allocate('executor');
      if (renewal.result?.deviceId !== 'executor') throw new Error('owner restart moved the live task to M2');
      executorAvailable = false;
      stage = 'unavailable executor refusal';
      const refused = await allocate('executor');
      if (refused.result !== null) throw new Error('unavailable current executor silently switched to M2');
      executorAvailable = true;
      for (const session of rtcSessions) session.close();
      await wait(() => g.getPeerPath(executor) === 'relay', 'direct path close');
      const fallbackBefore = physical.length;
      stage = 'relay fallback';
      const fallback = await g.invoke(executor, { channel: 'maker:remote-agent:v1', args: ['relay fallback'] });
      if (fallback.result !== 'relay fallback' || executed !== 3) throw new Error('relay fallback duplicated or lost work');
      const fallbackFrames = physical.slice(fallbackBefore).filter(frame => frame.kind === 'invoke' && frame.dst === 'executor');
      if (!fallbackFrames.length) throw new Error('fallback did not use G-M device-link relay');
      return { peers: 4, directBytes: new TextEncoder().encode(large).length, relayBusinessDuringDirect: relayBusiness.length,
        outageResult: outage.result, renewalExecutor: renewal.result.deviceId, unavailableExecutorRefused: refused.result === null,
        fallbackFrames: fallbackFrames.length, executorRuns: executed, ownerContent, errors };
    } catch (error) { throw new Error(`${stage}: ${String(error)}; warnings=${JSON.stringify(errors)}`); }
    finally { for (const client of [g, o, m, m2]) client.stop(); }
  });
  assert.equal(result.ownerContent, 0);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
}

/** Real production Desktop runtime -> isolated capture window -> preload -> RTC.
 * Only the logger is replaced to avoid touching any Cindy user/log directory.
 * Each endpoint has its own Electron process and TEMP profile. Signal names are
 * deliberately unresolvable, so same-host mDNS cannot make the baseline pass.
 * This is a transport experiment; the Chrome mode above tests authorized relay
 * routing with a server fixture, neither mode substitutes for real-account E2E.
 */
async function electronMdnsSmoke() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'cindy-direct-mdns-'));
  await mkdir(join(dir, 'main'), { recursive: true });
  await mkdir(join(dir, 'renderer/mdns/assets'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'cindy-mdns-smoke', version: '1.0.0', main: 'main/main.cjs' }));
  await writeFile(join(dir, 'renderer/mdns/index.html'), '<!doctype html><script src="assets/runtime.js"></script>');
  await build({ entryPoints: [join(root, 'apps/desktop/src/preload/desktopCapturePreload.ts')],
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(dir, 'main/desktopCapturePreload.js') });
  await build({ stdin: { resolveDir: root, contents: `
    import { startDirectLinkHost } from './apps/desktop/src/capture-renderer/directLinkHost.ts';
    const NativeRTC = window.RTCPeerConnection;
    window.probeConnections = [];
    window.RTCPeerConnection = class extends NativeRTC {
      constructor(config) { super(config); window.probeConnections.push(this); }
    };
    startDirectLinkHost(window.directLinkHost);
  ` }, bundle: true, platform: 'browser', format: 'iife', outfile: join(dir, 'renderer/mdns/assets/runtime.js') });
  await build({ stdin: { resolveDir: root, contents: `
    import { app, protocol } from 'electron';
    import { mkdirSync } from 'node:fs';
    import { desktopDirectRuntime } from './apps/desktop/src/main/device-link/directLink.ts';
    const profile = process.env.CINDY_MDNS_SMOKE_PROFILE;
    if (!profile) throw new Error('ISOLATED_PROFILE_REQUIRED');
    mkdirSync(profile, { recursive: true });
    app.setPath('userData', profile);
    app.setPath('sessionData', profile);
    protocol.registerSchemesAsPrivileged([{ scheme: 'cindy-desktop-capture',
      privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
    app.on('window-all-closed', () => {});
    globalThis.probe = { runtime: desktopDirectRuntime };
  ` }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    define: { DESKTOP_CAPTURE_VITE_DEV_SERVER_URL: 'undefined', DESKTOP_CAPTURE_VITE_NAME: JSON.stringify('mdns') },
    plugins: [{ name: 'isolated-logger', setup(b) {
      b.onResolve({ filter: /(?:^|\/)logger$/ }, () => ({ path: 'logger', namespace: 'smoke' }));
      b.onLoad({ filter: /.*/, namespace: 'smoke' }, () => ({ contents: 'export const createLogger = () => ({warn(){},error(){},info(){},debug(){}});' }));
    } }], outfile: join(dir, 'main/main.cjs') });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const apps = [];
  try {
    for (const endpoint of ['a', 'b']) apps.push(await electron.launch({ executablePath: require('electron'),
      args: [dir], env: { ...env, CINDY_MDNS_SMOKE_PROFILE: join(dir, `profile-${endpoint}`) }, timeout: 20_000 }));
    console.log(JSON.stringify({ experiment: 'electron-mdns', temp: dir,
      // Counts only: never print SDP, interface names or addresses.
      externalIpv4Interfaces: Object.values(networkInterfaces()).filter(entries =>
        entries?.some(entry => entry.family === 'IPv4' && !entry.internal)).length,
      versions: await apps[0].evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome })) }));
    const describe = async (app, action, sdp, policy) => app.evaluate(async ({ BrowserWindow }, input) => {
      const state = globalThis.probe;
      state.messages = [];
      state.opened = false;
      state.session = state.runtime.create('mdns-smoke', {
        open() { state.opened = true; }, closed() {}, drained() {}, message(text) { state.messages.push(text); },
      });
      const pending = input.action === 'offer' ? state.session.offer() : state.session.accept(input.sdp);
      // Override only in the experiment to reproduce the original behavior.
      // Null uses the policy installed by the actual production window factory.
      const win = BrowserWindow.getAllWindows()[0];
      if (input.policy) win.webContents.setWebRTCIPHandlingPolicy(input.policy);
      const result = await pending;
      const prefs = win.webContents.getLastWebPreferences();
      if (win.isVisible() || !prefs.sandbox || !prefs.contextIsolation || prefs.nodeIntegration)
        throw new Error('WINDOW_ISOLATION_REGRESSION');
      return result;
    }, { action, sdp, policy });
    const candidates = sdp => sdp.split('\r\n').filter(line => line.startsWith('a=candidate:'));
    const stats = sdp => {
      const addresses = candidates(sdp).map(line => line.split(' ')[4]);
      return { total: addresses.length, mdns: addresses.filter(address => address.endsWith('.local')).length,
        ipv4: addresses.filter(address => /^\d+\.\d+\.\d+\.\d+$/.test(address)).length };
    };
    const obscure = sdp => sdp.split('\r\n').map(line => {
      if (!line.startsWith('a=candidate:')) return line;
      const fields = line.split(' ');
      if (fields[4].endsWith('.local')) fields[4] = `${randomUUID()}.local`;
      return fields.join(' ');
    }).join('\r\n');
    const waitOpen = app => app.evaluate(async () => {
      const state = globalThis.probe;
      const until = Date.now() + 16_000; // exceeds production negotiation's 15s budget
      while (!state.opened && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      return state.opened;
    });
    const payload = '0123456789abcdef'.repeat(16_384); // exactly 256 KiB; compare every byte
    for (const [name, policies, shouldOpen] of [
      ['unresolvable-mdns-baseline', ['default', 'default'], false],
      ['both-native-policy', [null, null], true],
      ['offerer-only-native-policy', [null, 'default'], true],
      ['answerer-only-native-policy', ['default', null], true],
      ['no-host-candidates', ['default_public_interface_only', 'default_public_interface_only'], false],
    ]) {
      const offer = await describe(apps[0], 'offer', undefined, policies[0]);
      const answer = await describe(apps[1], 'accept', obscure(offer), policies[1]);
      await apps[0].evaluate((_, sdp) => globalThis.probe.session.answer(sdp), obscure(answer));
      const counts = [stats(offer), stats(answer)];
      if (name === 'unresolvable-mdns-baseline') assert.ok(counts.every(c => c.mdns > 0 && c.ipv4 === 0), 'baseline must contain mDNS only');
      if (name === 'both-native-policy') assert.ok(counts.every(c => c.ipv4 > 0 && c.mdns === 0), 'native policy must produce literal candidates');
      if (name === 'no-host-candidates') assert.ok(counts.every(c => c.total === 0), 'no-host fixture must have no candidates');
      const opened = await Promise.all(apps.map(waitOpen));
      assert.deepEqual(opened, [shouldOpen, shouldOpen], name);
      if (name === 'both-native-policy') {
        // Malformed and oversized remote descriptions must fail only their own
        // connection, leaving the already established pair able to send below.
        const rejected = await apps[0].evaluate(async () => {
          const runtime = globalThis.probe.runtime;
          const results = [];
          for (const [id, sdp] of [['malformed', 'v=0\r\ninvalid'], ['oversized', 'x'.repeat(128 * 1024 + 1)]]) {
            const bad = runtime.create(id, { open() {}, closed() {}, drained() {}, message() {} });
            try { await bad.accept(sdp); results.push(false); }
            catch { results.push(true); }
            finally { bad.close(); }
          }
          return results;
        });
        assert.deepEqual(rejected, [true, true], 'invalid remote SDP must not gain candidates or break healthy peers');
      }
      if (shouldOpen) {
        for (const app of apps) await app.evaluate((_, text) => globalThis.probe.session.send(text), payload);
        const received = await Promise.all(apps.map(app => app.evaluate(async () => {
          const until = Date.now() + 10_000;
          while (!globalThis.probe.messages.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
          return globalThis.probe.messages;
        })));
        for (const messages of received) assert.deepEqual(messages, [payload], `${name}: bytes or duplicate delivery`);
      }
      const paths = await Promise.all(apps.map(app => app.evaluate(async ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(async () => {
          const pc = window.probeConnections.find(connection => connection.signalingState !== 'closed');
          const stats = await pc.getStats();
          const transport = [...stats.values()].find(s => s.type === 'transport');
          const pair = stats.get(transport?.selectedCandidatePairId);
          const local = stats.get(pair?.localCandidateId), remote = stats.get(pair?.remoteCandidateId);
          return { ice: pc.iceConnectionState, local: local?.candidateType, remote: remote?.candidateType, protocol: local?.protocol };
        })()`))));
      if (shouldOpen) assert.ok(paths.every(path => ['connected', 'completed'].includes(path.ice)
        && path.protocol === 'udp' && path.local === 'host' && ['host', 'prflx'].includes(path.remote)), 'expected actual host UDP path');
      console.log(JSON.stringify({ name, candidates: counts, opened, paths,
        ...(name === 'both-native-policy' ? { malformedAndOversizedRejected: true, healthyPeerSurvived: true } : {}),
        bytesEachWay: shouldOpen ? Buffer.byteLength(payload) : 0,
        sha256: shouldOpen ? createHash('sha256').update(payload).digest('hex') : undefined }));
      for (const app of apps) await app.evaluate(() => { globalThis.probe.session.close(); globalThis.probe.runtime.suspend(); });
    }
    console.log('ELECTRON_MDNS_SMOKE=PASS');
  } finally { for (const app of apps) await app.close(); }
}
