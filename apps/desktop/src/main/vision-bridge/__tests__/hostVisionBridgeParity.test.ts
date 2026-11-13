/**
 * Host vs desktop: the vision bridge (release table row 5).
 *
 *   The desktop side is this directory's own modules, wired as maker-host/index.ts wires them;
 *   the Host side is apps/host/src/agent/vision-bridge.ts. Both describe the same image through
 *   the same local mock vision backends (a primary and a fallback custom provider on 127.0.0.1)
 *   and must send the same requests (path, model, credential, body), get the same description,
 *   fall back to the same backend, and give the same notices. The Pi env, the settings files
 *   (the Host keeps an unreadable one byte for byte: its boot step sets the process default,
 *   set here explicitly because the test does not run main.ts) and the process-wide controller
 *   and gateway key after an owner change are checked too. No real model is called.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';

const h = vi.hoisted(() => ({ desktopUserData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => h.desktopUserData } }));

import { createVisionBridge } from '../vision-bridge.js';
import { buildPiVisionBridgeEnv } from '../pi-vision-bridge-env.js';
import { createVisionBridgeSettingsStore } from '../visionBridgeSettingsStoreCore.js';
import { getVisionBridgeController, setVisionBridgeController } from '../vision-bridge-controller.js';
import { getActiveCatalog, setCustomProviders } from '../../maker-host/active-catalog.js';
import { resolveVisionBackendRoute, setCustomProviderKeyReader, setVisionGatewayKeyReader } from '../../maker-host/provider-route.js';
import { setPreserveUnreadableSettingsFilesByDefault } from '../../maker-host/override-settings-file.js';
import { createMakerLogger } from '../../maker-host/logger-adapter.js';

// Local fixture vision backends and real settings files, for both sides.
// An explicit bound instead of the 5 s / 10 s defaults, wide enough for the loaded full desktop pool.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type HostVisionBridge = {
  hook: (msg: unknown, ctx: { model: string; sessionId?: string }) => Promise<{ applied: boolean; message: { content: Array<{ type: string; text?: string }> } }>;
  settings: { readVisionBridgeSettings(): unknown };
  resolvePiVisionBridgeEnv(model: string, sessionId?: string): Record<string, string> | null;
  activate(): void;
  close(): void;
};
type HostModule = {
  createHostVisionBridge(options: Record<string, unknown>): HostVisionBridge;
  createVisionBridgeNotices(publish: (notice: unknown) => void, logger: unknown): (sessionId: string, reason: string, extra?: { imageCount?: number }) => void;
};
let host: HostModule;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const logger = createMakerLogger('vision-parity');
const roots: string[] = [];
const tempDir = (label: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vision-parity-${label}-`)); roots.push(dir); return dir; };

let base = '';
let primaryDown = false;
let requests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    requests.push({ path: req.url ?? '', authorization: (req.headers.authorization as string | undefined) ?? null, body: JSON.parse(raw || 'null') });
    const backend = (req.url ?? '').split('/')[1];
    if (backend === 'primary' && primaryDown) { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [{ type: 'output_text', text: `${backend} description` }] }));
  });
});

beforeAll(async () => {
  const hostModule = '../../../../../host/src/agent/vision-bridge.ts';
  host = (await import(/* @vite-ignore */ hostModule)) as HostModule;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  setCustomProviders(['primary', 'fallback'].map(name => buildUserProvider({
    id: `fixture-${name}`, name: `Fixture ${name}`,
    runtimes: { codex: { baseUrl: `${base}/${name}`, models: [{ id: 'vision-model', name: 'Vision' }] } },
  })));
  setCustomProviderKeyReader((id) => `key-${id}`);
}, 120_000);

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  setPreserveUnreadableSettingsFilesByDefault(false);
  setVisionBridgeController(null);
  setVisionGatewayKeyReader(() => null);
  primaryDown = false;
  requests = [];
});

const SETTINGS = {
  enabled: true, targetModels: ['fixture-target'],
  primary: { providerId: 'fixture-primary', modelId: 'vision-model' },
  fallback: { providerId: 'fixture-fallback', modelId: 'vision-model' },
};
const readCustomProviderKey = (id: string) => `key-${id}`;

/** The desktop wiring of maker-host/index.ts, with a fake userData and no Maker session. */
function desktopSide(notices: unknown[]) {
  h.desktopUserData = tempDir('desktop');
  fs.writeFileSync(path.join(h.desktopUserData, 'vision-bridge-settings.json'), JSON.stringify(SETTINGS));
  setVisionGatewayKeyReader(() => 'fixture-gateway-key');
  const getProviderById = (providerId: string) => getActiveCatalog().providers.find(p => p.id === providerId) ?? null;
  const bridge = createVisionBridge({
    getProviderById,
    resolveTargetModel: () => null,
    readCustomProviderKey,
    readGatewayKey: () => 'fixture-gateway-key',
    resolveGatewayEndpoint: () => null,
    resolveBackendRoute: (providerId, modelId) => resolveVisionBackendRoute(providerId, modelId, null),
    fetch: globalThis.fetch,
    logger: logger.child('vision-bridge'),
    onStart: (sessionId, imageCount) => notices.push(['vision-bridge-recognizing', sessionId, imageCount]),
    onNote: (_note, sessionId, kind) => notices.push([kind === 'fallback' ? 'vision-bridge-fallback' : 'vision-bridge-unavailable', sessionId, undefined]),
  });
  setVisionBridgeController({ shouldBridge: bridge.isTargetModel, describeImage: bridge.describeImage });
  const piEnv = (model: string, sessionId: string) => buildPiVisionBridgeEnv({
    getProviderById, readCustomProviderKey, readGatewayKey: () => 'fixture-gateway-key',
    resolveBackendRoute: (providerId, modelId) => resolveVisionBackendRoute(providerId, modelId, null),
    fetch: globalThis.fetch,
  }, model, sessionId);
  return { hook: bridge.hook, piEnv, close: () => { setVisionBridgeController(null); bridge.dispose(); } };
}

function hostSide(notices: unknown[], gatewayKey = 'fixture-gateway-key') {
  const userDataDir = tempDir('host');
  fs.writeFileSync(path.join(userDataDir, 'vision-bridge-settings.json'), JSON.stringify(SETTINGS));
  const bridge = host.createHostVisionBridge({
    userDataDir, getMaker: () => null, readCustomProviderKey, readGatewayKey: () => gatewayKey, logger,
    publish: (notice: { sessionId: string; event: { data: { reason: string; imageCount?: number } } }) =>
      notices.push([notice.event.data.reason, notice.sessionId, notice.event.data.imageCount]),
  });
  bridge.activate();
  return bridge;
}

function message(imagePath: string) {
  return { type: 'user' as const, content: [{ type: 'text' as const, text: 'what is in it' }, { type: 'image' as const, path: imagePath, pathOrigin: 'desktop-host' as const }] };
}

describe('the Host vision bridge describes images as the desktop does', () => {
  for (const down of [false, true]) {
    it(down ? 'primary unavailable: the same fallback backend, description and notices' : 'primary available: the same requests and description', async () => {
      const image = path.join(tempDir('image'), 'pixel.png');
      fs.writeFileSync(image, PNG);
      const runs: Record<string, unknown> = {};
      for (const side of ['desktop', 'host'] as const) {
        primaryDown = down;
        requests = [];
        const notices: unknown[] = [];
        const bridge = side === 'desktop' ? desktopSide(notices) : hostSide(notices);
        const result = await bridge.hook(message(image), { model: 'fixture-target', sessionId: 'task-1' });
        bridge.close();
        runs[side] = {
          applied: result.applied,
          text: (result.message.content as Array<{ type: string; text?: string }>)
            .filter(block => block.type === 'text').map(block => block.text),
          requests: requests.map(request => ({ ...request })),
          notices,
        };
      }
      expect(runs.host).toEqual(runs.desktop);
      const desktop = runs.desktop as { requests: Array<{ path: string; authorization: string }>; notices: unknown[]; applied: boolean };
      expect(desktop.applied).toBe(true);
      // Which backend answered: the fallback only after the primary failed.
      expect(desktop.requests.map(request => [request.path, request.authorization])).toEqual(down
        ? [['/primary/responses', 'Bearer key-fixture-primary'], ['/fallback/responses', 'Bearer key-fixture-fallback']]
        : [['/primary/responses', 'Bearer key-fixture-primary']]);
      expect(desktop.notices.map(notice => (notice as unknown[])[0])).toEqual(down
        ? ['vision-bridge-recognizing', 'vision-bridge-fallback'] : ['vision-bridge-recognizing']);
    });
  }

  it('the Pi env is the same on both sides', async () => {
    const env: Record<string, unknown> = {};
    const desktop = desktopSide([]);
    env.desktop = desktop.piEnv('fixture-target', 'task-1');
    desktop.close();
    const hostBridge = hostSide([]);
    env.host = hostBridge.resolvePiVisionBridgeEnv('fixture-target', 'task-1');
    hostBridge.close();
    expect(env.host).toEqual(env.desktop);
    expect(env.desktop).not.toBeNull();
  });
});

describe('the settings file', () => {
  const fixtures: Record<string, string | null> = {
    current: JSON.stringify(SETTINGS),
    unreadable: '{"enabled":true,"targetModels":',
    missing: null,
  };
  for (const [label, contents] of Object.entries(fixtures)) {
    it(`${label}: read the same on both sides; the Host leaves its file byte for byte`, () => {
      const read: Record<string, unknown> = {};
      for (const side of ['desktop', 'host'] as const) {
        const dir = tempDir(`settings-${side}`);
        const file = path.join(dir, 'vision-bridge-settings.json');
        if (contents !== null) fs.writeFileSync(file, contents);
        // The desktop never sets the default; the Host's boot step does (boot-settings.ts).
        setPreserveUnreadableSettingsFilesByDefault(side === 'host');
        if (side === 'desktop') {
          read.desktop = createVisionBridgeSettingsStore({ app: { getPath: () => dir } }).readVisionBridgeSettings();
        } else {
          fs.rmSync(file, { force: true });
          if (contents !== null) fs.writeFileSync(file, contents);
          const bridge = host.createHostVisionBridge({ userDataDir: dir, getMaker: () => null, readCustomProviderKey,
            readGatewayKey: () => null, publish: () => {}, logger });
          read.host = bridge.settings.readVisionBridgeSettings();
          bridge.close();
          expect(contents === null ? !fs.existsSync(file) : fs.readFileSync(file, 'utf8') === contents).toBe(true);
        }
      }
      expect(read.host).toEqual(read.desktop);
    });
  }
});

describe('an owner change', () => {
  it('leaves neither the previous owner gateway key nor its controller', () => {
    const gatewayRoute = () => resolveVisionBackendRoute('xd', 'claude-3-7-sonnet', 'https://tenant.gateway.fixture');
    const first = hostSide([], 'key-owner-a');
    const controllerA = getVisionBridgeController();
    expect(controllerA).not.toBeNull();
    expect(gatewayRoute()?.authorization).toBe('Bearer key-owner-a');
    first.close();
    expect(getVisionBridgeController()).toBeNull();
    expect(gatewayRoute()).toBeNull();
    const second = hostSide([], 'key-owner-b');
    expect(getVisionBridgeController()).not.toBe(controllerA);
    expect(gatewayRoute()?.authorization).toBe('Bearer key-owner-b');
    // A runtime closing after its successor started leaves the successor's controller.
    first.close();
    expect(getVisionBridgeController()).not.toBeNull();
    second.close();
  });
});

describe('the notices', () => {
  it('deduplicate a repeated fallback notice until the next recognition', () => {
    const sent: unknown[] = [];
    const notify = host.createVisionBridgeNotices(notice => sent.push(notice), logger);
    notify('task-1', 'vision-bridge-fallback');
    notify('task-1', 'vision-bridge-fallback');
    notify('task-1', 'vision-bridge-recognizing', { imageCount: 1 });
    notify('task-1', 'vision-bridge-fallback');
    expect(sent.map(notice => (notice as { event: { data: { reason: string } } }).event.data.reason))
      .toEqual(['vision-bridge-fallback', 'vision-bridge-recognizing', 'vision-bridge-fallback']);
    expect(sent[0]).toEqual({ sessionId: 'task-1', event: { type: 'error', source: 'vision-bridge',
      data: { message: '视觉桥使用了备用视觉后端（主后端不可用）', isTerminal: false, reason: 'vision-bridge-fallback' } } });
  });
});
