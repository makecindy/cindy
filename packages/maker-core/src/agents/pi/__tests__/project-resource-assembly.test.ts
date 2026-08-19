import { describe, expect, it, vi } from 'vitest';
import {
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  assembleApprovedPiProjectResources,
  fingerprintPiProjectSkillEntrypoint,
  MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES,
  reconcilePiProjectResourceRuntime,
  stageApprovedPiProjectResources,
  unavailablePiProjectResourceAssembly,
} from '../project-resource-assembly.js';
import { piProjectKey } from '../project-trust.js';
import type {
  PiProjectApprovalSnapshot,
  PiProjectTrustInputSnapshot,
} from '../../../types/pi-project-trust.js';

function inputFor(
  workingDir: string,
  approval: PiProjectApprovalSnapshot | null,
  skills = [`${workingDir}/.pi/skills/demo`],
): PiProjectTrustInputSnapshot {
  const repoRoot = workingDir.split('/').slice(0, 3).join('/');
  return {
    identity: {
      workingDir,
      canonicalWorkingDir: workingDir,
      canonicalRepoRoot: repoRoot,
      repoRootStatus: 'resolved',
      platform: 'posix',
      canonicalPathEncoding: 'utf8-lossless',
    },
    approval,
    discovered: {
      skills,
      canonicalSkillEvidence: skills.map((skillPath) => ({
        discoveredPath: skillPath,
        canonicalPath: skillPath,
      })),
      settings: [`${workingDir}/.pi/settings.json`],
      packages: [`${workingDir}/.pi/settings.json#packages`],
      extensions: [`${workingDir}/.pi/extensions/project.ts`],
    },
  };
}

const approved = (workingDir: string, revision: string): PiProjectApprovalSnapshot => ({
  status: 'approved',
  scope: 'working-dir',
  scopeKey: `${workingDir.split('/').slice(0, 3).join('/')}\0${workingDir}`,
  revision,
});

function inputForRepoRoot(
  workingDir: string,
  revision: string,
  skills: readonly string[],
): PiProjectTrustInputSnapshot {
  const identity: PiProjectTrustInputSnapshot['identity'] = {
    workingDir,
    canonicalWorkingDir: workingDir,
    canonicalRepoRoot: workingDir,
    repoRootStatus: 'resolved',
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    canonicalPathEncoding: process.platform === 'win32' ? 'utf16-lossless' : 'utf8-lossless',
    ...(process.platform === 'win32'
      ? { windowsCaseComparison: 'ordinal-insensitive' as const }
      : {}),
  };
  const scopeKey = piProjectKey(identity);
  if (!scopeKey) throw new Error('test project identity must be canonical');
  return {
    identity,
    approval: {
      status: 'approved',
      scope: 'working-dir',
      scopeKey,
      revision,
    },
    discovered: {
      skills,
      canonicalSkillEvidence: skills.map((skillPath) => ({
        discoveredPath: skillPath,
        canonicalPath: skillPath,
      })),
      settings: [],
      packages: [],
      extensions: [],
    },
  };
}

const available = {
  stat: async (candidate: string) => ({
    isDirectory: () => !candidate.toLowerCase().endsWith('.md'),
    isFile: () => candidate.toLowerCase().endsWith('.md'),
  }),
  realpath: async (skillPath: string) => skillPath,
  findNearestGitRoot: async (workingDir: string) => workingDir.split('/').slice(0, 3).join('/'),
};

const nativePathComparisonIdentity = process.platform === 'win32'
  ? { platform: 'win32' as const, windowsCaseComparison: 'ordinal-insensitive' as const }
  : { platform: 'posix' as const };

describe('Pi approved project resource assembly', () => {
  it('freezes only explicitly eligible project skill paths', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const result = await assembleApprovedPiProjectResources(input, workingDir, available);

    expect(result.skillPaths).toEqual(input.discovered.skills);
    expect(result.diagnostic).toEqual({
      status: 'approved',
      reason: 'approval-matched',
      approvalRevision: 'rev-a',
      requestedSkillCount: 1,
    });
    expect(result.decision?.launch).toEqual({
      approve: false,
      writeTrustJson: false,
      inheritUserPiHome: false,
      allowPackages: false,
      allowExtensions: false,
    });
    expect(result.decision?.eligibleSettingsPaths).toEqual([]);
    expect(result.decision?.settingsProjection).toBeNull();
    expect(Object.isFrozen(result.skillPaths)).toBe(true);
    expect(Object.isFrozen(result.diagnostic)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['missing', null, 'approval-missing'],
    ['unapproved', { status: 'unapproved', reason: 'user-denied' }, 'user-denied'],
    ['revoked', { status: 'revoked', revision: 'revoked-2', reason: 'user-revoked' }, 'user-revoked'],
    ['stale', { status: 'stale', revision: 'stale-2', reason: 'repo-moved' }, 'repo-moved'],
    ['unavailable', { status: 'unavailable', reason: 'authority-offline' }, 'authority-offline'],
  ] as const)('keeps %s approval discovered and fail-closed', async (_label, approval, reason) => {
    const workingDir = '/repo-a/packages/app';
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approval),
      workingDir,
      available,
    );

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe(reason);
    expect(result.decision?.resources.skills).toBe('discovered');
  });

  it('diagnoses a missing authority without manufacturing trust input', () => {
    expect(unavailablePiProjectResourceAssembly('approval-resolver-unavailable')).toEqual({
      decision: null,
      pathComparisonIdentity: null,
      skillPaths: [],
      launchSkillPaths: [],
      launchSkillDigests: [],
      launchSkillSourceFingerprints: [],
      diagnostic: {
        status: 'unavailable',
        reason: 'approval-resolver-unavailable',
        approvalRevision: null,
        requestedSkillCount: 0,
      },
    });
  });

  it('invalidates the entire approved set when one path disappeared before launch', async () => {
    const workingDir = '/repo-a/packages/app';
    const first = `${workingDir}/.pi/skills/first`;
    const missing = `${workingDir}/.agents/skills/missing`;
    const stat = vi.fn(async (skillPath: string) => {
      if (skillPath === missing) throw new Error('ENOENT');
      return { isDirectory: () => true, isFile: () => false };
    });
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-a'), [first, missing]),
      workingDir,
      { ...available, stat },
    );

    expect(stat).toHaveBeenCalled();
    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-unavailable');
    expect(result.decision?.resources.skills).toBe('eligible');
  });

  it('bounds launch path metadata probes before snapshot staging begins', async () => {
    const workingDir = '/repo-a/packages/app';
    const skillPath = `${workingDir}/.pi/skills/demo`;
    const blockedProbe = vi.fn(() => new Promise<never>(() => {}));
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-assembly-deadline')),
      workingDir,
      {
        ...available,
        stat: (candidate) => candidate === skillPath
          ? blockedProbe()
          : available.stat(candidate),
        deadlineMs: 10,
      },
    );

    expect(blockedProbe).toHaveBeenCalledOnce();
    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-unavailable');
  });

  it('limits concurrent launch path probes when the shared deadline expires', async () => {
    const workingDir = '/repo-a/packages/app';
    const skills = Array.from(
      { length: 32 },
      (_, index) => `${workingDir}/.pi/skills/skill-${index}`,
    );
    const skillPaths = new Set(skills);
    const blockedProbe = vi.fn(() => new Promise<never>(() => {}));
    const stat = vi.fn((candidate: string) => skillPaths.has(candidate)
      ? blockedProbe()
      : available.stat(candidate));

    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-bounded-launch-probes'), skills),
      workingDir,
      {
        ...available,
        stat,
        deadlineMs: 10,
      },
    );

    expect(blockedProbe).toHaveBeenCalledTimes(4);
    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-unavailable');
  });

  it('bounds nearest Git root resolution before snapshot staging begins', async () => {
    const workingDir = '/repo-a/packages/app';
    const blockedGitRoot = vi.fn(() => new Promise<string | null>(() => {}));
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-git-root-deadline')),
      workingDir,
      {
        ...available,
        findNearestGitRoot: blockedGitRoot,
        deadlineMs: 10,
      },
    );

    expect(blockedGitRoot).toHaveBeenCalledOnce();
    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-unavailable');
  });

  it('does not reinterpret a timed-out Git marker probe as a valid boundary', async () => {
    const workingDir = '/repo-a/packages/app';
    const repoMarker = '/repo-a/.git';
    const blockedProbe = vi.fn(() => new Promise<never>(() => {}));
    const stat = vi.fn(async (candidate: string) => {
      if (candidate === repoMarker) return blockedProbe();
      if (candidate.endsWith('/.git')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return available.stat(candidate);
    });
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-git-marker-deadline')),
      workingDir,
      {
        stat,
        realpath: available.realpath,
        deadlineMs: 10,
      },
    );

    expect(blockedProbe).toHaveBeenCalledOnce();
    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-unavailable');
  });

  it('fails closed when the approved Git marker becomes unreadable before launch', async () => {
    const workingDir = '/repo-a';
    const repoMarker = `${workingDir}/.git`;
    const stat = vi.fn(async (candidate: string) => {
      if (candidate === repoMarker) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return available.stat(candidate);
    });
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-unreadable-git-marker')),
      workingDir,
      {
        stat,
        realpath: available.realpath,
      },
    );

    expect(stat).toHaveBeenCalledWith(repoMarker);
    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-repo-root-changed');
  });

  it('fails closed when the approved Git marker is not a file or directory', async () => {
    const workingDir = '/repo-a';
    const repoMarker = `${workingDir}/.git`;
    const stat = vi.fn(async (candidate: string) => candidate === repoMarker
      ? { isDirectory: () => false, isFile: () => false }
      : available.stat(candidate));
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-invalid-git-marker')),
      workingDir,
      {
        stat,
        realpath: available.realpath,
      },
    );

    expect(stat).toHaveBeenCalledWith(repoMarker);
    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-repo-root-changed');
  });

  it('diagnoses canonical evidence changes without partially loading the remaining skill', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    input.discovered.canonicalSkillEvidence = [{
      discoveredPath: input.discovered.skills[0]!,
      canonicalPath: '/outside/retargeted-skill',
    }];
    const result = await assembleApprovedPiProjectResources(input, workingDir, available);

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skills-ineligible');
    expect(result.decision?.resources.skills).toBe('discovered');
  });

  it('keeps concurrent workingDir approval snapshots isolated', async () => {
    const firstDir = '/repo-a/packages/app';
    const secondDir = '/repo-b/packages/app';
    const [first, second] = await Promise.all([
      assembleApprovedPiProjectResources(
        inputFor(firstDir, approved(firstDir, 'rev-a')),
        firstDir,
        available,
      ),
      assembleApprovedPiProjectResources(
        inputFor(secondDir, { status: 'revoked', revision: 'rev-b', reason: 'user-revoked' }),
        secondDir,
        available,
      ),
    ]);

    expect(first.skillPaths).toEqual([`${firstDir}/.pi/skills/demo`]);
    expect(first.diagnostic.approvalRevision).toBe('rev-a');
    expect(second.skillPaths).toEqual([]);
    expect(second.diagnostic).toMatchObject({
      status: 'revoked',
      reason: 'user-revoked',
      approvalRevision: 'rev-b',
    });
  });

  it('invalidates the whole set when a canonical skill path is retargeted after approval', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      ...available,
      realpath: async (candidate) => candidate === input.discovered.skills[0]
        ? '/outside/retargeted-skill'
        : candidate,
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-changed');
  });

  it('invalidates a discovered Skill symlink retargeted after the resolver snapshot', async () => {
    const workingDir = '/repo-a/packages/app';
    const discoveredPath = `${workingDir}/.agents/skills/demo`;
    const canonicalPath = '/repo-a/packages/shared/a';
    const input = inputFor(
      workingDir,
      approved(workingDir, 'rev-discovered-retarget'),
      [discoveredPath],
    );
    input.discovered.canonicalSkillEvidence = [{ discoveredPath, canonicalPath }];

    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      ...available,
      realpath: async (candidate) => candidate === discoveredPath
        ? '/repo-a/packages/shared/b'
        : candidate,
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-changed');
  });

  it('invalidates a skill whose SKILL.md entrypoint is retargeted after discovery', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const skillFile = `${input.discovered.skills[0]}/SKILL.md`;
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      ...available,
      realpath: async (candidate) => candidate === skillFile
        ? '/outside/retargeted-SKILL.md'
        : candidate,
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-changed');
  });

  it('allows a directory SKILL.md symlink that still resolves inside the approved repo', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const skillFile = `${input.discovered.skills[0]}/SKILL.md`;
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      ...available,
      realpath: async (candidate) => candidate === skillFile
        ? '/repo-a/packages/shared/demo.md'
        : candidate,
    });

    expect(result.skillPaths).toEqual(input.discovered.skills);
    expect(result.diagnostic.reason).toBe('approval-matched');
  });

  it('keeps a single-file markdown skill discovered because Cindy project scanning only approves directories', async () => {
    const workingDir = '/repo-a/packages/app';
    const skillFile = `${workingDir}/.pi/skills/demo.md`;
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-a'), [skillFile]),
      workingDir,
      available,
    );

    expect(result.skillPaths).toEqual([]);
    expect(result.launchSkillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-unavailable');
  });

  it('pins a complete directory skill inside configHome before Pi receives it', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-stage-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo', 'packages', 'app');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(path.join(skillPath, 'assets'), { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved snapshot\n');
      writeFileSync(path.join(skillPath, 'assets', 'fixture.txt'), 'snapshot asset\n');
      const input = inputForRepoRoot(workingDir, 'rev-stage', [skillPath]);
      const assembled = await assembleApprovedPiProjectResources(input, workingDir);
      const openSpy = vi.spyOn(fsPromises, 'open');
      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      expect(staged.skillPaths).toEqual([skillPath]);
      expect(staged.launchSkillPaths).toHaveLength(1);
      expect(staged.launchSkillDigests).toHaveLength(1);
      expect(staged.launchSkillSourceFingerprints).toHaveLength(1);
      expect(staged.launchSkillPaths[0]).toBe(
        path.join(configHome, 'project-resources', 'skills', '0', 'demo'),
      );
      expect(readFileSync(path.join(staged.launchSkillPaths[0]!, 'SKILL.md'), 'utf8'))
        .toBe('# approved snapshot\n');
      expect(readFileSync(path.join(staged.launchSkillPaths[0]!, 'assets', 'fixture.txt'), 'utf8'))
        .toBe('snapshot asset\n');
      await expect(fingerprintPiProjectSkillEntrypoint(skillPath, workingDir, {
        pathComparisonIdentity: nativePathComparisonIdentity,
      }))
        .resolves.toMatchObject({
          contentDigest: staged.launchSkillDigests[0],
          sourceStateDigest: staged.launchSkillSourceFingerprints[0],
        });
      const nonBlockingFlag = constants.O_NONBLOCK ?? 0;
      expect((openSpy.mock.calls[0]?.[1] as number) & nonBlockingFlag)
        .toBe(nonBlockingFlag);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a case-only sibling before recursive Windows fingerprint I/O', async () => {
    const skillPath = String.raw`C:\Repo\.pi\skills\demo`;
    const repoRoot = String.raw`C:\Repo`;
    const escapedRealpath = String.raw`C:\repo\outside\demo`;
    const realRealpath = fsPromises.realpath.bind(fsPromises);
    const lstatSpy = vi.spyOn(fsPromises, 'lstat');
    vi.spyOn(fsPromises, 'realpath').mockImplementation(async (candidate, options) => {
      if (String(candidate) === skillPath) return escapedRealpath as never;
      if (String(candidate) === repoRoot) return repoRoot as never;
      return realRealpath(candidate, options as never) as never;
    });
    try {
      await expect(fingerprintPiProjectSkillEntrypoint(skillPath, repoRoot, {
        pathComparisonIdentity: {
          platform: 'win32',
          windowsCaseComparison: 'case-sensitive',
        },
      })).resolves.toBeNull();
      expect(lstatSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects a case-only Windows realpath retarget during fingerprinting', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-case-retarget-')));
    const repoRoot = path.join(root, 'repo');
    const skillPath = path.join(repoRoot, '.pi', 'skills', 'demo');
    const skillFile = path.join(skillPath, 'SKILL.md');
    const canonicalRepoRoot = String.raw`C:\Repo`;
    const canonicalSkillPath = String.raw`C:\Repo\.pi\skills\demo`;
    const canonicalSkillFile = String.raw`C:\Repo\.pi\skills\demo\SKILL.md`;
    const retargetedSkillPath = String.raw`C:\repo\.pi\skills\demo`;
    const retargetedSkillFile = String.raw`C:\repo\.pi\skills\demo\SKILL.md`;
    try {
      mkdirSync(skillPath, { recursive: true });
      writeFileSync(skillFile, '# approved\n');
      const realRealpath = fsPromises.realpath.bind(fsPromises);
      const realOpen = fsPromises.open.bind(fsPromises);
      let skillRootReads = 0;
      let skillFileReads = 0;
      vi.spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) =>
        realOpen(
          String(candidate) === canonicalSkillFile || String(candidate) === retargetedSkillFile
            ? skillFile
            : candidate,
          flags,
          mode,
        ));
      vi.spyOn(fsPromises, 'realpath').mockImplementation(async (candidate, options) => {
        const value = String(candidate);
        if (value === repoRoot) return canonicalRepoRoot as never;
        if (value === skillPath) {
          skillRootReads += 1;
          return (skillRootReads < 3 ? canonicalSkillPath : retargetedSkillPath) as never;
        }
        if (value === skillFile) {
          skillFileReads += 1;
          return (skillFileReads < 2 ? canonicalSkillFile : retargetedSkillFile) as never;
        }
        return realRealpath(candidate, options as never) as never;
      });

      await expect(fingerprintPiProjectSkillEntrypoint(skillPath, repoRoot, {
        pathComparisonIdentity: {
          platform: 'win32',
          windowsCaseComparison: 'case-sensitive',
        },
      })).resolves.toBeNull();
      expect(skillRootReads).toBe(3);
      expect(skillFileReads).toBe(2);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a nested symlink into a case-only Windows sibling during recursive fingerprinting', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-case-link-')));
    const repoRoot = path.join(root, 'repo');
    const skillPath = path.join(repoRoot, '.pi', 'skills', 'demo');
    const skillFile = path.join(skillPath, 'SKILL.md');
    const outsideDir = path.join(root, 'outside');
    const nestedLink = path.join(skillPath, 'outside');
    const canonicalRepoRoot = String.raw`C:\Repo`;
    const canonicalSkillPath = String.raw`C:\Repo\.pi\skills\demo`;
    const canonicalSkillFile = String.raw`C:\Repo\.pi\skills\demo\SKILL.md`;
    try {
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(skillFile, '# approved\n');
      writeFileSync(path.join(outsideDir, 'outside.txt'), 'outside\n');
      symlinkSync(outsideDir, nestedLink, process.platform === 'win32' ? 'junction' : 'dir');
      const realRealpath = fsPromises.realpath.bind(fsPromises);
      const realOpen = fsPromises.open.bind(fsPromises);
      let nestedRealpathReads = 0;
      vi.spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) =>
        realOpen(String(candidate) === canonicalSkillFile ? skillFile : candidate, flags, mode));
      vi.spyOn(fsPromises, 'realpath').mockImplementation(async (candidate, options) => {
        const value = String(candidate);
        if (value === repoRoot) return canonicalRepoRoot as never;
        if (value === skillPath) return canonicalSkillPath as never;
        if (value === skillFile) return canonicalSkillFile as never;
        if (value === nestedLink || value.startsWith(`${nestedLink}${path.sep}`)) {
          nestedRealpathReads += 1;
          const suffix = value.slice(nestedLink.length).split(path.sep).join('\\');
          return `${String.raw`C:\repo\outside`}${suffix}` as never;
        }
        return realRealpath(candidate, options as never) as never;
      });

      await expect(fingerprintPiProjectSkillEntrypoint(skillPath, repoRoot, {
        pathComparisonIdentity: {
          platform: 'win32',
          windowsCaseComparison: 'case-sensitive',
        },
      })).resolves.toBeNull();
      expect(nestedRealpathReads).toBeGreaterThan(0);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes unusable Windows comparison evidence to no staging identity', async () => {
    const workingDir = String.raw`C:\Repo`;
    const input: PiProjectTrustInputSnapshot = {
      identity: {
        workingDir,
        canonicalWorkingDir: workingDir,
        canonicalRepoRoot: workingDir,
        repoRootStatus: 'resolved',
        platform: 'win32',
        canonicalPathEncoding: 'utf16-lossless',
        windowsCaseComparison: 'unavailable',
      },
      approval: null,
      discovered: { skills: [], settings: [], packages: [], extensions: [] },
    };

    const assembled = await assembleApprovedPiProjectResources(input, workingDir);

    expect(assembled.pathComparisonIdentity).toBeNull();
    expect(assembled.skillPaths).toEqual([]);
    expect(assembled.diagnostic.reason).toBe('project-identity-unavailable');
  });

  it('fails snapshot staging closed without host path comparison identity', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-identity-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-missing-identity', [skillPath]),
        workingDir,
      );

      const staged = await stageApprovedPiProjectResources({
        ...assembled,
        pathComparisonIdentity: null,
      }, configHome);

      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the entire snapshot closed when one file exceeds the per-file byte budget', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-file-budget-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved content\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-file-budget', [skillPath]),
        workingDir,
      );

      const staged = await stageApprovedPiProjectResources(assembled, configHome, {
        maxFileBytes: 8,
        maxTotalBytes: 1024,
      });

      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the entire snapshot closed when the aggregate byte budget is exhausted', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-total-budget-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const first = path.join(workingDir, '.pi', 'skills', 'first');
    const second = path.join(workingDir, '.pi', 'skills', 'second');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(first, 'SKILL.md'), '12345678');
      writeFileSync(path.join(second, 'SKILL.md'), 'abcdefgh');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-total-budget', [first, second]),
        workingDir,
      );

      const staged = await stageApprovedPiProjectResources(assembled, configHome, {
        maxFileBytes: 8,
        maxTotalBytes: 15,
      });

      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the snapshot closed when its shared deadline is already exhausted', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-deadline-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-deadline', [skillPath]),
        workingDir,
      );

      const staged = await stageApprovedPiProjectResources(assembled, configHome, {
        deadlineMs: 0,
      });

      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds each streamed preflight directory read by the shared deadline', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-stream-deadline-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-stream-deadline', [skillPath]),
        workingDir,
      );
      const realOpendir = fsPromises.opendir.bind(fsPromises);
      const close = vi.fn(async () => ({ done: true as const, value: undefined }));
      vi.spyOn(fsPromises, 'opendir').mockImplementation(async (candidate, options) => {
        if (String(candidate) !== skillPath) {
          return realOpendir(candidate, options as never);
        }
        const iterator = {
          next: () => new Promise<IteratorResult<{ name: string }>>(() => {}),
          return: close,
          [Symbol.asyncIterator]() { return this; },
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        } as never;
      });

      const staged = await stageApprovedPiProjectResources(assembled, configHome, {
        // Leave enough time for Windows metadata probes to reach the streamed
        // directory read that this test deliberately leaves pending.
        deadlineMs: 1_000,
      });

      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      expect(close).toHaveBeenCalledOnce();
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds preflight metadata probes by the shared snapshot deadline', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-metadata-deadline-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-metadata-deadline', [skillPath]),
        workingDir,
      );
      const realLstat = fsPromises.lstat.bind(fsPromises);
      const blockedProbe = vi.fn(() => new Promise<never>(() => {}));
      vi.spyOn(fsPromises, 'lstat').mockImplementation((candidate, options) => (
        String(candidate) === skillPath
          ? blockedProbe()
          : realLstat(candidate, options)
      ));

      const staged = await stageApprovedPiProjectResources(assembled, configHome, {
        deadlineMs: 10,
      });

      expect(blockedProbe).toHaveBeenCalledOnce();
      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('streams source directories during materialization without readdir', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-copy-stream-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(path.join(skillPath, 'assets'), { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      writeFileSync(path.join(skillPath, 'assets', 'fixture.txt'), 'asset\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-copy-stream', [skillPath]),
        workingDir,
      );
      const realReaddir = fsPromises.readdir.bind(fsPromises);
      let sourceReaddirCount = 0;
      vi.spyOn(fsPromises, 'readdir').mockImplementation(async (candidate, options) => {
        if (String(candidate) === skillPath) sourceReaddirCount += 1;
        return realReaddir(candidate, options as never) as never;
      });

      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      expect(staged.launchSkillPaths).toHaveLength(1);
      expect(sourceReaddirCount).toBe(0);
      expect(readFileSync(path.join(staged.launchSkillPaths[0]!, 'assets', 'fixture.txt'), 'utf8'))
        .toBe('asset\n');
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds each streamed materialization directory read by the shared deadline', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-copy-deadline-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-copy-deadline', [skillPath]),
        workingDir,
      );
      const realOpendir = fsPromises.opendir.bind(fsPromises);
      const close = vi.fn(async () => ({ done: true as const, value: undefined }));
      let sourceDirectoryReads = 0;
      vi.spyOn(fsPromises, 'opendir').mockImplementation(async (candidate, options) => {
        if (String(candidate) !== skillPath) {
          return realOpendir(candidate, options as never);
        }
        sourceDirectoryReads += 1;
        if (sourceDirectoryReads !== 4) {
          return realOpendir(candidate, options as never);
        }
        const iterator = {
          next: () => new Promise<IteratorResult<{ name: string }>>(() => {}),
          return: close,
          [Symbol.asyncIterator]() { return this; },
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        } as never;
      });

      const staged = await stageApprovedPiProjectResources(assembled, configHome, {
        deadlineMs: 1_000,
      });

      expect(sourceDirectoryReads).toBe(4);
      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      expect(close).toHaveBeenCalledOnce();
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an oversized streamed directory before probing the over-budget child', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-stream-budget-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    const skillFile = path.join(skillPath, 'SKILL.md');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(skillFile, '# approved\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-stream-budget', [skillPath]),
        workingDir,
      );
      const realOpendir = fsPromises.opendir.bind(fsPromises);
      const realLstat = fsPromises.lstat.bind(fsPromises);
      const realRealpath = fsPromises.realpath.bind(fsPromises);
      const fileEntry = await realLstat(skillFile);
      let yieldedEntries = 0;
      let childProbeCount = 0;
      vi.spyOn(fsPromises, 'opendir').mockImplementation(async (candidate, options) => {
        if (String(candidate) !== skillPath) {
          return realOpendir(candidate, options as never);
        }
        const iterator = {
          next: async (): Promise<IteratorResult<{ name: string }>> => ({
            done: false,
            value: { name: `entry-${yieldedEntries++}` },
          }),
          return: async () => ({ done: true as const, value: undefined }),
          [Symbol.asyncIterator]() { return this; },
        };
        return {
          [Symbol.asyncIterator]: () => iterator,
        } as never;
      });
      vi.spyOn(fsPromises, 'lstat').mockImplementation(async (candidate, options) => {
        if (String(candidate).startsWith(`${skillPath}${path.sep}entry-`)) {
          childProbeCount += 1;
          return fileEntry;
        }
        return realLstat(candidate, options as never) as never;
      });
      vi.spyOn(fsPromises, 'realpath').mockImplementation(async (candidate, options) => {
        if (String(candidate).startsWith(`${skillPath}${path.sep}entry-`)) {
          return String(candidate);
        }
        return realRealpath(candidate, options as never) as never;
      });

      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      expect(yieldedEntries).toBe(MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES);
      expect(childProbeCount).toBe(MAX_PI_PROJECT_SKILL_FINGERPRINT_ENTRIES - 1);
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a snapshot exactly at both byte budget boundaries', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-budget-edge-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '12345678');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-budget-edge', [skillPath]),
        workingDir,
      );

      const staged = await stageApprovedPiProjectResources(assembled, configHome, {
        maxFileBytes: 8,
        maxTotalBytes: 8,
      });

      expect(staged.skillPaths).toEqual([skillPath]);
      expect(staged.launchSkillPaths).toHaveLength(1);
      expect(readFileSync(path.join(staged.launchSkillPaths[0]!, 'SKILL.md'), 'utf8'))
        .toBe('12345678');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an ordinary file injected into the temporary tree before publication', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-injection-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-injection', [skillPath]),
        workingDir,
      );
      const realReaddir = fsPromises.readdir.bind(fsPromises);
      let injected = false;
      vi.spyOn(fsPromises, 'readdir').mockImplementation(async (candidate, options) => {
        if (
          !injected
          && String(candidate).includes('.project-resources-')
          && String(candidate).endsWith(path.join('skills', '0', 'demo'))
        ) {
          injected = true;
          writeFileSync(path.join(String(candidate), 'injected.txt'), 'not fingerprinted\n');
        }
        return realReaddir(candidate, options as never) as never;
      });

      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      expect(injected).toBe(true);
      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a nested file injected after the baseline staging proof', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-late-injection-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-late-injection', [skillPath]),
        workingDir,
      );
      const realOpendir = fsPromises.opendir.bind(fsPromises);
      let stagingRootReads = 0;
      let injected = false;
      vi.spyOn(fsPromises, 'opendir').mockImplementation(async (candidate, options) => {
        if (
          String(candidate).includes('.project-resources-')
          && path.basename(String(candidate)) === 'skills'
        ) {
          stagingRootReads += 1;
          if (stagingRootReads === 2) {
            injected = true;
            writeFileSync(
              path.join(String(candidate), '0', 'demo', 'late.txt'),
              'changed after baseline\n',
            );
          }
        }
        return realOpendir(candidate, options as never);
      });

      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      expect(injected).toBe(true);
      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic.reason).toBe('approved-skill-snapshot-failed');
      await expect(fsPromises.readdir(configHome)).resolves.toEqual([]);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the launch snapshot immutable when the project skill is retargeted before spawn', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-retarget-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    const outsideSkill = path.join(root, 'outside-skill');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(outsideSkill, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      writeFileSync(path.join(outsideSkill, 'SKILL.md'), '# outside\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-retarget', [skillPath]),
        workingDir,
      );
      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      renameSync(skillPath, `${skillPath}-approved-old`);
      symlinkSync(outsideSkill, skillPath, process.platform === 'win32' ? 'junction' : 'dir');

      expect(readFileSync(path.join(staged.launchSkillPaths[0]!, 'SKILL.md'), 'utf8'))
        .toBe('# approved\n');
      expect(staged.launchSkillPaths[0]).not.toBe(skillPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an approved file is overwritten through the same inode while copying', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-rewrite-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    const skillFile = path.join(skillPath, 'SKILL.md');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(skillFile, '# approved content\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-rewrite', [skillPath]),
        workingDir,
      );
      const realOpen = fsPromises.open.bind(fsPromises);
      let overwritten = false;
      vi.spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) => {
        const handle = await realOpen(candidate, flags, mode);
        if (String(candidate) !== skillFile) return handle;
        const createReadStream = handle.createReadStream.bind(handle);
        handle.createReadStream = ((options) => {
          const stream = createReadStream(options);
          if (!overwritten) {
            stream.once('end', () => {
              overwritten = true;
              writeFileSync(skillFile, '# replacement content written in place\n');
            });
          }
          return stream;
        }) as typeof handle.createReadStream;
        return handle;
      });

      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      expect(overwritten).toBe(true);
      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic).toMatchObject({
        reason: 'approved-skill-snapshot-failed',
        requestedSkillCount: 0,
      });
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an approved directory changes after its children are enumerated', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-dir-churn-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    const skillFile = path.join(skillPath, 'SKILL.md');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(skillFile, '# approved content\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-dir-churn', [skillPath]),
        workingDir,
      );
      const realOpendir = fsPromises.opendir.bind(fsPromises);
      let mutated = false;
      vi.spyOn(fsPromises, 'opendir').mockImplementation(async (candidate, options) => {
        const directory = await realOpendir(candidate, options as never);
        if (String(candidate) !== skillPath) return directory;
        const iterator = directory[Symbol.asyncIterator]();
        const wrapped = {
          next: async () => {
            const result = await iterator.next();
            if (result.done && !mutated) {
              mutated = true;
              writeFileSync(path.join(skillPath, 'late-asset.txt'), 'added after preflight\n');
              const stableChangedTime = new Date('2000-01-01T00:00:00.000Z');
              utimesSync(skillPath, stableChangedTime, stableChangedTime);
            }
            return result;
          },
          return: () => iterator.return?.() ?? Promise.resolve({ done: true as const, value: undefined }),
          [Symbol.asyncIterator]() { return this; },
        };
        return {
          [Symbol.asyncIterator]: () => wrapped,
        } as never;
      });

      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      expect(mutated).toBe(true);
      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic).toMatchObject({
        reason: 'approved-skill-snapshot-failed',
        requestedSkillCount: 0,
      });
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds the launch fingerprint to the exact source root that was copied', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-root-swap-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    const skillFile = path.join(skillPath, 'SKILL.md');
    const oldSkillPath = `${skillPath}-old`;
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(skillFile, '# unchanged entrypoint\n');
      writeFileSync(path.join(skillPath, 'asset.txt'), 'copied asset\n');
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-root-swap', [skillPath]),
        workingDir,
      );
      const realOpen = fsPromises.open.bind(fsPromises);
      let sourceSkillOpenCount = 0;
      vi.spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) => {
        if (String(candidate) === skillFile) {
          sourceSkillOpenCount += 1;
          // Two opens establish the pre-copy fingerprint; the copy itself is
          // the third. Swap on the first post-copy source fingerprint open.
          if (sourceSkillOpenCount === 4) {
            renameSync(skillPath, oldSkillPath);
            mkdirSync(skillPath);
            writeFileSync(skillFile, '# unchanged entrypoint\n');
            writeFileSync(path.join(skillPath, 'asset.txt'), 'replacement asset\n');
          }
        }
        return realOpen(candidate, flags, mode);
      });

      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      expect(sourceSkillOpenCount).toBeGreaterThanOrEqual(2);
      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic).toMatchObject({
        reason: 'approved-skill-snapshot-failed',
        requestedSkillCount: 0,
      });
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a skill tree that changes between complete fingerprint passes', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-fingerprint-')));
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    const skillFile = path.join(skillPath, 'SKILL.md');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      writeFileSync(skillFile, '# first pass\n');
      const realOpen = fsPromises.open.bind(fsPromises);
      let skillOpenCount = 0;
      vi.spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) => {
        if (String(candidate) === skillFile) {
          skillOpenCount += 1;
          if (skillOpenCount === 2) writeFileSync(skillFile, '# second pass\n');
        }
        return realOpen(candidate, flags, mode);
      });

      await expect(fingerprintPiProjectSkillEntrypoint(skillPath, workingDir, {
        pathComparisonIdentity: nativePathComparisonIdentity,
      })).resolves.toBeNull();
      expect(skillOpenCount).toBe(2);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aborts fingerprinting when a file streams beyond its opened size', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-hash-growth-')));
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    const skillFile = path.join(skillPath, 'SKILL.md');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      writeFileSync(skillFile, '12345678');
      const realOpen = fsPromises.open.bind(fsPromises);
      let replacedStream = false;
      vi.spyOn(fsPromises, 'open').mockImplementation(async (candidate, flags, mode) => {
        const handle = await realOpen(candidate, flags, mode);
        if (String(candidate) === skillFile && !replacedStream) {
          replacedStream = true;
          handle.createReadStream = (() => Readable.from(['123456789'])) as typeof handle.createReadStream;
        }
        return handle;
      });

      await expect(fingerprintPiProjectSkillEntrypoint(skillPath, workingDir, {
        pathComparisonIdentity: nativePathComparisonIdentity,
        budget: {
          remainingEntries: 100,
          deadlineAtMs: Date.now() + 1_000,
          maxFileBytes: 8,
        },
      })).resolves.toBeNull();
      expect(replacedStream).toBe(true);
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('changes the source-state fingerprint when only a nested asset is rewritten in place', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-asset-')));
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    const assetPath = path.join(skillPath, 'assets', 'fixture.txt');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(path.dirname(assetPath), { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# unchanged entrypoint\n');
      writeFileSync(assetPath, 'asset-one\n');
      const before = await fingerprintPiProjectSkillEntrypoint(skillPath, workingDir, {
        pathComparisonIdentity: nativePathComparisonIdentity,
      });

      writeFileSync(assetPath, 'asset-two\n');
      const after = await fingerprintPiProjectSkillEntrypoint(skillPath, workingDir, {
        pathComparisonIdentity: nativePathComparisonIdentity,
      });

      expect(before?.contentDigest).toBe(after?.contentDigest);
      expect(before?.sourceStateDigest).not.toBe(after?.sourceStateDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a palette fingerprint exhausts its shared entry budget', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-budget-')));
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(path.join(skillPath, 'assets'), { recursive: true });
      writeFileSync(path.join(skillPath, 'SKILL.md'), '# approved\n');
      writeFileSync(path.join(skillPath, 'assets', 'fixture.txt'), 'asset\n');

      await expect(fingerprintPiProjectSkillEntrypoint(skillPath, workingDir, {
        pathComparisonIdentity: nativePathComparisonIdentity,
        budget: { remainingEntries: 1, deadlineAtMs: Number.POSITIVE_INFINITY },
      })).resolves.toBeNull();
      await expect(fingerprintPiProjectSkillEntrypoint(skillPath, workingDir, {
        pathComparisonIdentity: nativePathComparisonIdentity,
        budget: { remainingEntries: 10, deadlineAtMs: Date.now() - 1 },
      })).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds fingerprint metadata probes by the shared deadline', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-fingerprint-deadline-')));
    const workingDir = path.join(root, 'repo');
    const skillPath = path.join(workingDir, '.pi', 'skills', 'demo');
    const skillFile = path.join(skillPath, 'SKILL.md');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(skillPath, { recursive: true });
      writeFileSync(skillFile, '# approved\n');
      const realStat = fsPromises.stat.bind(fsPromises);
      const blockedProbe = vi.fn(() => new Promise<never>(() => {}));
      vi.spyOn(fsPromises, 'stat').mockImplementation((candidate, options) => (
        String(candidate) === skillFile
          ? blockedProbe()
          : realStat(candidate, options)
      ));

      await expect(fingerprintPiProjectSkillEntrypoint(skillPath, workingDir, {
        pathComparisonIdentity: nativePathComparisonIdentity,
        // Leave enough time for Windows canonical-path probes to reach the
        // metadata call that this test deliberately leaves pending.
        budget: { remainingEntries: 10, deadlineAtMs: Date.now() + 1_000 },
      })).resolves.toBeNull();
      expect(blockedProbe).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the entire snapshot closed when a nested symlink escapes the approved repo', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-project-resource-escape-')));
    const configHome = path.join(root, 'config-home');
    const workingDir = path.join(root, 'repo');
    const first = path.join(workingDir, '.pi', 'skills', 'first');
    const second = path.join(workingDir, '.pi', 'skills', 'second');
    const outsideDir = path.join(root, 'outside-dir');
    try {
      mkdirSync(path.join(workingDir, '.git'), { recursive: true });
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      mkdirSync(configHome, { recursive: true });
      writeFileSync(path.join(first, 'SKILL.md'), '# first\n');
      writeFileSync(path.join(second, 'SKILL.md'), '# second\n');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(path.join(outsideDir, 'outside.txt'), 'outside\n');
      symlinkSync(
        outsideDir,
        path.join(second, 'outside-dir'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const assembled = await assembleApprovedPiProjectResources(
        inputForRepoRoot(workingDir, 'rev-escape', [first, second]),
        workingDir,
      );
      const staged = await stageApprovedPiProjectResources(assembled, configHome);

      expect(staged.skillPaths).toEqual([]);
      expect(staged.launchSkillPaths).toEqual([]);
      expect(staged.diagnostic).toMatchObject({
        reason: 'approved-skill-snapshot-failed',
        requestedSkillCount: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates a skill whose SKILL.md entrypoint disappeared before launch', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const skillFile = `${input.discovered.skills[0]}/SKILL.md`;
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      ...available,
      stat: async (candidate) => {
        if (candidate === skillFile) throw new Error('ENOENT');
        return available.stat(candidate);
      },
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-unavailable');
  });

  it('invalidates approved skills when the lexical workingDir is retargeted', async () => {
    const workingDir = '/repo-a/packages/app-link';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      ...available,
      realpath: async (candidate) => candidate === input.identity.workingDir
        ? '/outside/retargeted-working-dir'
        : candidate,
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-project-path-changed');
  });

  it('rejects an internally valid approval snapshot for another requested workingDir', async () => {
    const approvedDir = '/repo-a/packages/app';
    const requestedDir = '/repo-b/packages/app';
    const input = inputFor(approvedDir, approved(approvedDir, 'rev-a'));
    const result = await assembleApprovedPiProjectResources(
      input,
      requestedDir,
      available,
    );

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic).toMatchObject({
      status: 'approved',
      reason: 'approval-working-dir-mismatch',
      approvalRevision: 'rev-a',
      requestedSkillCount: 0,
    });
  });

  it('rejects an approval snapshot when a nearer Git root appears before launch', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      ...available,
      findNearestGitRoot: async () => workingDir,
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic).toMatchObject({
      status: 'approved',
      reason: 'approved-repo-root-changed',
      approvalRevision: 'rev-a',
      requestedSkillCount: 0,
    });
  });

  it('reports loaded only when this get_commands catalog confirms every explicit path', async () => {
    const workingDir = '/repo-a/packages/app';
    const assembly = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-a')),
      workingDir,
      available,
    );
    const skillPath = assembly.skillPaths[0]!;
    const runtimeAssembly = {
      ...assembly,
      launchSkillPaths: [skillPath],
      launchSkillDigests: ['snapshot-digest'],
      launchSkillSourceFingerprints: ['source-fingerprint'],
    };
    const baseManifest = {
      capturedAt: '2026-08-10T00:00:00.000Z',
      generation: 1,
      status: 'loaded' as const,
      source: 'pi:get_commands' as const,
    };

    expect(reconcilePiProjectResourceRuntime(runtimeAssembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'project',
          source: 'local',
          baseDir: skillPath,
          path: `${skillPath}/SKILL.md`,
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-confirmed',
      requestedSkillCount: 1,
      loadedSkillCount: 1,
      loadedSkills: [{
        sourcePath: skillPath,
        runtimePath: skillPath,
        commandName: 'skill:demo',
        snapshotDigest: 'snapshot-digest',
        sourceFingerprint: 'source-fingerprint',
        canonicalRepoRoot: assembly.decision?.canonicalRepoRoot,
        pathComparisonIdentity: assembly.pathComparisonIdentity,
      }],
    });

    expect(reconcilePiProjectResourceRuntime(runtimeAssembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: { scope: 'user', source: 'auto', baseDir: skillPath },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-missing',
      requestedSkillCount: 1,
      loadedSkillCount: 0,
    });

    expect(reconcilePiProjectResourceRuntime(runtimeAssembly, {
      ...baseManifest,
      commands: [{
        name: 'not-a-skill-command',
        source: 'skill',
        sourceInfo: {
          scope: 'temporary',
          source: 'local',
          baseDir: skillPath,
          path: `${skillPath}/SKILL.md`,
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-missing',
      loadedSkillCount: 0,
      loadedSkills: [],
    });

    expect(reconcilePiProjectResourceRuntime(runtimeAssembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'temporary',
          source: 'local',
          baseDir: skillPath,
          path: '/other/SKILL.md',
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-missing',
      loadedSkillCount: 0,
    });

    expect(reconcilePiProjectResourceRuntime(runtimeAssembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'temporary',
          source: 'local',
          baseDir: skillPath,
          path: `${skillPath}/skill.md`,
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-missing',
      loadedSkillCount: 0,
    });

    expect(reconcilePiProjectResourceRuntime(runtimeAssembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'temporary',
          source: 'local',
          baseDir: `${skillPath}\0outside`,
          path: `${skillPath}\0outside/SKILL.md`,
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-missing',
      loadedSkillCount: 0,
    });
  });
});
