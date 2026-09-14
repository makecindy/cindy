import { describe, expect, it } from 'vitest';

import {
  decodeWindowsRegistryBase64Lines,
  decodeWindowsPathKindLines,
  decodeWindowsPathKindsFromProbeError,
  findWindowsExecutablesOnPath,
  gitInstallRootFromPath,
  gitPathsForInstallRoot,
  partitionWindowsProbeCandidates,
  probePartitionedWindowsPathKinds,
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

  it('isolates UNC candidates and keeps device paths local', () => {
    expect(partitionWindowsProbeCandidates([
      '\\\\offline-server\\Git\\cmd',
      'C:\\PortableGit\\cmd',
      '\\\\?\\C:\\PortableGit\\cmd',
      '//offline-server/Git/bin',
    ], new Set())).toEqual({
      local: ['C:\\PortableGit\\cmd', '\\\\?\\C:\\PortableGit\\cmd'],
      network: ['\\\\offline-server\\Git\\cmd', '//offline-server/Git/bin'],
    });
  });

  it('isolates mapped network drives from local Git paths', () => {
    expect(partitionWindowsProbeCandidates([
      'Z:\\Git\\cmd\\git.exe',
      'C:\\PortableGit\\cmd',
    ], new Set(['z']))).toEqual({
      local: ['C:\\PortableGit\\cmd'],
      network: ['Z:\\Git\\cmd\\git.exe'],
    });
  });

  it('keeps a later PortableGit PATH result when an earlier UNC candidate fails', () => {
    const offlineGit = '\\\\offline-server\\Git\\cmd\\git.exe';
    const localCmd = 'C:\\PortableGit\\cmd';
    const localGit = `${localCmd}\\git.exe`;
    const phases: string[][][] = [];

    const kinds = probePartitionedWindowsPathKinds(
      [offlineGit, localCmd, localGit],
      new Set(),
      (batches) => {
        phases.push(batches.map((batch) => [...batch]));
        if (batches.some((batch) => batch.includes(offlineGit))) return new Map();
        return new Map([
          [localCmd, 'directory'],
          [localGit, 'file'],
        ]);
      },
    );

    expect(phases).toEqual([[[localCmd, localGit]], [[offlineGit]]]);
    expect(kinds).toEqual(new Map([
      [localCmd, 'directory'],
      [localGit, 'file'],
    ]));
  });

  it('isolates an unclassified mapped drive from another local drive', () => {
    const offlineMappedGit = 'Z:\\Git\\cmd\\git.exe';
    const localCmd = 'C:\\PortableGit\\cmd';
    const localGit = `${localCmd}\\git.exe`;
    const phases: string[][][] = [];

    const kinds = probePartitionedWindowsPathKinds(
      [offlineMappedGit, localCmd, localGit],
      new Set(),
      (batches) => {
        phases.push(batches.map((batch) => [...batch]));
        return new Map([
          [localCmd, 'directory'],
          [localGit, 'file'],
        ]);
      },
    );

    expect(phases).toEqual([[[offlineMappedGit], [localCmd, localGit]]]);
    expect(kinds).toEqual(new Map([
      [localCmd, 'directory'],
      [localGit, 'file'],
    ]));
  });

  it('uses one total network batch across UNC shares and mapped drives', () => {
    const localGit = 'C:\\PortableGit\\cmd\\git.exe';
    const firstUnc = '\\\\offline-one\\Git\\cmd\\git.exe';
    const secondUnc = '\\\\offline-two\\Git\\cmd\\git.exe';
    const mappedGit = 'Z:\\Git\\cmd\\git.exe';
    const phases: string[][][] = [];

    probePartitionedWindowsPathKinds(
      [firstUnc, localGit, secondUnc, mappedGit],
      new Set(['Z']),
      (batches) => {
        phases.push(batches.map((batch) => [...batch]));
        return new Map();
      },
    );

    expect(phases).toEqual([
      [[localGit]],
      [[firstUnc], [secondUnc], [mappedGit]],
    ]);
  });

  it('keeps a later network Git result when an earlier network root times out', () => {
    const offlineGit = '\\\\offline-server\\Git\\cmd\\git.exe';
    const mappedGit = 'Z:\\PortableGit\\cmd\\git.exe';
    const networkBatches: string[][][] = [];

    const kinds = probePartitionedWindowsPathKinds(
      [offlineGit, mappedGit],
      new Set(['Z']),
      (batches) => {
        networkBatches.push(batches.map((batch) => [...batch]));
        return new Map([[mappedGit, 'file']]);
      },
    );

    expect(networkBatches).toEqual([[[offlineGit], [mappedGit]]]);
    expect(kinds).toEqual(new Map([[mappedGit, 'file']]));
  });

  it('isolates candidates within the same network root under one shared budget', () => {
    const offlineGit = 'Z:\\OldGit\\cmd\\git.exe';
    const mappedGit = 'Z:\\PortableGit\\cmd\\git.exe';
    const phases: string[][][] = [];

    const kinds = probePartitionedWindowsPathKinds(
      [offlineGit, mappedGit],
      new Set(['Z']),
      (batches) => {
        phases.push(batches.map((batch) => [...batch]));
        return new Map([[mappedGit, 'file']]);
      },
    );

    expect(phases).toEqual([[[offlineGit], [mappedGit]]]);
    expect(kinds).toEqual(new Map([[mappedGit, 'file']]));
  });

  it('uses one shared local budget when mapped drives cannot be classified', () => {
    const firstOfflineGit = 'Y:\\Git\\cmd\\git.exe';
    const secondOfflineGit = 'Z:\\Git\\cmd\\git.exe';
    const localGit = 'C:\\PortableGit\\cmd\\git.exe';
    const phases: string[][][] = [];

    const kinds = probePartitionedWindowsPathKinds(
      [firstOfflineGit, secondOfflineGit, localGit],
      new Set(),
      (batches) => {
        phases.push(batches.map((batch) => [...batch]));
        return new Map([[localGit, 'file']]);
      },
    );

    expect(phases).toEqual([[[firstOfflineGit], [secondOfflineGit], [localGit]]]);
    expect(kinds).toEqual(new Map([[localGit, 'file']]));
  });

  it('keeps one stale install root from consuming every local probe slot', () => {
    const offlineRoot = 'Y:\\OldGit';
    const localRoot = 'C:\\PortableGit';
    const offlineCandidates = [
      `${offlineRoot}\\cmd\\git.exe`,
      `${offlineRoot}\\cmd`,
      `${offlineRoot}\\cmd\\git.cmd`,
      `${offlineRoot}\\cmd\\git.bat`,
      `${offlineRoot}\\bin`,
      `${offlineRoot}\\bin\\git.exe`,
      `${offlineRoot}\\bin\\git.cmd`,
      `${offlineRoot}\\bin\\git.bat`,
      `${offlineRoot}\\usr\\bin`,
      `${offlineRoot}\\usr\\bin\\git.exe`,
      `${offlineRoot}\\usr\\bin\\git.cmd`,
      `${offlineRoot}\\usr\\bin\\git.bat`,
      `${offlineRoot}\\usr\\bin\\ls.exe`,
    ];
    const localCmd = `${localRoot}\\cmd`;
    const localGit = `${localCmd}\\git.exe`;
    const phases: string[][][] = [];

    const kinds = probePartitionedWindowsPathKinds(
      [...offlineCandidates, localGit, localCmd],
      new Set(),
      (batches) => {
        phases.push(batches.map((batch) => [...batch]));
        return new Map([[localGit, 'file'], [localCmd, 'directory']]);
      },
    );

    expect(phases).toEqual([[offlineCandidates, [localGit, localCmd]]]);
    expect(kinds).toEqual(new Map([[localGit, 'file'], [localCmd, 'directory']]));
  });

  it('keeps a valid HKLM Git root after an earlier offline HKCU root', () => {
    const offlineRoot = '\\\\offline-server\\Git';
    const localRoot = 'C:\\Program Files\\Git';
    const localCmd = `${localRoot}\\cmd`;
    const localGit = `${localCmd}\\git.exe`;
    const phases: string[][][] = [];

    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows',
      probes: {
        readRegistryInstallPaths: () => [offlineRoot, localRoot],
        findGitExecutablesOnPath: () => [],
        probePathKinds: (candidates) => probePartitionedWindowsPathKinds(
          candidates,
          new Set(),
          (batches) => {
            phases.push(batches.map((batch) => [...batch]));
            if (batches.some((batch) => batch.some((candidate) => candidate.startsWith(offlineRoot)))) {
              return new Map();
            }
            return new Map([
              [localCmd, 'directory'],
              [localGit, 'file'],
            ]);
          },
        ),
      },
    });

    expect(phases[0]?.flat()).toContain(localGit);
    expect(phases.at(-1)?.flat().every((candidate) => candidate.startsWith(offlineRoot))).toBe(true);
    expect(result).toBe(`C:\\Windows;${localCmd}`);
  });

  it('reserves bounded probe capacity for registry fallbacks after PATH roots are capped', () => {
    const staleRoots = Array.from({ length: 8 }, (_, index) => `C:\\StaleGit${index + 1}`);
    const staleGitExecutables = staleRoots.map((root) => `${root}\\cmd\\git.exe`);
    const registryRoot = 'D:\\Program Files\\Git';
    const registryCmd = `${registryRoot}\\cmd`;
    const registryGit = `${registryCmd}\\git.exe`;
    const phases: string[][][] = [];
    const warnings: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];

    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows',
      probes: {
        readRegistryInstallPaths: () => [registryRoot],
        findGitExecutablesOnPath: () => staleGitExecutables,
        probePathKinds: (candidates) => probePartitionedWindowsPathKinds(
          candidates,
          new Set(),
          (batches) => {
            phases.push(batches.map((batch) => [...batch]));
            const admitted = batches.slice(0, 8).flat();
            if (!admitted.includes(registryGit)) return new Map();
            return new Map([
              [registryCmd, 'directory'],
              [registryGit, 'file'],
            ]);
          },
        ),
      },
      logger: {
        warn: (message, context) => warnings.push({ message, context }),
      },
    });

    expect(phases).toHaveLength(1);
    expect(phases[0].slice(0, 8).some((batch) => batch.includes(registryGit))).toBe(true);
    expect(phases[0][8]).toEqual([staleGitExecutables[7]]);
    expect(warnings).toEqual([{
      message: 'windows git path PATH install-root candidates truncated',
      context: { limit: 7, omitted: 1 },
    }]);
    expect(JSON.stringify(warnings)).not.toContain(staleRoots[7]);
    expect(result).toBe(`C:\\Windows;${registryCmd}`);
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

  it('validates PATH executables and install roots in one path-kind snapshot', () => {
    const staleGit = 'Z:\\OldGit\\cmd\\git.exe';
    const git = 'C:\\PortableGit\\cmd\\git.exe';
    const cmd = 'C:\\PortableGit\\cmd';
    const bin = 'C:\\PortableGit\\bin';
    const binGit = `${bin}\\git.exe`;
    const snapshots: string[][] = [];

    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows',
      probes: {
        readRegistryInstallPaths: () => [],
        findGitExecutablesOnPath: () => [staleGit, git],
        probePathKinds: (candidates) => {
          snapshots.push([...candidates]);
          return new Map([
            [git, 'file'],
            [cmd, 'directory'],
            [binGit, 'file'],
            [bin, 'directory'],
          ]);
        },
      },
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual(expect.arrayContaining([staleGit, git, cmd, binGit, bin]));
    expect(result).toBe(`C:\\Windows;${cmd};${bin}`);
  });

  it('keeps path records emitted before a bounded probe timeout', () => {
    const root = 'C:\\PortableGit';
    const cmd = `${root}\\cmd`;
    const git = `${cmd}\\git.exe`;
    const partialOutput = [
      `D\t${Buffer.from(cmd, 'utf16le').toString('base64')}`,
      `F\t${Buffer.from(git, 'utf16le').toString('base64')}`,
    ].join('\r\n');
    const timeout = Object.assign(new Error('probe timed out'), { stdout: partialOutput });

    expect(decodeWindowsPathKindsFromProbeError(timeout)).toEqual(new Map([
      [cmd.toLowerCase(), 'directory'],
      [git.toLowerCase(), 'file'],
    ]));

    expect(resolveWindowsGitPath({
      platform: 'win32',
      existingPath: `\\\\offline-server\\Git;${cmd};C:\\Windows`,
      probes: {
        readRegistryInstallPaths: () => [ '\\\\offline-server\\Git' ],
        findGitExecutablesOnPath: () => [git],
        probePathKinds: () => decodeWindowsPathKindsFromProbeError(timeout),
      },
    })).toBe(`\\\\offline-server\\Git;${cmd};C:\\Windows`);
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
    const fs = fakeFs([
      'C:\\Tools\\Git\\bin\\git.exe',
      'C:\\Tools\\Git\\cmd\\git.exe',
    ]);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: '',
      probes: {
        readRegistryInstallPaths: () => [],
        findGitExecutablesOnPath: () => ['C:\\Tools\\Git\\bin\\git.exe'],
        ...fs,
      },
    });
    expect(result).toBe('C:\\Tools\\Git\\cmd;C:\\Tools\\Git\\bin');
  });

  it('keeps the PATH-selected Git root ahead of registry fallbacks', () => {
    const fs = fakeFs([
      'C:\\Git\\cmd\\git.exe',
      'C:\\Git\\bin\\git.exe',
      'D:\\Git\\cmd\\git.exe',
      'D:\\Git\\bin\\git.exe',
    ]);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'D:\\Git\\cmd;C:\\Windows',
      probes: {
        readRegistryInstallPaths: () => ['C:\\Git'],
        findGitExecutablesOnPath: () => ['D:\\Git\\cmd\\git.exe'],
        ...fs,
      },
    });

    expect(result.split(';')).toEqual([
      'D:\\Git\\cmd',
      'C:\\Windows',
      'D:\\Git\\bin',
      'C:\\Git\\cmd',
      'C:\\Git\\bin',
    ]);
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

  it('does not let a generic bin shim prove its own Git for Windows root', () => {
    const shim = 'C:\\ProgramData\\chocolatey\\bin\\git.exe';
    const fs = fakeFs([shim]);

    expect(resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows',
      probes: { readRegistryInstallPaths: () => [], findGitExecutablesOnPath: () => [shim], ...fs },
    })).toBe('C:\\Windows');
  });

  it('does not let a cmd shim prove its own Git for Windows root', () => {
    const shim = 'C:\\Tools\\cmd\\git.exe';
    const fs = fakeFs([shim]);

    expect(resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows',
      probes: { readRegistryInstallPaths: () => [], findGitExecutablesOnPath: () => [shim], ...fs },
    })).toBe('C:\\Windows');
  });

  it.each([
    'C:\\Git\\cmd\\git.exe',
    'C:\\Git\\bin\\git.exe',
    'C:\\Git\\usr\\bin\\git.exe',
    'C:\\Git\\mingw64\\bin\\git.exe',
  ])('uses a PATH executable at %s to add the inferred root paths', (gitPath) => {
    const fs = fakeFs([gitPath, 'C:\\Git\\cmd\\git.exe', 'C:\\Git\\bin\\git.exe']);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: '',
      probes: { readRegistryInstallPaths: () => [], findGitExecutablesOnPath: () => [gitPath], ...fs },
    });
    expect(result).toContain('C:\\Git\\cmd');
  });

  it('ignores executable shims without running PATH candidates', () => {
    const shim = 'C:\\Users\\alice\\workspace\\tools\\git.exe';
    const standardGit = 'C:\\PortableGit\\cmd\\git.exe';
    const fs = fakeFs([shim, standardGit, 'C:\\PortableGit\\bin\\git.exe']);
    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: 'C:\\Windows',
      probes: {
        readRegistryInstallPaths: () => [],
        findGitExecutablesOnPath: () => [shim, standardGit],
        ...fs,
      },
    });
    expect(result).toBe('C:\\Windows;C:\\PortableGit\\cmd;C:\\PortableGit\\bin');
  });

  it('fails open when a wrapper cannot identify a valid Git for Windows root', () => {
    const original = 'C:\\Windows;C:\\Tools';
    expect(resolveWindowsGitPath({
      platform: 'win32',
      existingPath: original,
      probes: {
        readRegistryInstallPaths: () => [],
        findGitExecutablesOnPath: () => ['C:\\Tools\\git.cmd'],
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
    expect(translateMsysPathSegment('\\usr\\bin', ['C:\\Git'], () => true)).toBeUndefined();
    expect(translateMsysPathSegment('C:\\Windows', ['C:\\Git'], () => true)).toBeUndefined();
  });

  it('preserves native root-relative PATH entries when Git is discovered', () => {
    const rootRelative = '\\custom\\bin';
    const gitRoot = 'C:\\Git';
    const gitCmd = `${gitRoot}\\cmd`;
    const gitExecutable = `${gitCmd}\\git.exe`;
    const translatedCandidate = `${gitRoot}\\custom\\bin`;
    const captured: string[] = [];

    const result = resolveWindowsGitPath({
      platform: 'win32',
      existingPath: `${rootRelative};C:\\Windows`,
      probes: {
        readRegistryInstallPaths: () => [gitRoot],
        findGitExecutablesOnPath: () => [],
        probePathKinds: (candidates) => {
          captured.push(...candidates);
          return new Map([
            [gitCmd.toLowerCase(), 'directory'],
            [gitExecutable.toLowerCase(), 'file'],
            [translatedCandidate.toLowerCase(), 'directory'],
          ]);
        },
      },
    });

    expect(captured).not.toContain(translatedCandidate);
    expect(result).toBe(`${rootRelative};C:\\Windows;${gitCmd}`);
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
