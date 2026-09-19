import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  profile: '',
  appPath: '',
  name: 'Cindy',
  packaged: false,
  spawn: vi.fn(),
  pty: vi.fn(),
  exit: vi.fn(),
  quit: vi.fn(),
  errorBox: vi.fn(),
  live: new Set<number>(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged;
    },
    getPath: () => h.profile,
    getAppPath: () => h.appPath,
    getName: () => h.name,
    getVersion: () => '0.1.99',
    setName: (name: string) => {
      h.name = name;
    },
    setPath: (_key: string, value: string) => {
      h.profile = value;
    },
    whenReady: async () => {},
    dock: { hide: vi.fn() },
    once: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    emit: vi.fn(),
    exit: h.exit,
    quit: h.quit,
  },
  dialog: { showErrorBox: h.errorBox },
}));
vi.mock('node:child_process', async (load) => ({
  ...(await load<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));
vi.mock('../../terminal/ptyFactory.js', () => ({ defaultPtySpawn: h.pty }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../../shared/brandRegion.js', () => ({ CURRENT_CINDY_REGION: 'global' }));

const originalExec = process.execPath;
const originalArgv = [...process.argv];
let root = '';
let startup: typeof import('../versionStartup');
let store: typeof import('../versionStore');
let original: import('../versionStore').OriginalVersion;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  root = await mkdtemp(path.join(os.tmpdir(), 'cindy-version-startup-'));
  h.profile = path.join(root, 'profile');
  h.appPath = path.join(root, 'checkout', 'apps', 'desktop');
  h.name = 'Cindy';
  h.packaged = false;
  await mkdir(h.profile);
  await mkdir(path.join(h.appPath, 'drizzle'), { recursive: true });
  await mkdir(path.join(root, 'checkout/config'), { recursive: true });
  await writeFile(
    path.join(root, 'checkout/config/endpoint.json'),
    JSON.stringify({
      schemaVersion: 1,
      region: 'global',
      authApiBaseUrl: 'https://auth.example.invalid',
    }),
  );
  await writeFile(
    path.join(h.appPath, 'drizzle', '0000_base.sql'),
    'CREATE TABLE sample(id TEXT);',
  );
  const executable = path.join(root, 'electron.exe');
  await writeFile(executable, 'fixture');
  Object.defineProperty(process, 'execPath', {
    value: executable,
    configurable: true,
    writable: true,
  });
  process.argv = [executable, h.appPath];
  h.live = new Set([process.pid]);
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (!h.live.has(Number(pid))) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  for (const key of [
    'CINDY_VERSION_PROFILE',
    'CINDY_VERSION_LAUNCH',
    'CINDY_VERSION_FORWARD_ARGUMENTS',
    'XDT_USER_DATA_DIR',
    'XDT_DEVICE_ID_OVERRIDE',
    'XDT_SCHEDULER_PASSIVE',
    'XDT_ENDPOINT_MANIFEST_FILE',
    'XDT_ENDPOINTS_CDN',
    'XDT_DESKTOP_DEV_MODE',
  ])
    vi.stubEnv(key, undefined);
  vi.stubEnv('PATH', path.dirname(originalExec));
  store = await import('../versionStore');
  startup = await import('../versionStartup');
  original = {
    protocol: 1,
    profile: { userData: h.profile, appName: 'Cindy', region: 'global', passive: false },
    executable,
    appPath: h.appPath,
    resources: h.appPath,
    development: {
      root: path.join(root, 'checkout'),
      node: originalExec,
      mode: 'remote',
      environment: { PATH: path.dirname(originalExec), XDT_USER_DATA_DIR: h.profile },
    },
  };
});
afterEach(async () => {
  process.argv = originalArgv;
  Object.defineProperty(process, 'execPath', {
    value: originalExec,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
function saveOriginal() {
  store.writeVersionJson(path.join(store.versionsRoot(h.profile), 'original.json'), original);
}
function launchRequest(patch: Partial<import('../versionStartup').VersionLaunchRequest> = {}) {
  const value: import('../versionStartup').VersionLaunchRequest = {
    protocol: 1,
    id: randomUUID(),
    profile: original.profile,
    parentPid: 44001,
    helperExecutable: process.execPath,
    helperAppPath: h.appPath,
    targetId: 'original',
    fallbackId: 'original',
    createdAt: Date.now(),
    state: 'starting',
    ...patch,
  };
  store.writeVersionJson(startup.versionRequestPath(h.profile, value.id), value);
  return value;
}
describe('one original version type for Dev and installed Cindy', () => {
  it('does nothing beyond normal startup when no personal version exists', async () => {
    startup.prepareCindyVersionStartup();
    expect(await startup.dispatchCindyVersionStartup()).toBe(false);
    expect(startup.getCurrentCindyVersionId()).toBe('original');
    expect(fs.existsSync(store.versionsRoot(h.profile))).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it('captures Dev as the original and keeps full Forge/Vite return information without credentials', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fake-never-persist');
    vi.stubEnv('NODE_OPTIONS', '--require private-hook');
    const value = await startup.rememberOriginalVersion(originalExec);
    expect(value.version).toBe('0.1.99');
    expect(store.readOriginalVersion(h.profile)?.version).toBe('0.1.99');
    expect(value.development).toMatchObject({
      root: path.join(root, 'checkout'),
      node: originalExec,
      mode: 'remote',
    });
    expect(value.development?.environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(value.development?.environment).not.toHaveProperty('NODE_OPTIONS');
    expect(JSON.parse(value.profile.endpointSnapshot!.manifestText).authApiBaseUrl).toBe(
      'https://auth.example.invalid',
    );
    expect(store.selectedVersion(h.profile)).toBe('original');
    expect(await startup.dispatchCindyVersionStartup()).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it('rejects a declared endpoint realm that differs from the running original', async () => {
    await writeFile(path.join(root, 'checkout/config/endpoint.json'), JSON.stringify({ schemaVersion: 1, region: 'cn', authApiBaseUrl: 'https://auth.example.invalid' }));
    await expect(startup.rememberOriginalVersion(originalExec)).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it('pins a validated launch to its original profile and consumes launch arguments before ordinary relaunch', async () => {
    saveOriginal();
    const request = launchRequest();
    process.argv.push(
      '--cindy-version-profile=' + h.profile,
      '--cindy-version-launch=' + request.id,
    );
    startup.prepareCindyVersionStartup();
    expect(h.profile).toBe(original.profile.userData);
    expect(startup.getCurrentCindyVersionId()).toBe('original');
    expect(process.argv.some((arg) => arg.startsWith('--cindy-version-'))).toBe(false);
    expect(store.readVersionJson(startup.versionRequestPath(h.profile, request.id))).toMatchObject({
      claimedPid: process.pid,
    });
    await startup.markCindyVersionReady();
    expect(store.readVersionJson(startup.versionRequestPath(h.profile, request.id))).toMatchObject({
      state: 'ready',
    });
  });
  it('allows Forge hot reload to reuse its running Dev supervisor without replaying the switch', async () => {
    saveOriginal();
    h.live.add(45003);
    const value = launchRequest({
      state: 'ready',
      claimedPid: 45004,
      helperPid: 45003,
      createdAt: 1,
    });
    vi.stubEnv('CINDY_VERSION_PROFILE', h.profile);
    vi.stubEnv('CINDY_VERSION_LAUNCH', value.id);
    startup.prepareCindyVersionStartup();
    expect(process.env.CINDY_VERSION_LAUNCH).toBeUndefined();
    expect(await startup.dispatchCindyVersionStartup()).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it('preserves the profile keychain identity and rejects a conflicting launch identity', async () => {
    saveOriginal();
    await writeFile(path.join(h.profile, 'keychain-identity'), 'CindyDev\n');
    const first = launchRequest();
    process.argv.push('--cindy-version-profile=' + h.profile, '--cindy-version-launch=' + first.id);
    expect(() => startup.prepareCindyVersionStartup()).toThrow();
    const second = launchRequest({
      profile: { ...original.profile, appName: 'CindyDev', deviceId: 'dev-test' },
    });
    process.argv = [
      process.execPath,
      h.appPath,
      '--cindy-version-profile=' + h.profile,
      '--cindy-version-launch=' + second.id,
    ];
    startup.prepareCindyVersionStartup();
    expect(h.name).toBe('CindyDev');
    expect(process.env.XDT_DEVICE_ID_OVERRIDE).toBe('dev-test');
  });
  it('uses the existing instance activation path instead of repeatedly launching the selected personal version', async () => {
    saveOriginal();
    h.live.add(45003);
    store.writeVersionJson(path.join(store.versionsRoot(h.profile), 'active.json'), {
      pid: 45003,
      id: randomUUID(),
      scope: 'profile',
    });
    await store.selectVersion(h.profile, randomUUID());
    expect(await startup.dispatchCindyVersionStartup()).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
    expect((await import('../versionRuntimeIdentity')).getCindyVersionLockScope()).toBe('profile');
  });
  it.each(['different-executable', 'different-app', 'expired', 'cancelled'])(
    'rejects %s handoffs before opening a profile',
    (failure) => {
      saveOriginal();
      const value = launchRequest(
        failure === 'expired'
          ? { createdAt: 1 }
          : failure === 'cancelled'
            ? { state: 'cancelled' }
            : {},
      );
      if (failure === 'different-executable') {
        original.executable = path.join(root, 'other.exe');
        saveOriginal();
      }
      if (failure === 'different-app') h.appPath = path.join(root, 'different-checkout');
      process.argv.push(
        '--cindy-version-profile=' + h.profile,
        '--cindy-version-launch=' + value.id,
      );
      expect(() => startup.prepareCindyVersionStartup()).toThrow();
      expect(h.spawn).not.toHaveBeenCalled();
    },
  );
  it('refuses a conflicting switch when activity appears while the helper starts', async () => {
    saveOriginal();
    h.spawn.mockImplementation((_command, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { pid: number; unref(): void };
      child.pid = 45001;
      child.unref = () => {};
      h.live.add(child.pid);
      queueMicrotask(() => {
        const id = args
          .find((arg) => arg.startsWith('--cindy-version-helper='))!
          .split('=')
          .at(-1)!;
        const file = startup.versionRequestPath(h.profile, id);
        store.writeVersionJson(file, {
          ...store.readVersionJson<object>(file),
          helperPid: child.pid,
        });
        child.emit('spawn');
      });
      return child;
    });
    const allowed = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(startup.startVersionHandoff('original', allowed)).rejects.toMatchObject({
      code: 'busy',
    });
    expect(h.quit).not.toHaveBeenCalled();
    expect(startup.isCindyVersionSwitching()).toBe(false);
    expect(store.selectedVersion(h.profile)).toBe('original');
  });
  it('starts the original Dev through the complete existing runner and retains its PTY until exit', async () => {
    saveOriginal();
    const value = launchRequest({ state: 'pending' });
    process.argv.push('--cindy-version-profile=' + h.profile, '--cindy-version-helper=' + value.id);
    let onExit!: () => void;
    const kill = vi.fn(() => onExit());
    h.pty.mockImplementation((_node, _args, options) => {
      expect(options.env.CINDY_VERSION_LAUNCH).toBe(value.id);
      queueMicrotask(() => {
        const file = startup.versionRequestPath(h.profile, value.id);
        store.writeVersionJson(file, {
          ...store.readVersionJson<object>(file),
          state: 'ready',
          claimedPid: 45002,
        });
      });
      return {
        onData: vi.fn(),
        onExit: (callback: () => void) => {
          onExit = callback;
        },
        kill,
      };
    });
    startup.prepareCindyVersionStartup();
    const result = startup.dispatchCindyVersionStartup();
    await vi.waitFor(() => expect(h.pty).toHaveBeenCalledOnce());
    expect(h.pty.mock.calls[0].slice(0, 2)).toEqual([
      originalExec,
      [path.join(root, 'checkout/scripts/desktop-dev-runner.mjs'), 'remote'],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.exit).not.toHaveBeenCalled();
    onExit();
    await expect(result).resolves.toBe(true);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(kill).not.toHaveBeenCalled();
  });
});
