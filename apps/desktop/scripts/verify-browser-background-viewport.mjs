#!/usr/bin/env node
// Live Electron regression; run only against this checkout's isolated dev sandbox.
// node apps/desktop/scripts/verify-browser-background-viewport.mjs --port=9500 [--out=/tmp/evidence]
// Exercises production pool/eager bridge, native main capture and Electron input; not a full MCP run.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBrowserFixtureScreenshot } from './browser-background-screenshot.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const port = Number(option('port'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('EXPLICIT_CDP_PORT_REQUIRED');
const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const out = option('out') ? path.resolve(option('out')) : await mkdtemp(path.join(os.tmpdir(), 'cindy-browser-viewport-'));
await mkdir(out, { recursive: true });
const key = `__viewport_probe_${randomUUID().replaceAll('-', '')}`;
const fixturePath = `/viewport-${randomUUID()}/`;
const report = { scope: 'production pool + eager bridge + native capture + native Electron input', cases: [], passed: false };
const connections = new Set();
let host, server, stage = 'connect';
const check = (value, code) => assert.ok(value, code);
const json = value => JSON.stringify(value);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(read, code) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(code);
}
async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  check(res.ok, 'CDP_TARGET_LIST_FAILED');
  return res.json();
}
async function connect(url) {
  const parsed = new URL(url);
  check(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'NON_LOCAL_CDP_REJECTED');
  check(Number(parsed.port) === port, 'CDP_PORT_MISMATCH');
  const ws = new WebSocket(url), pending = new Map();
  let next = 0;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP_CONNECT_FAILED')), { once: true });
  });
  const client = {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP_TIMEOUT')); }, 20000);
        pending.set(id, { resolve, reject, timer });
        ws.send(json({ id, method, params }));
      });
    },
    close() { ws.close(); connections.delete(client); },
  };
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), job = pending.get(message.id);
    if (!job) return;
    clearTimeout(job.timer); pending.delete(message.id);
    if (message.error) job.reject(new Error('CDP_COMMAND_FAILED'));
    else job.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('CDP_CLOSED')); }
    pending.clear();
  });
  connections.add(client);
  return client;
}
async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) console.error('Probe evaluation:', result.exceptionDetails.exception?.description?.split('\n')[0] ?? result.exceptionDetails.text);
  check(!result.exceptionDetails, 'PAGE_EVALUATION_FAILED');
  return result.result.value;
}
const inHost = body => evaluate(host, `(async () => { const p = window[${json(key)}]; ${body} })()`);
const inGuest = (id, expression) => inHost(`return p.pool.peek(${json(id)}).webview.executeJavaScript(${json(expression)});`);
const html = `<!doctype html><meta charset=utf-8><title>Local viewport fixture</title>
<style>body{margin:0;min-height:100vh;background:repeating-linear-gradient(45deg,#e8edf4,#e8edf4 30px,#d2deef 30px,#d2deef 60px);font:24px sans-serif}button{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:24px}output{display:block;padding:30px}</style>
<output>Local viewport fixture</output><button>Native click target</button>
<script>window.probe={clicks:0,trusted:false,nonce:crypto.randomUUID()};document.querySelector('button').addEventListener('click',e=>{probe.clicks++;probe.trusted=e.isTrusted;document.querySelector('output').textContent='Native clicks: '+probe.clicks})</script>`;

try {
  for (const target of await targets()) {
    if (target.type !== 'page' || !URL.canParse(target.url)) continue;
    const address = new URL(target.url);
    if (address.protocol !== 'http:' || address.search || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) continue;
    const candidate = await connect(target.webSocketDebuggerUrl);
    const matches = await evaluate(candidate, `(async () => {
      if (!window.electronAPI?.rsbBrowserBridge?.captureScreenshotData) return false;
      const sample = document.createElement('webview');
      if (typeof sample.executeJavaScript !== 'function' || typeof sample.sendInputEvent !== 'function') return false;
      const response = await fetch('/features/right-sidebar/lib/browserPartition.ts');
      return response.ok && (await response.text()).includes(${json(`${root}/apps/desktop/src/shared/webviewPartition.ts`)});
    })()`).catch(() => false);
    if (matches) { host = candidate; break; }
    candidate.close();
  }
  check(host, 'MATCHING_CHECKOUT_RENDERER_NOT_FOUND');
  stage = 'preflight';
  check(await evaluate(host, `(async () => {
    const bridgePath = '/features/right-sidebar/lib/rsbBrowserBridge.ts';
    const bridgeUrl = performance.getEntriesByType('resource').filter(entry =>
      new URL(entry.name).pathname === bridgePath).at(-1)?.name ?? bridgePath;
    const source = await (await fetch(bridgeUrl)).text();
    const line = source.split(String.fromCharCode(10)).find(text => text.startsWith('import ') && text.includes('browserWebviewPool'));
    if (!line) throw new Error('BRIDGE_POOL_IMPORT_NOT_FOUND');
    const poolUrl = line.slice(line.indexOf('\"') + 1, line.lastIndexOf('\"'));
    const { browserWebviewPool: pool } = await import(poolUrl);
    if (pool.inspectTabIds().length || document.querySelector('[data-pool-tab-id]')) return false;
    const bridge = await import(bridgeUrl);
    window[${json(key)}] = { pool, bridge, own: [], session: ${json(key)}, route: location.href };
    return true;
  })()`), 'POOL_NOT_EMPTY_REFUSING_INTERFERENCE');
  server = createServer((req, res) => {
    if (!req.url?.startsWith(fixturePath)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}${fixturePath}`;
  for (const count of [1, 3]) {
    const row = { pages: count, results: [] };
    report.cases.push(row);
    row.hostVisibilityBefore = await inHost(`p.groupFocus={element:document.activeElement,focused:document.hasFocus()}; return document.visibilityState;`);
    for (let i = 0; i < count; i++) {
      stage = `spawn-${count}-${i + 1}`;
      const id = `${key}_${count}_${i}`, url = `${base}${count}/${i}`;
      await inHost(`p.own.push(${json(id)}); await p.bridge.eagerSpawnAndReport(p.session, ${json(id)}, ${json(url)});`);
    }
    stage = `background-create-${count}`;
    row.backgroundCreationPreservedFocus = await inHost(`return location.href===p.route &&
      document.activeElement===p.groupFocus.element && document.hasFocus()===p.groupFocus.focused;`);
    check(row.backgroundCreationPreservedFocus, 'BACKGROUND_CREATION_CHANGED_FOCUS_OR_ROUTE');
    for (let i = 0; i < count; i++) {
      stage = `verify-${count}-${i + 1}`;
      const id = `${key}_${count}_${i}`;
      check(await inHost(`return p.pool.peek(${json(id)})?.wrapper.parentElement?.id === 'browser-webview-pool';`), 'PAGE_LEFT_BACKGROUND_PARKING');
      await poll(() => inGuest(id, `Boolean(window.probe && document.readyState === 'complete')`), 'FIXTURE_NOT_READY');
      const before = await inGuest(id, `({width:innerWidth,height:innerHeight,nonce:probe.nonce,origin:performance.timeOrigin})`);
      const result = { page: i + 1, width: before.width, height: before.height };
      row.results.push(result);
      check(before.width >= 640 && before.height >= 360, 'UNUSABLE_BACKGROUND_VIEWPORT');
      const point = await inGuest(id, `(() => {const r=document.querySelector('button').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      await inHost(`const webview=p.pool.peek(${json(id)}).webview;
        await webview.sendInputEvent({type:'mouseMove',...${json(point)}});
        await webview.sendInputEvent({type:'mouseDown',...${json(point)},button:'left',clickCount:1});
        await webview.sendInputEvent({type:'mouseUp',...${json(point)},button:'left',clickCount:1});`);
      const clicked = await poll(() => inGuest(id, `probe.clicks === 1 && probe.trusted`), 'NATIVE_CLICK_FAILED');
      result.nativeClick = clicked;
      stage = `capture-${count}-${i + 1}`;
      await inHost(`p.capture={state:'pending'};
        void window.electronAPI.rsbBrowserBridge.captureScreenshotData({tabId:${json(id)}}).then(
          image=>{p.capture={state:'ready',data:image.data};},
          error=>{p.capture={state:'failed',error:String(error)};});`);
      const captured = await poll(() => inHost(`return p.capture.state==='pending' ? false : {state:p.capture.state,error:p.capture.error};`), 'NATIVE_SCREENSHOT_TIMEOUT');
      if (captured.state === 'failed') console.error('Native capture:', captured.error);
      check(captured.state === 'ready', 'NATIVE_SCREENSHOT_FAILED');
      const bytes = await inHost(`return Array.from(p.capture.data);`);
      const png = Buffer.from(bytes);
      check(png.length > 24 && png.subarray(1, 4).toString() === 'PNG', 'NATIVE_SCREENSHOT_INVALID');
      result.screenshotWidth = png.readUInt32BE(16); result.screenshotHeight = png.readUInt32BE(20);
      check(result.screenshotWidth >= 640 && result.screenshotHeight >= 360, 'NATIVE_SCREENSHOT_TOO_SMALL');
      result.screenshot = `background-${count}-${i + 1}.png`;
      await writeFile(path.join(out, result.screenshot), png);
      stage = `capture-content-${count}-${i + 1}`;
      result.screenshotContent = await checkBrowserFixtureScreenshot(png);
      const after = await inGuest(id, `({nonce:probe.nonce,origin:performance.timeOrigin,clicks:probe.clicks})`);
      check(after.nonce === before.nonce && after.origin === before.origin && after.clicks === 1, 'BACKGROUND_PAGE_RELOADED');
    }
    stage = `foreground-${count}`;
    row.routeUnchanged = await inHost(`return location.href===p.route;`);
    check(row.routeUnchanged, 'NATIVE_INPUT_CHANGED_FOREGROUND_ROUTE');
    row.nativeInputChangedFocus = await inHost(`return document.activeElement!==p.groupFocus.element || document.hasFocus()!==p.groupFocus.focused;`);
    row.hostVisibilityAfter = await inHost(`return document.visibilityState;`);
    await inHost(`for (const id of p.own) {p.pool.release(id); await p.bridge.releaseRsbBrowserTab(id);} p.own=[];`);
  }
  report.passed = true;
} catch (error) {
  report.failure = { stage, code: /^[A-Z_]+$/.test(error.message) ? error.message : 'PROBE_FAILED' };
  process.exitCode = 1;
} finally {
  if (host) {
    try {
      await inHost(`if(p) {for(const id of p.own) {p.pool.release(id); await p.bridge.releaseRsbBrowserTab(id);} delete window[${json(key)}];}`);
      report.cleanedUp = true;
    } catch { report.cleanedUp = false; process.exitCode = 1; }
  }
  for (const connection of connections) connection.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(out, 'report.json'), json(report) + '\n');
  console.log(json({ passed: report.passed, failure: report.failure, evidence: out }));
}
