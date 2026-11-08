import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSkills, helperDiscoverySkill, loadIndex, readConfig, readSkill, syncLibrary, withLibraryWrite } from './library.js';
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

  // PR #9374: failed init/add published unusable sources before discovery finished.
  // Existing success/concurrency coverage missed failure persistence. Unit tier:
  // one malformed source through runCli must leave the previous library usable.
  it.each(['init', 'add'])('preserves the usable state after a failed %s', async (command) => {
    const target = path.join(root, `failed-${command}`);
    const invalid = path.join(root, `invalid-${command}`);
    await fs.mkdir(invalid);
    await fs.writeFile(path.join(invalid, 'SKILL.md'), '# Missing frontmatter');
    if (command === 'add') await runCli(['init', '--library', target, '--source', source], executable);
    const previous = command === 'add' ? await readConfig(target) : undefined;
    await expect(runCli([command, '--library', target, '--source', invalid], executable)).rejects.toThrow('frontmatter');
    if (previous) {
      expect(await readConfig(target)).toEqual(previous);
      expect(await runCli(['sync', '--library', target], executable)).toMatchObject({ skills: 2 });
    } else {
      await expect(readConfig(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await runCli(['init', '--library', target, '--source', source], executable)).toMatchObject({ skills: 2 });
    }
    expect(await runCli(['search', '--library', target, '--query', 'motion'], executable)).toMatchObject({ matches: [expect.objectContaining({ name: 'motion-feel' })] });
  });

  // Gateway placement inside/above its source makes discovery index its own route
  // or hide every original at the leaf boundary. Existing gateways were disjoint.
  // Unit tier: real CLI, including an existing junction with a not-yet-created child.
  it('rejects gateway placement overlapping physical source directories', async () => {
    const container = path.join(root, 'gateway-overlap');
    const originals = path.join(container, 'originals');
    const target = path.join(root, 'gateway-overlap-library');
    await fs.mkdir(originals, { recursive: true });
    await fs.cp(source, originals, { recursive: true });
    await runCli(['init', '--library', target, '--source', originals], executable);
    for (const output of [originals, path.join(originals, 'new', 'gateway'), container]) {
      await expect(runCli(['gateway', '--library', target, '--output', output], executable)).rejects.toThrow('outside');
      await expect(fs.stat(path.join(output, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const alias = path.join(root, 'gateway-source-alias');
    await fs.symlink(originals, alias, 'junction');
    await expect(runCli(['gateway', '--library', target, '--output', path.join(alias, 'new', 'gateway')], executable)).rejects.toThrow('outside');
    expect(await runCli(['sync', '--library', target], executable)).toMatchObject({ skills: 2 });
  });

  it('uses the host embedding adapter and a short native helper route', async () => {
    const target = path.join(root, 'host-library');
    await runCli(['init', '--library', target, '--source', source], executable);
    let requests = 0;
    const embedding = {
      identity: 'cindy-provider:model',
      embed: async (texts: readonly string[]) => {
        requests++;
        return { vectors: texts.map(() => [1, 0]), modelUsed: 'actual-model' };
      },
    };
    expect((await syncLibrary(target, { embedding })).vectors).toEqual({ embedded: 2, reused: 0 });
    expect((await syncLibrary(target, { embedding })).vectors).toEqual({ embedded: 0, reused: 2 });
    expect(requests).toBe(1);
    expect((await readConfig(target)).embedding).toBeUndefined();
    const route = helperDiscoverySkill('personal-methods');
    expect(route).toContain('search_local_skills');
    expect(route).toContain('read_local_skill');
    expect(route).toContain('personal-methods');
    expect(route).not.toContain('cli.cjs');
    expect(route).not.toContain('motion-feel');
    expect(route).not.toContain('actual-model');
    expect(route.split('\n').length).toBeLessThan(20);
  });

  // Review 4507386119: exercise actual index/config publication failures for every
  // CLI configuration writer, then check original bytes, semantic search and retry.
  it.each(['init', 'add', 'embedding', 'off'])('preserves the previous pair when %s configuration publication fails', async command => {
    const target = path.join(root, `commit-${command}`);
    const addition = path.join(root, `commit-source-${command}`);
    await fs.mkdir(addition);
    await fs.writeFile(path.join(addition, 'SKILL.md'), '---\nname: added\ndescription: Additional method\n---\nInstructions\n');
    vi.stubEnv('CINDY_SKILL_TEST_KEY', 'test-only');
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { model: string; input: string[] };
      return Response.json({ model: body.model, data: body.input.map((_, index) => ({ index, embedding: body.model === 'model-b' ? [0, 1] : [1, 0] })) });
    });
    const embeddingArgs = (model: string) => ['embedding', '--library', target, '--base-url', 'https://example.invalid/v1', '--model', model, '--key-env', 'CINDY_SKILL_TEST_KEY'];
    try {
      const initialSource = command === 'off' ? path.join(root, 'off-originals') : source;
      if (command === 'off') await fs.cp(source, initialSource, { recursive: true });
      if (command !== 'init') {
        await runCli(['init', '--library', target, '--source', initialSource], executable);
        await runCli(embeddingArgs('model-a'), executable);
      }
      const configFile = path.join(target, 'library.json'), indexFile = path.join(target, 'index.json');
      const before = command === 'init' ? [] : await Promise.all([configFile, indexFile].map(file => fs.readFile(file, 'utf8')));
      if (command === 'off') await fs.cp(addition, path.join(initialSource, 'new'), { recursive: true });
      const args = command === 'embedding' ? embeddingArgs('model-b')
        : command === 'off' ? ['embedding', '--library', target, '--off']
        : [command, '--library', target, '--source', command === 'add' ? addition : source];
      const rename = fs.rename.bind(fs);
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (...input) => {
        if (String(input[1]) === configFile) throw Object.assign(new Error('Configuration publication denied'), { code: 'EACCES' });
        return rename(...input);
      });
      try { await expect(runCli(args, executable)).rejects.toThrow('Configuration publication denied'); }
      finally { spy.mockRestore(); }
      if (command === 'init') {
        await expect(fs.stat(indexFile)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.stat(configFile)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(await fs.readFile(configFile, 'utf8')).toBe(before[0]);
        expect(await fs.readFile(indexFile, 'utf8')).toBe(before[1]);
        expect(await runCli(['search', '--library', target, '--query', 'unrelated semantic request'], executable))
          .toMatchObject({ mode: 'hybrid', matches: expect.arrayContaining([expect.objectContaining({ name: 'motion-feel' })]) });
      }
      expect((await fs.readdir(target)).sort()).toEqual(command === 'init' ? [] : ['index.json', 'library.json']);
      await expect(runCli(args, executable)).resolves.toHaveProperty('skills');
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  // Snapshot and gateway writers must leave a retryable state after actual I/O failure.
  it.each(['write', 'rename'])('keeps the old snapshot when index %s fails', async stage => {
    const target = path.join(root, `index-failure-${stage}`);
    const originals = path.join(root, `index-source-${stage}`);
    await fs.cp(source, originals, { recursive: true });
    await runCli(['init', '--library', target, '--source', originals], executable);
    const indexFile = path.join(target, 'index.json');
    const before = await fs.readFile(indexFile, 'utf8');
    const config = await fs.readFile(path.join(target, 'library.json'), 'utf8');
    await fs.writeFile(path.join(originals, 'audio/SKILL.md'), '---\nname: audio-edit\ndescription: Changed recording method\n---\nInstructions\n');
    const write = fs.writeFile.bind(fs), rename = fs.rename.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (stage === 'write' && String(args[0]).startsWith(`${indexFile}.`)) {
        await write(args[0], 'partial'); throw new Error('Index write failed');
      }
      return write(...args);
    });
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (stage === 'rename' && String(args[1]) === indexFile) throw new Error('Index rename failed');
      return rename(...args);
    });
    try { await expect(runCli(['sync', '--library', target], executable)).rejects.toThrow(`Index ${stage} failed`); }
    finally { writeSpy.mockRestore(); renameSpy.mockRestore(); }
    expect(await fs.readFile(indexFile, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(target, 'library.json'), 'utf8')).toBe(config);
    expect((await fs.readdir(target)).sort()).toEqual(['index.json', 'library.json']);
    expect(await runCli(['sync', '--library', target], executable)).toMatchObject({ changed: 1 });
  });

  it.each(['write', 'close'])('removes only its own gateway when %s fails and allows retry', async stage => {
    const target = path.join(root, `gateway-failure-${stage}`);
    const output = path.join(root, `gateway-output-${stage}`);
    const gatewayFile = path.join(output, 'SKILL.md');
    await runCli(['init', '--library', target, '--source', source], executable);
    const args = ['gateway', '--library', target, '--output', output];
    const open = fs.open.bind(fs);
    const handles: Array<{ mockRestore(): void }> = [];
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === gatewayFile) {
        const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
        if (stage === 'write') handles.push(vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await write('partial gateway'); throw new Error('Gateway write failed');
        }));
        else handles.push(vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close(); throw new Error('Gateway close failed');
        }));
      }
      return handle;
    });
    try { await expect(runCli(args, executable)).rejects.toThrow(`Gateway ${stage} failed`); }
    finally { for (const handle of handles) handle.mockRestore(); spy.mockRestore(); }
    await expect(fs.stat(gatewayFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runCli(args, executable)).toMatchObject({ filePath: gatewayFile });
    const original = await fs.readFile(gatewayFile, 'utf8');
    await expect(runCli(args, executable)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(gatewayFile, 'utf8')).toBe(original);
  });

  it('does not turn a successful atomic rename into a failed publication', async () => {
    const target = path.join(root, 'committed-publication');
    const rm = fs.rm.bind(fs);
    const spy = vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(target) && String(args[0]).endsWith('.tmp')) throw new Error('Post-publication cleanup failed');
      return rm(...args);
    });
    try { expect(await runCli(['init', '--library', target, '--source', source], executable)).toMatchObject({ skills: 2 }); }
    finally { spy.mockRestore(); }
    expect((await fs.readdir(target)).sort()).toEqual(['index.json', 'library.json']);
  });

  // A failed publication must stay visible if restoring its index also fails.
  it('reports both publication and rollback errors while keeping the old configuration', async () => {
    const target = path.join(root, 'rollback-error');
    await runCli(['init', '--library', target, '--source', source], executable);
    const original = await fs.readFile(path.join(target, 'library.json'), 'utf8');
    const rename = fs.rename.bind(fs);
    let indexWrites = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (String(args[1]) === path.join(target, 'library.json')) throw new Error('Config rename failed');
      if (String(args[1]) === path.join(target, 'index.json') && ++indexWrites === 2) throw new Error('Index restoration failed');
      return rename(...args);
    });
    try {
      const result = runCli(['embedding', '--library', target, '--off'], executable);
      await expect(result).rejects.toThrow('Config rename failed');
      await expect(result).rejects.toThrow('Index restoration failed');
    } finally { spy.mockRestore(); }
    expect(await fs.readFile(path.join(target, 'library.json'), 'utf8')).toBe(original);
    await expect(fs.stat(path.join(target, 'library.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // PR #9374: config B must not become visible with model A's persisted vectors.
  // Real CLI and HTTP adapter; controlled promises keep the rebuild overlap deterministic.
  it.each([false, true])('publishes embedding configuration only after a successful build (failure=%s)', async (fail) => {
    const target = path.join(root, `embedding-switch-${fail}`);
    await runCli(['init', '--library', target, '--source', source], executable);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const models: string[] = [];
    vi.stubEnv('CINDY_SKILL_TEST_KEY', 'test-only');
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { model: string; input: string[] };
      models.push(body.model);
      if (body.input.length === 1) {
        await expect(fs.stat(path.join(target, 'library.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      if (body.model === 'model-b') {
        entered();
        await blocked;
        if (fail) return new Response('invalid model', { status: 400 });
      }
      return Response.json({ model: body.model, data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    });
    const configure = (model: string) => runCli(['embedding', '--library', target, '--base-url', 'https://example.invalid/v1', '--model', model, '--key-env', 'CINDY_SKILL_TEST_KEY'], executable);
    const search = () => runCli(['search', '--library', target, '--query', 'motion'], executable);
    let rebuild: Promise<unknown> | undefined;
    try {
      await configure('model-a');
      const previousConfig = await readConfig(target);
      const previousIndex = (await loadIndex(target)).snapshot();
      rebuild = configure('model-b');
      // Attach rejection handling before deliberately parking the HTTP request.
      const outcome = rebuild.then(value => ({ value }), error => ({ error }));
      await started;
      try {
        await expect(search()).rejects.toThrow('being updated');
        expect(await readConfig(target)).toEqual(previousConfig);
      } finally {
        release();
      }
      const result = await outcome;
      if (fail) {
        expect(result).toHaveProperty('error');
        expect(await readConfig(target)).toEqual(previousConfig);
        expect((await loadIndex(target)).snapshot()).toEqual(previousIndex);
      } else {
        expect(result).toHaveProperty('value');
        expect((await readConfig(target)).embedding?.model).toBe('model-b');
      }
      expect(await search()).toMatchObject({ mode: 'hybrid' });
      expect(models.at(-1)).toBe(fail ? 'model-a' : 'model-b');
      const requestCount = models.length;
      await runCli(['sync', '--library', target], executable);
      expect(models).toHaveLength(requestCount);
      await runCli(['embedding', '--library', target, '--off'], executable);
      expect(await search()).toMatchObject({ mode: 'keyword' });
      expect(models).toHaveLength(requestCount);
    } finally {
      release();
      await rebuild?.catch(() => {});
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  // PR #9374: two successful add calls previously overwrote each other's source.
  // Unit tier: real CLI persistence under two overlapping writers, no timer waits.
  it('reports concurrent writers and retains every successful source addition', async () => {
    const target = path.join(root, 'concurrent-library');
    await runCli(['init', '--library', target, '--source', source], executable);
    const additions = [path.join(root, 'addition-a'), path.join(root, 'addition-b')];
    for (const [n, addition] of additions.entries()) {
      await fs.mkdir(addition);
      await fs.writeFile(path.join(addition, 'SKILL.md'), `---\nname: addition-${n}\ndescription: Added independently.\n---\n`);
    }
    const add = (addition: string) => runCli(['add', '--library', target, '--source', addition], executable);
    const results = await Promise.allSettled(additions.map(add));
    const config = await readConfig(target);
    for (const [n, result] of results.entries()) {
      if (result.status === 'fulfilled') expect(config.sources.map(item => item.path)).toContain(additions[n]);
      else {
        expect(result.reason.message).toContain('being updated');
        await add(additions[n]);
      }
    }
    expect((await readConfig(target)).sources).toHaveLength(3);
    expect((await loadIndex(target)).snapshot().entries).toHaveLength(4);
    // sync must participate in the same cross-process lock as configuration edits.
    await withLibraryWrite(target, async () => {
      await expect(runCli(['sync', '--library', target], executable)).rejects.toThrow('being updated');
      await expect(runCli(['embedding', '--library', target, '--off'], executable)).rejects.toThrow('being updated');
    });
    // Failed commands release ownership too.
    await expect(runCli(['embedding', '--library', target], executable)).rejects.toThrow('--base-url');
    expect(await runCli(['sync', '--library', target], executable)).toMatchObject({ skills: 4 });
    await expect(fs.stat(path.join(target, 'library.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
