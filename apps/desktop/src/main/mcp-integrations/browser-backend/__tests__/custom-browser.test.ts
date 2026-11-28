import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserControlRequest, BrowserRuntimeConfig } from '@cindy/browser-control-runtime';
import { createBrowserBackendSettingsStore } from '../../../browser-backend-settings-store.js';
import { createUserRecipeLoader } from '../../../browser-recipes/loader.js';
import { createUserRecipeWriter } from '../../../browser-recipes/writer.js';
import { createBrowserRuntime } from '../../browser.js';
import { createCustomBrowserStore } from '../custom-browser.js';

// #8899, unit: production settings handlers, disk selection and backend routing;
// replace only the CDP/process boundary. Older tests cover detected Chrome and
// copied logins separately, not a native picker result changing the active profile.
const dispatch = vi.hoisted(() => ({ config: undefined as BrowserRuntimeConfig | undefined, running: false, focus: vi.fn() }));
vi.mock('@cindy/browser-control-runtime', async (original) => ({
  ...await original<typeof import('@cindy/browser-control-runtime')>(),
  setBrowserControlRuntimeConfig: (config: BrowserRuntimeConfig) => { dispatch.config = config; },
  createBrowserControlRuntime: (options: { config: BrowserRuntimeConfig }) => {
    dispatch.config = options.config;
    return { call: async ({ action, profile, targetId }: BrowserControlRequest) => {
      const browser = dispatch.config?.browser;
      if (profile && !browser?.profiles?.[profile]) return { ok: false, action, status: 404 };
      if (action === 'start') dispatch.running = true;
      if (action === 'stop') dispatch.running = false;
      if (action === 'focus') dispatch.focus(profile, targetId);
      const executablePath = browser?.executablePath ?? null;
      return { ok: true, action, status: 200, data: {
        running: dispatch.running,
        ...(action === 'stop' ? { stopped: true } : {}),
        ...(action === 'status' ? {
          profile, executablePath, detectedExecutablePath: executablePath,
          detectedBrowser: executablePath ? 'custom' : null,
        } : {}),
        ...(action === 'tabs' ? { tabs: [{ targetId: 'visible-tab', type: 'page', url: 'about:blank' }] } : {}),
      } };
    } };
  },
}));
vi.mock('../proxy-auth.js', async (original) => ({
  ...await original<typeof import('../proxy-auth.js')>(),
  isManagedBrowserGone: async () => !dispatch.running,
  BrowserProxyAuthCoordinator: class { async start() {} async dispose() {} },
}));
vi.mock('../external-link-handoff.js', () => ({
  ExternalLinkHandoff: class { ensure() {} dispose() {} },
}));

let root: string;
let browserDir: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-custom-browser-')));
  browserDir = path.join(root, 'browser-runtime');
  vi.stubEnv('XDT_BROWSER_RUNTIME_DIR', browserDir);
  dispatch.running = false;
  dispatch.focus.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function nativeFixture(name: string): string {
  const file = path.join(root, `${name}.exe`);
  const header = Buffer.alloc(88);
  if (process.platform === 'win32') {
    header.writeUInt16LE(0x5a4d, 0);
    header.writeUInt32LE(64, 0x3c);
    header.writeUInt32LE(0x4550, 64);
    header.writeUInt16LE(2, 86);
  } else {
    header.writeUInt32BE(process.platform === 'darwin' ? 0xfeedfacf : 0x7f454c46, 0);
  }
  fs.writeFileSync(file, header, { mode: 0o700 });
  return fs.realpathSync(file);
}

function fixture(useRealProfile = false) {
  const store = createCustomBrowserStore(root);
  const settings = createBrowserBackendSettingsStore(() => root);
  if (useRealProfile) settings.writeBrowserUseRealProfile(true);
  const loader = createUserRecipeLoader(() => root);
  const runtime = createBrowserRuntime({
    tempDir: () => root, settings, customBrowserStore: store,
    recipes: { ...loader, ...createUserRecipeWriter({ userRecipesDir: loader.userRecipesDir, openPath: async () => undefined }) },
    secretIo: { readStrict: () => null, write: () => false },
    createEmbeddedBackend: () => ({
      kind: 'rsb-webview',
      async call(request) { return { ok: true, action: request.action, data: { backend: 'rsb-webview' } }; },
      async dispose() {},
    }),
  });
  let picked: string | null = null;
  const handlers = runtime.createBrowserSettingsHandlers(() => {}, async () => picked);
  return {
    runtime, store, settings, handlers,
    choose(file: string) { picked = file; return handlers.pickCustomBrowser(undefined); },
  };
}

describe('locally selected managed browser', () => {
  it('keeps each selected browser isolated across direct, proxied and manual launch, then restores detection', async () => {
    const { runtime, store, handlers, choose } = fixture(true);
    const first = nativeFixture('Chromium 1');
    const second = nativeFixture('Chromium 2');
    await expect(choose(first)).resolves.toMatchObject({ state: { active: 'external', useRealProfile: false, customBrowser: { executablePath: first } } });
    const deps = runtime.getBrowserMcpDeps();
    const control = deps.getRuntime();
    const profileA = deps.resolveProfile(undefined);
    expect(profileA).toMatch(/^Cindy-custom-[a-f0-9]{32}$/);
    expect(createCustomBrowserStore(root).read()).toEqual(store.read());
    expect(await runtime.getBrowserAvailability()).toEqual({ detected: true, browserKind: 'custom', executablePath: first });
    await expect(handlers.setUseRealProfile(undefined, { enabled: true })).rejects.toThrow(/PERMISSION_DENIED/);
    await runtime.openBrowserForLogin();
    expect(dispatch.focus).toHaveBeenCalledWith(profileA, 'visible-tab');
    expect(await control.call({ action: 'status' })).toMatchObject({ data: { profile: profileA, running: true, backend: 'external' } });
    expect(await control.call({ action: 'start', proxyServer: 'http://proxy.example.test:8080' }))
      .toMatchObject({ ok: true, data: { proxy: { mode: 'proxied' } } });
    expect(await control.call({ action: 'status' })).toMatchObject({ data: { profile: profileA, executablePath: first } });

    await choose(second);
    const profileB = deps.resolveProfile(undefined);
    expect(profileB).not.toBe(profileA);
    expect(await control.call({ action: 'status' })).toMatchObject({ data: { profile: profileB, running: false, executablePath: second } });
    expect(await control.call({ action: 'tabs', profile: profileA })).toMatchObject({ ok: false });
    await handlers.setKind(undefined, { kind: 'rsb-webview' });
    expect(await control.call({ action: 'status' })).toMatchObject({ data: { backend: 'rsb-webview' } });
    expect((await handlers.resetCustomBrowser(undefined)).active).toBe('rsb-webview');
    expect(store.read()).toBeNull();
    expect(handlers.getState(undefined)).toMatchObject({ useRealProfile: true });
    expect(await runtime.getBrowserAvailability()).toMatchObject({ executablePath: null });
  });

  it('keeps a valid choice on invalid input and fails closed when its executable disappears', async () => {
    const { runtime, handlers, choose } = fixture();
    const executablePath = nativeFixture('Selected');
    await choose(executablePath);
    const script = path.join(root, 'not-a-browser.exe');
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await expect(choose(script)).rejects.toThrow(/CUSTOM_BROWSER_INVALID/);
    expect(handlers.getState(undefined).customBrowser).toEqual({ executablePath });
    fs.unlinkSync(executablePath);
    expect(await runtime.getBrowserAvailability()).toMatchObject({ detected: false });
    const result = await runtime.getBrowserMcpDeps().getRuntime().call({ action: 'tabs' });
    expect(result).toMatchObject({ ok: false, data: { reason: 'CUSTOM_BROWSER_INVALID' } });
    await expect(runtime.openBrowserForLogin()).rejects.toMatchObject({ code: 'CUSTOM_BROWSER_INVALID' });
    expect((await handlers.resetCustomBrowser(undefined)).customBrowser).toBeUndefined();
  });

  it('does not treat an unreadable selection file as permission to launch a different browser', async () => {
    const file = path.join(root, 'browser-custom-selection.json');
    fs.writeFileSync(file, '{');
    const { runtime, handlers } = fixture();
    expect(handlers.getState(undefined).customBrowser).toEqual({ executablePath: null });
    await expect(runtime.openBrowserForLogin()).rejects.toMatchObject({ code: 'CUSTOM_BROWSER_INVALID' });
    expect((await handlers.resetCustomBrowser(undefined)).customBrowser).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects a custom profile directory redirected to the default managed profile', async () => {
    const { runtime, choose } = fixture();
    await choose(nativeFixture('Selected'));
    const profile = runtime.getBrowserMcpDeps().resolveProfile(undefined)!;
    const defaultDir = path.join(browserDir, 'browser', 'Cindy');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.symlinkSync(defaultDir, path.join(browserDir, 'browser', profile), 'junction');
    await expect(runtime.openBrowserForLogin()).rejects.toMatchObject({ code: 'CUSTOM_BROWSER_INVALID' });
  });
});
