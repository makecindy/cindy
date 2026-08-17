import { describe, expect, it } from 'vitest';

import {
  gitInstallRootFromPath,
  gitPathsForInstallRoot,
  resolveWindowsGitPath,
  translateMsysPathSegment,
  type WindowsGitPathProbes,
} from './windows-git-path.js';

function fakeFs(files: string[]): Pick<WindowsGitPathProbes, 'isDirectory' | 'isFile'> {
  const fileSet = new Set(files.map((file) => file.toLowerCase()));
  const dirs = new Set<string>();
  for (const file of fileSet) {
    let current = file;
    while (true) {
      current = current.slice(0, current.lastIndexOf('\\'));
      if (!current) break;
      dirs.add(current);
      if (/^[a-z]:$/i.test(current)) break;
    }
  }
  return {
    isFile: (candidate) => fileSet.has(candidate.replaceAll('/', '\\').toLowerCase()),
    isDirectory: (candidate) => dirs.has(candidate.replaceAll('/', '\\').replace(/[\\]+$/, '').toLowerCase()),
  };
}

describe('Windows Git/PATH helpers', () => {
  it('discovers Git install paths from registry probes', () => {
    const fs = fakeFs([
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files\\Git\\usr\\bin\\ls.exe',
    ]);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows\\System32',
      probes: { readRegistryInstallPaths: () => ['C:\\Program Files\\Git'], whereGit: () => [], ...fs },
    });
    expect(result.split(';')).toEqual([
      'C:\\Windows\\System32',
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files\\Git\\usr\\bin',
    ]);
  });

  it('discovers a Git install root from a where git result', () => {
    const fs = fakeFs(['C:\\Tools\\Git\\bin\\git.exe']);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: '',
      probes: { readRegistryInstallPaths: () => [], whereGit: () => ['C:\\Tools\\Git\\bin\\git.exe'], ...fs },
    });
    expect(result).toBe('C:\\Tools\\Git\\bin');
  });

  it.each([
    ['C:\\Git\\cmd\\git.exe', 'C:\\Git'],
    ['C:\\Git\\bin\\git.exe', 'C:\\Git'],
    ['C:\\Git\\usr\\bin\\git.exe', 'C:\\Git'],
    ['C:\\Git\\mingw64\\bin\\git.exe', 'C:\\Git'],
    ['C:\\Git\\mingw32\\bin\\git.exe', 'C:\\Git'],
  ])('infers install root from where git path %s', (gitPath, expected) => {
    expect(gitInstallRootFromPath(gitPath)).toBe(expected);
  });

  it.each([
    'C:\\Git\\cmd\\git.exe',
    'C:\\Git\\bin\\git.exe',
    'C:\\Git\\usr\\bin\\git.exe',
    'C:\\Git\\mingw64\\bin\\git.exe',
  ])('uses a where git probe at %s to add the inferred root paths', (gitPath) => {
    const fs = fakeFs([gitPath, 'C:\\Git\\cmd\\git.exe']);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: '',
      probes: { readRegistryInstallPaths: () => [], whereGit: () => [gitPath], ...fs },
    });
    expect(result).toContain('C:\\Git\\cmd');
  });

  it('validates cmd, bin and usr/bin candidates', () => {
    const fs = fakeFs(['D:\\Git\\cmd\\git.cmd', 'D:\\Git\\usr\\bin\\ls.exe']);
    expect(gitPathsForInstallRoot('D:\\Git', fs)).toEqual(['D:\\Git\\cmd', 'D:\\Git\\usr\\bin']);
  });

  it('deduplicates Windows PATH entries case-insensitively', () => {
    const fs = fakeFs(['C:\\Git\\cmd\\git.exe']);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Git\\CMD;c:\\git\\cmd;C:\\Windows',
      probes: { readRegistryInstallPaths: () => ['c:\\git'], whereGit: () => [], ...fs },
    });
    expect(result.split(';')).toEqual(['C:\\Git\\CMD', 'C:\\Windows']);
  });

  it('keeps Windows drive roots distinct from drive-relative paths', () => {
    const fs = fakeFs(['C:\\Git\\cmd\\git.exe']);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\;C:',
      probes: { readRegistryInstallPaths: () => ['C:\\Git'], whereGit: () => [], ...fs },
    });
    expect(result.split(';')).toEqual(['C:\\', 'C:', 'C:\\Git\\cmd']);
  });

  it('translates MSYS drive paths and anchors known MSYS roots', () => {
    expect(translateMsysPathSegment('/c/Users/alice', [], () => false)).toBe('C:\\Users\\alice');
    expect(translateMsysPathSegment('/d', [], () => false)).toBe('D:\\');
    expect(translateMsysPathSegment('/usr/bin', ['C:\\Git'], (candidate) => candidate === 'C:\\Git\\usr\\bin'))
      .toBe('C:\\Git\\usr\\bin');
    expect(translateMsysPathSegment('C:\\Windows', ['C:\\Git'], () => true)).toBeUndefined();
  });

  it('keeps the original PATH when Git is unavailable', () => {
    const original = 'C:\\Windows;C:\\Tools';
    expect(resolveWindowsGitPath({
      platform: 'win32',
      existingPath: original,
      probes: { readRegistryInstallPaths: () => [], whereGit: () => [], isDirectory: () => false, isFile: () => false },
    })).toBe(original);
  });

  it('keeps the original PATH when registry discovery only finds a stale install root', () => {
    const original = 'C:\\Tools;C:\\TOOLS';
    expect(resolveWindowsGitPath({
      platform: 'win32',
      existingPath: original,
      probes: {
        readRegistryInstallPaths: () => ['C:\\Missing Git'],
        whereGit: () => [],
        isDirectory: () => false,
        isFile: () => false,
      },
    })).toBe(original);
  });

  it('does not change PATH on non-Windows platforms', () => {
    const original = '/usr/bin:/bin';
    expect(resolveWindowsGitPath({
      platform: 'linux',
      existingPath: original,
      probes: { readRegistryInstallPaths: () => { throw new Error('must not probe'); } },
    })).toBe(original);
  });
});
