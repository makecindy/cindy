import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentSkillCommand,
  PiRuntimeCapabilityManifest,
} from '@cindy/maker-core';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { capturePiRuntimeCapabilityManifest } from '../../../../../../packages/maker-core/src/agents/pi/runtime-capabilities.js';
import { fingerprintPiProjectSkillEntrypoint } from '../../../../../../packages/maker-core/src/agents/pi/project-resource-assembly.js';
import {
  assertCurrentPiSkillInvocationSession,
  isCurrentPiSkillInvocation,
  isStalePiSkillInvocationError,
  piSkillScanErrorsBlockInvocation,
} from '../piSkillInvocationValidation.js';

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-skill-validation-'));
const sourcePath = path.join(repoRoot, '.pi', 'skills', 'demo');
const localPathComparisonIdentity = process.platform === 'win32'
  ? ({ platform: 'win32', windowsCaseComparison: 'case-sensitive' } as const)
  : ({ platform: 'posix' } as const);
fs.mkdirSync(sourcePath, { recursive: true });
fs.writeFileSync(path.join(sourcePath, 'SKILL.md'), '# demo\n');

let projectFingerprint: Awaited<ReturnType<typeof fingerprintPiProjectSkillEntrypoint>>;

beforeAll(async () => {
  projectFingerprint = await fingerprintPiProjectSkillEntrypoint(sourcePath, repoRoot, {
    pathComparisonIdentity: localPathComparisonIdentity,
  });
  if (!projectFingerprint) throw new Error('failed to fingerprint project Skill test fixture');
});

afterAll(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

function item(
  patch: Partial<NonNullable<AgentInputQueuedMessage['agentSkillInvocation']>> = {},
): Pick<AgentInputQueuedMessage, 'agentSkillInvocation' | 'createOpts'> {
  return {
    agentSkillInvocation: {
      name: 'demo',
      runtimeCommandName: 'skill:demo',
      scope: 'repo',
      sourcePath,
      ...patch,
    },
    createOpts: {
      agentKind: 'pi',
      workingDir: '/repo',
      model: 'model',
    },
  };
}

function manifest(
  patch: Partial<PiRuntimeCapabilityManifest> = {},
): PiRuntimeCapabilityManifest {
  return {
    capturedAt: '2026-08-12T00:00:00.000Z',
    generation: 1,
    status: 'loaded',
    source: 'pi:get_commands',
    commands: [{
      name: 'skill:demo',
      source: 'skill',
      sourceInfo: {
        scope: 'temporary',
        source: 'local',
        baseDir: '/snapshot/demo',
        path: '/snapshot/demo/SKILL.md',
      },
    }],
    projectResources: {
      status: 'approved',
      reason: 'runtime-skills-confirmed',
      approvalRevision: 'revision',
      requestedSkillCount: 1,
      loadedSkillCount: 1,
      loadedSkills: [{
        sourcePath,
        runtimePath: '/snapshot/demo',
        commandName: 'skill:demo',
        snapshotDigest: projectFingerprint?.contentDigest,
        sourceFingerprint: projectFingerprint?.sourceStateDigest,
        canonicalRepoRoot: repoRoot,
        pathComparisonIdentity: localPathComparisonIdentity,
      }],
    },
    ...patch,
  };
}

function skills(patch: Partial<AgentSkillCommand> = {}): AgentSkillCommand[] {
  return [{
    kind: 'agent-skill',
    name: 'demo',
    source: 'skill',
    scope: 'repo',
    path: sourcePath,
    runtimeStatus: 'loaded',
    runtimeCommandName: 'skill:demo',
    ...patch,
  }];
}

describe('Pi Skill invocation validation', () => {
  it('accepts one exact current project Skill provenance match', async () => {
    expect(await isCurrentPiSkillInvocation(item(), manifest(), skills())).toBe(true);
  });

  it('accepts a loaded project Skill receipt through its stable in-repo symlink', async () => {
    const physicalSource = path.join(repoRoot, '.pi', 'skills', 'physical-demo');
    const otherSource = path.join(repoRoot, '.pi', 'skills', 'other-demo');
    const linkedSource = path.join(repoRoot, '.pi', 'skills', 'linked-demo');
    try {
      fs.mkdirSync(physicalSource);
      fs.mkdirSync(otherSource);
      fs.writeFileSync(path.join(physicalSource, 'SKILL.md'), '# physical demo\n');
      fs.writeFileSync(path.join(otherSource, 'SKILL.md'), '# other demo\n');
      fs.symlinkSync(
        physicalSource,
        linkedSource,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const linkedFingerprint = await fingerprintPiProjectSkillEntrypoint(
        physicalSource,
        repoRoot,
        { pathComparisonIdentity: localPathComparisonIdentity },
      );
      expect(linkedFingerprint).not.toBeNull();

      expect(await isCurrentPiSkillInvocation(
        item({ sourcePath: linkedSource }),
        manifest({
          projectResources: {
            ...manifest().projectResources!,
            loadedSkills: [{
              sourcePath: physicalSource,
              runtimePath: '/snapshot/demo',
              commandName: 'skill:demo',
              snapshotDigest: linkedFingerprint!.contentDigest,
              sourceFingerprint: linkedFingerprint!.sourceStateDigest,
              canonicalRepoRoot: repoRoot,
              pathComparisonIdentity: localPathComparisonIdentity,
            }],
          },
        }),
        skills({ path: linkedSource }),
      )).toBe(true);

      fs.unlinkSync(linkedSource);
      fs.symlinkSync(
        otherSource,
        linkedSource,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(await isCurrentPiSkillInvocation(
        item({ sourcePath: linkedSource }),
        manifest({
          projectResources: {
            ...manifest().projectResources!,
            loadedSkills: [{
              sourcePath: physicalSource,
              runtimePath: '/snapshot/demo',
              commandName: 'skill:demo',
              snapshotDigest: linkedFingerprint!.contentDigest,
              sourceFingerprint: linkedFingerprint!.sourceStateDigest,
              canonicalRepoRoot: repoRoot,
              pathComparisonIdentity: localPathComparisonIdentity,
            }],
          },
        }),
        skills({ path: linkedSource }),
      )).toBe(false);
    } finally {
      fs.rmSync(linkedSource, { recursive: true, force: true });
      fs.rmSync(physicalSource, { recursive: true, force: true });
      fs.rmSync(otherSource, { recursive: true, force: true });
    }
  });

  it('rejects a project Skill whose source tree changes after runtime discovery', async () => {
    const changingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-skill-changing-'));
    const changingSource = path.join(changingRoot, '.pi', 'skills', 'demo');
    try {
      fs.mkdirSync(changingSource, { recursive: true });
      fs.writeFileSync(path.join(changingSource, 'SKILL.md'), '# changing demo\n');
      fs.writeFileSync(path.join(changingSource, 'reference.txt'), 'before\n');
      const fingerprint = await fingerprintPiProjectSkillEntrypoint(
        changingSource,
        changingRoot,
        { pathComparisonIdentity: localPathComparisonIdentity },
      );
      expect(fingerprint).not.toBeNull();
      const changingItem = item({ sourcePath: changingSource });
      const changingSkills = skills({ path: changingSource });
      const changingManifest = manifest({
        projectResources: {
          ...manifest().projectResources!,
          loadedSkills: [{
            sourcePath: changingSource,
            runtimePath: '/snapshot/demo',
            commandName: 'skill:demo',
            snapshotDigest: fingerprint!.contentDigest,
            sourceFingerprint: fingerprint!.sourceStateDigest,
            canonicalRepoRoot: changingRoot,
            pathComparisonIdentity: localPathComparisonIdentity,
          }],
        },
      });

      await expect(isCurrentPiSkillInvocation(
        changingItem,
        changingManifest,
        changingSkills,
      )).resolves.toBe(true);

      fs.writeFileSync(path.join(changingSource, 'reference.txt'), 'after\n');
      await expect(isCurrentPiSkillInvocation(
        changingItem,
        changingManifest,
        changingSkills,
      )).resolves.toBe(false);
    } finally {
      fs.rmSync(changingRoot, { recursive: true, force: true });
    }
  });

  it('fingerprints the unique project Skill only after later candidates are canonicalized', async () => {
    const changingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-skill-final-fence-'));
    const selectedSource = path.join(changingRoot, '.pi', 'skills', 'demo');
    const laterSource = path.join(changingRoot, '.pi', 'skills', 'other');
    try {
      fs.mkdirSync(selectedSource, { recursive: true });
      fs.mkdirSync(laterSource, { recursive: true });
      fs.writeFileSync(path.join(selectedSource, 'SKILL.md'), '# selected demo\n');
      fs.writeFileSync(path.join(selectedSource, 'reference.txt'), 'before\n');
      fs.writeFileSync(path.join(laterSource, 'SKILL.md'), '# later demo\n');
      const fingerprint = await fingerprintPiProjectSkillEntrypoint(
        selectedSource,
        changingRoot,
        { pathComparisonIdentity: localPathComparisonIdentity },
      );
      expect(fingerprint).not.toBeNull();
      let mutated = false;
      const realpath = vi.fn(async (candidate: string) => {
        if (!mutated && path.resolve(candidate) === laterSource) {
          mutated = true;
          fs.writeFileSync(path.join(selectedSource, 'reference.txt'), 'after\n');
        }
        return fs.promises.realpath(candidate);
      });

      await expect(isCurrentPiSkillInvocation(
        item({ sourcePath: selectedSource }),
        manifest({
          projectResources: {
            ...manifest().projectResources!,
            loadedSkills: [
              {
                sourcePath: selectedSource,
                runtimePath: '/snapshot/demo',
                commandName: 'skill:demo',
                snapshotDigest: fingerprint!.contentDigest,
                sourceFingerprint: fingerprint!.sourceStateDigest,
                canonicalRepoRoot: changingRoot,
                pathComparisonIdentity: localPathComparisonIdentity,
              },
              {
                sourcePath: laterSource,
                runtimePath: '/snapshot/other',
                commandName: 'skill:demo',
                snapshotDigest: 'unused',
                sourceFingerprint: 'unused',
                canonicalRepoRoot: changingRoot,
                pathComparisonIdentity: localPathComparisonIdentity,
              },
            ],
          },
        }),
        skills({ path: selectedSource }),
        { realpath },
      )).resolves.toBe(false);
      expect(mutated).toBe(true);
    } finally {
      fs.rmSync(changingRoot, { recursive: true, force: true });
    }
  });

  it('rejects legacy, stale, renamed, changed, and ambiguous project receipts', async () => {
    expect(await isCurrentPiSkillInvocation(item({ scope: undefined }), manifest(), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item({ sourcePath: undefined }), manifest(), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest({ status: 'unknown' }), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest(), skills({ path: '/repo/.pi/skills/other' }))).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest(), skills({ runtimeStatus: 'discovered' }))).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest({ projectResources: undefined }), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest(), [...skills(), ...skills()])).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest({
      projectResources: {
        ...manifest().projectResources!,
        loadedSkills: [{
          sourcePath,
          runtimePath: '/snapshot/demo',
          commandName: 'skill:demo',
          canonicalRepoRoot: repoRoot,
        }],
      },
    }), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest({
      projectResources: {
        ...manifest().projectResources!,
        loadedSkills: [{
          sourcePath,
          runtimePath: '/snapshot/demo',
          commandName: 'skill:demo',
          canonicalRepoRoot: repoRoot,
          pathComparisonIdentity: {
            platform: 'invalid',
          } as never,
        }],
      },
    }), skills())).toBe(false);

    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-skill-other-repo-'));
    try {
      expect(await isCurrentPiSkillInvocation(item(), manifest({
        projectResources: {
          ...manifest().projectResources!,
          loadedSkills: [{
            sourcePath,
            runtimePath: '/snapshot/demo',
            commandName: 'skill:demo',
            canonicalRepoRoot: unrelatedRoot,
            pathComparisonIdentity: localPathComparisonIdentity,
          }],
        },
      }), skills())).toBe(false);
    } finally {
      fs.rmSync(unrelatedRoot, { recursive: true, force: true });
    }
  });

  it('requires exact current user Skill source provenance too', async () => {
    const userBaseDir = path.join(repoRoot, 'user-skill-provenance', '.agents');
    const userSource = path.join(userBaseDir, 'skills', 'demo');
    const replacement = path.join(userBaseDir, 'skills', 'replacement');
    const original = path.join(userBaseDir, 'skills', 'original');
    fs.mkdirSync(userSource, { recursive: true });
    fs.writeFileSync(path.join(userSource, 'SKILL.md'), '# user skill\n');
    fs.mkdirSync(replacement, { recursive: true });
    fs.writeFileSync(path.join(replacement, 'SKILL.md'), '# replacement user skill\n');
    const userItem = item({ scope: 'user', sourcePath: userSource });
    const userSkills = skills({ scope: 'user', path: userSource, runtimeStatus: undefined });
    const userManifest = await capturePiRuntimeCapabilityManifest(
      {
        request: async () => ({
          type: 'response',
          command: 'get_commands',
          success: true,
          data: {
            commands: [
              {
                name: 'skill:demo',
                source: 'skill',
                sourceInfo: {
                  scope: 'user',
                  source: 'auto',
                  baseDir: userBaseDir,
                  path: path.join(userSource, 'SKILL.md'),
                },
              },
              {
                name: 'skill:demo',
                source: 'skill',
                sourceInfo: {
                  scope: 'user',
                  source: 'auto',
                  baseDir: userBaseDir,
                },
              },
            ],
          },
        }),
      },
      {},
      1,
      'ready',
      { userSkillBaseDirs: [userBaseDir] },
    );
    expect(await isCurrentPiSkillInvocation(userItem, userManifest, userSkills)).toBe(true);

    fs.renameSync(userSource, original);
    fs.renameSync(replacement, userSource);
    expect(fs.readFileSync(path.join(userSource, 'SKILL.md'), 'utf8')).toContain('replacement');
    expect(await isCurrentPiSkillInvocation(userItem, userManifest, userSkills)).toBe(false);

    expect(await isCurrentPiSkillInvocation(
      userItem,
      userManifest,
      skills({ scope: 'user', path: '/home/user/.agents/skills/other' }),
    )).toBe(false);

    expect(await isCurrentPiSkillInvocation(
      userItem,
      manifest({
        commands: [{
          name: 'skill:demo',
          source: 'skill',
          sourceInfo: {
            scope: 'user',
            source: 'auto',
            baseDir: '/other/.agents',
            path: '/other/.agents/skills/demo',
          },
        }],
      }),
      [...userSkills, ...skills({
        scope: 'user',
        path: '/other/.agents/skills/demo',
        runtimeStatus: undefined,
      })],
    )).toBe(false);

    expect(await isCurrentPiSkillInvocation(
      userItem,
      manifest({
        commands: [{
          name: 'skill:demo',
          source: 'skill',
          sourceInfo: {
            scope: 'user',
            source: 'auto',
            baseDir: '/home/user/.agents',
            path: '/other/.agents/skills/demo/SKILL.md',
          },
        }],
      }),
      userSkills,
    )).toBe(false);
  });

  it('accepts a user Skill symlink whose selected name differs from its target', async () => {
    const userBaseDir = path.join(repoRoot, 'linked-user-skill', '.agents');
    const sharedSource = path.join(repoRoot, 'linked-user-skill-target', 'physical-name');
    const linkedSource = path.join(userBaseDir, 'skills', 'demo');
    try {
      fs.mkdirSync(sharedSource, { recursive: true });
      fs.mkdirSync(path.dirname(linkedSource), { recursive: true });
      fs.writeFileSync(path.join(sharedSource, 'SKILL.md'), '# linked user skill\n');
      fs.symlinkSync(
        sharedSource,
        linkedSource,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const linkedManifest = await capturePiRuntimeCapabilityManifest(
        {
          request: async () => ({
            type: 'response',
            command: 'get_commands',
            success: true,
            data: {
              commands: [{
                name: 'skill:demo',
                source: 'skill',
                sourceInfo: {
                  scope: 'user',
                  source: 'auto',
                  baseDir: userBaseDir,
                  path: path.join(sharedSource, 'SKILL.md'),
                },
              }],
            },
          }),
        },
        {},
        1,
        'ready',
        { userSkillBaseDirs: [userBaseDir] },
      );

      expect(await isCurrentPiSkillInvocation(
        item({ scope: 'user', sourcePath: linkedSource }),
        linkedManifest,
        skills({ scope: 'user', path: linkedSource, runtimeStatus: undefined }),
      )).toBe(true);
    } finally {
      fs.rmSync(linkedSource, { recursive: true, force: true });
      fs.rmSync(sharedSource, { recursive: true, force: true });
    }
  });

  it('accepts a managed-package Skill with temporary local runtime provenance', async () => {
    const managedRoot = path.join(repoRoot, 'managed-package-runtime');
    const managedSkill = path.join(managedRoot, 'skills', 'sample', 'SKILL.md');
    const otherManagedSkill = path.join(managedRoot, 'skills', 'other', 'SKILL.md');
    fs.mkdirSync(path.dirname(managedSkill), { recursive: true });
    fs.mkdirSync(path.dirname(otherManagedSkill), { recursive: true });
    fs.writeFileSync(managedSkill, '# managed package skill\n');
    fs.writeFileSync(otherManagedSkill, '# different managed package skill\n');
    try {
      const managedItem = item({
        name: 'managed-sample',
        runtimeCommandName: 'skill:managed-sample',
        scope: 'user',
        sourcePath: managedSkill,
      });
      const managedSkillEntry = skills({
        name: 'managed-sample',
        runtimeCommandName: 'skill:managed-sample',
        scope: 'user',
        path: managedSkill,
        runtimeStatus: 'loaded',
      });
      const managedManifest = manifest({
        commands: [{
          name: 'skill:managed-sample',
          source: 'skill',
          sourceInfo: {
            scope: 'temporary',
            source: 'local',
            baseDir: path.dirname(managedSkill),
            path: managedSkill,
          },
        }],
        managedPackageSkills: [{
          sourcePath: managedSkill,
          name: 'managed-sample',
          runtimeCommandName: 'skill:managed-sample',
        }],
      });

      await expect(isCurrentPiSkillInvocation(
        managedItem,
        managedManifest,
        managedSkillEntry,
      )).resolves.toBe(true);

      await expect(isCurrentPiSkillInvocation(
        managedItem,
        manifest({
          ...managedManifest,
          commands: [{
            ...managedManifest.commands[0]!,
            sourceInfo: {
              ...managedManifest.commands[0]!.sourceInfo,
              path: otherManagedSkill,
            },
          }],
        }),
        managedSkillEntry,
      )).resolves.toBe(false);
    } finally {
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  it('fails closed for a retargeted user Skill symlink when runtime provenance omits path', async () => {
    const userBaseDir = path.join(repoRoot, 'retargeted-user-skill', '.agents');
    const firstTarget = path.join(repoRoot, 'retargeted-user-skill-target-a');
    const secondTarget = path.join(repoRoot, 'retargeted-user-skill-target-b');
    const linkedSource = path.join(userBaseDir, 'skills', 'demo');
    try {
      fs.mkdirSync(firstTarget, { recursive: true });
      fs.mkdirSync(secondTarget, { recursive: true });
      fs.mkdirSync(path.dirname(linkedSource), { recursive: true });
      fs.writeFileSync(path.join(firstTarget, 'SKILL.md'), '# first target\n');
      fs.writeFileSync(path.join(secondTarget, 'SKILL.md'), '# second target\n');
      fs.symlinkSync(
        firstTarget,
        linkedSource,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const pathlessRuntimeManifest = await capturePiRuntimeCapabilityManifest(
        {
          request: async () => ({
            type: 'response',
            command: 'get_commands',
            success: true,
            data: {
              commands: [{
                name: 'skill:demo',
                source: 'skill',
                sourceInfo: {
                  scope: 'user',
                  source: 'auto',
                  baseDir: userBaseDir,
                },
              }],
            },
          }),
        },
        {},
        1,
        'ready',
        { userSkillBaseDirs: [userBaseDir] },
      );

      expect(await isCurrentPiSkillInvocation(
        item({ scope: 'user', sourcePath: linkedSource }),
        pathlessRuntimeManifest,
        skills({ scope: 'user', path: linkedSource, runtimeStatus: undefined }),
      )).toBe(true);

      fs.unlinkSync(linkedSource);
      fs.symlinkSync(
        secondTarget,
        linkedSource,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      expect(await isCurrentPiSkillInvocation(
        item({ scope: 'user', sourcePath: linkedSource }),
        pathlessRuntimeManifest,
        skills({ scope: 'user', path: linkedSource, runtimeStatus: undefined }),
      )).toBe(false);
    } finally {
      fs.rmSync(linkedSource, { recursive: true, force: true });
      fs.rmSync(firstTarget, { recursive: true, force: true });
      fs.rmSync(secondTarget, { recursive: true, force: true });
    }
  });

  it('fails closed when a pathless user Skill directory is replaced at the same path', async () => {
    const userBaseDir = path.join(repoRoot, 'replaced-user-skill', '.agents');
    const userSource = path.join(userBaseDir, 'skills', 'demo');
    const replacement = path.join(repoRoot, 'replaced-user-skill-next');
    const original = path.join(repoRoot, 'replaced-user-skill-original');
    try {
      fs.mkdirSync(userSource, { recursive: true });
      fs.mkdirSync(replacement, { recursive: true });
      fs.writeFileSync(path.join(userSource, 'SKILL.md'), '# original user skill\n');
      fs.writeFileSync(path.join(replacement, 'SKILL.md'), '# replacement user skill\n');
      const runtimeManifest = await capturePiRuntimeCapabilityManifest(
        {
          request: async () => ({
            type: 'response',
            command: 'get_commands',
            success: true,
            data: {
              commands: [{
                name: 'skill:demo',
                source: 'skill',
                sourceInfo: { scope: 'user', source: 'auto', baseDir: userBaseDir },
              }],
            },
          }),
        },
        {},
        1,
        'ready',
        { userSkillBaseDirs: [userBaseDir] },
      );
      const invocation = item({ scope: 'user', sourcePath: userSource });
      const currentSkills = skills({ scope: 'user', path: userSource, runtimeStatus: undefined });

      await expect(isCurrentPiSkillInvocation(
        invocation,
        runtimeManifest,
        currentSkills,
      )).resolves.toBe(true);

      fs.renameSync(userSource, original);
      fs.renameSync(replacement, userSource);
      await expect(isCurrentPiSkillInvocation(
        invocation,
        runtimeManifest,
        currentSkills,
      )).resolves.toBe(false);
    } finally {
      fs.rmSync(userSource, { recursive: true, force: true });
      fs.rmSync(original, { recursive: true, force: true });
      fs.rmSync(replacement, { recursive: true, force: true });
    }
  });

  it('rejects a user Skill whose physical source disappeared after scanning', async () => {
    const userBaseDir = path.join(repoRoot, 'deleted-user-skill', '.agents');
    const userSource = path.join(userBaseDir, 'skills', 'demo');
    fs.mkdirSync(userSource, { recursive: true });
    const userItem = item({ scope: 'user', sourcePath: userSource });
    const userSkills = skills({ scope: 'user', path: userSource, runtimeStatus: undefined });
    const userManifest = manifest({
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'user',
          source: 'auto',
          baseDir: userBaseDir,
        },
      }],
    });

    fs.rmSync(userSource, { recursive: true, force: true });

    expect(await isCurrentPiSkillInvocation(userItem, userManifest, userSkills)).toBe(false);
  });

  it('fails closed when repo or user source canonicalization exceeds the deadline', async () => {
    const blockedRealpath = vi.fn(() => new Promise<string>(() => {}));
    const dependencies = { realpath: blockedRealpath, deadlineMs: 10 };

    vi.useFakeTimers();
    try {
      const repoValidation = isCurrentPiSkillInvocation(
        item(),
        manifest(),
        skills(),
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect(repoValidation).resolves.toBe(false);

      const userSource = '/home/user/.agents/skills/demo';
      const userValidation = isCurrentPiSkillInvocation(
        item({ scope: 'user', sourcePath: userSource }),
        manifest({
          commands: [{
            name: 'skill:demo',
            source: 'skill',
            sourceInfo: {
              scope: 'user',
              source: 'auto',
              baseDir: '/home/user/.agents',
            },
          }],
        }),
        skills({ scope: 'user', path: userSource, runtimeStatus: undefined }),
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect(userValidation).resolves.toBe(false);
      expect(blockedRealpath).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a replacement Session after the final async runtime proof', async () => {
    const sessionA = { id: 'session-a' };
    const sessionB = { id: 'session-b' };
    let currentSession = sessionA;
    let delivered = false;

    await expect((async () => {
      await assertCurrentPiSkillInvocationSession(
        sessionA,
        () => currentSession,
        async () => {
          currentSession = sessionB;
          return true;
        },
      );
      delivered = true;
    })()).rejects.toSatisfy(isStalePiSkillInvocationError);

    expect(delivered).toBe(false);
    expect(currentSession).toBe(sessionB);
  });

  it('rechecks queued turn Session and manifest identities after the awaited proof', () => {
    const registerSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'register.ts'),
      'utf8',
    );
    const start = registerSource.indexOf('const validateQueuedAgentSkillInvocation = async (');
    const end = registerSource.indexOf('\n  const inputCoordinator:', start);
    const validation = registerSource.slice(start, end);
    const reload = validation.indexOf("maker.listAgentSkills('pi', {");
    const manifestCapture = validation.indexOf('const manifest = session.getRuntimeCapabilities();');
    const proof = validation.indexOf('const invocationIsCurrent = await isCurrentPiSkillInvocation(');
    const scopedErrorCheck = validation.indexOf('piSkillScanErrorsBlockInvocation(');
    const sessionRecheck = validation.indexOf('maker.getSession(sessionId) === session', proof);
    const manifestRecheck = validation.indexOf(
      'session.getRuntimeCapabilities() === manifest',
      proof,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(scopedErrorCheck).toBeGreaterThanOrEqual(0);
    expect(validation).not.toContain('if (currentSkills.errors?.length) return false;');
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(manifestCapture).toBeGreaterThan(reload);
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(sessionRecheck).toBeGreaterThan(proof);
    expect(manifestRecheck).toBeGreaterThan(proof);
  });

  it('does not let a changed sibling Skill block the selected runtime proof', () => {
    const selected = path.resolve('/repo/.pi/skills/stable');
    const sibling = path.resolve('/repo/.pi/skills/changed');

    expect(piSkillScanErrorsBlockInvocation([
      { path: sibling, message: 'Project skill changed after this Pi session started' },
    ], selected)).toBe(false);
    expect(piSkillScanErrorsBlockInvocation([
      { path: selected, message: 'Project skill changed after this Pi session started' },
    ], selected)).toBe(true);
  });

  it('keeps scanner-wide and selected source-root failures fail closed', () => {
    const selected = path.resolve('/repo/.pi/skills/stable');

    expect(piSkillScanErrorsBlockInvocation([
      { message: 'Pi customization scan deadline expired' },
    ], selected)).toBe(true);
    expect(piSkillScanErrorsBlockInvocation([
      { path: path.dirname(selected), message: 'Unable to scan project Skills' },
    ], selected)).toBe(true);
  });
});
