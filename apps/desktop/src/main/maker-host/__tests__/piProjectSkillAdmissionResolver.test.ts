import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cindy/maker-core', () => ({
  piProjectKey: (identity: {
    canonicalRepoRoot: string | null;
    canonicalWorkingDir: string | null;
    repoRootStatus: string;
    canonicalPathEncoding: string;
    windowsCaseComparison?: string;
  }) => identity.repoRootStatus === 'resolved'
    && (
      identity.canonicalPathEncoding === 'utf8-lossless'
      || identity.canonicalPathEncoding === 'utf16-lossless'
    )
    && identity.canonicalRepoRoot
    && identity.canonicalWorkingDir
    ? (identity.windowsCaseComparison === 'ordinal-insensitive'
      ? `${identity.canonicalRepoRoot}\0${identity.canonicalWorkingDir}`.toLowerCase()
      : `${identity.canonicalRepoRoot}\0${identity.canonicalWorkingDir}`)
    : null,
}));

import {
  __testing,
  MAX_PI_PROJECT_SKILL_DISCOVERY_ENTRIES,
  PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS,
  resolveDesktopPiProjectIdentity,
  resolveDesktopPiProjectTrustInput,
  scanContainedDesktopPiProjectSkills,
} from '../pi-project-skill-admission-resolver.js';

let root = '';

function writeSkill(parent: string, name: string): string {
  const skill = path.join(parent, name);
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`);
  return skill;
}

function makeProject(): { repo: string; first: string; second: string; skills: string[] } {
  const repo = path.join(root, 'repo');
  const first = path.join(repo, 'packages', 'first');
  const second = path.join(repo, 'packages', 'second');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const skills = [
    writeSkill(path.join(first, '.pi', 'skills'), 'pi-skill'),
    writeSkill(path.join(first, '.agents', 'skills'), 'local-skill'),
    writeSkill(path.join(repo, '.agents', 'skills'), 'repo-skill'),
  ];
  fs.writeFileSync(path.join(first, '.pi', 'settings.json'), '{not-json');
  fs.writeFileSync(path.join(first, 'package.json'), '{"scripts":{"postinstall":"throw"}}');
  fs.mkdirSync(path.join(first, '.pi', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(first, '.pi', 'extensions', 'must-not-run.ts'), 'throw 1');
  return { repo, first, second, skills };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auto-skill-admission-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveDesktopPiProjectIdentity', () => {
  it('resolves the canonical working directory and nearest Git boundary', async () => {
    const project = makeProject();
    const alias = path.join(root, 'alias');
    fs.symlinkSync(project.first, alias);

    const identity = await resolveDesktopPiProjectIdentity(alias);
    const platform = process.platform === 'win32' ? 'win32' : 'posix';

    expect(identity).toMatchObject({
      workingDir: path.resolve(alias),
      canonicalWorkingDir: await fs.promises.realpath(project.first),
      canonicalRepoRoot: await fs.promises.realpath(project.repo),
      repoRootStatus: 'resolved',
      platform,
      canonicalPathEncoding: platform === 'win32' ? 'utf16-lossless' : 'utf8-lossless',
      ...(platform === 'win32'
        ? { windowsCaseComparison: 'ordinal-insensitive' }
        : {}),
    });
  });

  it('fails closed when the Git marker cannot be inspected', async () => {
    const project = makeProject();
    const gitMarker = path.join(fs.realpathSync(project.repo), '.git');
    const identity = await resolveDesktopPiProjectIdentity(project.first, {
      platform: 'posix',
      realpath: (candidate) => fs.promises.realpath(candidate),
      stat: async (candidate) => {
        if (candidate === gitMarker) {
          const error = new Error('denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return fs.promises.stat(candidate);
      },
    });

    expect(identity).toBeNull();
  });
});

describe('canonical Windows comparison', () => {
  const insensitiveIdentity = {
    workingDir: 'C:\\Repo',
    canonicalWorkingDir: 'C:\\Repo',
    canonicalRepoRoot: 'C:\\Repo',
    repoRootStatus: 'resolved' as const,
    platform: 'win32' as const,
    canonicalPathEncoding: 'utf16-lossless' as const,
    windowsCaseComparison: 'ordinal-insensitive' as const,
  };

  it('handles drive/extended paths without prefix or sibling aliases', () => {
    expect(__testing.canonicalPathIsWithin(
      insensitiveIdentity,
      '\\\\?\\C:\\Repo',
      'c:\\repo\\.pi\\skills\\safe',
    )).toBe(true);
    expect(__testing.canonicalPathIsWithin(
      insensitiveIdentity,
      'C:\\Repo',
      'C:\\Repository\\escaped',
    )).toBe(false);
  });

  it('preserves case-sensitive identity and rejects non-ASCII ordinal folding', () => {
    expect(__testing.canonicalPathsEqual(
      { ...insensitiveIdentity, windowsCaseComparison: 'case-sensitive' },
      'C:\\Repo',
      'c:\\repo',
    )).toBe(false);
    expect(__testing.comparisonPath(
      insensitiveIdentity,
      'C:\\项目',
    )).toBeNull();
  });

  it('probes child lookup semantics instead of the working directory parent', async () => {
    const lstat = vi.fn(async (candidate: string) => {
      expect(candidate).toMatch(/^C:\\Repo\\(?:Demo|demo)$/);
      return { dev: 1, ino: 2 };
    });
    await expect(__testing.detectWindowsCaseComparison('C:\\Repo', {
      readdir: async () => [{ name: 'Demo' }],
      lstat,
    })).resolves.toBe('ordinal-insensitive');
    expect(lstat).toHaveBeenCalledWith('C:\\Repo\\Demo');
    expect(lstat).toHaveBeenCalledWith('C:\\Repo\\demo');
    expect(lstat).not.toHaveBeenCalledWith('c:\\Repo');
  });

  it('detects a case-sensitive directory and fails closed without a child proof', async () => {
    await expect(__testing.detectWindowsCaseComparison('C:\\Repo', {
      readdir: async () => [{ name: 'Demo' }, { name: 'demo' }],
      lstat: async () => ({ dev: 1, ino: 2 }),
    })).resolves.toBe('case-sensitive');

    await expect(__testing.detectWindowsCaseComparison('C:\\Repo', {
      readdir: async () => [],
      lstat: async () => ({ dev: 1, ino: 2 }),
    })).resolves.toBe('unavailable');

    await expect(__testing.detectWindowsCaseComparison('C:\\Repo', {
      readdir: async () => [{ name: 'Demo' }],
      lstat: async () => ({}),
    })).resolves.toBe('unavailable');

    await expect(__testing.detectWindowsCaseComparison('C:\\Repo', {
      readdir: async () => [{ name: 'Demo' }],
      lstat: async () => ({ dev: 0, ino: 0 }),
    })).resolves.toBe('unavailable');
  });

  it('streams Windows case probes through the shared discovery budget', async () => {
    let reads = 0;
    const close = vi.fn(async (): Promise<IteratorResult<{ name: string }>> => ({
      done: true,
      value: undefined,
    }));
    const next = vi.fn(async (): Promise<IteratorResult<{ name: string }>> => {
      reads += 1;
      return {
        done: false,
        value: { name: `entry-${reads}` },
      };
    });
    const readdir = vi.fn(async () => []);
    const lstat = vi.fn(async () => ({ dev: 1, ino: 2 }));
    const budget = {
      remainingEntries: 2,
      deadlineAtMs: Date.now() + PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS,
    };

    await expect(__testing.detectWindowsCaseComparison('C:\\Repo', {
      readdir,
      openDirectory: async () => ({
        [Symbol.asyncIterator]: () => ({ next, return: close }),
      }),
      lstat,
    }, budget)).resolves.toBe('unavailable');

    expect(reads).toBe(3);
    expect(budget.remainingEntries).toBe(0);
    expect(readdir).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed when any participating Windows directory has different comparison semantics', async () => {
    const resolveWindowsCaseComparison = vi.fn(async (candidate: string) => (
      candidate === 'C:\\Repo\\packages'
        ? 'case-sensitive' as const
        : 'ordinal-insensitive' as const
    ));
    const dependencies = {
      readdir: async () => [],
      lstat: async () => ({
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
      stat: async () => ({ isDirectory: () => true, isFile: () => false }),
      realpath: async (candidate: string) => candidate,
      resolveWindowsCaseComparison,
    };

    await expect(__testing.windowsDirectoryChainMatchesIdentity(
      insensitiveIdentity,
      'C:\\Repo\\packages\\app',
      dependencies,
    )).resolves.toBe(false);
    expect(resolveWindowsCaseComparison).toHaveBeenCalledWith('C:\\Repo\\packages\\app');
    expect(resolveWindowsCaseComparison).toHaveBeenCalledWith('C:\\Repo\\packages');
    expect(resolveWindowsCaseComparison).not.toHaveBeenCalledWith('C:\\Repo');
  });

  it('fails closed when the repo root lookup differs from its own child semantics', async () => {
    const resolveWindowsCaseComparison = vi.fn(async (candidate: string) => (
      candidate === 'C:\\'
        ? 'case-sensitive' as const
        : 'ordinal-insensitive' as const
    ));
    const dependencies = {
      readdir: async () => [],
      lstat: async () => ({
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
      stat: async () => ({ isDirectory: () => true, isFile: () => false }),
      realpath: async (candidate: string) => candidate,
      resolveWindowsCaseComparison,
    };

    await expect(__testing.windowsDirectoryChainMatchesIdentity(
      insensitiveIdentity,
      'C:\\Repo\\packages\\app',
      dependencies,
    )).resolves.toBe(false);
    expect(resolveWindowsCaseComparison).toHaveBeenCalledWith('C:\\Repo');
    expect(resolveWindowsCaseComparison).toHaveBeenCalledWith('C:\\');
  });
});

describe('scanContainedDesktopPiProjectSkills', () => {
  it('rejects an oversized discovery directory before probing its children', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const targetRoot = path.join(identity.canonicalWorkingDir!, '.pi', 'skills');
    const stat = vi.fn(async (candidate: string) => fs.promises.stat(candidate));
    const lstat = vi.fn(async (candidate: string) => fs.promises.lstat(candidate));
    const realpath = vi.fn(async (candidate: string) => fs.promises.realpath(candidate));
    const openDirectory = vi.fn(async (candidate: string) => {
      if (candidate !== targetRoot) return fs.promises.opendir(candidate);
      return (async function* oversizedEntries() {
        for (let index = 0; index <= MAX_PI_PROJECT_SKILL_DISCOVERY_ENTRIES; index += 1) {
          yield {
            name: `skill-${index}`,
            isDirectory: (): boolean => true,
            isSymbolicLink: (): boolean => false,
          };
        }
      }());
    });

    expect(await scanContainedDesktopPiProjectSkills(identity, {
      readdir: async () => [],
      openDirectory,
      stat,
      lstat,
      realpath,
      resolveWindowsCaseComparison: async () => (
        identity.windowsCaseComparison ?? 'unavailable'
      ),
    })).toBeNull();
    expect(openDirectory).toHaveBeenCalledWith(targetRoot);
    expect(realpath).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(lstat).toHaveBeenCalledTimes(1);
  });

  it('bounds each candidate path probe by the discovery deadline', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const blockedSkill = path.join(identity.canonicalWorkingDir!, '.pi', 'skills', 'pi-skill');
    let markBlockedProbeStarted!: () => void;
    const blockedProbeStarted = new Promise<void>((resolve) => {
      markBlockedProbeStarted = resolve;
    });
    const blockedProbe = vi.fn(() => {
      markBlockedProbeStarted();
      return new Promise<string>(() => {});
    });
    const stat = vi.fn(async (candidate: string) => fs.promises.stat(candidate));

    vi.useFakeTimers();
    try {
      const pending = scanContainedDesktopPiProjectSkills(identity, {
        readdir: (candidate) => fs.promises.readdir(candidate, { withFileTypes: true }),
        lstat: (candidate) => fs.promises.lstat(candidate),
        stat,
        realpath: (candidate) => candidate === blockedSkill
          ? blockedProbe()
          : fs.promises.realpath(candidate),
        resolveWindowsCaseComparison: async () => (
          identity.windowsCaseComparison ?? 'unavailable'
        ),
      });

      await blockedProbeStarted;
      await vi.advanceTimersByTimeAsync(PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS);

      await expect(pending).resolves.toBeNull();
      expect(blockedProbe).toHaveBeenCalledOnce();
      expect(stat).not.toHaveBeenCalledWith(blockedSkill);
    } finally {
      vi.useRealTimers();
    }
  });

  it('triggers streaming directory cleanup after the discovery deadline', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const targetRoot = path.join(identity.canonicalWorkingDir!, '.pi', 'skills');
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const next = vi.fn(() => {
      markReadStarted();
      return new Promise<IteratorResult<fs.Dirent>>(() => {});
    });
    const close = vi.fn(() => new Promise<IteratorResult<fs.Dirent>>(() => {}));

    vi.useFakeTimers();
    try {
      const pending = scanContainedDesktopPiProjectSkills(identity, {
        readdir: (candidate) => fs.promises.readdir(candidate, { withFileTypes: true }),
        openDirectory: async (candidate) => candidate === targetRoot
          ? {
              [Symbol.asyncIterator]: () => ({ next, return: close }),
            }
          : fs.promises.opendir(candidate),
        lstat: (candidate) => fs.promises.lstat(candidate),
        stat: (candidate) => fs.promises.stat(candidate),
        realpath: (candidate) => fs.promises.realpath(candidate),
        resolveWindowsCaseComparison: async () => (
          identity.windowsCaseComparison ?? 'unavailable'
        ),
      });

      await readStarted;
      await vi.advanceTimersByTimeAsync(PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS);

      await expect(pending).resolves.toBeNull();
      expect(next).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds only directory-form Pi skills from workingDir through the repo root', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;

    const evidence = await scanContainedDesktopPiProjectSkills(identity);

    expect(evidence?.map((item) => item.discoveredPath)).toEqual(
      [
        path.join(identity.canonicalWorkingDir!, '.pi', 'skills', 'pi-skill'),
        path.join(identity.canonicalWorkingDir!, '.agents', 'skills', 'local-skill'),
        path.join(identity.canonicalRepoRoot!, '.agents', 'skills', 'repo-skill'),
      ]
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(evidence?.map((item) => item.canonicalPath)).toEqual(
      await Promise.all(evidence!.map((item) => fs.promises.realpath(item.discoveredPath))),
    );
  });

  it('fails closed when a skill or a skill source symlink escapes the repository', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const outside = writeSkill(path.join(root, 'outside'), 'escaped');
    fs.symlinkSync(outside, path.join(project.first, '.pi', 'skills', 'escaped'));

    expect(await scanContainedDesktopPiProjectSkills(identity)).toBeNull();

    fs.rmSync(path.join(project.first, '.pi', 'skills'), { recursive: true, force: true });
    fs.symlinkSync(path.dirname(outside), path.join(project.first, '.pi', 'skills'));
    expect(await scanContainedDesktopPiProjectSkills(identity)).toBeNull();
  });

  it('distinguishes absent sources from broken source or manifest symlinks', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const piSkillRoot = path.join(project.first, '.pi', 'skills');
    fs.rmSync(piSkillRoot, { recursive: true, force: true });
    fs.symlinkSync(path.join(root, 'missing-root'), piSkillRoot);
    expect(await scanContainedDesktopPiProjectSkills(identity)).toBeNull();

    fs.unlinkSync(piSkillRoot);
    const skill = writeSkill(piSkillRoot, 'broken-manifest');
    fs.unlinkSync(path.join(skill, 'SKILL.md'));
    fs.symlinkSync(path.join(root, 'missing-skill.md'), path.join(skill, 'SKILL.md'));
    expect(await scanContainedDesktopPiProjectSkills(identity)).toBeNull();
  });
});

describe('resolveDesktopPiProjectTrustInput', () => {
  it('wires production identity and scan through their shared-deadline overloads', async () => {
    const identityImplementation = vi.fn(async () => null);
    const scanImplementation = vi.fn(async () => null);
    const dependencies = __testing.defaultResolverDeps(
      identityImplementation,
      scanImplementation,
    );
    const identity = {
      workingDir: 'C:\\Repo',
      canonicalWorkingDir: 'C:\\Repo',
      canonicalRepoRoot: 'C:\\Repo',
      repoRootStatus: 'resolved' as const,
      platform: 'win32' as const,
      canonicalPathEncoding: 'utf16-lossless' as const,
      windowsCaseComparison: 'ordinal-insensitive' as const,
    };

    await dependencies.resolveIdentity('C:\\Repo', 1234);
    await dependencies.scanProjectSkills(identity, 1234);

    expect(identityImplementation).toHaveBeenCalledWith('C:\\Repo', 1234);
    expect(scanImplementation).toHaveBeenCalledWith(identity, 1234);
  });

  it('automatically admits contained skills and hard-empties every non-skill surface', async () => {
    const project = makeProject();

    const snapshot = await resolveDesktopPiProjectTrustInput({
      sessionId: 'runtime-one',
      workingDir: project.first,
    });
    const identity = snapshot!.identity;
    const expectedProjectKey = `${identity.canonicalRepoRoot}\0${identity.canonicalWorkingDir}`;

    expect(snapshot?.approval).toMatchObject({
      status: 'approved',
      scope: 'working-dir',
      scopeKey: identity.windowsCaseComparison === 'ordinal-insensitive'
        ? expectedProjectKey.toLowerCase()
        : expectedProjectKey,
    });
    expect(snapshot?.approval?.revision).toMatch(/^auto-skills-v1:[a-f0-9]{64}$/);
    expect(snapshot?.discovered.skills).toEqual(
      project.skills.map((skill) => path.join(
        identity.canonicalRepoRoot!,
        path.relative(project.repo, skill),
      ))
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(snapshot?.discovered).toMatchObject({ settings: [], packages: [], extensions: [] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.discovered.skills)).toBe(true);
  });

  it('re-evaluates each new runtime and isolates concurrent working directories', async () => {
    const project = makeProject();
    const secondSkill = writeSkill(path.join(project.second, '.pi', 'skills'), 'second-skill');
    const scanProjectSkills = vi.fn(scanContainedDesktopPiProjectSkills);
    const deps = { resolveIdentity: resolveDesktopPiProjectIdentity, scanProjectSkills };

    const [first, second] = await Promise.all([
      resolveDesktopPiProjectTrustInput(
        { sessionId: 'first', workingDir: project.first },
        deps,
      ),
      resolveDesktopPiProjectTrustInput(
        { sessionId: 'second', workingDir: project.second },
        deps,
      ),
    ]);
    const added = writeSkill(path.join(project.first, '.pi', 'skills'), 'new-runtime-skill');
    const restarted = await resolveDesktopPiProjectTrustInput(
      { sessionId: 'first-restarted', workingDir: project.first },
      deps,
    );

    expect(scanProjectSkills).toHaveBeenCalledTimes(6);
    expect(restarted).not.toBeNull();
    expect(first?.approval?.revision).not.toBe(second?.approval?.revision);
    expect(restarted?.approval?.revision).not.toBe(first?.approval?.revision);
    expect(restarted?.discovered.skills).toContain(
      path.join(restarted!.identity.canonicalWorkingDir!, '.pi', 'skills', path.basename(added)),
    );
    expect(second?.discovered.skills).toEqual([
      path.join(second!.identity.canonicalRepoRoot!, '.agents', 'skills', 'repo-skill'),
      path.join(second!.identity.canonicalWorkingDir!, '.pi', 'skills', path.basename(secondSkill)),
    ].sort((left, right) => left.localeCompare(right)));
  });

  it('fails closed for remote sessions and scan failures', async () => {
    const project = makeProject();
    const scanProjectSkills = vi.fn(scanContainedDesktopPiProjectSkills);

    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first, remoteHostId: 'remote-one' },
      { resolveIdentity: resolveDesktopPiProjectIdentity, scanProjectSkills },
    )).toBeNull();
    expect(scanProjectSkills).not.toHaveBeenCalled();

    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first },
      { resolveIdentity: resolveDesktopPiProjectIdentity, scanProjectSkills: async () => null },
    )).toBeNull();
  });

  it('shares one deadline across identity resolution and both stability scans', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const evidence = (await scanContainedDesktopPiProjectSkills(identity))!;
    const deadlines: number[] = [];
    const resolveIdentity = vi.fn(async (_workingDir: string, deadlineAtMs?: number) => {
      deadlines.push(deadlineAtMs!);
      return identity;
    });
    const scanProjectSkills = vi.fn(async (
      _identity: typeof identity,
      deadlineAtMs?: number,
    ) => {
      deadlines.push(deadlineAtMs!);
      return evidence;
    });

    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first },
      { resolveIdentity, scanProjectSkills },
    )).not.toBeNull();
    expect(deadlines).toHaveLength(4);
    expect(new Set(deadlines).size).toBe(1);
  });

  it('fails closed when outer identity resolution exceeds the shared deadline', async () => {
    const project = makeProject();
    const resolveIdentity = vi.fn(() => (
      new Promise<Awaited<ReturnType<typeof resolveDesktopPiProjectIdentity>>>(() => {})
    ));
    const scanProjectSkills = vi.fn(async () => []);

    vi.useFakeTimers();
    try {
      const pending = resolveDesktopPiProjectTrustInput(
        { workingDir: project.first },
        { resolveIdentity, scanProjectSkills },
      );
      await vi.advanceTimersByTimeAsync(PI_PROJECT_SKILL_DISCOVERY_DEADLINE_MS);

      await expect(pending).resolves.toBeNull();
      expect(resolveIdentity).toHaveBeenCalledOnce();
      expect(scanProjectSkills).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates if the repo identity or complete skill directory set changes mid-resolution', async () => {
    const project = makeProject();
    const firstIdentity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const changedIdentity = { ...firstIdentity, canonicalWorkingDir: project.second };
    const resolveIdentity = vi.fn()
      .mockResolvedValueOnce(firstIdentity)
      .mockResolvedValueOnce(changedIdentity);
    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first },
      { resolveIdentity, scanProjectSkills: scanContainedDesktopPiProjectSkills },
    )).toBeNull();

    const evidence = (await scanContainedDesktopPiProjectSkills(firstIdentity))!;
    const scanProjectSkills = vi.fn()
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce(evidence.slice(1));
    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first },
      { resolveIdentity: async () => firstIdentity, scanProjectSkills },
    )).toBeNull();
  });

  it('fails closed when a skill symlink changes after the first scan', async () => {
    const project = makeProject();
    const firstTarget = writeSkill(path.join(project.repo, 'skill-targets'), 'first-target');
    const secondTarget = writeSkill(path.join(project.repo, 'skill-targets'), 'second-target');
    const skillLink = path.join(project.first, '.pi', 'skills', 'linked-skill');
    fs.symlinkSync(firstTarget, skillLink);
    let scans = 0;
    const scanProjectSkills = async (identity: Parameters<
      typeof scanContainedDesktopPiProjectSkills
    >[0]) => {
      const evidence = await scanContainedDesktopPiProjectSkills(identity);
      if (scans++ === 0) {
        fs.unlinkSync(skillLink);
        fs.symlinkSync(secondTarget, skillLink);
      }
      return evidence;
    };

    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first },
      { resolveIdentity: resolveDesktopPiProjectIdentity, scanProjectSkills },
    )).toBeNull();
    expect(scans).toBe(2);
  });

  it('fails closed when Windows comparison identity changes with the same project key', async () => {
    const firstIdentity = {
      workingDir: 'c:\\repo',
      canonicalWorkingDir: 'c:\\repo',
      canonicalRepoRoot: 'c:\\repo',
      repoRootStatus: 'resolved' as const,
      platform: 'win32' as const,
      canonicalPathEncoding: 'utf16-lossless' as const,
      windowsCaseComparison: 'case-sensitive' as const,
    };
    const secondIdentity = {
      ...firstIdentity,
      windowsCaseComparison: 'ordinal-insensitive' as const,
    };
    const resolveIdentity = vi.fn()
      .mockResolvedValueOnce(firstIdentity)
      .mockResolvedValueOnce(secondIdentity);

    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: 'c:\\repo' },
      { resolveIdentity, scanProjectSkills: async () => [] },
    )).toBeNull();
  });
});
