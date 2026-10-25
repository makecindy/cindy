// Real Chromium WebRTC + production clients/bridges; loopback fixture relay, no accounts.
// Usage: node scripts/direct-link-smoke.mjs <Chrome executable>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const executablePath = process.argv[2];
if (!executablePath) throw new Error('Pass a Chrome executable');
const output = await build({ stdin: {
  contents: `export { DeviceLinkClient } from './packages/device-link/src/client.ts';
    export { createDirectRtcRuntime } from './packages/device-link/src/directRtcRuntime.ts';
    export { createDirectRuntimeBridge, createDirectRuntimeHost } from './packages/device-link/src/directRuntimeBridge.ts';
    export { DIRECT_LINK_RUNTIME_SOURCE } from './packages/device-link/src/directRuntimeSource.ts';`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)),
}, bundle: true, write: false, format: 'iife', globalName: 'DirectSmoke', platform: 'browser' });
const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: output.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const { DeviceLinkClient, createDirectRtcRuntime, createDirectRuntimeBridge, createDirectRuntimeHost } = DirectSmoke;
    const sockets = new Map(), physical = [], sessions = [], errors = [];
    const wait = async (condition) => {
      const deadline = Date.now() + 20_000;
      while (!condition()) { if (Date.now() > deadline) throw new Error(`smoke timeout: ${JSON.stringify(errors)}`); await new Promise(r => setTimeout(r, 10)); }
    };
    const rtc = createDirectRtcRuntime();
    const hostRuntime = { create(id, events) {
      const session = rtc.create(id, events); sessions.push(session); return session;
    } };
    // Exercise exactly the serialized runtime that iOS/Android WebViews load.
    const script = document.createElement('script'); script.textContent = DirectSmoke.DIRECT_LINK_RUNTIME_SOURCE; document.head.append(script);
    const mobileBridge = createDirectRuntimeBridge();
    const mobileRuntime = CindyDirectLink.create(event => mobileBridge.receive(JSON.parse(JSON.stringify(event))));
    mobileBridge.attach(command => { void mobileRuntime.command(JSON.parse(JSON.stringify(command))); });
    const secondBridge = createDirectRuntimeBridge();
    const secondRuntime = createDirectRuntimeHost(createDirectRtcRuntime(), event => secondBridge.receive(event));
    secondBridge.attach(command => { void secondRuntime.command(command); });
    function client(id, directRuntime) {
      return new DeviceLinkClient({ directRuntime, getWsUrl: () => 'ws://fixture.invalid', getToken: async () => 'fixture',
        getHello: () => ({ deviceName: id, platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
        logger: { debug() {}, info() {}, warn: (...args) => errors.push(args.join(' ')), error: (...args) => errors.push(args.join(' ')) },
        createWebSocket() {
          const handlers = new Map();
          const ws = { bufferedAmount: 0, on(event, callback) { handlers.set(event, callback); },
            close() {}, deliver(env) { handlers.get('message')?.({ toString: () => JSON.stringify(env) }); },
            send(text) {
              const env = JSON.parse(text); physical.push({ from: id, ...env });
              if (env.kind === 'hello') setTimeout(() => ws.deliver({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: id, userId: 'fixture' } }), 0);
              else if (env.kind === 'ping') setTimeout(() => ws.deliver({ v: 1, kind: 'pong' }), 0);
              else setTimeout(() => sockets.get(env.dst)?.deliver({ ...env, src: id }), 0);
            },
          };
          sockets.set(id, ws); setTimeout(() => handlers.get('open')?.(), 0); return ws;
        }, timing: { transportRetryIntervalMs: 500, requestTimeoutMs: 20_000 },
      });
    }
    const desktop = client('desktop', hostRuntime), mobile = client('phone-a', mobileBridge.runtime), other = client('phone-b', secondBridge.runtime);
    let executions = 0, breakNext = false;
    const large = '局域网😀'.repeat(80_000);
    desktop.onFrame(env => {
      if (env.kind === 'link-open') desktop.sendLinkAccept(env.src, env.id, { appVersion: '1', allowlistHash: 'fixture' });
      if (env.kind === 'invoke') {
        executions++;
        if (breakNext) { breakNext = false; sessions[0].close(); }
        desktop.sendInvokeResult(env.src, env.id, { ok: true, result: (env.payload.args ?? [])[0] === 'large' ? large : 'provider-event' });
      }
    });
    try {
      for (const c of [desktop, mobile, other]) c.start();
      await wait(() => [desktop, mobile, other].every(c => c.getStatus() === 'online'));
      for (const c of [mobile, other]) await c.openLink('desktop', { controllerName: 'Viewer', protocolVersion: 1, appVersion: '1' });
      await wait(() => mobile.getPeerPath('desktop') === 'direct' && other.getPeerPath('desktop') === 'direct');
      const before = physical.length;
      await mobile.invoke('desktop', { channel: 'maker:remote-agent:v1', args: ['warmup'] });
      await new Promise(resolve => setTimeout(resolve, 150));
      const reply = await mobile.invoke('desktop', { channel: 'maker:remote-agent:v1', args: ['large'] });
      const relayBusiness = physical.slice(before).filter(e => ['invoke', 'invoke-result'].includes(e.kind));
      if (reply.result !== large || relayBusiness.length) throw new Error('LAN transfer used relay or corrupted UTF-8');
      breakNext = true;
      const fallback = await mobile.invoke('desktop', { channel: 'maker:remote-agent:v1', args: ['poll'] });
      const healthy = await other.invoke('desktop', { channel: 'maker:remote-agent:v1', args: ['poll'] });
      if (fallback.result !== 'provider-event' || healthy.result !== 'provider-event' || executions !== 4
        || other.getPeerPath('desktop') !== 'direct') throw new Error('fallback duplicated work or disrupted another peer');
      return { directUtf8Bytes: new TextEncoder().encode(reply.result).length, relayBusinessFramesDuringDirect: relayBusiness.length,
        executions, fallback: fallback.ok, secondController: other.getPeerPath('desktop'),
        signaling: physical.filter(e => e.payload?.channel === 'device-link:direct-signal').length, errors };
    } finally { for (const c of [desktop, mobile, other]) c.stop(); mobileRuntime.dispose(); secondRuntime.dispose(); }
  });
  assert.equal(result.relayBusinessFramesDuringDirect, 0);
  assert.equal(result.fallback, true);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
