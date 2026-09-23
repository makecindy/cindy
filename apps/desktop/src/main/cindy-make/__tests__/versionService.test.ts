import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  profile: '',
  currentId: 'original',
  selectedId: 'original',
  current: true,
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
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../versionStartup.js', () => ({
  describeOriginalVersion: () => h.original,
  getCurrentCindyVersionId: () => h.currentId,
  isCindyVersionSwitching: () => h.switching,
  startVersionHandoff: h.handoff,
}));
import { actCindyVersion, configureCindyVersions, getCindyVersions } from '../versionService';
import { versionsRoot, versionDirectory, writeVersionJson } from '../versionStore';
import { CindyMakeManager } from '../manager';
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const latestId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const setPersonal = (target = id) =>
  writeVersionJson(path.join(versionsRoot(h.profile), 'personal.json'), { id: target });
async function seedPersonal(target: string, commit: string) {
  const directory = versionDirectory(h.profile, target);
  const runtime = path.join(directory, 'runtime');
  await mkdir(path.join(runtime, 'resources'), { recursive: true });
  await writeFile(path.join(runtime, 'Cindy.exe'), 'application');
  writeVersionJson(path.join(directory, 'version.json'), {
    protocol: 1,
    id: target,
    profile: h.original.profile,
    title: 'Old task title',
    version: `Cindy Make ${target.slice(0, 8)}`,
    commit,
    builtAt: '2026-09-22T12:00:00+08:00',
    platform: process.platform,
    arch: process.arch,
    executable: path.join('runtime', 'Cindy.exe'),
    resources: path.join('runtime', 'resources'),
    executableHash: 'a'.repeat(64),
    applicationHash: 'a'.repeat(64),
    migrationHash: 'a'.repeat(64),
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  h.profile = await mkdtemp(path.join(os.tmpdir(), 'cindy-version-service-'));
  h.currentId = 'original';
  h.selectedId = 'original';
  h.current = true;
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
  it('allows switching and returning to original while preparation is still running', async () => {
    setPersonal();
    const manager = new CindyMakeManager();
    configureCindyVersions(() => manager.hasActiveWork());
    let release!: () => void;
    await manager.startTask(
      { runId: 'version-prepare', request: 'fix', title: 'fix' },
      {
        create: async () => ({
          runId: 'version-prepare',
          platform: 'win32',
          arch: 'x64',
          checks: [],
          status: 'running',
          task: { sessionId: 'version-session', phase: 'waiting' },
        }),
        persist: async () => {},
        prepare: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        start: async () => {},
        isCurrent: () => true,
        onError: () => {},
      },
    );
    await actCindyVersion('switch', id);
    expect(h.handoff).toHaveBeenCalledWith(id, expect.any(Function));
    release();
    await manager.waitForTask('version-prepare');
    expect(manager.taskReport('version-prepare')?.status).toBe('completed');
    h.currentId = id;
    await actCindyVersion('switch', 'original');
    expect(h.handoff).toHaveBeenLastCalledWith('original', expect.any(Function));
  });
  it('switches away from a personal version without consuming its retained source conflict', async () => {
    const manager = new CindyMakeManager();
    const conflict = {
      id: 'source-update',
      status: 'conflict' as const,
      ref: 'main',
      upstreamCommit: 'a'.repeat(40),
      hasWorkspace: true,
    };
    manager.setUpstreamMerge(conflict);
    configureCindyVersions(() => manager.hasActiveWork());
    h.currentId = id;
    await actCindyVersion('switch', 'original');
    expect(h.handoff).toHaveBeenCalledWith('original', expect.any(Function));
    expect(manager.getState().upstreamMerge).toEqual(conflict);
    await actCindyVersion('switch', 'original');
    expect(h.handoff).toHaveBeenLastCalledWith('original', expect.any(Function));
  });
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
  it('allows switching during build or other running work and never quits on a failed handoff', async () => {
    setPersonal();
    configureCindyVersions(() => true);
    await actCindyVersion('switch', id);
    expect(h.handoff).toHaveBeenCalledWith(id, expect.any(Function));
    configureCindyVersions(() => false);
    await actCindyVersion('switch', id);
    expect(h.handoff).toHaveBeenLastCalledWith(id, expect.any(Function));
    h.handoff.mockRejectedValueOnce(
      Object.assign(new Error('incompatible'), { code: 'incompatible' }),
    );
    await expect(actCindyVersion('switch', id)).rejects.toThrow('incompatible');
    expect(h.quit).not.toHaveBeenCalled();
  });
  it('uses normal quit only after the host-owned handoff accepts the current owner', async () => {
    setPersonal();
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
    setPersonal();
    const directory = versionDirectory(h.profile, id);
    await seedPersonal(id, 'a'.repeat(40));
    await writeFile(path.join(h.profile, 'keep.db'), 'keep data');
    h.currentId = id;
    await expect(actCindyVersion('remove', id)).rejects.toThrow('busy');
    h.currentId = 'original';
    writeVersionJson(path.join(versionsRoot(h.profile), 'selected.json'), { id });
    await expect(actCindyVersion('remove', id)).rejects.toThrow('busy');
    writeVersionJson(path.join(versionsRoot(h.profile), 'selected.json'), { id: 'original' });
    configureCindyVersions(() => true);
    await expect(actCindyVersion('remove', id)).rejects.toThrow('busy');
    configureCindyVersions(() => false);
    await actCindyVersion('remove', id);
    await expect(access(path.join(directory, 'runtime'))).rejects.toThrow();
    await expect(access(path.join(directory, 'version.json'))).resolves.toBeUndefined();
    await expect(access(path.join(h.profile, 'keep.db'))).resolves.toBeUndefined();
    expect((await getCindyVersions()).versions.map((version) => version.id)).toEqual(['original']);
  });
  it('exposes just original and personal, with current metadata while a newer generation awaits restart', async () => {
    await seedPersonal(id, 'a'.repeat(40));
    await seedPersonal(latestId, 'b'.repeat(40));
    setPersonal(latestId);
    writeVersionJson(path.join(versionsRoot(h.profile), 'original.json'), h.original);
    h.currentId = id;
    const state = await getCindyVersions();
    expect(state.versions.map((version) => version.id)).toEqual(['original', 'personal']);
    expect(state.currentId).toBe('personal');
    expect(state.currentVersion?.commit).toBe('a'.repeat(40));
    expect(state.versions[1].commit).toBe('b'.repeat(40));
    expect(state.versions[1].title).toBeUndefined();
    expect(state.versions[1].version).toBeUndefined();
    expect(state.personalUpdateAvailable).toBe(true);
    h.currentId = latestId;
    expect((await getCindyVersions()).personalUpdateAvailable).toBe(false);
  });
  it.each(['personal', id])(
    'switches %s to the current personal slot, including old completion UUIDs',
    async (target) => {
      setPersonal(latestId);
      await actCindyVersion('switch', target);
      expect(h.handoff).toHaveBeenCalledWith(latestId, expect.any(Function));
    },
  );
  it('rejects stale deletion and a switch after the personal version has been removed', async () => {
    setPersonal(latestId);
    await expect(actCindyVersion('remove', id)).rejects.toThrow('unavailable');
    writeVersionJson(path.join(versionsRoot(h.profile), 'personal.json'), { id: null });
    await expect(actCindyVersion('switch', id)).rejects.toThrow('unavailable');
    expect(h.handoff).not.toHaveBeenCalled();
  });
});
