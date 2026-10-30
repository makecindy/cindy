import { promises as fs, type WatchListener, type WatchOptions } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildBotSkillQueryIndex, queryBotSkillIndex, searchBotSkillQueryIndex } from '../botSkillQueryIndex';
import { botSkillRootDir, botSkillsDir, listBotSkills, saveBotSkill, deleteBotSkill } from '../botSkillStore';
import { listBotSkillsForSession } from '../botSkillService';

const observation = vi.hoisted(() => ({ native: true, changes: new Map<string, (filename: string) => void>() }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: (file: string, options: Pick<WatchOptions, 'recursive' | 'persistent'>, listener: WatchListener<string>) => {
    if (observation.native) return actual.watch(file, options, listener);
    observation.changes.set(file, filename => listener('change', filename));
    return { close() { observation.changes.delete(file); }, on() { return this; } };
  } };
});

// Windows inherits the existing 60s I/O budget from vitest.config.ts.
// Other platforms retain the large-fixture 30s allowance.
const largeFixtureTimeout = process.platform === 'win32' ? undefined : 30_000;

let home: string;
const bot = 'bot';
const root = () => botSkillRootDir(home, bot);
const deps = () => ({ userDataDir: home, resolveBotId: async () => ({ ok: true as const, botId: bot }) });
const query = (params = {}) => queryBotSkillIndex(root(), home, bot, params);
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-query-')); });
afterEach(async () => { observation.native = true; observation.changes.clear(); vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });
async function write(slug: string, name: string, description = 'Searchable', disabled = false, body = 'Steps') {
  const dir = path.join(root(), disabled ? 'disabled-skills' : 'skills', slug);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  return file;
}

it('finds block-scalar description keywords in enabled and disabled Skills, including beyond the runtime preview', async () => {
  const folded = await write('folded', 'Folded', `>-\n  ${'prefix '.repeat(2000)}\n  reconciliation needle-folded`);
  const literal = await write('literal', 'Literal', '|\n  invoice processing\n  needle-literal', true);
  const originals = await Promise.all([folded, literal].map(file => fs.readFile(file, 'utf8')));
  expect(await listBotSkillsForSession({ callerSessionId: 's', query: 'reconciliation needle-folded' }, deps()))
    .toMatchObject({ ok: true, total: 1, skills: [{ slug: 'folded' }] });
  expect(await query({ query: 'invoice needle-literal' }))
    .toMatchObject({ total: 1, skills: [{ slug: 'literal', enabled: false }] });
  expect(await Promise.all([folded, literal].map(file => fs.readFile(file, 'utf8')))).toEqual(originals);
});

it('reuses its index for different terms/pages without enumerating or opening source Skills', async () => {
  // No mutation is signalled in this case. Native notification delivery (which
  // may include delayed setup writes) is exercised separately below.
  observation.native = false;
  await write('alpha', 'Alpha', 'red blue', false, 'Large body\n'.repeat(100_000));
  await write('beta', 'Beta', 'blue', true);
  expect(await listBotSkillsForSession({ callerSessionId: 's', limit: 1 }, deps()))
    .toMatchObject({ ok: true, total: 2, nextOffset: 1, skills: [{ slug: 'alpha' }] });
  const before = await fs.stat(path.join(root(), '.runtime-skills/query-catalog.jsonl'));
  const originalOpen = fs.open.bind(fs);
  const opens = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (/[/\\](?:disabled-)?skills[/\\]/.test(String(args[0]))) throw new Error('source reopened');
    return originalOpen(...args);
  });
  const opendir = vi.spyOn(fs, 'opendir').mockRejectedValue(new Error('source enumerated'));
  const readdir = vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('shelf materialized'));
  const readFile = vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('full file read'));
  expect(await listBotSkillsForSession({ callerSessionId: 's', query: 'BLUE', offset: 1 }, deps()))
    .toMatchObject({ ok: true, total: 2, skills: [{ slug: 'beta', enabled: false }] });
  expect(await query({ query: 'red blue' })).toMatchObject({ total: 1, skills: [{ slug: 'alpha' }] });
  expect(await query({ query: 'missing' })).toEqual({ total: 0, skills: [] });
  expect(opendir).not.toHaveBeenCalled(); expect(readdir).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled();
  expect(opens.mock.calls.every(([, mode]) => mode === 'r')).toBe(true);
  expect((await fs.stat(path.join(root(), '.runtime-skills/query-catalog.jsonl'))).mtimeMs).toBe(before.mtimeMs);
});

it('preserves full metadata matching, locale ordering, ties, disabled duplicates and byte-bounded pages', async () => {
  const values = [['z', 'Same'], ['a', 'Same'], ['中', '中文'], ['accent', 'Éclair'], ['alpha', 'Alpha']];
  for (const [slug, name] of values) await write(slug, name, '界'.repeat(300));
  await write('a', 'Same', 'Disabled duplicate', true);
  await write('huge', 'Z'.repeat(600_000) + 'tail-name', 'D'.repeat(600_000) + 'tail-description');
  const expected = await listBotSkills(home, bot);
  const all = [];
  let offset = 0;
  do {
    const page = await query({ offset, limit: 2 });
    all.push(...page.skills.map(item => [item.slug, item.enabled]));
    offset = page.nextOffset ?? 0;
  } while (offset);
  expect(all).toEqual(expected.map(item => [item.slug, item.enabled]));
  expect(await query({ query: 'tail-name tail-description' })).toMatchObject({ total: 1, skills: [{ slug: 'huge' }] });
  const result = await query({ query: 'tail-description' });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16 * 1024);
});

it('refreshes saved/deleted/disabled/external metadata and missing catalogs without mixing owners', async () => {
  // Exercise the actual watcher callback deterministically. Native notification
  // timing is covered by the runtime projection's hand-edit test; it can miss
  // changes made immediately after watch() during this multi-step query test.
  observation.native = false;
  await write('alpha', 'Alpha', 'Original');
  await write('off', 'Off', 'Disabled', true);
  expect((await query()).total).toBe(2);
  await saveBotSkill(home, bot, { name: 'alpha', description: 'Saved update', body: 'Steps' });
  expect(await query({ query: 'saved' })).toMatchObject({ total: 1 });
  await deleteBotSkill(home, bot, 'alpha');
  expect((await query()).skills.map(item => item.slug)).toEqual(['off']);
  await write('off', 'Off', 'Hand edited disabled', true);
  expect(await query({ query: 'edited' })).toMatchObject({ total: 0 });
  const changed = observation.changes.get(path.join(root(), 'disabled-skills'));
  expect(changed).toBeTypeOf('function');
  changed!(path.join('off', 'SKILL.md'));
  expect(await query({ query: 'edited' })).toMatchObject({ total: 1 });
  await fs.mkdir(botSkillsDir(home, bot), { recursive: true });
  await fs.rename(path.join(root(), 'disabled-skills/off'), path.join(root(), 'skills/off'));
  expect((await query()).skills[0].enabled).toBeUndefined();
  const catalog = path.join(root(), '.runtime-skills/query-catalog.jsonl');
  await fs.unlink(catalog);
  expect((await query()).total).toBe(1);
  const other = path.join(home, 'other-owner');
  expect(await queryBotSkillIndex(botSkillRootDir(other, bot), other, bot, {})).toEqual({ total: 0, skills: [] });
  expect((await query()).total).toBe(1);
});

it('checks the owner boundary again after streaming a query', async () => {
  await write('alpha', 'Alpha');
  let owner = 'before';
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('query-catalog.jsonl') && args[1] === 'r') owner = 'after';
    return originalOpen(...args);
  });
  expect(await listBotSkillsForSession({ callerSessionId: 's' }, { ...deps(), ownerScopeKey: () => owner }))
    .toMatchObject({ ok: false, errorCode: 'OWNER_SCOPE_CHANGED' });
});

it('externally sorts 100,000 entries before enumeration completes and keeps the last page reachable', async () => {
  const directory = path.join(root(), '.runtime-skills');
  async function* source() {
    for (let index = 99_999; index >= 0; index--) {
      if (index === 95_000) {
        const staging = (await fs.readdir(directory)).find(name => name.startsWith('query-'))!;
        const runs = await fs.readdir(path.join(directory, staging));
        expect(runs.length).toBeGreaterThan(1);
        expect((await fs.stat(path.join(directory, staging, runs[0]))).size).toBeGreaterThan(0);
      }
      const slug = `s-${String(index).padStart(6, '0')}`;
      yield { slug, name: slug, description: 'Fixture', updatedAt: '', dirPath: `/fixture/${slug}`,
        filePath: `/fixture/${slug}/SKILL.md`, frontmatterBytes: 60, bodyStartLine: 5 };
    }
  }
  const catalog = await buildBotSkillQueryIndex(root(), source());
  const text = await fs.readFile(catalog, 'utf8');
  const rows = text.trim().split('\n');
  expect(rows).toHaveLength(100_000);
  expect(JSON.parse(rows[0]).slug).toBe('s-000000');
  expect(JSON.parse(rows.at(-1)!).slug).toBe('s-099999');
  expect(await searchBotSkillQueryIndex(catalog, { query: 'Fixture', offset: 99_999, limit: 20 }))
    .toMatchObject({ total: 100_000, skills: [{ slug: 's-099999' }] });
  expect(await searchBotSkillQueryIndex(catalog, { query: 's-099999' }))
    .toMatchObject({ total: 1, skills: [{ slug: 's-099999' }] });
  async function* failed() {
    yield { slug: 'partial', name: 'Partial', description: 'x'.repeat(300_000), updatedAt: '',
      dirPath: '/fixture/partial', filePath: '/fixture/partial/SKILL.md', frontmatterBytes: 60, bodyStartLine: 5 };
    throw new Error('fixture enumeration failure');
  }
  await expect(buildBotSkillQueryIndex(root(), failed())).rejects.toThrow('fixture enumeration failure');
  expect(await fs.readFile(catalog, 'utf8')).toBe(text);
  expect(await fs.readdir(directory)).toEqual(['query-catalog.jsonl']);
}, largeFixtureTimeout);

it('keeps disabled Skill metadata discoverable without publishing read paths, then restores them on enable', async () => {
  const file = await write('off', 'Off', 'Searchable disabled', true, 'Private disabled instructions');
  const before = await fs.readFile(file, 'utf8');
  const first = await listBotSkillsForSession({ callerSessionId: 's', query: 'disabled' }, deps());
  expect(first).toMatchObject({ ok: true, skills: [{ slug: 'off', name: 'Off', description: 'Searchable disabled', enabled: false }] });
  if (!first.ok) throw Error('Expected result');
  expect(first.skills[0]).not.toHaveProperty('filePath');
  expect(first.skills[0]).not.toHaveProperty('bodyStartLine');
  expect(first.skills[0]).not.toHaveProperty('dirPath');
  // A cached query and the full settings read keep the same disabled state.
  expect((await query({ query: 'disabled' })).skills[0]).not.toHaveProperty('filePath');
  expect((await listBotSkills(home, bot))[0]).toMatchObject({ enabled: false, filePath: file });
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  await fs.mkdir(botSkillsDir(home, bot), { recursive: true });
  await fs.rename(path.dirname(file), path.join(root(), 'skills/off'));
  await vi.waitFor(async () => expect((await query({ query: 'disabled' })).skills[0])
    .toMatchObject({ filePath: path.join(root(), 'skills/off/SKILL.md'), bodyStartLine: 5 }));
});
