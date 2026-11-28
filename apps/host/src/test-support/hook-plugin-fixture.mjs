// A hook-answering plugin for Host tests, run in the Host's own plugin sandbox (real headless
// Chromium, the shared GhostRuntime), as installed plugins run on the Host (plugins/runtime.ts).
//
// Hooks (will-user-message and the runtime control points) reach a plugin's logic page through
// cindy.onHostMessage, and the plugin answers with cindy.send({ type: 'event-verdict', hookId, ... })
// (plugin-creator references: plugin-event-subscriptions.md, plugin-control-points.md). A Node worker
// cannot answer them: its events also go to the logic page. So the fixture is a logic plugin.
//
// What the plugin does for each hook name is fixed when it is written (`behaviors`):
//   { action, ... }        answer with that verdict for the hookId it was asked
//   'silent'               never answer (the host's wait runs out)
//   'throw'                throw inside the handler (a plugin error)
//   { impersonate, ... }   answer with another hookId (a verdict that is not this question's)
// Every message the page receives is also reported back as { type: 'fixture-received', message }.
//
// Chromium: CINDY_TEST_CHROMIUM, else Playwright's default build when it is installed. Without one
// the caller skips with `chromiumUnavailable` as the reason. Never a user's browser or profile.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createHeadlessPluginSandbox } from '../plugins/chromium-sandbox.ts';
import { createGhostPageHandler } from '../../../desktop/src/main/cindy-brain/runtime/ghostPageHandler.ts';
import { GhostRuntime } from '../../../desktop/src/main/cindy-brain/runtime/GhostRuntime.ts';
import { installedGhostStoragePart } from '../../../desktop/src/shared/pluginIdentity.ts';

/** The Chromium a test may launch, or null. */
export function testChromiumExecutable() {
  const explicit = process.env.CINDY_TEST_CHROMIUM?.trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  try {
    const bundled = chromium.executablePath();
    return bundled && fs.existsSync(bundled) ? bundled : null;
  } catch { return null; }
}
export const chromiumUnavailable = 'no Chromium for the plugin sandbox: set CINDY_TEST_CHROMIUM to a headless Chromium build';

/** Write the fixture plugin into `dir` and return its installed-plugin record. */
export function writeHookPlugin(dir, { id = 'hook-fixture', hooks = ['will-user-message'], behaviors = {}, manifest = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ghost.json'), JSON.stringify({
    schemaVersion: 3, id, name: 'Hook fixture', description: 'Synthetic hook answers for Host tests.',
    version: '1.0.0', minCindyVersion: '0.0.0', entry: 'main.js', launch: 'resident',
    subscribe: { hooks }, ...manifest,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'main.js'), `
    const behaviors = ${JSON.stringify(behaviors)};
    cindy.onHostMessage(async message => {
      await cindy.send({ type: 'fixture-received', message });
      if (!message || message.type !== 'event' || typeof message.hookId !== 'string') return;
      const behavior = behaviors[message.name];
      if (behavior === undefined || behavior === 'silent') return;
      if (behavior === 'throw') throw new Error('fixture plugin failure');
      const { impersonate, ...verdict } = behavior;
      await cindy.send({ type: 'event-verdict', hookId: impersonate ?? message.hookId, ...verdict });
    });
    globalThis.fixtureReady = true;
  `);
  const manifestFile = JSON.parse(fs.readFileSync(path.join(dir, 'ghost.json'), 'utf8'));
  return { manifest: manifestFile, dir, enabled: true, namespace: null, namespaceState: 'confirmed',
    approval: { state: 'approved', revision: `${id}-fixture` } };
}

/**
 * The Host's plugin sandbox and GhostRuntime over the given plugins. Everything a plugin sends
 * reaches `onSend(id, payload)` (where plugins/runtime.ts routes it on the Host). `close()` stops the
 * runtimes and the browser; register it on lifoCleanup.
 */
export async function startHookPluginSandbox({ ghosts, executablePath, onSend = () => {} }) {
  const installed = new Map(ghosts.map(ghost => [installedGhostStoragePart(ghost), ghost]));
  const enabled = new Set(installed.keys());
  const kv = new Map();
  const bridge = await build({ entryPoints: [fileURLToPath(new URL('../../../desktop/src/shared/ghostPageBridge.ts', import.meta.url))],
    write: false, bundle: true, platform: 'browser', format: 'iife', globalName: 'CindyPluginBridge' });
  const platform = createHeadlessPluginSandbox({
    executablePath, bridgeSource: bridge.outputFiles[0].text,
    ownerKey: () => 'hook-fixture-owner',
    isCurrent: ghost => enabled.has(installedGhostStoragePart(ghost)),
    send: async (ghost, payload) => {
      await onSend(installedGhostStoragePart(ghost), payload);
      return { ok: true };
    },
    pageHandler: (ghost, origin, isCurrent) => createGhostPageHandler({
      ghost, origin, isCurrent,
      ghostKvStore: { read: id => kv.get(id) ?? {}, write: (id, value) => kv.set(id, value),
        captureTarget: id => enabled.has(id) ? id : null, isTargetCurrent: id => enabled.has(id) },
      ghostWakeHandler: null, ghostAppContextProvider: null, ghostModelPickerProvider: null,
      ghostAgentModelsProvider: null, ghostModelPreferencesProvider: null, ghostMediaModelsProvider: null, ghostModelsHandler: null,
      ghostSecretsHandler: null, ghostOauthHandler: null, ghostConnectionsHandler: null,
      serveGhostMedia: async () => new Response(null, { status: 404 }),
      serveGhostLibraryFile: async () => new Response(null, { status: 404 }),
      serveGhostGallery: async () => Response.json([]), log: { error() {}, warn() {} },
    }),
  });
  const runtime = new GhostRuntime({ adapter: platform.adapter, onStateChanged: () => {} });
  return {
    runtime, platform, installed,
    id: ghost => installedGhostStoragePart(ghost),
    spawn: ghost => runtime.spawn(ghost),
    deliver: (ghost, message) => platform.deliver(installedGhostStoragePart(ghost), message),
    async close() {
      for (const id of installed.keys()) runtime.stop(id);
      await platform.close();
    },
  };
}

/** Process ids whose command line runs `executablePath` (POSIX `ps`), for leak checks. */
export async function processesRunning(executablePath) {
  const { execFile } = await import('node:child_process');
  const out = await new Promise((resolve, reject) => execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
  return new Set(out.split('\n').filter(line => line.includes(executablePath)).map(line => Number.parseInt(line, 10)).filter(Number.isFinite));
}
