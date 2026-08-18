import { describe, expect, it } from 'vitest';

import {
  decodeWindowsRegistryBase64Lines,
  decodeWindowsPathKindLines,
  findWindowsExecutablesOnPath,
  gitInstallRootFromPath,
  gitPathsForInstallRoot,
  resolveWindowsGitPath,
  translateMsysPathSegment,
  WINDOWS_GIT_REGISTRY_KEYS,
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
  it('checks per-user Git for Windows installs before machine-wide registry keys', () => {
    expect(WINDOWS_GIT_REGISTRY_KEYS).toEqual([
      'HKCU\\SOFTWARE\\GitForWindows',
      'HKLM\\SOFTWARE\\GitForWindows',
      'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
    ]);
  });

  it('round-trips non-ASCII registry paths through the PowerShell Base64 transport', () => {
    const installPath = 'C:\\Users\\测试用户\\Git';
    const encoded = Buffer.from(installPath, 'utf16le').toString('base64');
    expect(decodeWindowsRegistryBase64Lines(`${encoded}\r\nnot-base64\r\n`)).toEqual([installPath]);
  });

  it('finds git.exe in Unicode PATH segments without searching the current directory', () => {
    const gitPath = 'C:\\Users\\测试用户\\Git\\cmd\\git.exe';
    const isFile = (candidate: string) => candidate === gitPath;
    expect(findWindowsExecutablesOnPath(
      ';;tools;\\root-relative;"C:\\Users\\测试用户\\Git\\cmd";C:\\Windows',
      'git.exe',
      isFile,
    )).toEqual([gitPath]);
  });

  it('round-trips Unicode file kinds from the bounded native path probe', () => {
    const directory = 'C:\\Users\\测试用户\\Git\\cmd';
    const file = `${directory}\\git.exe`;
    const output = [
      `D\t${Buffer.from(directory, 'utf16le').toString('base64')}`,
      `F\t${Buffer.from(file, 'utf16le').toString('base64')}`,
      'invalid',
    ].join('\r\n');
    expect([...decodeWindowsPathKindLines(output).values()]).toEqual(['directory', 'file']);
  });

  it('uses one injected path-kind snapshot instead of direct filesystem probes', () => {
    const root = '\\\\offline-server\\Git';
    const cmd = `${root}\\cmd`;
    const git = `${cmd}\\git.exe`;
    let captured: readonly string[] = [];
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows',
      probes: {
        readRegistryInstallPaths: () => [root],
        findGitExecutablesOnPath: () => [],
        probePathKinds: (candidates) => {
          captured = candidates;
          return new Map([[cmd, 'directory'], [git, 'file']]);
        },
      },
    });
    expect(captured).toContain(git);
    expect(result).toBe(`C:\\Windows;${cmd}`);
  });

  it('discovers Git install paths from registry probes', () => {
    const fs = fakeFs([
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files\\Git\\usr\\bin\\ls.exe',
    ]);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows\\System32',
      probes: {
        readRegistryInstallPaths: () => ['C:\\Program Files\\Git'],
        findGitExecutablesOnPath: () => [],
        ...fs,
      },
    });
    expect(result.split(';')).toEqual([
      'C:\\Windows\\System32',
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files\\Git\\usr\\bin',
    ]);
  });

  it('discovers a Git install root from a PATH executable', () => {
    const fs = fakeFs(['C:\\Tools\\Git\\bin\\git.exe']);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: '',
      probes: {
        readRegistryInstallPaths: () => [],
        findGitExecutablesOnPath: () => ['C:\\Tools\\Git\\bin\\git.exe'],
        ...fs,
      },
    });
    expect(result).toBe('C:\\Tools\\Git\\bin');
  });

  it.each([
    ['C:\\Git\\cmd\\git.exe', 'C:\\Git'],
    ['C:\\Git\\bin\\git.exe', 'C:\\Git'],
    ['C:\\Git\\usr\\bin\\git.exe', 'C:\\Git'],
    ['C:\\Git\\mingw64\\bin\\git.exe', 'C:\\Git'],
    ['C:\\Git\\mingw32\\bin\\git.exe', 'C:\\Git'],
  ])('infers install root from PATH executable %s', (gitPath, expected) => {
    expect(gitInstallRootFromPath(gitPath)).toBe(expected);
  });

  it('rejects a package-manager shim as a Git install root', () => {
    expect(gitInstallRootFromPath('C:\\Users\\alice\\scoop\\shims\\git.exe')).toBeUndefined();
  });

  it.each([
    'C:\\Git\\cmd\\git.exe',
    'C:\\Git\\bin\\git.exe',
    'C:\\Git\\usr\\bin\\git.exe',
    'C:\\Git\\mingw64\\bin\\git.exe',
  ])('uses a PATH executable at %s to add the inferred root paths', (gitPath) => {
    const fs = fakeFs([gitPath, 'C:\\Git\\cmd\\git.exe']);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: '',
      probes: { readRegistryInstallPaths: () => [], findGitExecutablesOnPath: () => [gitPath], ...fs },
    });
    expect(result).toContain('C:\\Git\\cmd');
  });

  it('uses git --exec-path to resolve an executable shim without package-manager-specific rules', () => {
    const fs = fakeFs([
      'C:\\Users\\alice\\scoop\\apps\\git\\current\\cmd\\git.exe',
      'C:\\Users\\alice\\scoop\\apps\\git\\current\\usr\\bin\\ls.exe',
    ]);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows',
      probes: {
        readRegistryInstallPaths: () => [],
        findGitExecutablesOnPath: () => ['C:\\Users\\alice\\scoop\\shims\\git.exe'],
        readGitExecPath: () => 'C:/Users/alice/scoop/apps/git/current/mingw64/libexec/git-core',
        ...fs,
      },
    });
    expect(result.split(';')).toEqual([
      'C:\\Windows',
      'C:\\Users\\alice\\scoop\\apps\\git\\current\\cmd',
      'C:\\Users\\alice\\scoop\\apps\\git\\current\\usr\\bin',
    ]);
  });

  it('fails open when a wrapper cannot identify a valid Git for Windows root', () => {
    const original = 'C:\\Windows;C:\\Tools';
    expect(resolveWindowsGitPath({
      platform: 'win32',
      existingPath: original,
      probes: {
        readRegistryInstallPaths: () => [],
        findGitExecutablesOnPath: () => ['C:\\Tools\\git.cmd'],
        readGitExecPath: () => undefined,
        isDirectory: () => false,
        isFile: () => false,
      },
    })).toBe(original);
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
      probes: { readRegistryInstallPaths: () => ['c:\\git'], findGitExecutablesOnPath: () => [], ...fs },
    });
    expect(result.split(';')).toEqual(['C:\\Git\\CMD', 'C:\\Windows']);
  });

  it('keeps Windows drive roots distinct from drive-relative paths', () => {
    const fs = fakeFs(['C:\\Git\\cmd\\git.exe']);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\;C:',
      probes: { readRegistryInstallPaths: () => ['C:\\Git'], findGitExecutablesOnPath: () => [], ...fs },
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
      probes: {
        readRegistryInstallPaths: () => [],
        findGitExecutablesOnPath: () => [],
        isDirectory: () => false,
        isFile: () => false,
      },
    })).toBe(original);
  });

  it('keeps the original PATH when registry discovery only finds a stale install root', () => {
    const original = 'C:\\Tools;C:\\TOOLS';
    expect(resolveWindowsGitPath({
      platform: 'win32',
      existingPath: original,
      probes: {
        readRegistryInstallPaths: () => ['C:\\Missing Git'],
        findGitExecutablesOnPath: () => [],
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
