import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listPersonalVersions,
  personalVersionId,
  hasPublishedPersonalVersionCommit,
  migrationIdentity,
  publishPersonalVersion,
  readOriginalVersion,
  readPersonalVersion,
  readVersionJson,
  retainPersonalVersion,
  runnableBundlePaths,
  selectedVersion,
  selectVersion,
  verifyPersonalVersion,
  verifyPersonalVersionSync,
  versionDirectory,
  versionsRoot,
  writeVersionJson,
  type OriginalVersion,
  type VersionProfile,
} from '../versionStore';
const uninstall = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../remote-desktop/windowsHost.js', () => ({
  uninstallWindowsDesktopSupportFrom: uninstall,
}));
import { cleanupPersonalVersions } from '../personalVersionCleanup';
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
const roots: string[] = [];
afterEach(async () => {
  uninstall.mockReset();
  uninstall.mockResolvedValue(undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-version-store-'));
  roots.push(root);
  const userData = path.join(root, 'profile');
  await mkdir(userData);
  const profile: VersionProfile = { userData, appName: 'Cindy', region: 'global', passive: false };
  const source = path.join(root, process.platform === 'darwin' ? 'Cindy.app' : 'Cindy');
  const { resources, executable } = runnableBundlePaths(source, 'Cindy');
  await mkdir(path.join(resources, 'drizzle'), { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, 'executable A');
  await writeFile(path.join(resources, 'app.asar'), 'application A');
  await writeFile(
    path.join(resources, 'drizzle/0000_base.sql'),
    'CREATE TABLE example(id TEXT);\n',
  );
  await writeFile(
    path.join(resources, 'cindy-version-protocol.json'),
    JSON.stringify({ version: 1 }),
  );
  const commit = 'a'.repeat(40);
  const builtAt = '2026-09-17T20:00:00.000+08:00';
  await writeFile(
    path.join(resources, 'cindy-source.json'),
    JSON.stringify({ sourceCommit: commit, builtAt }),
  );
  const original: OriginalVersion = {
    protocol: 1,
    profile,
    executable,
    appPath: path.join(resources, 'app.asar'),
    resources,
  };
  const retain = () =>
    retainPersonalVersion({
      profile,
      sourceDirectory: source,
      appName: 'Cindy',
      title: 'Blue background',
      commit,
    });
  return {
    root,
    userData,
    profile,
    source,
    resources,
    executable,
    original,
    retain,
    commit,
    builtAt,
  };
}
describe('local Cindy version snapshots', () => {
  it('defaults to the original without creating a version registry', async () => {
    const h = await fixture();
    expect(selectedVersion(h.userData)).toBe('original');
    expect(readOriginalVersion(h.userData)).toBeNull();
    expect(listPersonalVersions(h.userData, null)).toEqual([]);
    expect(fs.existsSync(versionsRoot(h.userData))).toBe(false);
  });
  it('atomically stores readable JSON and remembers an explicit selection', async () => {
    const h = await fixture();
    const file = path.join(h.userData, 'record.json');
    writeVersionJson(file, { message: 'hello' });
    expect(readVersionJson(file)).toEqual({ message: 'hello' });
    const id = 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12);
    await selectVersion(h.userData, id);
    expect(selectedVersion(h.userData)).toBe(id);
    await selectVersion(h.userData, 'original');
    expect(selectedVersion(h.userData)).toBe('original');
  });
  it('keeps A unchanged while building B and only lists successfully published versions', async () => {
    const h = await fixture();
    const first = (await h.retain())!;
    expect(listPersonalVersions(h.userData, h.original)).toEqual([]);
    expect(hasPublishedPersonalVersionCommit(h.userData, h.commit)).toBe(false);
    publishPersonalVersion(h.userData, first);
    expect(hasPublishedPersonalVersionCommit(h.userData, h.commit)).toBe(true);
    const a = await verifyPersonalVersion(h.userData, first, h.original);
    expect(a.builtAt).toBe(h.builtAt);
    expect(a.version).toBe(`Cindy Make ${first.slice(0, 8)}`);
    expect(listPersonalVersions(h.userData, h.original)).toEqual([
      expect.objectContaining({
        id: first,
        commit: h.commit,
        builtAt: h.builtAt,
      }),
    ]);
    expect(listPersonalVersions(h.userData, h.original)[0].title).toBeUndefined();
    expect(listPersonalVersions(h.userData, h.original)[0].version).toBeUndefined();
    await writeFile(path.join(h.resources, 'app.asar'), 'application B');
    const second = (await h.retain())!;
    expect(second).not.toBe(first);
    publishPersonalVersion(h.userData, second);
    expect(
      await readFile(
        path.join(versionDirectory(h.userData, first), a.resources, 'app.asar'),
        'utf8',
      ),
    ).toBe('application A');
    expect(listPersonalVersions(h.userData, h.original).map((item) => item.id)).toEqual([second]);
    expect(selectedVersion(h.userData)).toBe('original');
    // Clearing Make source cannot erase the runnable versions.
    await mkdir(path.join(h.userData, 'cindy-make', 'source'), { recursive: true });
    await rm(path.join(h.userData, 'cindy-make'), { recursive: true });
    expect(await verifyPersonalVersion(h.userData, first, h.original)).toMatchObject({ id: first });
  });
  it('keeps only the latest personal slot while staging and preserves running files and publication facts', async () => {
    const h = await fixture();
    const first = (await h.retain())!;
    publishPersonalVersion(h.userData, first);
    await selectVersion(h.userData, first);
    writeVersionJson(path.join(versionsRoot(h.userData), 'active.json'), {
      id: first,
      pid: process.pid,
    });
    const secondCommit = 'b'.repeat(40);
    await writeFile(
      path.join(h.resources, 'cindy-source.json'),
      JSON.stringify({
        sourceCommit: secondCommit,
        builtAt: h.builtAt,
      }),
    );
    const second = (await retainPersonalVersion({
      profile: h.profile,
      sourceDirectory: h.source,
      appName: 'Cindy',
      title: 'Another task',
      commit: secondCommit,
    }))!;
    // Even with identical build timestamps, staging cannot replace the last good version.
    expect(personalVersionId(h.userData)).toBe(first);
    await cleanupPersonalVersions(h.userData);
    expect(fs.existsSync(path.join(versionDirectory(h.userData, second), 'runtime'))).toBe(true);
    publishPersonalVersion(h.userData, second);
    await cleanupPersonalVersions(h.userData);
    expect(personalVersionId(h.userData)).toBe(second);
    expect(await verifyPersonalVersion(h.userData, first, h.original)).toMatchObject({ id: first });
    await selectVersion(h.userData, second);
    writeVersionJson(path.join(versionsRoot(h.userData), 'active.json'), {
      id: second,
      pid: process.pid,
    });
    await cleanupPersonalVersions(h.userData);
    expect(fs.existsSync(path.join(versionDirectory(h.userData, first), 'runtime'))).toBe(false);
    expect(hasPublishedPersonalVersionCommit(h.userData, h.commit)).toBe(true);
    expect(hasPublishedPersonalVersionCommit(h.userData, secondCommit)).toBe(true);
    expect(await verifyPersonalVersion(h.userData, second, h.original)).toMatchObject({
      id: second,
    });
    expect(listPersonalVersions(h.userData, h.original)).toHaveLength(1);
  });
  it('uninstalls lock-screen support before retiring a replaced personal runtime', async () => {
    const h = await fixture();
    const first = (await h.retain())!;
    publishPersonalVersion(h.userData, first);
    const firstResources = path.join(
      versionDirectory(h.userData, first),
      readPersonalVersion(h.userData, first).resources,
    );
    const second = (await h.retain())!;
    publishPersonalVersion(h.userData, second);
    await cleanupPersonalVersions(h.userData);
    expect(uninstall).toHaveBeenCalledExactlyOnceWith(firstResources);
    expect(fs.existsSync(path.join(versionDirectory(h.userData, first), 'runtime'))).toBe(false);
    expect(fs.existsSync(path.join(versionDirectory(h.userData, second), 'runtime'))).toBe(true);
  });
  it('keeps a replaced personal runtime when lock-screen uninstall fails', async () => {
    const h = await fixture();
    const first = (await h.retain())!;
    publishPersonalVersion(h.userData, first);
    const firstResources = path.join(
      versionDirectory(h.userData, first),
      readPersonalVersion(h.userData, first).resources,
    );
    const second = (await h.retain())!;
    publishPersonalVersion(h.userData, second);
    uninstall.mockRejectedValueOnce(new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE'));
    await cleanupPersonalVersions(h.userData);
    expect(uninstall).toHaveBeenCalledExactlyOnceWith(firstResources);
    expect(fs.existsSync(path.join(versionDirectory(h.userData, first), 'runtime'))).toBe(true);
    expect(fs.existsSync(path.join(versionDirectory(h.userData, second), 'runtime'))).toBe(true);
  });
  it('adopts only the newest legacy application and never resurrects it after explicit deletion', async () => {
    const h = await fixture();
    const first = (await h.retain())!;
    publishPersonalVersion(h.userData, first);
    await writeFile(
      path.join(h.resources, 'cindy-source.json'),
      JSON.stringify({
        sourceCommit: h.commit,
        builtAt: '2026-09-18T01:00:00.000+08:00',
      }),
    );
    const second = (await h.retain())!;
    publishPersonalVersion(h.userData, second);
    await rm(path.join(versionsRoot(h.userData), 'personal.json'));
    expect(personalVersionId(h.userData)).toBe(second);
    expect(listPersonalVersions(h.userData, h.original)).toHaveLength(1);
    writeVersionJson(path.join(versionsRoot(h.userData), 'personal.json'), { id: null });
    expect(personalVersionId(h.userData)).toBeUndefined();
    expect(listPersonalVersions(h.userData, h.original)).toEqual([]);
  });
  it('retains the fallback bundle until the handoff helper has really exited', async () => {
    const h = await fixture();
    const first = (await h.retain())!;
    publishPersonalVersion(h.userData, first);
    const second = (await h.retain())!;
    publishPersonalVersion(h.userData, second);
    const launch = path.join(versionsRoot(h.userData), 'launches', 'a'.repeat(36) + '.json');
    writeVersionJson(launch, {
      state: 'ready',
      helperPid: process.pid,
      targetId: second,
      fallbackId: first,
    });
    await cleanupPersonalVersions(h.userData);
    expect(fs.existsSync(path.join(versionDirectory(h.userData, first), 'runtime'))).toBe(true);
    await rm(launch);
    await cleanupPersonalVersions(h.userData);
    expect(fs.existsSync(path.join(versionDirectory(h.userData, first), 'runtime'))).toBe(false);
  });
  it('never follows a replaced runtime junction while retiring old application files', async () => {
    const h = await fixture();
    const first = (await h.retain())!;
    publishPersonalVersion(h.userData, first);
    const second = (await h.retain())!;
    publishPersonalVersion(h.userData, second);
    const runtime = path.join(versionDirectory(h.userData, first), 'runtime');
    await rm(runtime, { recursive: true, force: true });
    const outside = path.join(h.root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'unrelated data');
    await symlink(outside, runtime, process.platform === 'win32' ? 'junction' : 'dir');
    await cleanupPersonalVersions(h.userData);
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('unrelated data');
    expect(fs.lstatSync(runtime).isSymbolicLink()).toBe(true);
    expect(personalVersionId(h.userData)).toBe(second);
  });
  it('rejects modified applications and mismatched database migrations before launch', async () => {
    const h = await fixture();
    const id = (await h.retain())!;
    publishPersonalVersion(h.userData, id);
    const item = readPersonalVersion(h.userData, id);
    const archive = path.join(versionDirectory(h.userData, id), item.resources, 'app.asar');
    await writeFile(archive, 'modified');
    await expect(verifyPersonalVersion(h.userData, id, h.original)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await writeFile(archive, 'application A');
    await writeFile(
      path.join(h.resources, 'drizzle/0001_new.sql'),
      'ALTER TABLE example ADD COLUMN name TEXT;',
    );
    await expect(verifyPersonalVersion(h.userData, id, h.original)).rejects.toMatchObject({
      code: 'incompatible',
    });
    expect(listPersonalVersions(h.userData, h.original)[0].compatible).toBe(false);
  });
  it('verifies synchronously for the pre-ready startup path with the same outcome', async () => {
    const h = await fixture();
    const id = (await h.retain())!;
    publishPersonalVersion(h.userData, id);
    expect(verifyPersonalVersionSync(h.userData, id, h.original)).toEqual(
      await verifyPersonalVersion(h.userData, id, h.original),
    );
    const item = readPersonalVersion(h.userData, id);
    await writeFile(
      path.join(versionDirectory(h.userData, id), item.executable),
      'executable tampered',
    );
    let failure: unknown;
    try {
      verifyPersonalVersionSync(h.userData, id, h.original);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'unavailable' });
  });
  it('runs retained personal applications even after the original Dev source directory is removed', async () => {
    const h = await fixture();
    h.original.migrationHash = migrationIdentity(path.join(h.resources, 'drizzle'));
    const id = (await h.retain())!;
    publishPersonalVersion(h.userData, id);
    await rm(h.source, { recursive: true, force: true });
    await expect(verifyPersonalVersion(h.userData, id, h.original)).resolves.toMatchObject({ id });
  });
  it('includes companion scripts in the compatibility identity and normalizes line endings', async () => {
    const h = await fixture();
    const drizzle = path.join(h.resources, 'drizzle');
    const first = migrationIdentity(drizzle);
    await writeFile(path.join(drizzle, '0000_base.sql'), 'CREATE TABLE example(id TEXT);\r\n');
    expect(migrationIdentity(drizzle)).toBe(first);
    await mkdir(path.join(drizzle, 'scripts'));
    await writeFile(path.join(drizzle, 'scripts/0000_base.ts'), 'module.exports = () => {};');
    expect(migrationIdentity(drizzle)).not.toBe(first);
  });
  it('preserves internal framework links but rejects links escaping the application', async () => {
    const h = await fixture();
    const inside = path.join(h.source, 'FrameworkVersions', 'A');
    await mkdir(inside, { recursive: true });
    await writeFile(path.join(inside, 'keep'), 'framework');
    const link = path.join(h.source, 'FrameworkVersions', 'Current');
    await symlink(
      process.platform === 'win32' ? inside : 'A',
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // Absolute junctions would keep pointing at the temporary source after copying, so test
    // portable relative links on POSIX; Windows Electron outputs have no framework links.
    if (process.platform !== 'win32') expect(await h.retain()).toEqual(expect.any(String));
    await rm(link);
    const outside = path.join(h.root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'private');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(h.retain()).rejects.toMatchObject({ code: 'unavailable' });
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('private');
  });
  it('retains legacy installer support without pretending an old application can switch profiles', async () => {
    const h = await fixture();
    await rm(path.join(h.resources, 'cindy-version-protocol.json'));
    expect(await h.retain()).toBeUndefined();
    expect(fs.existsSync(versionsRoot(h.userData))).toBe(false);
  });
  it('uses complete bundle layouts on both macOS and Windows', () => {
    const root = path.join(os.tmpdir(), 'Cindy.app');
    expect(runnableBundlePaths(root, 'Cindy', 'darwin')).toEqual({
      executable: path.join(root, 'Contents/MacOS/Cindy'),
      resources: path.join(root, 'Contents/Resources'),
    });
    expect(runnableBundlePaths(root, 'Cindy', 'win32')).toEqual({
      executable: path.join(root, 'Cindy.exe'),
      resources: path.join(root, 'resources'),
    });
  });
});
