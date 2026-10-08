import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_LEGACY_CODEX_SKILLS_LINK_NAME,
  CODEX_SHARED_AGENTS_SKILLS_LINK_NAME,
  codexGlobalSkillsPaths,
  codexManagedSkillLinkName,
  prepareCodexGlobalSkillsLinks,
} from '../maker-host/codex-global-skills';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-skills-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string): Promise<void> {
  const skillDir = path.join(skillsDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n\nbody\n`,
    'utf8',
  );
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

describe('prepareCodexGlobalSkillsLinks', () => {
  it('loads only verified individual sources, retires old aggregates and preserves foreign occupants', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'codex');
    const ownerA = path.join(
      root,
      'owner-a',
      'ghost-install-state',
      'skill-snapshots',
      'example',
      'rev',
    );
    const ownerB = path.join(
      root,
      'owner-b',
      'ghost-install-state',
      'skill-snapshots',
      'example',
      'rev',
    );
    await writeSkill(path.join(ownerA, 'skills'), 'learn');
    await writeSkill(path.join(ownerB, 'skills'), 'learn');
    const projection = path.join(root, 'owner-a', 'ghost-install-state', 'agent-skills', 'skills');
    await writeSkill(projection, 'unapproved--extra');
    await fs.mkdir(path.join(codexHome, 'skills'), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(projection, path.join(codexHome, 'skills', 'cindy-1'), linkType);
    const foreign = path.join(root, 'foreign');
    await fs.mkdir(foreign);
    await fs.symlink(foreign, path.join(codexHome, 'skills', 'cindy-foreign'), linkType);
    await fs.mkdir(path.join(codexHome, 'skills', 'cindy-user-directory'));
    const command = 'cindy-plugin-example:learn';
    const link = path.join(codexHome, 'skills', codexManagedSkillLinkName(command));
    const options = (owner: string) => ({
      homeDir,
      managedRoots: [root],
      managedSkills: [
        {
          path: path.join(owner, 'skills', 'learn', 'SKILL.md'),
          claudeCommandName: command,
        },
      ],
    });
    await prepareCodexGlobalSkillsLinks(codexHome, options(ownerA));
    expect(await sameRealPath(link, path.join(ownerA, 'skills', 'learn'))).toBe(true);
    await expect(fs.lstat(path.join(codexHome, 'skills', 'cindy-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readdir(projection)).toEqual(['unapproved--extra']);
    await prepareCodexGlobalSkillsLinks(codexHome, options(ownerB));
    expect(await sameRealPath(link, path.join(ownerB, 'skills', 'learn'))).toBe(true);
    await prepareCodexGlobalSkillsLinks(codexHome, {
      homeDir,
      managedRoots: [root],
      managedSkills: [],
    });
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sameRealPath(path.join(codexHome, 'skills', 'cindy-foreign'), foreign)).toBe(true);
    expect(
      (await fs.stat(path.join(codexHome, 'skills', 'cindy-user-directory'))).isDirectory(),
    ).toBe(true);
    await fs.symlink(foreign, link, linkType);
    await expect(prepareCodexGlobalSkillsLinks(codexHome, options(ownerA))).rejects.toThrow(
      'foreign skill link is preserved',
    );
    expect(await sameRealPath(link, foreign)).toBe(true);
    await expect(fs.stat(path.join(homeDir, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(homeDir, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['directory-conflict', 'create-error', 'replace-error', 'missing', 'cycle'] as const)(
    'rejects an incomplete managed projection (%s) instead of reporting a successful refresh',
    async (failure) => {
      const root = await makeTmpDir();
      const codexHome = path.join(root, 'codex');
      const snapshots = path.join(root, 'ghost-install-state', 'skill-snapshots');
      const command = 'cindy-plugin-example:learn';
      const link = path.join(codexHome, 'skills', codexManagedSkillLinkName(command));
      await fs.mkdir(path.dirname(link), { recursive: true });
      await writeSkill(snapshots, 'old');
      await writeSkill(snapshots, 'current');
      let source = path.join(snapshots, 'current');
      if (failure === 'directory-conflict') {
        await fs.mkdir(link);
        await fs.writeFile(path.join(link, 'keep.txt'), 'user-owned');
      } else if (failure === 'replace-error') {
        await fs.symlink(
          path.join(snapshots, 'old'),
          link,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        const rm = fs.rm;
        vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
          if (target === link) throw Object.assign(new Error('locked entry'), { code: 'EPERM' });
          return rm(target, options);
        });
      } else if (failure === 'create-error') {
        vi.spyOn(fs, 'symlink').mockRejectedValue(
          Object.assign(new Error('link denied'), { code: 'EACCES' }),
        );
      } else if (failure === 'missing') {
        source = path.join(snapshots, 'missing');
      } else {
        source = path.join(codexHome, 'skills', 'cycle');
        await writeSkill(path.dirname(source), 'cycle');
      }
      await expect(
        prepareCodexGlobalSkillsLinks(codexHome, {
          homeDir: path.join(root, 'home'),
          managedRoots: [root],
          managedSkills: [{ path: path.join(source, 'SKILL.md'), claudeCommandName: command }],
        }),
      ).rejects.toThrow('Cannot prepare Codex managed Skill');
      if (failure === 'directory-conflict')
        expect(await fs.readFile(path.join(link, 'keep.txt'), 'utf8')).toBe('user-owned');
      if (failure === 'replace-error')
        expect(await sameRealPath(link, path.join(snapshots, 'old'))).toBe(true);
      expect(await fs.readFile(path.join(snapshots, 'current', 'SKILL.md'), 'utf8')).toContain(
        'body',
      );
    },
  );

  it('links legacy Codex and shared agent skills directly under the custom CODEX_HOME skills root', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    const agentsSkills = path.join(homeDir, '.agents', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');
    await writeSkill(agentsSkills, 'shared-skill');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(path.basename(paths.legacyCodexSkillsLink)).toBe(CODEX_LEGACY_CODEX_SKILLS_LINK_NAME);
    expect(path.basename(paths.sharedAgentsSkillsLink)).toBe(CODEX_SHARED_AGENTS_SKILLS_LINK_NAME);
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
    expect(await sameRealPath(paths.sharedAgentsSkillsLink, agentsSkills)).toBe(true);
  });

  it('skips missing source roots without failing the scan-entry setup', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
    expect(result.sources.find((source) => source.name === 'codex')?.status).toMatch(/linked|kept/);
    expect(result.sources.find((source) => source.name === 'agents')?.status).toBe('missing');
  });

  it('removes a stale managed link when its source root disappears', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);

    await fs.rm(legacySkills, { recursive: true, force: true });
    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(result.sources.find((source) => source.name === 'codex')?.status).toBe('missing');
    await expect(fs.lstat(paths.legacyCodexSkillsLink)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replace a non-managed directory at a source link path', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const paths = codexGlobalSkillsPaths(codexHome, homeDir);
    const conflictingDir = paths.legacyCodexSkillsLink;
    await fs.mkdir(conflictingDir, { recursive: true });
    await fs.writeFile(path.join(conflictingDir, 'keep.txt'), 'do not remove', 'utf8');

    const result = await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });

    expect(result.sources.find((source) => source.name === 'codex')?.status).toBe('conflict');
    await expect(fs.readFile(path.join(conflictingDir, 'keep.txt'), 'utf8')).resolves.toBe(
      'do not remove',
    );
    expect(
      result.warnings.some((warning) => warning.includes('cannot link Codex codex skills')),
    ).toBe(true);
  });

  it('removes the old aggregate scan link without deleting non-managed files', async () => {
    const root = await makeTmpDir();
    const homeDir = path.join(root, 'home');
    const codexHome = path.join(root, 'xdt-codex-home');
    const legacySkills = path.join(homeDir, '.codex', 'skills');
    await writeSkill(legacySkills, 'legacy-skill');

    const oldAggregateDir = path.join(codexHome, 'global_skills');
    const oldScanEntry = path.join(codexHome, 'skills', 'xdt-global');
    await fs.mkdir(path.join(codexHome, 'skills'), { recursive: true });
    await fs.mkdir(oldAggregateDir, { recursive: true });
    await fs.symlink(
      oldAggregateDir,
      oldScanEntry,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.writeFile(path.join(oldAggregateDir, 'keep.txt'), 'do not remove', 'utf8');

    await prepareCodexGlobalSkillsLinks(codexHome, { homeDir });
    const paths = codexGlobalSkillsPaths(codexHome, homeDir);

    await expect(fs.lstat(oldScanEntry)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(oldAggregateDir, 'keep.txt'), 'utf8')).resolves.toBe(
      'do not remove',
    );
    expect(await sameRealPath(paths.legacyCodexSkillsLink, legacySkills)).toBe(true);
  });
});
