import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

vi.mock('../registry', () => ({
  registryService: {
    listAllInstalls: vi.fn(async () => []),
    removeInstall: vi.fn(async () => undefined),
  },
}));

import {
  isExistingSkillPathGranted,
  listSkillFolderChildren,
  readSkillContent,
  readSkillRawFile,
  readSkillSiblingFile,
  renameLocalSkill,
  resolveExistingSkillPathForGrant,
  scanAllSkills,
  writeSkillFile,
} from '../scanner';
import type { Maker } from '@cindy/maker-core';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createSymlinkedSkill() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-symlink-'));
  tempRoots.push(root);

  const actualDir = path.join(root, '.cc-switch', 'skills', 'lark-drive');
  const exposedDir = path.join(root, '.agents', 'skills', 'lark-drive');
  fs.mkdirSync(actualDir, { recursive: true });
  fs.mkdirSync(path.dirname(exposedDir), { recursive: true });
  fs.writeFileSync(
    path.join(actualDir, 'SKILL.md'),
    [
      '---',
      'name: lark-drive',
      '---',
      '',
      '# Lark Drive',
      '',
      'Original content',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.mkdirSync(path.join(actualDir, 'references'));
  fs.writeFileSync(path.join(actualDir, 'pricing.json'), '{"tier":"internal"}\n', 'utf-8');
  fs.symlinkSync(actualDir, exposedDir, process.platform === 'win32' ? 'junction' : 'dir');

  return {
    actualSkillMd: path.join(actualDir, 'SKILL.md'),
    exposedDir,
    exposedPricingJson: path.join(exposedDir, 'pricing.json'),
    exposedSkillMd: path.join(exposedDir, 'SKILL.md'),
  };
}

describe('scanAllSkills', () => {
  it('uses projectRoot as maker workingDirs and maps projectHash back to project skills', async () => {
    const projectRoot = path.resolve('/repo');
    const skillDir = path.join(projectRoot, '.claude', 'skills', 'demo');
    const maker = {
      listCustomizations: vi.fn(async () => ({
        errors: [],
        items: [
          {
            engine: 'claude-code',
            kind: 'skill',
            scope: 'project',
            name: 'demo',
            absolutePath: skillDir,
            mdPath: path.join(skillDir, 'SKILL.md'),
            workingDir: projectRoot,
            files: [],
          },
        ],
      })),
    } as unknown as Maker;

    const result = await scanAllSkills({
      projects: [{ projectRoot, hash: 'abcd1234' }],
    }, maker);

    expect(maker.listCustomizations).toHaveBeenCalledWith({
      workingDirs: [projectRoot],
      forceReload: false,
    });
    expect(result.skills[0]).toMatchObject({
      id: 'claude-code:skill:project:abcd1234:demo',
      urlKey: 'skill:project:abcd1234:demo',
      projectRoot,
      projectHash: 'abcd1234',
    });
  });

  it('gives same-name project skills from different physical sources distinct stable ids', async () => {
    const projectRoot = path.resolve('/repo');
    const piSkill = path.join(projectRoot, '.pi', 'skills', 'demo');
    const agentsSkill = path.join(projectRoot, '.agents', 'skills', 'demo');
    const items = [piSkill, agentsSkill].map((absolutePath) => ({
      engine: 'pi' as const,
      kind: 'skill' as const,
      scope: 'repo' as const,
      name: 'demo',
      absolutePath,
      mdPath: path.join(absolutePath, 'SKILL.md'),
      workingDir: projectRoot,
      runtimeStatus: 'discovered' as const,
      files: [],
    }));
    const maker = {
      listCustomizations: vi
        .fn()
        .mockResolvedValueOnce({ errors: [], items: [items[0]] })
        .mockResolvedValueOnce({ errors: [], items })
        .mockResolvedValueOnce({ errors: [], items: [items[0]] })
        .mockResolvedValueOnce({ errors: [], items: items.toReversed() }),
    } as unknown as Maker;

    const params = { projects: [{ projectRoot, hash: 'abcd1234' }] };
    const singleBefore = await scanAllSkills(params, maker);
    const first = await scanAllSkills(params, maker);
    const singleAfter = await scanAllSkills(params, maker);
    const reversed = await scanAllSkills(params, maker);

    expect(singleBefore.skills[0].id).toBe(singleAfter.skills[0].id);
    expect(singleBefore.skills[0].sourceKey).toBeDefined();

    expect(first.skills).toHaveLength(2);
    expect(new Set(first.skills.map((skill) => skill.urlKey))).toEqual(
      new Set(['skill:project:abcd1234:demo']),
    );
    expect(new Set(first.skills.map((skill) => skill.id))).toHaveLength(2);
    expect(first.skills.every((skill) => /^[a-f0-9]{64}$/.test(skill.sourceKey ?? ''))).toBe(true);
    expect(first.skills.every((skill) => skill.requiresSourceKey === true)).toBe(true);
    expect(new Set(reversed.skills.map((skill) => skill.id))).toEqual(
      new Set(first.skills.map((skill) => skill.id)),
    );
  });

  it('keeps a shared ancestor skill in every project that discovered it', async () => {
    const firstRoot = path.resolve('/repo/apps/first');
    const secondRoot = path.resolve('/repo/apps/second');
    const sharedSkill = path.resolve('/repo/.agents/skills/shared-skill');
    const maker = {
      listCustomizations: vi.fn(async () => ({
        errors: [],
        items: [firstRoot, secondRoot].map((workingDir) => ({
          engine: 'pi' as const,
          kind: 'skill' as const,
          scope: 'repo',
          name: 'shared-skill',
          absolutePath: sharedSkill,
          mdPath: path.join(sharedSkill, 'SKILL.md'),
          workingDir,
          runtimeStatus: 'discovered' as const,
          files: [],
        })),
      })),
    } as unknown as Maker;

    const result = await scanAllSkills({
      projects: [
        { projectRoot: firstRoot, hash: 'first123' },
        { projectRoot: secondRoot, hash: 'second456' },
      ],
    }, maker);

    expect(result.skills).toHaveLength(2);
    expect(result.skills.map((skill) => skill.projectHash).sort()).toEqual([
      'first123',
      'second456',
    ]);
    expect(result.skills.map((skill) => skill.projectRoot).sort()).toEqual([
      firstRoot,
      secondRoot,
    ].sort());
  });

  it('maps a canonical scanner workingDir back to the original symlink project root', async () => {
    const projectRoot = path.resolve('/workspace/project-link');
    const canonicalRoot = path.resolve('/workspace/project-real');
    const skillDir = path.join(canonicalRoot, '.pi', 'skills', 'pi-demo');
    const realpathSyncSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((value) => {
      const candidate = String(value);
      if (candidate === projectRoot) return canonicalRoot;
      return candidate;
    });
    const maker = {
      listCustomizations: vi.fn(async () => ({
        errors: [],
        items: [{
          engine: 'pi',
          kind: 'skill',
          scope: 'repo',
          name: 'pi-demo',
          absolutePath: skillDir,
          mdPath: path.join(skillDir, 'SKILL.md'),
          workingDir: canonicalRoot,
          runtimeStatus: 'discovered',
          files: [],
        }],
      })),
    } as unknown as Maker;

    const result = await scanAllSkills({
      projects: [{ projectRoot, hash: 'linked123' }],
    }, maker);

    expect(result.skills[0]).toMatchObject({
      scope: 'project',
      projectRoot,
      projectHash: 'linked123',
    });
    realpathSyncSpy.mockRestore();
  });

  it('keeps lexical aliases of one physical project assigned to their own project entries', async () => {
    const projectRoot = path.resolve('/workspace/project-real');
    const linkedRoot = path.resolve('/workspace/project-link');
    const skillDir = path.join(projectRoot, '.pi', 'skills', 'pi-demo');
    const realpathSyncSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((value) => {
      const candidate = String(value);
      if (candidate === linkedRoot) return projectRoot;
      return candidate;
    });
    const maker = {
      listCustomizations: vi.fn(async () => ({
        errors: [],
        items: [projectRoot, linkedRoot].map((workingDir) => ({
          engine: 'pi' as const,
          kind: 'skill' as const,
          scope: 'repo' as const,
          name: 'pi-demo',
          absolutePath: skillDir,
          mdPath: path.join(skillDir, 'SKILL.md'),
          workingDir,
          runtimeStatus: 'discovered' as const,
          files: [],
        })),
      })),
    } as unknown as Maker;

    const result = await scanAllSkills({
      projects: [
        { projectRoot, hash: 'real1234' },
        { projectRoot: linkedRoot, hash: 'link5678' },
      ],
    }, maker);

    expect(result.skills.map((skill) => skill.projectHash).sort()).toEqual(['link5678', 'real1234']);
    expect(result.skills.map((skill) => skill.projectRoot).sort()).toEqual([
      linkedRoot,
      projectRoot,
    ].sort());
    realpathSyncSpy.mockRestore();
  });

  it('ignores non-absolute projectRoot values before calling maker', async () => {
    const maker = {
      listCustomizations: vi.fn(async () => ({ errors: [], items: [] })),
    } as unknown as Maker;

    await scanAllSkills({
      projects: [{ projectRoot: 'relative/project', hash: 'badroot' }],
    }, maker);

    expect(maker.listCustomizations).toHaveBeenCalledWith({
      workingDirs: [],
      forceReload: false,
    });
  });

  it('dedupes the same global skill across Claude and Codex, preferring the shared .agents path', async () => {
    const home = path.join('/Users', 'devuser');
    const claudePath = path.join(home, '.claude', 'skills', 'web-access');
    const agentsPath = path.join(home, '.agents', 'skills', 'web-access');

    // 模拟 symlink 场景：.claude 路径实际指向 .agents 路径
    const realpathSyncSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((p) => {
      const s = String(p);
      if (s === claudePath || s === agentsPath) return agentsPath;
      return s;
    });
    const maker = {
      listCustomizations: vi.fn(async () => ({
        errors: [],
        items: [
          {
            engine: 'claude-code',
            kind: 'skill',
            scope: 'global',
            name: 'web-access',
            absolutePath: claudePath,
            mdPath: path.join(claudePath, 'SKILL.md'),
            files: [],
          },
          {
            engine: 'claude-code',
            kind: 'skill',
            scope: 'global',
            name: 'web-access',
            absolutePath: agentsPath,
            mdPath: path.join(agentsPath, 'SKILL.md'),
            files: [],
          },
          {
            engine: 'codex',
            kind: 'skill',
            scope: 'user',
            name: 'web-access',
            absolutePath: path.join(agentsPath, 'SKILL.md'),
            files: [],
          },
        ],
      })),
    } as unknown as Maker;

    const result = await scanAllSkills({}, maker);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      id: 'claude-code:skill:global:web-access',
      urlKey: 'skill:global:web-access',
      name: 'web-access',
      absolutePath: agentsPath,
      mdPath: path.join(agentsPath, 'SKILL.md'),
    });
    expect(result.skills[0].linkedEngines).toEqual([
      { engine: 'claude-code', label: 'Claude' },
      { engine: 'codex', label: 'Codex' },
    ]);

    realpathSyncSpy.mockRestore();
  });

  it('preserves Pi discovery status on per-engine badges', async () => {
    const projectRoot = path.resolve('/repo');
    const skillDir = path.join(projectRoot, '.pi', 'skills', 'pi-demo');
    const maker = {
      listCustomizations: vi.fn(async () => ({
        errors: [],
        items: [{
          engine: 'pi',
          kind: 'skill',
          scope: 'repo',
          name: 'pi-demo',
          absolutePath: skillDir,
          mdPath: path.join(skillDir, 'SKILL.md'),
          workingDir: projectRoot,
          runtimeStatus: 'discovered',
          files: [],
        }],
      })),
    } as unknown as Maker;

    const result = await scanAllSkills({
      projects: [{ projectRoot, hash: 'pi123456' }],
    }, maker);

    expect(result.skills[0]).toMatchObject({
      engine: 'pi',
      scope: 'project',
      projectRoot,
      linkedEngines: [{ engine: 'pi', label: 'Pi', runtimeStatus: 'discovered' }],
    });
  });

  it('allows SkillHub detail reads from project .pi/skills', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-pi-skill-'));
    tempRoots.push(root);
    const skillDir = path.join(root, '.pi', 'skills', 'pi-demo');
    const skillMd = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillMd, '---\nname: pi-demo\n---\n\n# Pi Demo\n', 'utf-8');

    await expect(readSkillContent({ mdPath: skillMd })).resolves.toMatchObject({
      success: true,
      content: '\n# Pi Demo\n',
    });
    await expect(listSkillFolderChildren({ dirPath: skillDir })).resolves.toMatchObject({
      success: true,
      entries: [{ name: 'SKILL.md', kind: 'file' }],
    });
    await expect(readSkillRawFile({ filePath: skillMd })).resolves.toMatchObject({ success: true });
    await expect(writeSkillFile({ filePath: skillMd, content: '# Updated Pi Demo\n' })).resolves.toEqual({
      success: true,
    });
    expect(fs.readFileSync(skillMd, 'utf-8')).toBe('# Updated Pi Demo\n');
  });

  it('filters sensitive entries from the initial skill files snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-scan-files-'));
    tempRoots.push(root);
    const skillDir = path.join(root, '.agents', 'skills', 'with-secrets');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Demo\n', 'utf-8');

    const maker = {
      listCustomizations: vi.fn(async () => ({
        errors: [],
        items: [
          {
            engine: 'claude-code',
            kind: 'skill',
            scope: 'global',
            name: 'with-secrets',
            absolutePath: skillDir,
            mdPath: path.join(skillDir, 'SKILL.md'),
            files: [
              { name: 'SKILL.md', kind: 'file' },
              { name: '.env', kind: 'file' },
              { name: '.git-credentials', kind: 'file' },
              { name: '.kube', kind: 'dir' },
              { name: '.config', kind: 'dir' },
              { name: '.cca-bindings.json', kind: 'file' },
            ],
          },
        ],
      })),
    } as unknown as Maker;

    const result = await scanAllSkills({}, maker);

    expect(result.skills[0].files).toEqual([
      { name: 'SKILL.md', kind: 'file' },
      { name: '.config', kind: 'dir' },
      { name: '.cca-bindings.json', kind: 'file' },
    ]);
  });
});

describe('skill file access', () => {
  it.skipIf(process.platform === 'win32')('rejects writing through a final file symlink', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-write-file-link-'));
    tempRoots.push(root);
    const skillDir = path.join(root, '.agents', 'skills', 'linked-file');
    const outsideMd = path.join(root, 'outside.md');
    const exposedMd = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(outsideMd, '# Outside\n', 'utf-8');
    fs.symlinkSync(outsideMd, exposedMd, 'file');

    await expect(writeSkillFile({
      filePath: exposedMd,
      content: '# Changed\n',
    })).resolves.toEqual({
      success: false,
      error: 'refusing to write through a symbolic link',
    });
    expect(fs.readFileSync(outsideMd, 'utf-8')).toBe('# Outside\n');
    expect(fs.lstatSync(exposedMd).isSymbolicLink()).toBe(true);
  });

  it('rejects renaming a skill directory symlink without mutating its target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-pi-rename-link-'));
    tempRoots.push(root);
    const projectRoot = path.join(root, 'project');
    const skillRoot = path.join(projectRoot, '.pi', 'skills');
    const targetSkill = path.join(skillRoot, 'target');
    const aliasSkill = path.join(skillRoot, 'alias');
    fs.mkdirSync(targetSkill, { recursive: true });
    fs.writeFileSync(path.join(targetSkill, 'SKILL.md'), '---\nname: target\n---\n# Target\n', 'utf-8');
    fs.symlinkSync(targetSkill, aliasSkill, process.platform === 'win32' ? 'junction' : 'dir');

    const maker = {
      listCustomizations: vi.fn(async () => ({
        errors: [],
        items: [{
          engine: 'pi',
          kind: 'skill',
          scope: 'repo',
          name: 'target',
          absolutePath: aliasSkill,
          mdPath: path.join(aliasSkill, 'SKILL.md'),
          workingDir: projectRoot,
          runtimeStatus: 'discovered',
          files: [],
        }],
      })),
    } as unknown as Maker;
    const scanned = await scanAllSkills({
      projects: [{ projectRoot, hash: 'pi-alias' }],
    }, maker);
    expect(scanned.skills[0]).toMatchObject({
      absolutePath: fs.realpathSync(targetSkill),
      discoveredPath: aliasSkill,
    });

    await expect(renameLocalSkill({
      absolutePath: scanned.skills[0].discoveredPath,
      newName: 'renamed-alias',
    })).resolves.toMatchObject({ success: false });
    expect(fs.existsSync(aliasSkill)).toBe(true);
    expect(fs.existsSync(path.join(skillRoot, 'renamed-alias'))).toBe(false);
    expect(fs.readFileSync(path.join(targetSkill, 'SKILL.md'), 'utf-8')).toBe(
      '---\nname: target\n---\n# Target\n',
    );
  });

  it.skipIf(process.platform === 'win32')('rejects renaming a skill whose SKILL.md is a symlink', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-pi-rename-md-link-'));
    tempRoots.push(root);
    const skillRoot = path.join(root, 'project', '.pi', 'skills');
    const skillDir = path.join(skillRoot, 'linked-md');
    const outsideMd = path.join(root, 'outside.md');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(outsideMd, '---\nname: outside\n---\n# Outside\n', 'utf-8');
    fs.symlinkSync(outsideMd, path.join(skillDir, 'SKILL.md'), 'file');

    await expect(renameLocalSkill({
      absolutePath: skillDir,
      newName: 'renamed-linked-md',
    })).resolves.toMatchObject({ success: false });
    expect(fs.existsSync(skillDir)).toBe(true);
    expect(fs.existsSync(path.join(skillRoot, 'renamed-linked-md'))).toBe(false);
    expect(fs.readFileSync(outsideMd, 'utf-8')).toBe('---\nname: outside\n---\n# Outside\n');
  });

  it('rejects project .pi skill symlinks that escape the physical skill root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-pi-escape-'));
    tempRoots.push(root);
    const projectRoot = path.join(root, 'project');
    const outsideSkill = path.join(root, 'outside-skill');
    const exposedSkill = path.join(projectRoot, '.pi', 'skills', 'escape');
    fs.mkdirSync(outsideSkill, { recursive: true });
    fs.mkdirSync(path.dirname(exposedSkill), { recursive: true });
    fs.writeFileSync(path.join(outsideSkill, 'SKILL.md'), '# Outside\n', 'utf-8');
    fs.writeFileSync(path.join(outsideSkill, 'notes.txt'), 'private\n', 'utf-8');
    fs.symlinkSync(outsideSkill, exposedSkill, process.platform === 'win32' ? 'junction' : 'dir');

    const exposedSkillMd = path.join(exposedSkill, 'SKILL.md');
    const exposedNotes = path.join(exposedSkill, 'notes.txt');
    await expect(readSkillContent({ mdPath: exposedSkillMd })).resolves.toMatchObject({ success: false });
    await expect(listSkillFolderChildren({ dirPath: exposedSkill })).resolves.toMatchObject({ success: false });
    await expect(readSkillSiblingFile({ filePath: exposedNotes })).resolves.toMatchObject({ success: false });
    await expect(readSkillRawFile({ filePath: exposedSkillMd })).resolves.toMatchObject({ success: false });
    await expect(writeSkillFile({ filePath: exposedSkillMd, content: '# Changed\n' })).resolves.toMatchObject({ success: false });
    expect(fs.readFileSync(path.join(outsideSkill, 'SKILL.md'), 'utf-8')).toBe('# Outside\n');
  });

  it('anchors project .pi skill boundaries before nested marker segments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-pi-nested-marker-'));
    tempRoots.push(root);
    const projectRoot = path.join(root, 'project');
    const outsideRoot = path.join(root, 'outside');
    const nestedSkill = path.join(outsideRoot, '.pi', 'skills', 'escape');
    const exposedRoot = path.join(projectRoot, '.pi', 'skills', 'alias');
    fs.mkdirSync(nestedSkill, { recursive: true });
    fs.mkdirSync(path.dirname(exposedRoot), { recursive: true });
    fs.writeFileSync(path.join(nestedSkill, 'SKILL.md'), '# Outside\n', 'utf-8');
    fs.symlinkSync(outsideRoot, exposedRoot, process.platform === 'win32' ? 'junction' : 'dir');

    const exposedSkill = path.join(exposedRoot, '.pi', 'skills', 'escape');
    const exposedSkillMd = path.join(exposedSkill, 'SKILL.md');
    await expect(readSkillContent({ mdPath: exposedSkillMd })).resolves.toMatchObject({ success: false });
    await expect(listSkillFolderChildren({ dirPath: exposedSkill })).resolves.toMatchObject({ success: false });
    await expect(writeSkillFile({
      filePath: exposedSkillMd,
      content: '# Changed\n',
    })).resolves.toMatchObject({ success: false });
    expect(fs.readFileSync(path.join(nestedSkill, 'SKILL.md'), 'utf-8')).toBe('# Outside\n');
  });

  it('follows a supported skill path symlink across detail, files panel, and editor access', async () => {
    const { actualSkillMd, exposedDir, exposedPricingJson, exposedSkillMd } = createSymlinkedSkill();

    const grantedRoot = resolveExistingSkillPathForGrant(exposedDir);
    expect(grantedRoot).toBe(fs.realpathSync.native(exposedDir));
    expect(isExistingSkillPathGranted(exposedSkillMd, new Set([grantedRoot!]))).toBe(true);
    expect(isExistingSkillPathGranted(actualSkillMd, new Set([grantedRoot!]))).toBe(false);

    await expect(readSkillContent({ mdPath: exposedSkillMd })).resolves.toMatchObject({
      success: true,
      content: '\n# Lark Drive\n\nOriginal content\n',
    });
    fs.mkdirSync(path.join(exposedDir, '.config', 'gcloud'), { recursive: true });
    const excludedMarkdown = path.join(exposedDir, '.config', 'gcloud', 'README.md');
    fs.writeFileSync(excludedMarkdown, '# Credentials note\n', 'utf-8');
    await expect(readSkillContent({ mdPath: excludedMarkdown })).resolves.toMatchObject({
      success: false,
      error: 'path is excluded from SkillHub packages',
    });
    await expect(listSkillFolderChildren({ dirPath: exposedDir })).resolves.toMatchObject({
      success: true,
      entries: expect.arrayContaining([
        { name: 'references', kind: 'dir' },
        { name: 'pricing.json', kind: 'file' },
      ]),
    });
    await expect(readSkillSiblingFile({ filePath: exposedPricingJson })).resolves.toMatchObject({
      success: true,
      content: '{"tier":"internal"}\n',
    });
    fs.writeFileSync(path.join(exposedDir, '.env'), 'TOKEN=secret\n', 'utf-8');
    await expect(readSkillSiblingFile({ filePath: path.join(exposedDir, '.env') })).resolves.toMatchObject({
      success: false,
      error: 'path is excluded from SkillHub packages',
    });
    await expect(readSkillRawFile({ filePath: path.join(exposedDir, '.env') })).resolves.toMatchObject({
      success: false,
      error: 'path is excluded from SkillHub packages',
    });
    await expect(writeSkillFile({ filePath: path.join(exposedDir, '.env'), content: 'TOKEN=changed\n' })).resolves.toEqual({
      success: false,
      error: 'path is excluded from SkillHub packages',
    });
    await expect(readSkillRawFile({ filePath: exposedSkillMd })).resolves.toMatchObject({
      success: true,
      content: expect.stringContaining('Original content'),
    });

    await expect(writeSkillFile({ filePath: exposedSkillMd, content: '# Updated\n' })).resolves.toEqual({
      success: true,
    });

    expect(fs.readFileSync(actualSkillMd, 'utf-8')).toBe('# Updated\n');
  });

  it('shows declared dotfile fixtures in the files panel and hides unsafe package paths', async () => {
    const { exposedDir } = createSymlinkedSkill();
    fs.writeFileSync(path.join(exposedDir, '.cca-bindings.json'), '{"task":"demo"}\n', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, '.cca-state', 'task'), { recursive: true });
    fs.writeFileSync(path.join(exposedDir, '.cca-state', 'task', 'current-goal.md'), 'goal\n', 'utf-8');
    fs.writeFileSync(path.join(exposedDir, '.env'), 'TOKEN=secret\n', 'utf-8');
    fs.writeFileSync(path.join(exposedDir, '.envrc'), 'export TOKEN=secret\n', 'utf-8');
    fs.writeFileSync(path.join(exposedDir, '.npmrc'), '//registry/:_authToken=secret\n', 'utf-8');
    fs.writeFileSync(path.join(exposedDir, '.netrc'), 'machine example.com password secret\n', 'utf-8');
    fs.writeFileSync(path.join(exposedDir, '.pypirc'), '[pypi]\npassword=secret\n', 'utf-8');
    fs.writeFileSync(path.join(exposedDir, '.DS_Store'), 'metadata', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(exposedDir, '.ssh', 'id_rsa'), 'private key\n', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(exposedDir, '.aws', 'credentials'), 'aws_secret_access_key=secret\n', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, '.docker'), { recursive: true });
    fs.writeFileSync(path.join(exposedDir, '.docker', 'config.json'), '{"auths":{"example.com":{}}}\n', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, '.gem'), { recursive: true });
    fs.writeFileSync(path.join(exposedDir, '.gem', 'credentials'), ':rubygems_api_key: secret\n', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, '.config', 'gcloud'), { recursive: true });
    fs.writeFileSync(
      path.join(exposedDir, '.config', 'gcloud', 'application_default_credentials.json'),
      '{"client_secret":"secret"}\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(exposedDir, '.kube'), { recursive: true });
    fs.writeFileSync(path.join(exposedDir, '.kube', 'config'), 'token: secret\n', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(exposedDir, '.config', 'gh', 'hosts.yml'), 'oauth_token: secret\n', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, '.azure'), { recursive: true });
    fs.writeFileSync(path.join(exposedDir, '.azure', 'accessTokens.json'), '[]\n', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, '.config', 'tool'), { recursive: true });
    fs.writeFileSync(path.join(exposedDir, '.config', 'tool', 'settings.json'), '{"fixture":true}\n', 'utf-8');
    fs.mkdirSync(path.join(exposedDir, 'node_modules', 'pkg'), { recursive: true });

    const result = await listSkillFolderChildren({ dirPath: exposedDir });
    expect(result).toMatchObject({ success: true });
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { name: '.cca-state', kind: 'dir' },
        { name: '.cca-bindings.json', kind: 'file' },
      ]),
    );
    expect(result.entries?.map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining([
        '.env',
        '.envrc',
        '.npmrc',
        '.netrc',
        '.pypirc',
        '.DS_Store',
        '.ssh',
        '.aws',
        'node_modules',
      ]),
    );

    await expect(listSkillFolderChildren({ dirPath: path.join(exposedDir, '.config', 'gcloud') })).resolves.toMatchObject({
      success: true,
      entries: [],
    });
    await expect(listSkillFolderChildren({ dirPath: path.join(exposedDir, '.docker') })).resolves.toMatchObject({
      success: true,
      entries: [],
    });
    await expect(listSkillFolderChildren({ dirPath: path.join(exposedDir, '.gem') })).resolves.toMatchObject({
      success: true,
      entries: [],
    });
    await expect(listSkillFolderChildren({ dirPath: path.join(exposedDir, '.kube') })).resolves.toMatchObject({
      success: true,
      entries: [],
    });
    await expect(listSkillFolderChildren({ dirPath: path.join(exposedDir, '.config', 'gh') })).resolves.toMatchObject({
      success: true,
      entries: [],
    });
    await expect(listSkillFolderChildren({ dirPath: path.join(exposedDir, '.azure') })).resolves.toMatchObject({
      success: true,
      entries: [],
    });
    await expect(listSkillFolderChildren({ dirPath: path.join(exposedDir, '.config') })).resolves.toMatchObject({
      success: true,
      entries: [{ name: 'tool', kind: 'dir' }],
    });
    await expect(listSkillFolderChildren({ dirPath: path.join(exposedDir, '.config', 'tool') })).resolves.toMatchObject({
      success: true,
      entries: [{ name: 'settings.json', kind: 'file' }],
    });
    await expect(readSkillSiblingFile({
      filePath: path.join(exposedDir, '.config', 'gcloud', 'application_default_credentials.json'),
    })).resolves.toMatchObject({
      success: false,
      error: 'path is excluded from SkillHub packages',
    });
  });

  it('uses package-relative filtering for Claude command directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-command-'));
    tempRoots.push(root);
    const commandDir = path.join(root, '.claude', 'commands', 'deploy');
    fs.mkdirSync(path.join(commandDir, '.config', 'gcloud'), { recursive: true });
    fs.writeFileSync(
      path.join(commandDir, '.config', 'gcloud', 'application_default_credentials.json'),
      '{"client_secret":"secret"}\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(commandDir, '.config', 'tool'), { recursive: true });
    fs.writeFileSync(path.join(commandDir, '.config', 'tool', 'settings.json'), '{"fixture":true}\n', 'utf-8');

    await expect(listSkillFolderChildren({ dirPath: path.join(commandDir, '.config', 'gcloud') })).resolves.toMatchObject({
      success: true,
      entries: [],
    });
    await expect(listSkillFolderChildren({ dirPath: path.join(commandDir, '.config', 'tool') })).resolves.toMatchObject({
      success: true,
      entries: [{ name: 'settings.json', kind: 'file' }],
    });
  });
});
