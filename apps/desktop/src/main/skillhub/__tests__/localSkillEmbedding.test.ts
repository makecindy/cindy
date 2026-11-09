import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EmbeddingClient } from '@cindy/embedding-client';
import { SkillIndex } from '@cindy/skill-index';
import { EmbeddingService } from '../../embedding-host/EmbeddingService';
import { createLocalSkillEmbeddingAdapter } from '../localSkillEmbedding';
import { createLocalSkillLibraryTools, createLocalSkillLibraryCoordinator } from '../localSkillLibrary';
import { XdtHelperToolRegistry } from '../../../../../../packages/lizi-mcps/src/lizi_xdtHelperToolRegistry';
import { registerLocalSkillLibraryTools } from '../../../../../../packages/lizi-mcps/src/xdt-helper/local_skills';

vi.mock('@cindy/mcps', () => import('../../../../../../packages/lizi-mcps/src/session-path-auth'));
let root: string;
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-embedding-')); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

// Production adapter -> EmbeddingService -> real EmbeddingClient, with only fetch and the
// desktop route setting injected. Protects bounded native API calls and explicit rebuilds
// after a server alias changes; CLI batching tests do not execute this host route.
// Minimal failures: 65 entries; identical metadata rebuilt after v1 -> v2. Unit, no DB/network.
vi.mock('../../utility-model/oneShotCandidates', () => ({
  isProviderModelRouteDisabled: () => false,
  isProviderRouteSuspended: () => false,
}));

function fixture() {
  const state = { model: 'backend-v1', active: 0, peak: 0 };
  const batches: string[][] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    state.peak = Math.max(state.peak, ++state.active);
    const input = JSON.parse(String(init?.body)).input as string[];
    batches.push(input);
    await Promise.resolve();
    state.active--;
    return new Response(JSON.stringify({ model: state.model,
      data: input.map((text, index) => ({ index, embedding: [text.length, state.model === 'backend-v1' ? 1 : 2] })),
    }), { status: 200 });
  });
  const client = new EmbeddingClient({ baseUrl: 'https://embedding.invalid', getApiKey: () => 'invalid-test-key', fetchImpl });
  const service = new EmbeddingService({
    getClient: () => client,
    getDbClient: () => { throw new Error('Synchronous embeddings must not read the database'); },
    isVecAvailable: () => false,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  const adapter = createLocalSkillEmbeddingAdapter('text-embedding-3-small', () => service, () => {});
  return { state, batches, fetchImpl, client, service, adapter };
}

describe('native local Skill embeddings', () => {
  // Review 4507777247: request cancellation does not dispose its task instance.
  // Real registry/handler -> host -> adapter/service/client; only HTTP is injected.
  it.each([false, true])('honors request cancellation with the task still active (other waiter=%s)', async otherWaiter => {
    const f = fixture();
    const home = path.join(root, `request-cancel-${otherWaiter}`);
    const source = path.join(home, 'methods');
    await fs.mkdir(source, { recursive: true });
    const coordinator = createLocalSkillLibraryCoordinator();
    const registry = new XdtHelperToolRegistry();
    registerLocalSkillLibraryTools(registry, {
      getSessionContext: () => ({ agentKind: 'codex', workingDir: home, sessionId: 'active-task', sessionInstanceId: 'same-instance' }),
      execute: createLocalSkillLibraryTools({
        coordinator, ownerScope: () => 'owner', storageRoot: () => path.join(home, 'libraries'), homeDir: () => home,
        isCurrentSession: () => true, isOrdinaryTask: async () => true,
        embedding: (_model, checkCurrent) => createLocalSkillEmbeddingAdapter('text-embedding-3-small', () => f.service, checkCurrent),
      }),
    });
    const call = async (name: string, args: unknown, signal?: AbortSignal) => {
      const response = await registry.call(name, args, signal);
      return JSON.parse((response.content[0] as { text: string }).text);
    };
    expect(await call('configure_local_skill_library', { action: 'register', library_id: 'methods', sources: [source], embedding_model: 'text-embedding-3-small' })).toMatchObject({ ok: true });
    const indexFile = path.join(home, 'libraries/methods/index.json');
    const before = await fs.readFile(indexFile, 'utf8');
    await Promise.all(Array.from({ length: 65 }, async (_, i) => {
      const folder = path.join(source, `skill-${i}`);
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: skill-${i}\ndescription: Method ${i}\n---\nInstructions\n`);
    }));
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetchImpl = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(async (...args) => {
      const response = await fetchImpl(...args);
      entered(); await held; return response;
    });
    const controller = new AbortController();
    const first = call('configure_local_skill_library', { action: 'refresh', library_id: 'methods' }, controller.signal);
    await started;
    let second: Promise<unknown> | undefined;
    try {
      if (otherWaiter) {
        const pending = [...coordinator.syncing.values()][0]!;
        let joined!: () => void;
        const joining = new Promise<void>(resolve => { joined = resolve; });
        const add = pending.work.participants.add.bind(pending.work.participants);
        const spy = vi.spyOn(pending.work.participants, 'add').mockImplementation(value => { const result = add(value); joined(); return result; });
        try {
          second = call('search_local_skills', { library_id: 'methods', query: 'semantic task' });
          await joining;
        } finally { spy.mockRestore(); }
      }
      controller.abort(); release();
      expect(await first).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
      if (otherWaiter) {
        expect(await second).toMatchObject({ ok: true, mode: 'hybrid' });
        expect(f.batches.map(batch => batch.length)).toEqual([32, 32, 1, 1]);
        expect(JSON.parse(await fs.readFile(indexFile, 'utf8')).entries).toHaveLength(65);
      } else {
        expect(f.batches.map(batch => batch.length)).toEqual([32]);
        expect(await fs.readFile(indexFile, 'utf8')).toBe(before);
      }
      await expect(fs.stat(path.join(home, 'libraries/methods/library.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release(); await Promise.all([first, second]); }
  });

  it.each(['waiting', 'none', 'late'] as const)('keeps synchronization scoped to its current participants: %s', async (mode) => {
    const waiterCurrent = mode !== 'none';
    const f = fixture();
    const home = path.join(root, `participants-${mode}`);
    const source = path.join(home, 'methods');
    await fs.mkdir(source, { recursive: true });
    const current = new Set(['task-a', 'task-b']);
    const coordinator = createLocalSkillLibraryCoordinator();
    const makeCallback = () => createLocalSkillLibraryTools({
      coordinator, ownerScope: () => 'owner', storageRoot: () => path.join(home, 'libraries'), homeDir: () => home,
      isCurrentSession: (context) => current.has(context.sessionId!), isOrdinaryTask: async () => true,
      embedding: (_model, checkCurrent) => createLocalSkillEmbeddingAdapter('text-embedding-3-small', () => f.service, checkCurrent),
    });
    const firstCallback = makeCallback();
    const secondCallback = makeCallback();
    const context = { agentKind: 'codex', workingDir: home, sessionId: 'task-a', sessionInstanceId: 'instance' };
    await firstCallback({ action: 'register', library_id: 'methods', sources: [source], embedding_model: 'text-embedding-3-small' }, context);
    const indexFile = path.join(home, 'libraries/methods/index.json');
    const before = await fs.readFile(indexFile, 'utf8');
    await Promise.all(Array.from({ length: 65 }, async (_, i) => {
      const folder = path.join(source, `skill-${i}`);
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: skill-${i}\ndescription: Method ${i}\n---\nInstructions\n`);
    }));
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const fetchImpl = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(async (...args) => {
      const response = await fetchImpl(...args);
      entered(); await waiting;
      return response;
    });
    const search = { action: 'search' as const, library_id: 'methods', query: 'semantic task' };
    const first = firstCallback(search, context);
    await paused;
    const unlink = fs.unlink.bind(fs);
    let unlock!: () => void;
    let cancellationEntered!: () => void;
    const unlocking = new Promise<void>((resolve) => { unlock = resolve; });
    const cancelling = new Promise<void>((resolve) => { cancellationEntered = resolve; });
    let held = false;
    const cleanupSpy = mode === 'late' ? vi.spyOn(fs, 'unlink').mockImplementation(async (...args) => {
      if (!held && String(args[0]).endsWith('library.lock')) {
        held = true; cancellationEntered(); await unlocking;
      }
      return unlink(...args);
    }) : undefined;
    if (mode === 'late') {
      current.delete('task-a');
      release();
      await cancelling;
    }
    const readFile = fs.readFile.bind(fs);
    let joined!: () => void;
    const joining = new Promise<void>((resolve) => { joined = resolve; });
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const value = await readFile(...args);
      if (String(args[0]).endsWith('library.json')) setImmediate(joined);
      return value;
    });
    const second = secondCallback(search, { ...context, agentKind: 'pi', sessionId: 'task-b' });
    try {
      await joining;
      current.delete('task-a');
      if (!waiterCurrent) current.delete('task-b');
      release();
      unlock();
      expect(await first).toMatchObject({ errorCode: 'CANCELLED' });
      if (waiterCurrent) {
        expect(await second).toMatchObject({ ok: true, mode: 'hybrid', matches: expect.any(Array) });
        expect(f.batches.map(batch => batch.length)).toEqual(mode === 'late' ? [32, 32, 32, 1, 1] : [32, 32, 1, 1]);
        expect(JSON.parse(await fs.readFile(indexFile, 'utf8')).entries).toHaveLength(65);
      } else {
        expect(await second).toMatchObject({ errorCode: 'CANCELLED' });
        expect(f.fetchImpl).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(indexFile, 'utf8')).toBe(before);
      }
    } finally { release(); unlock(); spy.mockRestore(); cleanupSpy?.mockRestore(); await Promise.all([first, second]); }
  });
  it('cancels a host refresh after one batch and preserves the published index', async () => {
    const f = fixture();
    const source = path.join(root, 'methods');
    await Promise.all(Array.from({ length: 65 }, async (_, i) => {
      const folder = path.join(source, `skill-${i}`);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: skill-${i}\ndescription: Task ${i}\n---\nInstructions\n`);
    }));
    let current = true;
    const execute = createLocalSkillLibraryTools({
      coordinator: createLocalSkillLibraryCoordinator(),
      ownerScope: () => 'same-owner', storageRoot: () => path.join(root, 'libraries'), homeDir: () => root,
      isCurrentSession: () => current, isOrdinaryTask: async () => true,
      embedding: (_model, checkCurrent) => createLocalSkillEmbeddingAdapter('text-embedding-3-small', () => f.service, checkCurrent),
    });
    const context = { agentKind: 'codex', workingDir: root, sessionId: 'task', sessionInstanceId: 'instance' };
    expect(await execute({ action: 'register', library_id: 'methods', sources: [source], embedding_model: 'text-embedding-3-small' }, context)).toMatchObject({ ok: true });
    const indexFile = path.join(root, 'libraries/methods/index.json');
    const before = await fs.readFile(indexFile, 'utf8');
    f.fetchImpl.mockClear();
    const fetchImpl = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (...args) => {
      const response = await fetchImpl(...args);
      current = false;
      return response;
    });
    expect(await execute({ action: 'refresh', library_id: 'methods', rebuild: true }, context)).toMatchObject({ errorCode: 'CANCELLED' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(indexFile, 'utf8')).toBe(before);
  });
  it('stops after the first HTTP batch when the task instance expires', async () => {
    const f = fixture();
    let current = true;
    const adapter = createLocalSkillEmbeddingAdapter('text-embedding-3-small', () => f.service, () => {
      if (!current) throw new Error('Task instance changed');
    });
    const index = new SkillIndex();
    index.sync(Array.from({ length: 65 }, (_, i) => ({
      id: `skill-${i}`, name: `skill-${i}`, description: `Task ${i}`, source: 'library', filePath: path.resolve(`skill-${i}`, 'SKILL.md'),
    })));
    const before = index.snapshot();
    const fetchImpl = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (...args) => {
      const response = await fetchImpl(...args);
      current = false;
      return response;
    });
    await expect(index.buildVectors(adapter)).rejects.toThrow('Task instance changed');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(index.snapshot()).toEqual(before);
  });
  it('serializes 65 entries into 32/32/1 HTTP batches and preserves every vector', async () => {
    const f = fixture();
    const texts = Array.from({ length: 65 }, (_, i) => `skill-${i}`);
    expect(await f.adapter.embed(texts, 'document')).toEqual({ vectors: texts.map(text => [text.length, 1]), modelUsed: 'backend-v1' });
    expect(f.batches.map(batch => batch.length)).toEqual([32, 32, 1]);
    expect(f.batches.flat()).toEqual(texts);
    expect(f.state.peak).toBe(1);
  });

  it('rebuilds identical metadata against the current server model instead of its LRU copy', async () => {
    const f = fixture();
    const index = new SkillIndex();
    index.sync([{ id: 'video', name: 'video', description: 'Extract subtitles', source: 'library', filePath: path.resolve('video', 'SKILL.md') }]);
    await index.buildVectors(f.adapter);
    expect(await index.buildVectors(f.adapter)).toEqual({ embedded: 0, reused: 1 });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    f.state.model = 'backend-v2';
    await index.buildVectors(f.adapter, { rebuild: true });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(index.snapshot().vectorModel).toBe('backend-v2');
    expect(index.snapshot().entries[0]!.vector?.[1]).toBe(2);
  });

  it('keeps ordinary consumers cacheable while native Skill queries see the current alias', async () => {
    const f = fixture();
    const input = { modelId: 'text-embedding-3-small' as const, inputType: 'query' as const };
    await f.service.embedSync(['video'], input);
    expect((await f.service.embedSync(['video'], input)).cacheHits).toBe(1);
    f.state.model = 'backend-v2';
    expect((await f.adapter.embed(['video'], 'query')).modelUsed).toBe('backend-v2');
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect((await f.service.embedSync(['video'], input)).modelUsed).toBe('backend-v1');
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['model', 'owner'] as const)('keeps the previous complete index when %s changes between batches', async (changed) => {
    const f = fixture();
    const index = new SkillIndex();
    index.sync(Array.from({ length: 65 }, (_, i) => ({
      id: `skill-${i}`, name: `skill-${i}`, description: `Task ${i}`, source: 'library', filePath: path.resolve(`skill-${i}`, 'SKILL.md'),
    })));
    await index.buildVectors(f.adapter);
    const before = index.snapshot();
    f.fetchImpl.mockClear();
    let batch = 0;
    const adapter = createLocalSkillEmbeddingAdapter('text-embedding-3-small', () => {
      if (++batch === 2) {
        if (changed === 'owner') throw new Error('Account changed');
        f.state.model = 'backend-v2';
      }
      return f.service;
    }, () => {});
    await expect(index.buildVectors(adapter, { rebuild: true })).rejects.toThrow(changed === 'owner' ? 'Account changed' : 'Embedding model changed between batches');
    expect(f.fetchImpl).toHaveBeenCalledTimes(changed === 'owner' ? 1 : 2);
    expect(index.snapshot()).toEqual(before);
  });
});
