// Opt-in real Chromium, private profile/port, no credentials. The caller replaces
// the UI process while a page operation is pending in the production Host runtime.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { once } from 'node:events';
import { createHostPlatformTools } from '../../src/platform/tools.ts';
import { createBrowserBackendSettingsStore } from '../../../desktop/src/main/browser-backend-settings-store.ts';

export async function browserContinuity(profileDir) {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const cdpPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let pageLoads = 0, writes = 0, release, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/hold') {
      writes++;
      release = () => res.end('completed-once');
      markStarted();
    } else if (req.url === '/') {
      pageLoads++;
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Host continuity fixture</title><p>Persistent page</p><script>window.handoffState={count:0}</script>');
    } else { res.statusCode = 404; res.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const settings = createBrowserBackendSettingsStore(() => profileDir);
  settings.writeBrowserBackendKind('external');
  const tools = createHostPlatformTools({ profileDir, assertCurrent: () => {},
    secretIo: { readStrict: () => null, write: () => { throw new Error('Fixture forbids credentials'); } },
    uploadRoots: async () => [],
    browserExtensions: { getPageControl: () => null, getPageControlUnavailableReason: () => 'plugin-missing' },
    // Isolated HOME has no login keychain. This credential-free fixture must
    // never prompt for or consult the user's real macOS keychain.
    managedLaunch: { cdpPort, headless: true, useMockKeychain: true, executablePath: chromium.executablePath() },
  });
  const runtime = tools.browser.getBrowserMcpDeps().getRuntime();
  let pending, targetId;
  const check = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  return {
    providers: tools.providers,
    async begin() {
      check(await runtime.call({ action: 'start' }));
      const opened = check(await runtime.call({ action: 'open', url: `http://127.0.0.1:${server.address().port}/` }));
      targetId = opened.data.targetId;
      assert.equal(typeof targetId, 'string');
      check(await runtime.call({ action: 'act', targetId, request: {
        kind: 'wait', targetId, text: 'Persistent page', timeoutMs: 10_000,
      } }));
      pending = runtime.call({ action: 'act', targetId, request: {
        kind: 'evaluate', targetId, timeoutMs: 180_000,
        fn: 'async () => { window.handoffState.count++; await fetch("/hold"); return window.handoffState.count; }',
      } });
      await Promise.race([started, pending.then(result => { check(result); throw new Error('Browser operation finished before release'); })]);
    },
    async finish() {
      release();
      check(await pending);
      const state = check(await runtime.call({ action: 'act', targetId, request: {
        kind: 'evaluate', targetId, fn: '() => window.handoffState.count',
      } }));
      assert.equal(state.data.result, 1, JSON.stringify(state));
      const tabs = check(await runtime.call({ action: 'tabs' }));
      assert.ok(tabs.data.tabs.some(tab => tab.targetId === targetId), 'same live browser target after client replacement');
      assert.equal(pageLoads, 1, 'no page reconstruction');
      assert.equal(writes, 1, 'no side-effect replay');
      console.log('PASS real Chromium: same target, page memory retained, in-flight operation completed once');
    },
    async close() {
      release?.();
      await pending?.catch(() => {});
      try { await tools.close(); } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      }
    },
  };
}
