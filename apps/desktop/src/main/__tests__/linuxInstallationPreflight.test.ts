import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findLinuxUserInstallation, linuxUserDesktopName, recognizeLinuxUserInstallation } from '../linuxInstallation';

// In-memory filesystem answers keep ownership/ACL cases deterministic on all
// hosts, including root and Windows where chmod cannot model Linux access.
describe('Linux user installation preflight', () => {
  const home = path.resolve('fixture-home');
  const prefix = path.join(home, 'cindy');
  const current = 'releases/1.0.0-digest';
  const exe = path.join(prefix, current, 'Cindy');
  const uid = 1000;
  const entries = new Map<string, fs.Stats>();
  const denied = new Set<string>();
  const stat = (type: 'file' | 'directory' | 'link', owner = uid) => ({
    uid: owner,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'link',
  }) as fs.Stats;
  const find = () => findLinuxUserInstallation(exe, home, uid);
  const recognize = () => recognizeLinuxUserInstallation(exe, home, uid);
  const desktopName = () => {
    const installation = recognize();
    return installation && linuxUserDesktopName(installation.prefix);
  };

  beforeEach(() => {
    entries.clear();
    denied.clear();
    entries.set(prefix, stat('directory'));
    entries.set(path.join(prefix, '.cindy-user-install'), stat('file'));
    entries.set(path.join(prefix, 'releases'), stat('directory'));
    entries.set(path.join(prefix, '.install.lock'), stat('file'));
    const lookup = (input: fs.PathLike) => {
      const entry = entries.get(String(input));
      if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return entry;
    };
    vi.spyOn(fs, 'realpathSync').mockImplementation((input) => String(input));
    vi.spyOn(fs, 'statSync').mockImplementation(lookup as typeof fs.statSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(lookup as typeof fs.lstatSync);
    vi.spyOn(fs, 'readlinkSync').mockReturnValue(current);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('cindy-user-install-v1:global');
    vi.spyOn(fs, 'accessSync').mockImplementation((input) => {
      if (denied.has(String(input))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('checks staging and lock access, allowing an absent lock or previous link', () => {
    expect(find()).toEqual({ prefix, current, region: 'global' });
    expect(fs.accessSync).toHaveBeenCalledWith(prefix, fs.constants.W_OK | fs.constants.X_OK);
    expect(fs.accessSync).toHaveBeenCalledWith(path.join(prefix, 'releases'), fs.constants.W_OK | fs.constants.X_OK);
    expect(fs.accessSync).toHaveBeenCalledWith(path.join(prefix, '.install.lock'), fs.constants.W_OK);
    entries.delete(path.join(prefix, '.install.lock'));
    entries.set(path.join(prefix, 'previous'), stat('link'));
    expect(find()).not.toBeNull();
  });

  it.each(['', 'releases', '.install.lock'])('rejects denied access to %s until repaired', (name) => {
    const identity = desktopName();
    expect(identity).not.toBeNull();
    const target = path.join(prefix, name);
    denied.add(target);
    expect(find()).toBeNull();
    expect(desktopName()).toBe(identity);
    denied.delete(target);
    expect(find()).not.toBeNull();
    expect(desktopName()).toBe(identity);
  });

  it.each(['releases', '.install.lock'])('rejects foreign ownership and symlinks at %s', (name) => {
    const target = path.join(prefix, name);
    entries.set(target, stat(name === 'releases' ? 'directory' : 'file', uid + 1));
    expect(find()).toBeNull();
    expect(recognize()).not.toBeNull();
    entries.set(target, stat('link'));
    expect(find()).toBeNull();
    expect(recognize()).not.toBeNull();
  });

  it('rejects a non-link previous destination before activation', () => {
    entries.set(path.join(prefix, 'previous'), stat('directory'));
    expect(find()).toBeNull();
    expect(recognize()).not.toBeNull();
  });

  it('recognizes identity without probing update write access', () => {
    expect(recognize()).toEqual({ prefix, current, region: 'global' });
    expect(fs.accessSync).not.toHaveBeenCalled();
  });

  it.each(['marker contents', 'marker owner', 'current target'])('rejects invalid %s for both identity and update', (invalid) => {
    if (invalid === 'marker contents') vi.mocked(fs.readFileSync).mockReturnValue('not-cindy');
    if (invalid === 'marker owner') entries.set(path.join(prefix, '.cindy-user-install'), stat('file', uid + 1));
    if (invalid === 'current target') vi.mocked(fs.readlinkSync).mockReturnValue('releases/another-release');
    expect(recognize()).toBeNull();
    expect(find()).toBeNull();
  });
});
