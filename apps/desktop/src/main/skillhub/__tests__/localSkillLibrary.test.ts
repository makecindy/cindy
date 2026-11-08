import fs from 'node:fs/promises';
import { ok as assertOk } from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalSkillLibraryTools, createLocalSkillLibraryCoordinator } from '../localSkillLibrary';
import type { SkillEmbeddingAdapter } from '@cindy/skill-index';

// Production host callback -> registered sources -> index -> short gateway -> selected original.
// Unit tier: local Skills, injected host identity and fixed embeddings.
// Covers task-first synchronization/reuse, explicit refresh, owner/teammate scope and real
// selected-id reads. Existing SkillHub tests exercise market publication, not this local route.
// Keep real gateway path resolution without loading every unrelated MCP provider.
vi.mock('@cindy/mcps', () => import('../../../../../../packages/lizi-mcps/src/session-path-auth'));

let root: string;
beforeAll(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-local-library-'))); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function fixture(name: string) {
  const home = path.join(root, name);
  const source = path.join(home, 'methods');
  await fs.mkdir(source, { recursive: true });
  const workingDir = path.join(home, 'task');
  await fs.mkdir(workingDir);
  const put = async (id: string, description: string) => {
    const folder = path.join(source, id);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${id}\ndescription: ${description}\n---\nOriginal instructions for ${id}.\n`);
  };
  await put('video', '视频字幕提取');
  const state = { owner: 'owner', current: true, ordinary: true };
  const embedding = vi.fn<(model: string) => SkillEmbeddingAdapter | undefined>(() => undefined);
  const coordinator = createLocalSkillLibraryCoordinator();
  const createCallback = () => createLocalSkillLibraryTools({
    coordinator,
    ownerScope: () => state.owner, storageRoot: () => path.join(home, state.owner, 'skill-libraries'),
    homeDir: () => home, isCurrentSession: () => state.current,
    isOrdinaryTask: async () => state.ordinary, embedding,
  });
  const execute = createCallback();
  const context = { agentKind: 'codex', workingDir, sessionId: 'task', sessionInstanceId: 'one' };
  const register = () => execute({ action: 'register', library_id: 'methods', sources: [source] }, context);
  const search = (query: string) => execute({ action: 'search', library_id: 'methods', query }, context);
  return { home, source, put, state, embedding, execute, createCallback, context, register, search };
}

describe('native local Skill libraries', () => {
  it('keeps shared callback state separate for different libraries and owners', async () => {
    const f = await fixture('shared-scopes');
    const second = f.createCallback();
    await f.register();
    const audio = path.join(f.home, 'audio');
    await fs.mkdir(audio);
    await fs.writeFile(path.join(audio, 'SKILL.md'), '---\nname: audio\ndescription: Music production\n---\nInstructions\n');
    expect(await second({ action: 'register', library_id: 'audio', sources: [audio] }, f.context)).toMatchObject({ ok: true });
    const results = await Promise.all([
      f.search('字幕'),
      second({ action: 'search', library_id: 'audio', query: 'Music' }, { ...f.context, sessionId: 'second-task' }),
    ]);
    expect(results[0]).toMatchObject({ ok: true, matches: [{ name: 'video' }] });
    expect(results[1]).toMatchObject({ ok: true, matches: [{ name: 'audio' }] });
    f.state.owner = 'owner-two';
    expect(await second({ action: 'register', library_id: 'methods', sources: [audio] }, f.context)).toMatchObject({ ok: true });
    expect(await second({ action: 'search', library_id: 'methods', query: 'Music' }, f.context))
      .toMatchObject({ ok: true, matches: [{ name: 'audio' }] });
    f.state.owner = 'owner';
    expect(await f.search('字幕')).toMatchObject({ ok: true, matches: [{ name: 'video' }] });
  });
  it('shares a first synchronization between independently created engine callbacks', async () => {
    const f = await fixture('engine-callbacks');
    const secondCallback = f.createCallback();
    const embed = vi.fn<SkillEmbeddingAdapter['embed']>(async (texts) => ({ vectors: texts.map(() => [1, 0]), modelUsed: 'model' }));
    f.embedding.mockReturnValue({ identity: 'model', embed });
    await f.execute({ action: 'register', library_id: 'methods', sources: [f.source], embedding_model: 'model' }, f.context);
    await f.put('audio', 'Music production');
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    embed.mockClear();
    embed.mockImplementation(async (texts, inputType) => {
      if (inputType === 'document') { entered(); await waiting; }
      return { vectors: texts.map(() => [1, 0]), modelUsed: 'model' };
    });
    const first = f.search('semantic task');
    await paused;
    const readFile = fs.readFile.bind(fs);
    let secondEntered!: () => void;
    const secondReading = new Promise<void>((resolve) => { secondEntered = resolve; });
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const result = await readFile(...args);
      if (String(args[0]).endsWith('library.json')) setImmediate(secondEntered);
      return result;
    });
    try {
      const second = secondCallback({ action: 'search', library_id: 'methods', query: 'semantic task' }, { ...f.context, agentKind: 'pi', sessionId: 'pi-task' });
      await secondReading;
      release();
      for (const result of await Promise.all([first, second])) {
        expect(result).toMatchObject({ ok: true, mode: 'hybrid' });
        assertOk(result.ok);
        expect(result.matches).toHaveLength(2);
      }
      expect(embed.mock.calls.filter(([, inputType]) => inputType === 'document')).toHaveLength(1);
    } finally { release(); spy.mockRestore(); await first; }
  });
  it('keeps an in-flight query on its captured index while the same configuration is registered again', async () => {
    const f = await fixture('query-snapshot');
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let held = false;
    f.embedding.mockImplementation((model) => ({ identity: model, embed: async (texts, inputType) => {
      if (inputType === 'query' && !held) { held = true; entered(); await waiting; }
      return { vectors: texts.map(() => [1, 0]), modelUsed: model };
    } }));
    const request = { action: 'register' as const, library_id: 'methods', sources: [f.source], embedding_model: 'model' };
    await f.execute(request, f.context);
    const configFile = path.join(f.home, 'owner/skill-libraries/methods/library.json');
    const originalGeneration = JSON.parse(await fs.readFile(configFile, 'utf8')).generation;
    const first = f.search('unrelated semantic task');
    await paused;
    try {
      await f.put('audio', 'Music production');
      expect(await f.execute(request, { ...f.context, sessionId: 'registrar' })).toMatchObject({ ok: true });
      expect(JSON.parse(await fs.readFile(configFile, 'utf8')).generation).not.toBe(originalGeneration);
      const next = await f.execute({ action: 'search', library_id: 'methods', query: 'unrelated semantic task' }, { ...f.context, sessionId: 'next-task' });
      assertOk(next.ok);
      expect(next.mode).toBe('hybrid');
      expect(next.matches).toHaveLength(2);
    } finally { release(); }
    expect(await first).toMatchObject({ ok: true, mode: 'hybrid', matches: [{ name: 'video' }] });
  });
  it('does not treat a pending read as the first search synchronization', async () => {
    const f = await fixture('read-before-search');
    await f.register();
    const snapshot = JSON.parse(await fs.readFile(path.join(f.home, 'owner/skill-libraries/methods/index.json'), 'utf8'));
    await f.put('audio', 'Music production');
    const open = fs.open.bind(fs);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let held = false;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (!held && String(args[0]).endsWith('library.lock')) { held = true; entered(); await waiting; }
      return open(...args);
    });
    try {
      const read = f.execute({ action: 'read', library_id: 'methods', id: snapshot.entries[0].entry.id }, f.context);
      await paused;
      const search = f.search('Music');
      release();
      expect(await read).toMatchObject({ ok: true });
      expect(await search).toMatchObject({ ok: true, matches: [{ name: 'audio' }] });
    } finally { release(); spy.mockRestore(); }
  });
  it('pairs a resumed first search with the registration that owns the acquired lock', async () => {
    const f = await fixture('registration-generation');
    f.embedding.mockImplementation((model) => ({ identity: model, embed: async (texts) => ({
      vectors: texts.map(() => model === 'model-a' ? [1, 0] : [0, 1]), modelUsed: model,
    }) }));
    await f.execute({ action: 'register', library_id: 'methods', sources: [f.source], embedding_model: 'model-a' }, f.context);
    const sourceB = path.join(f.home, 'methods-b');
    await fs.mkdir(sourceB);
    await fs.writeFile(path.join(sourceB, 'SKILL.md'), '---\nname: audio\ndescription: Music production\n---\nAudio instructions\n');
    const open = fs.open.bind(fs);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let held = false;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (!held && String(args[0]).endsWith('library.lock')) {
        held = true; entered(); await waiting;
      }
      return open(...args);
    });
    try {
      const first = f.search('unrelated semantic task');
      await paused;
      expect(await f.execute({ action: 'register', library_id: 'methods', sources: [sourceB], embedding_model: 'model-b' }, { ...f.context, sessionId: 'registrar' }))
        .toMatchObject({ ok: true });
      const joined = f.execute({ action: 'search', library_id: 'methods', query: 'unrelated semantic task' }, { ...f.context, sessionId: 'new-task' });
      release();
      expect(await first).toMatchObject({ ok: true, mode: 'hybrid', matches: [{ name: 'audio' }] });
      expect(await joined).toMatchObject({ ok: true, mode: 'hybrid', matches: [{ name: 'audio' }] });
      const snapshot = JSON.parse(await fs.readFile(path.join(f.home, 'owner/skill-libraries/methods/index.json'), 'utf8'));
      expect(snapshot.vectorIdentity).toBe('model-b');
      expect(await f.search('unrelated semantic task')).toMatchObject({ mode: 'hybrid', matches: [{ name: 'audio' }] });
    } finally { release(); spy.mockRestore(); }
  });
  it('requires a current local task and reads only a selected index id', async () => {
    const f = await fixture('task-scope');
    f.state.current = false;
    expect(await f.register()).toMatchObject({ errorCode: 'NO_SESSION_CONTEXT' });
    f.state.current = true;
    expect(await f.register()).toMatchObject({ ok: true });
    expect(await f.execute({ action: 'search', library_id: 'methods', query: '字幕' }, { ...f.context, remoteHostId: 'remote' }))
      .toMatchObject({ errorCode: 'NO_SESSION_CONTEXT' });
    expect(await f.execute({ action: 'read', library_id: 'methods', id: path.join(f.source, 'video', 'SKILL.md') }, f.context))
      .toMatchObject({ errorCode: 'NOT_FOUND' });
  });
  it('registers a hundred Skills once, then searches, reads and refreshes the library', async () => {
    const f = await fixture('authorization-count');
    for (let i = 1; i < 100; i++) await f.put(`method-${i}`, `Method ${i}`);
    expect(await f.register()).toMatchObject({ ok: true, skills: 100 });
    const result = await f.search('字幕');
    assertOk(result.ok);
    const matches = result.matches as Array<{ id: string }>;
    expect(await f.execute({ action: 'read', library_id: 'methods', id: matches[0].id }, f.context)).toMatchObject({ ok: true });
    expect(await f.execute({ action: 'refresh', library_id: 'methods' }, f.context)).toMatchObject({ ok: true });
  });

  it('registers a short gateway, searches summaries and reads the original without a CLI', async () => {
    const f = await fixture('workflow');
    expect(await f.register()).toMatchObject({ ok: true, skills: 1 });
    const gateway = await fs.readFile(path.join(f.home, '.agents/skills/cindy-skill-library-methods/SKILL.md'), 'utf8');
    expect(gateway).toContain('search_local_skills');
    expect(gateway).not.toContain('视频字幕提取');
    const result = await f.search('字幕');
    expect(result).toMatchObject({ ok: true, mode: 'keyword', matches: [{ name: 'video' }] });
    assertOk(result.ok);
    const matches = result.matches as Array<{ id: string }>;
    expect(result).not.toHaveProperty('content');
    expect(await f.execute({ action: 'read', library_id: 'methods', id: matches[0].id }, f.context))
      .toMatchObject({ ok: true, resourceRoot: path.join(f.source, 'video'), content: expect.stringContaining('Original instructions'), eof: true });
    expect(f.embedding).not.toHaveBeenCalled();
  });

  it('syncs once per task instance, then refreshes explicitly or on a new instance', async () => {
    const f = await fixture('refresh');
    await f.register();
    await f.put('audio', '音乐制作');
    expect(await f.search('音乐')).toMatchObject({ matches: [{ name: 'audio' }] });
    await f.put('drawing', '绘画设计');
    expect(await f.search('绘画')).toMatchObject({ matches: [] });
    expect(await f.execute({ action: 'refresh', library_id: 'methods' }, f.context)).toMatchObject({ ok: true, added: 1 });
    expect(await f.search('绘画')).toMatchObject({ matches: [{ name: 'drawing' }] });
    await f.put('code', '编程开发');
    f.context.sessionInstanceId = 'two';
    expect(await f.search('编程')).toMatchObject({ matches: [{ name: 'code' }] });
  });

  it('removes registration while preserving source and gateway, and isolates owners and teammates', async () => {
    const f = await fixture('scope');
    await f.register();
    f.state.ordinary = false;
    expect(await f.search('字幕')).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
    f.state.ordinary = true;
    f.state.owner = 'another';
    expect(await f.search('字幕')).toMatchObject({ errorCode: 'NOT_FOUND' });
    f.state.owner = 'owner';
    expect(await f.execute({ action: 'remove', library_id: 'methods' }, f.context)).toMatchObject({ ok: true });
    expect(await f.search('字幕')).toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(await fs.readFile(path.join(f.source, 'video/SKILL.md'), 'utf8')).toContain('Original');
    expect(await fs.stat(path.join(f.home, '.agents/skills/cindy-skill-library-methods/SKILL.md'))).toBeDefined();
  });

  it('shares first-use synchronization and uses the supplied host embedding adapter', async () => {
    const f = await fixture('concurrent');
    const embed = vi.fn<SkillEmbeddingAdapter['embed']>(async (texts) => ({ vectors: texts.map(() => [1, 0]), modelUsed: 'host-model' }));
    f.embedding.mockReturnValue({ identity: 'host-model', embed });
    expect(await f.execute({ action: 'register', library_id: 'methods', sources: [f.source], embedding_model: 'host-model' }, f.context)).toMatchObject({ ok: true });
    await f.put('audio', '音乐制作');
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    embed.mockImplementation(async (texts, inputType) => {
      if (inputType === 'document') { started(); await waiting; }
      return { vectors: texts.map(() => [1, 0]), modelUsed: 'host-model' };
    });
    const first = f.search('声音处理');
    await entered;
    const second = f.execute({ action: 'search', library_id: 'methods', query: '声音处理' }, { ...f.context, sessionId: 'another-task' });
    release();
    expect(await first).toMatchObject({ ok: true, mode: 'hybrid' });
    expect(await second).toMatchObject({ ok: true, mode: 'hybrid' });
    expect(embed.mock.calls.filter(([, inputType]) => inputType === 'document')).toHaveLength(2);
  });

  it('keeps the discovery gateway out of indexed sources', async () => {
    const f = await fixture('gateway-scope');
    expect(await f.execute({ action: 'register', library_id: 'methods', sources: [f.source], gateway_path: path.join(f.source, 'gateway') }, f.context))
      .toMatchObject({ errorCode: 'INVALID_ARGS' });
    await expect(fs.stat(path.join(f.source, 'gateway'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

});
