import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSkills, loadIndex, readSkill } from './library.js';
import { runCli } from './cli.js';

// Production entry: CLI -> discovery -> persisted index -> search -> original read.
// Contract: the single discovery Skill selects methods without importing the catalog.
// New coverage: package has no existing library/CLI fixture. Minimal input is two
// Skills in one registered root, one with nested resources. Unit tier; one temp root.
describe('local Skill library workflow', () => {
  let root: string;
  let source: string;
  let library: string;
  let executable: string;
  const motion = '---\nname: motion-feel\ndescription: Tune drag inertia and spring motion.\nmetadata:\n  aliases: [回弹手感]\n  tags: [拖拽, 回弹]\n---\n# Motion\nRead [details](references/details.md).\n' + 'Keep momentum. '.repeat(900);

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-index-'));
    source = path.join(root, '原始技能 库');
    library = path.join(root, 'local-index');
    executable = path.join(root, 'cli.cjs');
    await fs.mkdir(path.join(source, 'motion', 'references'), { recursive: true });
    await fs.writeFile(path.join(source, 'motion', 'SKILL.md'), motion);
    await fs.writeFile(path.join(source, 'motion', 'references', 'details.md'), 'Use a spring.');
    await fs.mkdir(path.join(source, 'audio'));
    await fs.writeFile(path.join(source, 'audio', 'SKILL.md'), '---\nname: audio-edit\ndescription: Edit a podcast audio track.\n---\n# Audio\n');
  });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('initializes, ranks a task, reads original resources, and resumes the full body', async () => {
    const initialized = await runCli(['init', '--library', library, '--source', source], executable);
    expect(initialized).toMatchObject({ skills: 2, added: 2 });
    const search = await runCli(['search', '--library', library, '--query', '拖拽列表的回弹手感'], executable) as { matches: Array<{ id: string; name: string; content?: string }> };
    expect(search.matches[0].name).toBe('motion-feel');
    expect(search.matches[0]).not.toHaveProperty('content');
    const index = await loadIndex(library);
    let page = await readSkill(index, search.matches[0].id, { chars: 1000 });
    expect(page.resourceRoot).toBe(path.join(source, 'motion'));
    expect(await fs.readFile(path.join(page.resourceRoot, 'references', 'details.md'), 'utf8')).toBe('Use a spring.');
    let content = page.content;
    while (!page.eof) {
      page = await readSkill(index, page.id, { offset: page.nextOffset, chars: 1000, expectedSha256: page.sha256 });
      content += page.content;
    }
    expect(content).toBe(motion);
    const persisted = await fs.readFile(path.join(library, 'index.json'), 'utf8');
    expect(persisted).not.toContain('Keep momentum');
    expect(persisted).not.toContain('Use a spring');
  });

  it('installs a gateway whose content stays independent of catalog size', async () => {
    const gateway = path.join(root, 'native-skills', 'cindy-skill-library');
    await runCli(['gateway', '--library', library, '--output', gateway], executable);
    const first = await fs.readFile(path.join(gateway, 'SKILL.md'), 'utf8');
    expect(first).toContain('At the start of a task');
    expect(first).toContain(JSON.stringify(library));
    expect(first).not.toContain('motion-feel');
    expect(first).not.toContain('podcast');
    const more = path.join(root, 'more');
    for (let n = 0; n < 24; n++) {
      const dir = path.join(more, `skill-${n}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: extra-${n}\ndescription: Unique catalog item ${n}.\n---\n`);
    }
    await runCli(['add', '--library', library, '--source', more], executable);
    const secondGateway = path.join(root, 'another-native-root', 'cindy-skill-library');
    await runCli(['gateway', '--library', library, '--output', secondGateway], executable);
    expect(await fs.readFile(path.join(secondGateway, 'SKILL.md'), 'utf8')).toBe(first);
    expect((await loadIndex(library)).snapshot().entries).toHaveLength(26);
  });

  it('deduplicates physical sources and stops at a Skill resource boundary', async () => {
    const nested = path.join(source, 'motion', 'references', 'example');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'SKILL.md'), '---\nname: example-only\ndescription: Documentation example.\n---\n');
    const entries = await discoverSkills([{ name: 'first', path: source }, { name: 'alias', path: source }]);
    expect(entries.map(entry => entry.name).sort()).toEqual(['audio-edit', 'motion-feel']);
    expect(entries.every(entry => entry.source === 'first')).toBe(true);
  });

  it('updates one changed Skill and preserves its original stable identity', async () => {
    const before = (await loadIndex(library)).snapshot().entries.find(item => item.entry.name === 'audio-edit')!;
    await fs.writeFile(before.entry.filePath, '---\nname: audio-edit\ndescription: Mix voice and background music.\n---\n# New instructions\n');
    expect(await runCli(['sync', '--library', library], executable)).toMatchObject({ changed: 1, added: 0, removed: 0 });
    const index = await loadIndex(library);
    expect(index.resolve(before.entry.id)?.description).toContain('background music');
    expect((await index.search('background music')).matches[0].id).toBe(before.entry.id);
    expect((await readSkill(index, before.entry.id)).content).toContain('# New instructions');
  });

  it('requires the same original version when continuing a read', async () => {
    const index = await loadIndex(library);
    const entry = index.snapshot().entries.find(item => item.entry.name === 'motion-feel')!.entry;
    const first = await readSkill(index, entry.id, { chars: 50 });
    await expect(readSkill(index, entry.id, { offset: 50 })).rejects.toThrow('--sha256');
    await fs.appendFile(entry.filePath, '\nA new paragraph.\n');
    await expect(readSkill(index, entry.id, { offset: 50, expectedSha256: first.sha256 })).rejects.toThrow('Skill changed');
    expect((await readSkill(index, entry.id)).sha256).not.toBe(first.sha256);
  });

  it('returns CLI help without creating a library and preserves existing configuration', async () => {
    expect(await runCli(['--help'], executable)).toContain('search');
    await expect(runCli(['init', '--library', library, '--source', source], executable)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await loadIndex(library)).snapshot().entries).toHaveLength(26);
    await expect(runCli(['search', '--library', library], executable)).rejects.toThrow('--query');
  });
});
