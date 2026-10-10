import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectBotOwnSkillMounts, listBotSkillsForSession } from '../botSkillService';
import { BOT_SKILL_RUNTIME_INDEX_BYTES, projectBotSkillMounts } from '../botSkillRuntimeProjection';
import { botSkillRootDir, parseBotSkillFile, saveBotSkill, seedBotSkillIfMissing, importBotSkillFiles, deleteBotSkill } from '../botSkillStore';
import { buildBotSkillIndex } from '../botSystemPrompt';
import { applyPiBotSkillPolicy } from '../../../../../../packages/maker-core/src/agents/pi/bot-skill-policy';
import { buildCodexBotSkillConfigOverrides } from '../../../../../../packages/maker-core/src/agents/codex/capability-routing';
import * as runtimeSource from '../botSkillRuntimeSource';

const observation = vi.hoisted(() => ({ native: true }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => {
    if (observation.native) return actual.watch(...args);
    return { close() {}, on() { return this; } };
  } };
});

// Windows inherits the existing 60s I/O budget from vitest.config.ts.
// Other platforms retain the large-fixture 30s allowance.
const largeFixtureTimeout = process.platform === 'win32' ? undefined : 30_000;

let userDataDir: string;
const botId = 'imported-bot';
beforeEach(async () => { userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-projection-')); });
afterEach(async () => { observation.native = true; vi.restoreAllMocks(); await fs.rm(userDataDir, { recursive: true, force: true }); });
const deps = () => ({ userDataDir, resolveBotId: async () => ({ ok: true as const, botId }) });

async function writeSkill(slug: string, source: string, disabled = false) {
  const directory = path.join(botSkillRootDir(userDataDir, botId), disabled ? 'disabled-skills' : 'skills', slug);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'SKILL.md');
  await fs.writeFile(filePath, source);
  return filePath;
}

async function assertBoundedNativeMounts() {
  const mounts = await collectBotOwnSkillMounts(botId, deps());
  expect(mounts.skills).toHaveLength(1);
  expect(Buffer.byteLength(buildBotSkillIndex(mounts.skills))).toBeLessThan(BOT_SKILL_RUNTIME_INDEX_BYTES);
  const policy = { mode: 'allowlist' as const, configured: [], catalog: [], ownSkills: mounts.skills };
  const pi = applyPiBotSkillPolicy(policy, {
    skillPaths: [], launchSkillPaths: [], launchSkillDigests: [], launchSkillSourceFingerprints: [],
  } as unknown as Parameters<typeof applyPiBotSkillPolicy>[1]);
  expect(pi.explicitSkillPaths).toEqual([mounts.skills[0].path]);
  expect(Buffer.byteLength(JSON.stringify(pi.explicitSkillPaths))).toBeLessThan(4096);
  expect(buildCodexBotSkillConfigOverrides(policy)['skills.config']).toEqual([
    { path: mounts.skills[0].filePath, enabled: true },
  ]);
  // Claude Code sees only the discovery Skill, never the original large shelf.
  expect(await fs.readdir(path.join(mounts.pluginRoot, 'skills'))).toEqual(['personal-skill-library']);
  expect(JSON.parse(await fs.readFile(path.join(mounts.pluginRoot, '.claude-plugin/plugin.json'), 'utf8')).name)
    .toBe('personal-skill-library');
  const mountedSource = await fs.readFile(mounts.skills[0].filePath, 'utf8');
  const metadata = parseBotSkillFile(mountedSource);
  expect(metadata.name.length).toBeLessThanOrEqual(64);
  expect(metadata.description.length).toBeLessThanOrEqual(280);
  expect(Buffer.byteLength(mountedSource)).toBeLessThan(4096);
  return mounts;
}

describe('complete personal Skills with bounded startup projection', () => {
  it.each(['.claude-plugin/plugin.json', '.claude-plugin'])('rebuilds a missing Claude artifact %s on the next hydration', async missing => {
    const source = `---\nname: oversized\ndescription: ${'Long description '.repeat(30)}\n---\nOriginal instructions\n`;
    const original = await writeSkill('oversized', source);
    const mounts = await assertBoundedNativeMounts();
    const manifestPath = path.join(mounts.pluginRoot, '.claude-plugin', 'plugin.json');
    const manifest = await fs.readFile(manifestPath, 'utf8');
    const catalog = await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8');
    const discovery = await fs.readFile(mounts.skills[0].filePath, 'utf8');
    // Only a generated Claude file/directory disappears; source metadata, the
    // catalog and the Pi/Codex discovery Skill remain unchanged.
    await fs.rm(path.join(mounts.pluginRoot, missing), { recursive: true });
    expect(await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8')).toBe(catalog);
    expect(await fs.readFile(mounts.skills[0].filePath, 'utf8')).toBe(discovery);
    expect(await collectBotOwnSkillMounts(botId, deps())).toEqual(mounts);
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(manifest);
    expect(await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8')).toBe(catalog);
    expect(await fs.readFile(mounts.skills[0].filePath, 'utf8')).toBe(discovery);
    expect(await fs.readFile(original, 'utf8')).toBe(source);
    const opens = vi.spyOn(fs, 'open');
    await assertBoundedNativeMounts();
    expect(opens).not.toHaveBeenCalled();
  });

  it('preserves a near-16 MiB original header and loads only bounded runtime metadata', async () => {
    const source = `---\r\nname: ${'n'.repeat(7 * 1024 * 1024)}\r\ndescription: ${'d'.repeat(8 * 1024 * 1024)} tail-query\r\n---\r\nRun scripts/report.py\r\n`;
    const original = await writeSkill('oversized', source);
    await fs.mkdir(path.join(path.dirname(original), 'scripts'));
    await fs.writeFile(path.join(path.dirname(original), 'scripts/report.py'), '# original resource');
    const mounts = await assertBoundedNativeMounts();
    const rows = (await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'oversized', filePath: original, bodyStartLine: 5 });
    expect(rows[0].name).toHaveLength(64);
    expect(rows[0].description).toHaveLength(280);
    expect(await fs.readFile(original, 'utf8')).toBe(source);
    expect(source.split('\n').slice(rows[0].bodyStartLine - 1).join('\n')).toContain('Run scripts/report.py');
    expect(await fs.readFile(path.join(path.dirname(rows[0].filePath), 'scripts/report.py'), 'utf8')).toBe('# original resource');
    // Search sees even metadata beyond the runtime preview and returns a short page.
    const page = await listBotSkillsForSession({ callerSessionId: 'session', query: 'tail-query' }, deps());
    expect(page).toMatchObject({ ok: true, total: 1, skills: [{ slug: 'oversized' }] });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(BOT_SKILL_RUNTIME_INDEX_BYTES);
    // Disabling the only Skill also clears its previously mounted catalog.
    const disabled = path.join(botSkillRootDir(userDataDir, botId), 'disabled-skills');
    await fs.mkdir(disabled);
    await fs.rename(path.dirname(original), path.join(disabled, 'oversized'));
    expect((await collectBotOwnSkillMounts(botId, deps())).skills).toEqual([]);
    expect(await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8')).toBe('');
    expect(await fs.readFile(path.join(disabled, 'oversized', 'SKILL.md'), 'utf8')).toBe(source);
  });

  describe('2,048-file shelf', () => {
    const count = 2048;
    // Fixture creation, native hydration and query indexing are separate I/O
    // phases. Each follows the platform budget; none asserts total latency.
    // Each test gets a fresh real shelf, so it can also run independently.
    beforeEach(async () => {
      // This shelf is immutable. Delayed native notifications from fixture
      // creation can invalidate its index during the cold scan on Windows.
      // Native hand-edit notifications remain covered by the mutation test below.
      observation.native = false;
      // Bounded filesystem concurrency; these are real files consumed by the store.
      for (let start = 0; start < count; start += 32) {
        await Promise.all(Array.from({ length: 32 }, (_, offset) => {
          const slug = `skill-${String(start + offset).padStart(5, '0')}`;
          return writeSkill(slug, `---\nname: ${slug}\ndescription: Workflow ${slug}\n---\nInstructions for ${slug}\n`);
        }));
      }
      await writeSkill('disabled', '---\nname: disabled\ndescription: Leave disabled\n---\nDo not run\n', true);
    }, largeFixtureTimeout);

    it('catalogs every enabled Skill and reuses the native projection', async () => {
      const mounts = await assertBoundedNativeMounts();
      const catalog = (await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(catalog).toHaveLength(count);
      expect(new Set(catalog.map(item => item.slug)).size).toBe(count);
      const last = catalog.find(item => item.slug === 'skill-02047');
      expect(last).toBeDefined();
      expect(await fs.readFile(last.filePath, 'utf8')).toContain('Instructions for skill-02047');
      const reads = vi.spyOn(fs, 'readFile');
      const opens = vi.spyOn(fs, 'open');
      const catalogTime = (await fs.stat(path.join(mounts.pluginRoot, 'catalog.jsonl'))).mtimeMs;
      for (let turn = 0; turn < 5; turn++) expect((await collectBotOwnSkillMounts(botId, deps())).skills).toEqual(mounts.skills);
      const sourcePrefix = path.join(botSkillRootDir(userDataDir, botId), 'skills') + path.sep;
      expect(reads.mock.calls.filter(([file]) => String(file).startsWith(sourcePrefix))).toHaveLength(0);
      expect(opens.mock.calls.filter(([file]) => String(file).includes('catalog.jsonl'))).toHaveLength(0);
      expect((await fs.stat(path.join(mounts.pluginRoot, 'catalog.jsonl'))).mtimeMs).toBe(catalogTime);
      reads.mockRestore(); opens.mockRestore();
    // This includes a cold scan/open of all 2,048 real files. Under the full
    // Windows worker pool it can exceed the default 60s I/O allowance; this
    // is a completeness/cache test, not a wall-clock performance assertion.
    }, process.platform === 'win32' ? 120_000 : largeFixtureTimeout);

    it('keeps every Skill discoverable through the final query page', async () => {
      const scans = vi.spyOn(runtimeSource, 'iterateBotSkillQuerySummaries');
      const firstPage = await listBotSkillsForSession({ callerSessionId: 'session', query: 'workflow' }, deps());
      expect(firstPage).toMatchObject({ ok: true, total: count, nextOffset: 20 });
      const lastPage = await listBotSkillsForSession({ callerSessionId: 'session', query: 'workflow', offset: count - 1 }, deps());
      expect(lastPage).toMatchObject({ ok: true, skills: [{ slug: 'skill-02047' }] });
      expect(lastPage).not.toHaveProperty('nextOffset');
      expect(scans).toHaveBeenCalledTimes(1);
    }, largeFixtureTimeout);
  });

  it('refreshes a projected catalog after additions and rebuilds it after deletion', async () => {
    // Enter the same discovery projection by metadata size. Mutation/recovery
    // do not need two more scans of the 2,048-file completeness fixture above.
    const source = `---\nname: oversized\ndescription: ${'Long description '.repeat(30)}\n---\nOriginal instructions\n`;
    const original = await writeSkill('oversized', source);
    const mounts = await assertBoundedNativeMounts();
    const catalogPath = path.join(mounts.pluginRoot, 'catalog.jsonl');
    expect((await fs.readFile(catalogPath, 'utf8')).trim().split('\n')).toHaveLength(1);
    await writeSkill('z-new', '---\nname: z-new\ndescription: Newly learned\n---\nNew steps\n');
    await collectBotOwnSkillMounts(botId, deps());
    const catalog = (await fs.readFile(catalogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(catalog.map(item => item.slug).sort()).toEqual(['oversized', 'z-new']);
    expect(await fs.readFile(catalog.find(item => item.slug === 'z-new').filePath, 'utf8')).toContain('New steps');
    await fs.unlink(catalogPath);
    await collectBotOwnSkillMounts(botId, deps());
    expect((await fs.readFile(catalogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(catalog);
    expect(await fs.readFile(original, 'utf8')).toBe(source);
    expect(await fs.readdir(path.join(mounts.pluginRoot))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  });

  it('writes a 100,000-entry stream before enumeration finishes, with atomic failure recovery', async () => {
    const root = botSkillRootDir(userDataDir, botId);
    const catalogRoot = path.join(root, '.runtime-skills');
    async function* items() {
      for (let index = 0; index < 100_000; index++) {
        if (index === 2000) {
          const staging = (await fs.readdir(catalogRoot)).find(file => file.endsWith('.tmp'))!;
          expect((await fs.stat(path.join(catalogRoot, staging))).size).toBeGreaterThan(0);
          await expect(fs.stat(path.join(catalogRoot, 'catalog.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        yield { slug: `s-${index}`, name: `Skill ${index}`, description: 'Fixture', updatedAt: '',
          dirPath: `/fixture/s-${index}`, filePath: `/fixture/s-${index}/SKILL.md`, frontmatterBytes: 60, bodyStartLine: 5 };
      }
    }
    const mounts = await projectBotSkillMounts(root, items());
    expect(mounts.skills).toHaveLength(1);
    const catalogPath = path.join(catalogRoot, 'catalog.jsonl');
    const original = await fs.readFile(catalogPath, 'utf8');
    expect(original.trim().split('\n')).toHaveLength(100_000);
    expect(original).toContain('"slug":"s-99999"');
    async function* failed() {
      yield { slug: 'partial', name: 'Partial', description: '', updatedAt: '',
        dirPath: '/fixture/partial', filePath: '/fixture/partial/SKILL.md', frontmatterBytes: 60, bodyStartLine: 5 };
      throw new Error('fixture enumeration failure');
    }
    await expect(projectBotSkillMounts(root, failed())).rejects.toThrow('fixture enumeration failure');
    expect(await fs.readFile(catalogPath, 'utf8')).toBe(original);
    expect((await fs.readdir(catalogRoot)).some(file => file.endsWith('.tmp'))).toBe(false);
  }, largeFixtureTimeout);

  it('refreshes after typed mutations, hand edits, disabling and directory replacement without mixing owners', async () => {
    const input = { name: 'report', description: 'Original', body: 'Steps' };
    await seedBotSkillIfMissing(userDataDir, botId, input);
    const collect = () => collectBotOwnSkillMounts(botId, deps());
    expect((await collect()).skills[0].description).toBe('Original');
    await saveBotSkill(userDataDir, botId, { ...input, description: 'Saved update' });
    expect((await collect()).skills[0].description).toBe('Saved update');
    await importBotSkillFiles(userDataDir, botId, 'imported', [{ name: 'SKILL.md',
      bytes: Buffer.from('---\nname: imported\ndescription: Imported\n---\nSteps'), executable: false }], () => {});
    expect((await collect()).skills.map(item => item.name)).toEqual(['imported', 'report']);
    await writeSkill('report', '---\nname: report\ndescription: Hand edited\n---\nSteps');
    await vi.waitFor(async () => expect((await collect()).skills.find(item => item.name === 'report')?.description).toBe('Hand edited'));
    await deleteBotSkill(userDataDir, botId, 'imported');
    expect((await collect()).skills.map(item => item.name)).toEqual(['report']);
    const root = botSkillRootDir(userDataDir, botId);
    await fs.rename(path.join(root, 'skills'), path.join(root, 'disabled-skills'));
    expect((await collect()).skills).toEqual([]);
    await writeSkill('replacement', '---\nname: replacement\ndescription: New directory\n---\nSteps');
    expect((await collect()).skills.map(item => item.name)).toEqual(['replacement']);
    const other = path.join(userDataDir, 'other-owner');
    await seedBotSkillIfMissing(other, botId, { ...input, name: 'private-other-owner' });
    expect((await collectBotOwnSkillMounts(botId, { userDataDir: other })).skills.map(item => item.name)).toEqual(['private-other-owner']);
    expect((await collect()).skills.map(item => item.name)).toEqual(['replacement']);
  });

  it('paginates by response bytes as well as page size without losing the remainder', async () => {
    for (let index = 0; index < 35; index++) {
      const slug = `wide-${String(index).padStart(2, '0')}`;
      await writeSkill(slug, `---\nname: ${slug}\ndescription: ${'说明'.repeat(140)}\n---\nSteps\n`);
    }
    const found: string[] = [];
    let offset = 0;
    do {
      const result = await listBotSkillsForSession({ callerSessionId: 'session', limit: 50, offset }, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(BOT_SKILL_RUNTIME_INDEX_BYTES + 256);
      found.push(...result.skills.map(item => item.slug));
      if (result.nextOffset === undefined) break;
      expect(result.nextOffset).toBeGreaterThan(offset);
      offset = result.nextOffset;
    } while (offset < 35);
    expect(found).toHaveLength(35);
    expect(new Set(found).size).toBe(35);
    expect(offset).toBeGreaterThan(0);
  });
});
