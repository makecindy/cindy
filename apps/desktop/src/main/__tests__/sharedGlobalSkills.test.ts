import os from 'node:os';
import path from 'node:path';
import nodeFs, { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const lockRoot = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'cindy-projection-locks-'));
vi.mock('electron', () => ({ app: { getPath: () => lockRoot } }));
vi.mock('../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
import { acquireSharedSkillMutationLease } from '../skillhub/sharedMutationLease';

import {
  prepareSharedGlobalSkillLinks,
  prepareSharedProjectSkillLinks,
  projectWorkingDirFromSkillPath,
  sharedGlobalSkillsPaths,
  sharedProjectSkillsPaths,
} from '../maker-host/shared-global-skills';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-global-skills-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string): Promise<string> {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n\nbody\n`,
    'utf8',
  );
  return skillDir;
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(ra) === normalize(rb);
}

afterEach(async () => {
  vi.restoreAllMocks();
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
afterAll(() => nodeFs.rmSync(lockRoot, { recursive: true, force: true }));

describe('shared Skill projection mutations', () => {
  it.each(['global', 'project'] as const)('blocks %s projection for a pending uninstall, then permits its installing caller', async (scope) => {
    const root = await makeTmpDir();
    const name = randomUUID();
    const paths = sharedGlobalSkillsPaths(root);
    const source = await writeSkill(paths.sharedSkillsDir, name);
    const project = async () => scope === 'global'
      ? prepareSharedGlobalSkillLinks({ homeDir: root, isCrossAgentSyncEnabled: () => false })
      : prepareSharedProjectSkillLinks({ workingDir: root });
    const token = randomUUID();
    const initial = (await acquireSharedSkillMutationLease([name]))!;
    initial.retainUntilComplete(token);
    await initial();
    expect((await project()).changed).toBe(false);
    await expect(fs.lstat(path.join(paths.claudeSkillsDir, name))).rejects.toMatchObject({ code: 'ENOENT' });
    const owner = (await acquireSharedSkillMutationLease([name], token))!;
    try {
      owner.complete(token);
      expect((await project()).changed).toBe(false); // An independent window still cannot write.
      expect((await owner.run(project)).changed).toBe(true);
      expect(await sameRealPath(source, path.join(paths.claudeSkillsDir, name))).toBe(true);
    } finally { await owner(); }
  });

  it('locks the physical basename when projecting a differently named external alias', async () => {
    const root = await makeTmpDir();
    const paths = sharedGlobalSkillsPaths(root);
    const name = randomUUID();
    const alias = randomUUID();
    const source = await writeSkill(path.join(root, 'external'), name);
    await fs.mkdir(paths.sharedSkillsDir, { recursive: true });
    await fs.symlink(source, path.join(paths.sharedSkillsDir, alias), process.platform === 'win32' ? 'junction' : 'dir');
    const lease = (await acquireSharedSkillMutationLease([name]))!;
    try {
      const result = await prepareSharedGlobalSkillLinks({ homeDir: root, isCrossAgentSyncEnabled: () => false });
      expect(result.changed).toBe(false);
      await expect(fs.lstat(path.join(paths.claudeSkillsDir, alias))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await lease(); }
  });

  it('revalidates the source after the final awaited mkdir before linking', async () => {
    const root = await makeTmpDir();
    const paths = sharedGlobalSkillsPaths(root);
    const name = randomUUID();
    const source = await writeSkill(paths.sharedSkillsDir, name);
    const mkdir = fs.mkdir;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof mkdir>) => {
      const result = await mkdir(...args);
      if (String(args[0]) === paths.claudeSkillsDir) {
        await fs.rename(source, `${source}-old`);
        await mkdir(source);
      }
      return result;
    });
    await expect(prepareSharedProjectSkillLinks({ workingDir: root })).rejects.toThrow('Skill source changed');
    await expect(fs.lstat(path.join(paths.claudeSkillsDir, name))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a broken link replaced while the cleanup reads its previous target', async () => {
    const root = await makeTmpDir();
    const paths = sharedGlobalSkillsPaths(root);
    const name = randomUUID();
    const link = path.join(paths.claudeSkillsDir, name);
    const nextTarget = path.join(paths.sharedSkillsDir, `${name}-new`);
    await fs.mkdir(paths.claudeSkillsDir, { recursive: true });
    await fs.symlink(path.join(paths.sharedSkillsDir, name), link, process.platform === 'win32' ? 'junction' : 'dir');
    const readlink = fs.readlink;
    let replaced = false;
    vi.spyOn(fs, 'readlink').mockImplementation(async (...args: Parameters<typeof readlink>) => {
      const result = await readlink(...args);
      if (!replaced && String(args[0]) === link) {
        replaced = true;
        await fs.unlink(link);
        await fs.symlink(nextTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return result;
    });
    await prepareSharedProjectSkillLinks({ workingDir: root });
    expect(replaced).toBe(true);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toContain(`${name}-new`);
  });
});

describe('prepareSharedGlobalSkillLinks', () => {
  it('does not pull other-agent skills into the shared index by default (opt-in gate, #2930)', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    await writeSkill(paths.claudeSkillsDir, 'claude-only');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.changed).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.warnings).toEqual([
      'cross-agent global skill sync is disabled; set crossAgentSyncEnabled to opt in',
    ]);
    // 未 opt-in 时，不把 Claude 的用户技能拉进 ~/.agents/skills。
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'claude-only'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('still projects the shared index into Claude when sync is disabled (Ghost projection)', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'ghost-managed');

    const result = await prepareSharedGlobalSkillLinks({ homeDir });

    expect(result.changed).toBe(true);
    // ~/.agents → ~/.claude 的 Cindy 自有索引投影仍保留（Ghost skill 依赖它）。
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'ghost-managed'), sharedSkill)).toBe(true);
    // 纯 Ghost 对账不应打扰（无其它 Agent 用户技能可同步时，不提示）。
    expect(result.warnings).toEqual([]);
  });

  it('links existing Claude skills into the shared skills root for Codex visibility', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'claude-only');

    const result = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'claude-only'), claudeSkill)).toBe(true);
  });

  it('stops before the next shared-root write when the owner changes mid-fanout', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    await writeSkill(paths.claudeSkillsDir, 'a-first');
    await writeSkill(paths.claudeSkillsDir, 'b-second');

    let ownerStable = true;
    const realSymlink = fs.symlink;
    const symlinkSpy = vi.spyOn(fs, 'symlink').mockImplementation(async (...args) => {
      await realSymlink(...args);
      ownerStable = false;
    });
    try {
      await expect(
        prepareSharedGlobalSkillLinks({
          homeDir,
          isCrossAgentSyncEnabled: () => true,
          assertOwnerStable: () => {
            if (!ownerStable) throw new Error('owner changed');
          },
        }),
      ).rejects.toThrow('owner changed');
    } finally {
      symlinkSpy.mockRestore();
    }

    expect(await sameRealPath(
      path.join(paths.sharedSkillsDir, 'a-first'),
      path.join(paths.claudeSkillsDir, 'a-first'),
    )).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'b-second'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('links shared skills into Claude skills so Claude Code can load them', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared-only');

    const result = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'shared-only'), sharedSkill)).toBe(true);
  });

  it('links existing Codex skills into Claude and the shared skills root', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const codexSkill = await writeSkill(paths.codexSkillsDir, 'codex-only');

    await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });
    const secondResult = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(secondResult.changed).toBe(false);
    expect(secondResult.warnings).toEqual([]);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'codex-only'), codexSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'codex-only'), codexSkill)).toBe(true);
  });

  it('stops before the Codex-to-shared write when the owner changes after Claude fanout', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    await writeSkill(paths.codexSkillsDir, 'codex-owner-change');

    let ownerStable = true;
    const realSymlink = fs.symlink;
    const symlinkSpy = vi.spyOn(fs, 'symlink').mockImplementation(async (...args) => {
      await realSymlink(...args);
      ownerStable = false;
    });
    try {
      await expect(
        prepareSharedGlobalSkillLinks({
          homeDir,
          isCrossAgentSyncEnabled: () => true,
          assertOwnerStable: () => {
            if (!ownerStable) throw new Error('owner changed');
          },
        }),
      ).rejects.toThrow('owner changed');
    } finally {
      symlinkSpy.mockRestore();
    }

    expect(await sameRealPath(
      path.join(paths.claudeSkillsDir, 'codex-owner-change'),
      path.join(paths.codexSkillsDir, 'codex-owner-change'),
    )).toBe(true);
    await expect(
      fs.lstat(path.join(paths.sharedSkillsDir, 'codex-owner-change')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite a conflicting shared skill directory with a Codex skill', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'duplicate');
    const codexSkill = await writeSkill(paths.codexSkillsDir, 'duplicate');

    const result = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(result.warnings.some((warning) => warning.includes('duplicate'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), codexSkill)).toBe(false);
  });

  it('does not overwrite a user-owned shared symlink with a Codex skill', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const codexSkill = await writeSkill(paths.codexSkillsDir, 'user-link');
    const externalSkill = await writeSkill(path.join(root, 'external-skills'), 'user-link');
    const sharedLink = path.join(paths.sharedSkillsDir, 'user-link');
    await fs.mkdir(paths.sharedSkillsDir, { recursive: true });
    await fs.symlink(externalSkill, sharedLink, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(result.warnings.some((warning) => warning.includes('user-link'))).toBe(true);
    expect(await sameRealPath(sharedLink, externalSkill)).toBe(true);
    expect(await sameRealPath(sharedLink, codexSkill)).toBe(false);
  });

  it('cleans up shared and Claude links after a Codex source skill is removed', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const codexSkill = await writeSkill(paths.codexSkillsDir, 'removed-codex-skill');

    await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'removed-codex-skill'), codexSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'removed-codex-skill'), codexSkill)).toBe(true);

    await fs.rm(codexSkill, { recursive: true, force: true });
    const result = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(result.changed).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'removed-codex-skill'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.lstat(path.join(paths.claudeSkillsDir, 'removed-codex-skill'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('filters Codex links that already point into the shared root', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared-backlink');
    const codexLink = path.join(paths.codexSkillsDir, 'shared-backlink');
    await fs.mkdir(paths.codexSkillsDir, { recursive: true });
    await fs.symlink(sharedSkill, codexLink, process.platform === 'win32' ? 'junction' : 'dir');

    await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });
    const secondResult = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(secondResult.changed).toBe(false);
    expect(secondResult.warnings).toEqual([]);
    expect(await sameRealPath(codexLink, sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'shared-backlink'), sharedSkill)).toBe(true);
  });

  it('does not overwrite conflicting real skill directories', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'duplicate');
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'duplicate');

    const result = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(result.warnings.some((warning) => warning.includes('duplicate'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'duplicate'), claudeSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), path.join(paths.claudeSkillsDir, 'duplicate'))).toBe(false);
  });

  it('does not overwrite user-owned symlinks that point elsewhere', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'user-link');
    const externalSkill = await writeSkill(path.join(root, 'external-skills'), 'user-link');
    const claudeLink = path.join(paths.claudeSkillsDir, 'user-link');
    await fs.mkdir(paths.claudeSkillsDir, { recursive: true });
    await fs.symlink(externalSkill, claudeLink, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(result.warnings.some((warning) => warning.includes('user-link'))).toBe(true);
    expect(await sameRealPath(claudeLink, externalSkill)).toBe(true);
    expect(await sameRealPath(claudeLink, sharedSkill)).toBe(false);
  });

  it('cleans up broken managed links after the source skill is removed', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const paths = sharedGlobalSkillsPaths(homeDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'removed-later');

    await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'removed-later'), claudeSkill)).toBe(true);

    await fs.rm(claudeSkill, { recursive: true, force: true });
    const result = await prepareSharedGlobalSkillLinks({ homeDir, isCrossAgentSyncEnabled: () => true });

    expect(result.changed).toBe(true);
    await expect(fs.lstat(path.join(paths.sharedSkillsDir, 'removed-later'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('prepareSharedProjectSkillLinks', () => {
  it('exposes a legacy Claude project skill to Codex without copying it', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'legacy');

    const result = await prepareSharedProjectSkillLinks({ workingDir });
    const sharedLink = path.join(paths.sharedSkillsDir, 'legacy');

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect((await fs.lstat(sharedLink)).isSymbolicLink()).toBe(true);
    expect(await sameRealPath(sharedLink, claudeSkill)).toBe(true);
    if (process.platform !== 'win32') {
      expect(path.isAbsolute(await fs.readlink(sharedLink))).toBe(false);
    }
  });

  it('exposes a canonical shared project skill to Claude without copying it', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'shared');

    const result = await prepareSharedProjectSkillLinks({ workingDir });
    const claudeLink = path.join(paths.claudeSkillsDir, 'shared');

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
    expect(await sameRealPath(claudeLink, sharedSkill)).toBe(true);
  });

  it('does not create empty discovery roots when the project has no skills', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result).toMatchObject({ changed: false, actions: [], warnings: [] });
    await expect(fs.lstat(paths.sharedSkillsDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(paths.claudeSkillsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps conflicting real project skills on both sides', async () => {
    const workingDir = await makeTmpDir();
    const paths = sharedProjectSkillsPaths(workingDir);
    const sharedSkill = await writeSkill(paths.sharedSkillsDir, 'duplicate');
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'duplicate');

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result.warnings.some((warning) => warning.includes('duplicate'))).toBe(true);
    expect(await sameRealPath(path.join(paths.sharedSkillsDir, 'duplicate'), sharedSkill)).toBe(true);
    expect(await sameRealPath(path.join(paths.claudeSkillsDir, 'duplicate'), claudeSkill)).toBe(true);
    expect(await sameRealPath(sharedSkill, claudeSkill)).toBe(false);
  });

  it('repairs a broken absolute project link after the checkout moves', async () => {
    const root = await makeTmpDir();
    const oldWorkingDir = path.join(root, 'old-checkout');
    const workingDir = path.join(root, 'moved-checkout');
    const oldPaths = sharedProjectSkillsPaths(oldWorkingDir);
    const paths = sharedProjectSkillsPaths(workingDir);
    const claudeSkill = await writeSkill(paths.claudeSkillsDir, 'moved-skill');
    const staleSharedLink = path.join(paths.sharedSkillsDir, 'moved-skill');
    await fs.mkdir(paths.sharedSkillsDir, { recursive: true });
    await fs.symlink(
      path.join(oldPaths.claudeSkillsDir, 'moved-skill'),
      staleSharedLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await sameRealPath(staleSharedLink, claudeSkill)).toBe(true);
  });

  it('does not replace an unrelated broken project skill symlink', async () => {
    const root = await makeTmpDir();
    const workingDir = path.join(root, 'checkout');
    const paths = sharedProjectSkillsPaths(workingDir);
    await writeSkill(paths.claudeSkillsDir, 'user-link');
    const userLink = path.join(paths.sharedSkillsDir, 'user-link');
    const externalTarget = path.join(root, 'removed-external-skills', 'user-link');
    await fs.mkdir(paths.sharedSkillsDir, { recursive: true });
    await fs.symlink(
      externalTarget,
      userLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await prepareSharedProjectSkillLinks({ workingDir });

    expect(result.changed).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('user-link'))).toBe(true);
    expect(await fs.readlink(userLink)).toBe(externalTarget);
  });
});

describe('projectWorkingDirFromSkillPath', () => {
  it('accepts only direct project skill discovery children', () => {
    const projectRoot = path.resolve(path.sep, 'projects', 'demo');
    expect(
      projectWorkingDirFromSkillPath(
        path.join(projectRoot, '.agents', 'skills', 'my-skill'),
      ),
    ).toBe(projectRoot);
    expect(
      projectWorkingDirFromSkillPath(
        path.join(projectRoot, '.claude', 'skills', 'my-skill'),
      ),
    ).toBe(projectRoot);
    expect(projectWorkingDirFromSkillPath(path.join(projectRoot, 'skills', 'my-skill')))
      .toBeNull();
  });
});
