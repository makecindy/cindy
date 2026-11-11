import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cachedBotSkillRuntime, invalidateBotSkillRuntime } from '../botSkillRuntimeCache';
import { projectBotSkillMounts } from '../botSkillRuntimeProjection';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-cache-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const projection = (name: string) => ({ pluginRoot: root,
  skills: [{ name, description: name, path: root, filePath: path.join(root, 'SKILL.md') }] });

it('keeps query artifacts separate from runtime mounts and invalidates both on a Skill write', async () => {
  const catalog = path.join(root, 'query-catalog.jsonl');
  const runtime = vi.fn(async () => projection('runtime'));
  const query = vi.fn(async () => {
    await fs.writeFile(catalog, 'fixture');
    return { pluginRoot: root, skills: [], artifacts: [catalog] };
  });
  for (let turn = 0; turn < 2; turn++) {
    expect((await cachedBotSkillRuntime(root, runtime)).skills[0].name).toBe('runtime');
    expect((await cachedBotSkillRuntime(root, query, 'query')).artifacts).toEqual([catalog]);
  }
  expect(runtime).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
  invalidateBotSkillRuntime(root);
  await cachedBotSkillRuntime(root, runtime);
  await cachedBotSkillRuntime(root, query, 'query');
  expect(runtime).toHaveBeenCalledTimes(2); expect(query).toHaveBeenCalledTimes(2);
});

it('shares concurrent hydration work and reconciles mutations during the read', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let version = 'old';
  const build = vi.fn(async () => {
    const captured = version;
    if (captured === 'old') await held;
    return projection(captured);
  });
  const first = cachedBotSkillRuntime(root, build);
  await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
  const second = cachedBotSkillRuntime(root, build);
  const third = cachedBotSkillRuntime(root, build);
  version = 'new';
  invalidateBotSkillRuntime(root);
  release();
  const results = await Promise.all([first, second, third]);
  expect(results.map(item => item.skills[0].name)).toEqual(['new', 'new', 'new']);
  expect(build).toHaveBeenCalledTimes(2);
  results[0].skills[0].name = 'caller edit';
  expect(results[1].skills[0].name).toBe('new');
  expect((await cachedBotSkillRuntime(root, build)).skills[0].name).toBe('new');
  expect(build).toHaveBeenCalledTimes(2);
});

it('retries failed catalog builds and never caches an unwatchable source', async () => {
  const build = vi.fn().mockRejectedValueOnce(new Error('fixture write failure')).mockResolvedValue(projection('retry'));
  await expect(cachedBotSkillRuntime(root, build)).rejects.toThrow('fixture write failure');
  expect((await cachedBotSkillRuntime(root, build)).skills[0].name).toBe('retry');
  expect(build).toHaveBeenCalledTimes(2);
  const missing = path.join(root, 'missing');
  const uncached = vi.fn(async () => ({ pluginRoot: missing, skills: [] }));
  await cachedBotSkillRuntime(missing, uncached);
  await cachedBotSkillRuntime(missing, uncached);
  expect(uncached).toHaveBeenCalledTimes(2);
});

it.each([false, true])('serializes catalog writers after eviction, including failed predecessors (%s)', async (failOld) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const item = (slug: string) => ({ slug, name: slug, description: 'Fixture', updatedAt: '',
    dirPath: path.join(root, 'skills', slug), filePath: path.join(root, 'skills', slug, 'SKILL.md'),
    frontmatterBytes: 20_000, bodyStartLine: 5 });
  const oldBuild = vi.fn(async () => {
    async function* oldSnapshot() {
      yield item('before');
      events.push('old-reading');
      await held;
      if (failOld) throw new Error('old build failed');
    }
    try { return await projectBotSkillMounts(root, oldSnapshot()); }
    finally { events.push('old-finished'); }
  });
  // Capture failures immediately, so the failed-predecessor case cannot produce
  // an unhandled rejection while its replacement is still queued.
  const first = cachedBotSkillRuntime(root, oldBuild).then(value => ({ value }), error => ({ error }));
  let second: ReturnType<typeof cachedBotSkillRuntime> | undefined;
  try {
    await vi.waitFor(() => expect(events).toEqual(['old-reading']));
    // More roots than the LRU can retain; the old writer stays in flight.
    await Promise.all(Array.from({ length: 33 }, async (_, index) => {
      const other = path.join(root, `other-${index}`);
      await fs.mkdir(other);
      return cachedBotSkillRuntime(other, async () => ({ pluginRoot: other, skills: [] }));
    }));
    const replacement = vi.fn(async () => {
      events.push('new-reading');
      return projectBotSkillMounts(root, [item('before'), item('added')]);
    });
    const stats = vi.spyOn(fs, 'stat');
    second = cachedBotSkillRuntime(root, replacement);
    // Wait for this hydration's source checks and then one event-loop turn. No
    // source I/O remains between those checks and entering the writer queue.
    await vi.waitFor(() => expect(stats.mock.calls.some(([file]) => file === root)).toBe(true));
    await Promise.allSettled(stats.mock.results.map(result => result.value));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(replacement).not.toHaveBeenCalled();
    release();
    await second;
    const outcome = await first;
    if (failOld) expect(outcome).toMatchObject({ error: new Error('old build failed') });
    else expect(outcome).toHaveProperty('value');
    expect(events).toEqual(['old-reading', 'old-finished', 'new-reading']);
    const catalog = path.join(root, '.runtime-skills', 'catalog.jsonl');
    expect((await fs.readFile(catalog, 'utf8')).trim().split('\n').map(line => JSON.parse(line).slug))
      .toEqual(['before', 'added']);
    expect((await fs.readdir(path.dirname(catalog))).some(file => file.endsWith('.tmp'))).toBe(false);
    // The evicted build's completion/failure must not clear the replacement.
    await cachedBotSkillRuntime(root, replacement);
    expect(replacement).toHaveBeenCalledTimes(1);
    invalidateBotSkillRuntime(root);
    await cachedBotSkillRuntime(root, replacement);
    expect(replacement).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

it('rejoins the active entry when evicted during a cached artifact check', async () => {
  const pluginRoot = path.join(root, '.runtime-skills');
  await fs.mkdir(pluginRoot);
  await fs.mkdir(path.join(pluginRoot, '.claude-plugin'));
  await fs.writeFile(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), '{"name":"fixture"}');
  const catalog = path.join(pluginRoot, 'catalog.jsonl');
  const filePath = path.join(pluginRoot, 'SKILL.md');
  await fs.writeFile(filePath, 'Fixture');
  const build = (name: string) => async () => {
    await fs.writeFile(catalog, name);
    return { pluginRoot, skills: [{ name, description: name, path: pluginRoot, filePath }] };
  };
  const initial = vi.fn(build('old'));
  await cachedBotSkillRuntime(root, initial);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const access = fs.access;
  const checks = vi.spyOn(fs, 'access').mockImplementationOnce(async (...args) => {
    await held;
    return access(...args);
  });
  const warm = cachedBotSkillRuntime(root, initial);
  try {
    await vi.waitFor(() => expect(checks).toHaveBeenCalled());
    await Promise.all(Array.from({ length: 33 }, async (_, index) => {
      const other = path.join(root, `other-${index}`);
      await fs.mkdir(other);
      await cachedBotSkillRuntime(other, async () => ({ pluginRoot: other, skills: [] }));
    }));
    const replacement = vi.fn(build('new'));
    await cachedBotSkillRuntime(root, replacement);
    release();
    expect((await warm).skills[0].name).toBe('new');
    expect(await fs.readFile(catalog, 'utf8')).toBe('new');
    expect(initial).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await warm;
  }
});
