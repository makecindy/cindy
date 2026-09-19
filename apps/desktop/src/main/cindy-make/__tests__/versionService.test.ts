import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  profile: '',
  currentId: 'original',
  selectedId: 'original',
  current: true,
  busy: false,
  switching: false,
  handoff: vi.fn(),
  quit: vi.fn(),
  original: {} as Record<string, unknown>,
}));
vi.mock('electron', () => ({ app: { getPath: () => h.profile, quit: h.quit } }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => h.current,
}));
vi.mock('../../relaunchBusyActivityIpc.js', () => ({
  readRelaunchBlockingActivity: async () => ({ busy: h.busy }),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../versionStartup.js', () => ({
  describeOriginalVersion: () => h.original,
  getCurrentCindyVersionId: () => h.currentId,
  isCindyVersionSwitching: () => h.switching,
  startVersionHandoff: h.handoff,
}));
const uninstall = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../remote-desktop/windowsHost.js', () => ({
  uninstallWindowsDesktopSupportFrom: uninstall,
}));
import { actCindyVersion, configureCindyVersions, getCindyVersions } from '../versionService';
import {
  runnableBundlePaths,
  versionsRoot,
  versionDirectory,
  writeVersionJson,
} from '../versionStore';
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
beforeEach(async () => {
  vi.clearAllMocks();
  h.profile = await mkdtemp(path.join(os.tmpdir(), 'cindy-version-service-'));
  h.currentId = 'original';
  h.selectedId = 'original';
  h.current = true;
  h.busy = false;
  h.switching = false;
  const executable = path.join(h.profile, 'original.exe');
  await writeFile(executable, 'original');
  h.original = {
    protocol: 1,
    version: '0.1.99',
    commit: 'a'.repeat(40),
    profile: { userData: h.profile, region: 'global', appName: 'Cindy', passive: false },
    executable,
    resources: h.profile,
    appPath: h.profile,
    development: { root: h.profile, node: executable, mode: 'remote', environment: {} },
  };
  configureCindyVersions(() => false);
  h.handoff.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await rm(h.profile, { recursive: true, force: true });
});
describe('version management main boundary', () => {
  it('projects Dev as the original without creating a registry on a read', async () => {
    expect(await getCindyVersions()).toMatchObject({
      currentId: 'original',
      selectedId: 'original',
      versions: [
        {
          id: 'original',
          kind: 'original',
          development: true,
          version: '0.1.99',
          commit: 'a'.repeat(40),
        },
      ],
    });
    await expect(access(versionsRoot(h.profile))).rejects.toThrow();
  });
  it('continues showing the saved original version while a personal version is running', async () => {
    writeVersionJson(path.join(versionsRoot(h.profile), 'original.json'), h.original);
    h.currentId = id;
    expect((await getCindyVersions()).versions[0]).toMatchObject({
      version: '0.1.99',
      commit: 'a'.repeat(40),
    });
  });
  it('reads the original package version for registries created before version labels', async () => {
    delete h.original.version;
    await writeFile(path.join(h.profile, 'package.json'), JSON.stringify({ version: '0.1.98' }));
    writeVersionJson(path.join(versionsRoot(h.profile), 'original.json'), h.original);
    h.currentId = id;
    expect((await getCindyVersions()).versions[0].version).toBe('0.1.98');
  });
  it.each([
    ['switch', '../outside'],
    ['remove', {}],
    ['run', id],
  ])('rejects arbitrary version action %s %s', async (action, target) => {
    await expect(actCindyVersion(action, target)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(h.handoff).not.toHaveBeenCalled();
  });
  it('blocks switching during build or other running work and never quits on a failed handoff', async () => {
    configureCindyVersions(() => true);
    await expect(actCindyVersion('switch', id)).rejects.toThrow('busy');
    configureCindyVersions(() => false);
    h.busy = true;
    await expect(actCindyVersion('switch', id)).rejects.toThrow('busy');
    h.busy = false;
    h.handoff.mockRejectedValueOnce(
      Object.assign(new Error('incompatible'), { code: 'incompatible' }),
    );
    await expect(actCindyVersion('switch', id)).rejects.toThrow('incompatible');
    expect(h.quit).not.toHaveBeenCalled();
  });
  it('uses normal quit only after the host-owned handoff accepts the current owner', async () => {
    h.handoff.mockImplementationOnce(async (_id, current: () => Promise<boolean>) => {
      expect(await current()).toBe(true);
    });
    await actCindyVersion('switch', id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.quit).toHaveBeenCalledOnce();
    h.quit.mockClear();
    h.handoff.mockImplementationOnce(async () => {
      h.current = false;
    });
    await expect(actCindyVersion('switch', id)).rejects.toThrow('busy');
    expect(h.quit).not.toHaveBeenCalled();
  });
  it('deletes only an inactive selected snapshot, retaining source and user data', async () => {
    const directory = versionDirectory(h.profile, id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'application'), 'snapshot');
    await writeFile(path.join(h.profile, 'keep.db'), 'keep data');
    h.currentId = id;
    await expect(actCindyVersion('remove', id)).rejects.toThrow('busy');
    h.currentId = 'original';
    writeVersionJson(path.join(versionsRoot(h.profile), 'selected.json'), { id });
    await expect(actCindyVersion('remove', id)).rejects.toThrow('busy');
    writeVersionJson(path.join(versionsRoot(h.profile), 'selected.json'), { id: 'original' });
    await actCindyVersion('remove', id);
    expect(uninstall).not.toHaveBeenCalled();
    await expect(access(directory)).rejects.toThrow();
    await expect(access(path.join(h.profile, 'keep.db'))).resolves.toBeUndefined();
  });
  it('uninstalls the version-scoped lock-screen service before deleting a personal snapshot', async () => {
    const directory = versionDirectory(h.profile, id);
    const runtimeName = process.platform === 'darwin' ? 'Cindy.app' : 'Cindy';
    const runtime = path.join(directory, 'runtime', runtimeName);
    const { resources, executable } = runnableBundlePaths(runtime, 'Cindy');
    await mkdir(path.dirname(executable), { recursive: true });
    await mkdir(resources, { recursive: true });
    await writeFile(executable, 'executable');
    await writeFile(path.join(resources, 'app.asar'), 'application');
    writeVersionJson(path.join(directory, 'version.json'), {
      protocol: 1,
      id,
      profile: { userData: h.profile, region: 'global', appName: 'Cindy', passive: false },
      title: 'personal',
      commit: 'a'.repeat(40),
      builtAt: '2026-09-17T20:00:00.000+08:00',
      platform: process.platform,
      arch: process.arch,
      executable: path.relative(directory, executable),
      resources: path.relative(directory, resources),
      executableHash: 'a'.repeat(64),
      applicationHash: 'b'.repeat(64),
      migrationHash: 'c'.repeat(64),
    });
    writeVersionJson(path.join(versionsRoot(h.profile), 'selected.json'), { id: 'original' });
    await actCindyVersion('remove', id);
    expect(uninstall).toHaveBeenCalledExactlyOnceWith(resources);
    await expect(access(directory)).rejects.toThrow();
  });
});
