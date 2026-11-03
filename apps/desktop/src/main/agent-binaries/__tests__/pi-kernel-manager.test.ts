import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PiKernelManager, parseOfficialPiRelease, type PiKernelManagerDeps } from '../pi-kernel-manager.js';
import { atomicWriteFileSync } from '../../utils/atomicWriteFile.js';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
vi.mock('../../manifestService.js', () => ({ getBaseUrl: () => 'https://hotfix.cindy.app/cindy', getPlatformKey: () => 'darwin-arm64' }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const executable = process.platform === 'win32' ? 'pi.exe' : 'pi';
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-selection-test-')); roots.push(root);
  // Reproduce the real legacy mismatch: folder 0.84.4 contains Pi 0.85.1.
  const legacy = path.join(root, '0.84.4', executable);
  await fs.mkdir(path.dirname(legacy)); await fs.writeFile(legacy, '0.85.1');
  let current = legacy;
  const deps: PiKernelManagerDeps = {
    root, current: () => current, activate: binary => { current = binary; },
    lookup: vi.fn(async source => ({ version: source === 'official' ? '0.84.4' : '0.87.1', url: 'https://example.test/pi', sha256: 'a'.repeat(64), format: 'tar.gz' as const, executable })),
    probe: vi.fn(async binary => fs.readFile(binary, 'utf8').catch(() => null)),
    install: vi.fn(async (installRoot, release) => {
      const directory = path.join(installRoot, `${release.version}-${randomUUID()}`);
      await fs.mkdir(directory); await fs.writeFile(path.join(directory, executable), release.version);
      await fs.writeFile(path.join(directory, '.verified'), release.sha256);
      return { binaryPath: path.join(directory, executable), version: release.version };
    }),
    writeSelection: atomicWriteFileSync, lock: async operation => operation(),
  };
  return { root, legacy, deps, manager: new PiKernelManager(deps) };
}

describe('Pi version selection', () => {
  it('reads real versions, isolates upgrades, and retains an explicit downgrade across restart', async () => {
    const { root, legacy, deps, manager } = await fixture();
    expect(await manager.check()).toMatchObject({ currentVersion: '0.85.1', official: { release: { version: '0.84.4' }, error: false }, upstream: { release: { version: '0.87.1' }, error: false } });
    await manager.install({ source: 'upstream', version: '0.87.1' });
    const higher = deps.current()!;
    expect(path.basename(path.dirname(higher))).toMatch(/^0\.87\.1-/);
    await manager.install({ source: 'official', version: '0.84.4' });
    const restored = deps.current();
    expect(path.basename(path.dirname(restored!))).toMatch(/^0\.84\.4-/);
    expect(await new PiKernelManager(deps).selectedBinary()).toBe(restored);
    expect(await fs.readFile(higher, 'utf8')).toBe('0.87.1');
    expect(await fs.readFile(legacy, 'utf8')).toBe('0.85.1');
    expect(JSON.parse(await fs.readFile(path.join(root, 'selected.json'), 'utf8'))).toMatchObject({ source: 'official', version: '0.84.4' });
  });
  it('does not install a different release from the one the user confirmed', async () => {
    const { manager, deps, legacy } = await fixture();
    await expect(manager.install({ source: 'upstream', version: '0.86.0' })).rejects.toMatchObject({ reason: 'version-changed' });
    expect(deps.install).not.toHaveBeenCalled(); expect(deps.current()).toBe(legacy);
  });
  it.each(['download', 'selection'])('preserves the old pointer and executable when %s fails', async stage => {
    const { manager, deps, root } = await fixture();
    await manager.install({ source: 'official', version: '0.84.4' });
    const old = deps.current();
    const before = await fs.readFile(path.join(root, 'selected.json'), 'utf8');
    const directories = await fs.readdir(root);
    if (stage === 'download') deps.install = async () => { throw new Error('network'); };
    else deps.writeSelection = () => { throw new Error('disk'); };
    await expect(manager.install({ source: 'upstream', version: '0.87.1' })).rejects.toThrow();
    expect(deps.current()).toBe(old);
    expect(await fs.readFile(path.join(root, 'selected.json'), 'utf8')).toBe(before);
    expect(await fs.readdir(root)).toEqual(directories);
    expect((await manager.state()).operation).toBeNull();
  });
  it('serializes UI and command updates and shows the in-flight state', async () => {
    const { manager, deps } = await fixture();
    const lookup = deps.lookup;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    deps.lookup = async (...args) => { await gate; return lookup(...args); };
    const first = manager.install({ source: 'upstream', force: false });
    expect((await manager.state()).operation).toEqual({ source: 'upstream', phase: 'lookup' });
    await expect(manager.install({ source: 'official', version: '0.84.4' })).rejects.toMatchObject({ reason: 'busy' });
    release(); await first;
    expect(deps.install).toHaveBeenCalledTimes(1);
  });
  it('repairs legacy equal-version directory naming, without silently downgrading a newer native version', async () => {
    const { manager, deps, legacy } = await fixture();
    await fs.writeFile(legacy, '0.88.0');
    expect(await manager.install({ source: 'upstream', force: false })).toBe('0.88.0');
    expect(deps.install).not.toHaveBeenCalled();
    await fs.writeFile(legacy, '0.87.1');
    await manager.install({ source: 'upstream', force: false });
    expect(deps.current()).not.toBe(legacy);
    expect(path.basename(path.dirname(deps.current()!))).toMatch(/^0\.87\.1-/);
  });
  it('keeps native self-updates usable and lets managed commands repair a broken saved selection', async () => {
    const { manager, deps, root } = await fixture();
    await manager.install({ source: 'upstream', force: true });
    await fs.writeFile(deps.current()!, '0.88.0');
    expect(await new PiKernelManager(deps).selectedBinary()).toBe(deps.current());
    await fs.writeFile(path.join(root, 'selected.json'), '{broken');
    await expect(manager.selectedBinary()).rejects.toMatchObject({ reason: 'selection-invalid' });
    await manager.install({ source: 'upstream', force: true });
    expect(await manager.selectedBinary()).toBe(deps.current());
  });
  it('does not silently adopt another version when the selected binary is missing', async () => {
    const { manager, deps } = await fixture();
    await manager.install({ source: 'official', version: '0.84.4' });
    await fs.rm(deps.current()!);
    await expect(new PiKernelManager(deps).selectedBinary()).rejects.toMatchObject({ reason: 'selection-invalid' });
  });
  it('marks failed checks and preserves last known release without claiming freshness', async () => {
    const { manager, deps } = await fixture();
    const before = await manager.check();
    deps.lookup = async () => { throw new Error('offline'); };
    expect(await manager.check()).toMatchObject({ official: { ...before.official, error: true }, upstream: { ...before.upstream, error: true } });
  });
});

describe('Cindy formal Pi release parsing', () => {
  const base = 'https://hotfix.cindy.app/cindy';
  const pi = { version: '0.84.4', sha256: 'a'.repeat(64), file: 'pi/0.84.4/darwin-arm64/pi.dist.tar.gz', size: 123 };
  it('uses the formal manifest asset and digest, including Windows directory archives', () => {
    expect(parseOfficialPiRelease({ pi }, base, 'win32')).toMatchObject({ url: `${base}/${pi.file}`, executable: 'pi.exe', format: 'tar.gz', version: pi.version, sha256: pi.sha256 });
  });
  it.each(['../pi.tar.gz', '//example.test/pi.tar.gz', 'pi/../pi.tar.gz', '/pi.tar.gz', 'https://example.test/pi.tar.gz'])('rejects an escaping asset: %s', file => {
    expect(() => parseOfficialPiRelease({ pi: { ...pi, file } }, base)).toThrow();
  });
});
