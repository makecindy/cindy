import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { inspectPiProjectWorkspaceResources, piProjectResourcesEvidence, piProjectSkillDenials, resolvePiProjectTrust, resolveTurns, validateTurnInput } from './headless-integrations.js';

const execFileAsync = promisify(execFile);

describe('headless capability inputs', () => {
  it('keeps string turns compatible and accepts structured attachments', () => {
    expect(validateTurnInput('hello')).toBe('hello');
    expect(validateTurnInput({ text: 'inspect', attachments: [{ type: 'file', path: 'fixture.txt' }] })).toMatchObject({ text: 'inspect' });
  });

  it('resolves workspace attachments and rejects traversal', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'headless-input-'));
    await writeFile(path.join(workspace, 'fixture.txt'), 'fixture');
    const turns = await resolveTurns([{ text: 'inspect', attachments: [{ type: 'file', path: 'fixture.txt' }] }], workspace, { attachments: true, workspaceOnly: true });
    expect(turns[0]).toMatchObject({ type: 'user', content: [{ type: 'text' }, { type: 'file', path: await realpath(path.join(workspace, 'fixture.txt')) }] });
    expect(() => validateTurnInput({ text: 'bad', attachments: [{ type: 'file', path: '../outside' }] })).toThrow(/workspace-relative/);
  });

  it('fails closed when attachments are disabled', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'headless-input-off-'));
    await mkdir(path.join(workspace, 'files'));
    await writeFile(path.join(workspace, 'files', 'fixture.txt'), 'fixture');
    await expect(resolveTurns([{ text: 'inspect', attachments: [{ type: 'file', path: 'files/fixture.txt' }] }], workspace, undefined)).rejects.toThrow(/does not enable attachments/);
  });

  it('builds a scoped Pi approval snapshot for current and ancestor project skills', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'headless-pi-skills-'));
    const workspace = path.join(repo, 'packages', 'app');
    await mkdir(path.join(workspace, '.pi', 'skills', 'local'), { recursive: true });
    await mkdir(path.join(repo, '.agents', 'skills', 'shared'), { recursive: true });
    await writeFile(path.join(workspace, '.pi', 'skills', 'local', 'SKILL.md'), '# Local');
    await writeFile(path.join(repo, '.agents', 'skills', 'shared', 'SKILL.md'), '# Shared');
    await execFileAsync('git', ['init', repo]);
    const snapshot = await resolvePiProjectTrust(workspace, { enabled: true, roots: ['.pi/skills', '.agents/skills'] });
    expect(snapshot?.approval).toMatchObject({ status: 'approved', scope: 'working-dir' });
    expect(snapshot?.discovered.skills).toHaveLength(2);
    expect(snapshot?.discovered.packages).toEqual([]);
    expect(snapshot?.discovered.extensions).toEqual([]);
  });
});

describe('pi project workspace resources', () => {
  it('mirrors upstream in-place collection and denies unapproved Skills', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'headless-pi-resources-'));
    const workspace = path.join(repo, 'packages', 'app');
    await mkdir(path.join(workspace, '.pi', 'skills', 'local'), { recursive: true });
    await mkdir(path.join(workspace, '.pi', 'skills', '.hidden'), { recursive: true });
    await mkdir(path.join(workspace, '.pi', 'skills', 'nomarker'), { recursive: true });
    await mkdir(path.join(repo, '.agents', 'skills', 'shared'), { recursive: true });
    await writeFile(path.join(workspace, '.pi', 'skills', 'local', 'SKILL.md'), '# Local');
    await writeFile(path.join(workspace, '.pi', 'skills', '.hidden', 'SKILL.md'), '# Hidden');
    await writeFile(path.join(workspace, '.pi', 'skills', 'nomarker', 'readme.md'), '# None');
    await writeFile(path.join(repo, '.agents', 'skills', 'shared', 'skill.md'), '# Shared');
    await mkdir(path.join(workspace, '.pi', 'prompts'), { recursive: true });
    await writeFile(path.join(workspace, '.pi', 'prompts', 'review.md'), '# Review');
    await writeFile(path.join(workspace, '.pi', 'prompts', 'notes.txt'), 'ignored');
    await writeFile(path.join(workspace, '.pi', 'prompts', 'SHOUT.MD'), 'ignored by upstream suffix rule');
    await mkdir(path.join(workspace, '.pi', 'extensions', 'pack'), { recursive: true });
    await writeFile(path.join(workspace, '.pi', 'extensions', 'single.ts'), 'export {};');
    await writeFile(path.join(workspace, '.pi', 'extensions', 'pack', 'index.ts'), 'export {};');
    await writeFile(path.join(workspace, '.pi', 'extensions', 'pack', 'helper.ts'), 'export {};');
    await execFileAsync('git', ['init', repo]);
    const resources = await inspectPiProjectWorkspaceResources(workspace);
    const relative = (target: string) => path.relative(resources.canonicalRepoRoot, target).replaceAll('\\', '/');
    expect(resources.canonicalRepoRoot).toBe(await realpath(repo));
    expect(resources.skills.map(relative).sort()).toEqual(['.agents/skills/shared', 'packages/app/.pi/skills/local']);
    expect(resources.promptTemplates.map(relative)).toEqual(['packages/app/.pi/prompts/review.md']);
    expect(resources.extensions.map(relative).sort()).toEqual(['packages/app/.pi/extensions/pack/index.ts', 'packages/app/.pi/extensions/single.ts']);

    const approved = await resolvePiProjectTrust(workspace, { enabled: true, roots: ['.agents/skills'] });
    const denials = piProjectSkillDenials(resources, approved?.discovered.skills ?? []);
    expect(denials.map(relative)).toEqual(['packages/app/.pi/skills/local']);
    expect(piProjectSkillDenials(resources, []).map(relative).sort()).toEqual(['.agents/skills/shared', 'packages/app/.pi/skills/local']);
    expect(piProjectResourcesEvidence(resources, denials)).toMatchObject({
      inPlace: true,
      approvedSkillRootsEnforced: true,
      presentSkills: expect.arrayContaining(['packages/app/.pi/skills/local']),
      deniedSkills: ['packages/app/.pi/skills/local'],
      extensions: expect.arrayContaining(['packages/app/.pi/extensions/single.ts']),
    });
  });

  it('reports an empty workspace without failing closed on a missing Git root', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'headless-pi-plain-'));
    const resources = await inspectPiProjectWorkspaceResources(workspace);
    expect(resources.canonicalRepoRoot).toBe(resources.canonicalWorkingDir);
    expect(resources.skills).toEqual([]);
    expect(resources.promptTemplates).toEqual([]);
    expect(resources.extensions).toEqual([]);
    expect(piProjectResourcesEvidence(null, [])).toBeNull();
  });
});
