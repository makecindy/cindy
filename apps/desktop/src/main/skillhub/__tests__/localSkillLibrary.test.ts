import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalSkillLibraryTools } from '../localSkillLibrary';
import type { SkillEmbeddingAdapter } from '@cindy/skill-index';
import type { SessionPathAuthorizationRequest } from '@cindy/mcps';

// Production host callback -> registered sources -> index -> short gateway -> selected original.
// Unit tier: two local Skills, injected host identity/path grants and fixed embeddings.
// Covers task-first synchronization/reuse, explicit refresh, owner/teammate scope and real
// junction targets. Existing SkillHub tests exercise market publication, not this local route.
// Keep the real path authorizer without loading every unrelated MCP provider.
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
  const state = { owner: 'owner', current: true, ordinary: true, allowed: true };
  const authorizePath = vi.fn(async (_request: SessionPathAuthorizationRequest) => state.allowed
    ? { allowed: true as const, isCurrent: () => state.current }
    : { allowed: false as const, reason: 'Denied' });
  const embedding = vi.fn<(model: string) => SkillEmbeddingAdapter | undefined>(() => undefined);
  const execute = createLocalSkillLibraryTools({
    ownerScope: () => state.owner, storageRoot: () => path.join(home, state.owner, 'skill-libraries'),
    homeDir: () => home, isCurrentSession: () => state.current,
    isOrdinaryTask: async () => state.ordinary, authorizePath, embedding,
  });
  const context = { agentKind: 'codex', workingDir, sessionId: 'task', sessionInstanceId: 'one' };
  const register = () => execute({ action: 'register', library_id: 'methods', sources: [source] }, context);
  const search = (query: string) => execute({ action: 'search', library_id: 'methods', query }, context);
  return { home, source, put, state, authorizePath, embedding, execute, context, register, search };
}

describe('native local Skill libraries', () => {
  it('bounds source authorization independently of the number of Skills', async () => {
    const f = await fixture('authorization-count');
    for (let i = 1; i < 100; i++) await f.put(`method-${i}`, `Method ${i}`);
    expect(await f.register()).toMatchObject({ ok: true, skills: 100 });
    expect(f.authorizePath).toHaveBeenCalledTimes(2);
    const result = await f.search('字幕');
    const matches = (result as { matches: Array<{ id: string }> }).matches;
    expect(await f.execute({ action: 'read', library_id: 'methods', id: matches[0].id }, f.context)).toMatchObject({ ok: true });
    expect(await f.execute({ action: 'refresh', library_id: 'methods' }, f.context)).toMatchObject({ ok: true });
    expect(f.authorizePath).toHaveBeenCalledTimes(2);
  });

  it('uses the canonical working directory without outside-path approval', async () => {
    const f = await fixture('workdir-authorization');
    f.context.workingDir = f.home;
    expect(await f.register()).toMatchObject({ ok: true });
    expect(await f.search('字幕')).toMatchObject({ ok: true });
    expect(f.authorizePath).not.toHaveBeenCalled();
    const external = path.join(root, 'workdir-external');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'SKILL.md'), '---\nname: external\ndescription: External method\n---\nBody\n');
    await fs.symlink(external, path.join(f.source, 'external'), 'junction');
    f.state.allowed = false;
    expect(await f.execute({ action: 'refresh', library_id: 'methods' }, f.context)).toMatchObject({ ok: false, message: 'Denied' });
    expect(f.authorizePath).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: external, operation: 'read' }));
  });

  it('does not share root grants between tasks, instances or owners', async () => {
    const f = await fixture('grant-scope');
    await f.register();
    f.authorizePath.mockClear();
    expect(await f.search('字幕')).toMatchObject({ ok: true });
    expect(f.authorizePath).not.toHaveBeenCalled();
    f.context.sessionId = 'task-two';
    expect(await f.search('字幕')).toMatchObject({ ok: true });
    expect(f.authorizePath).toHaveBeenCalledTimes(1);
    f.context.sessionInstanceId = 'two';
    expect(await f.search('字幕')).toMatchObject({ ok: true });
    expect(f.authorizePath).toHaveBeenCalledTimes(2);
    f.state.owner = 'owner-two';
    expect(await f.register()).toMatchObject({ ok: true });
    expect(f.authorizePath).toHaveBeenCalledTimes(4);
  });

  it('rechecks expired grants instead of reusing previous approval', async () => {
    const f = await fixture('expired-grant');
    let valid = true;
    f.authorizePath.mockImplementation(async () => ({ allowed: true, isCurrent: () => valid }));
    await f.register();
    valid = false;
    f.authorizePath.mockClear();
    f.authorizePath.mockImplementation(async () => ({ allowed: false, reason: 'Grant expired' }));
    expect(await f.search('字幕')).toMatchObject({ ok: false, message: 'Grant expired' });
    expect(f.authorizePath).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: f.source }));
  });
  it('registers a short gateway, searches summaries and reads the original without a CLI', async () => {
    const f = await fixture('workflow');
    expect(await f.register()).toMatchObject({ ok: true, skills: 1 });
    const gateway = await fs.readFile(path.join(f.home, '.agents/skills/cindy-skill-library-methods/SKILL.md'), 'utf8');
    expect(gateway).toContain('search_local_skills');
    expect(gateway).not.toContain('视频字幕提取');
    const result = await f.search('字幕');
    expect(result).toMatchObject({ ok: true, mode: 'keyword', matches: [{ name: 'video' }] });
    const matches = (result as { matches: Array<{ id: string }> }).matches;
    expect(result).not.toHaveProperty('content');
    expect(await f.execute({ action: 'read', library_id: 'methods', id: matches[0].id }, f.context))
      .toMatchObject({ ok: true, resourceRoot: path.join(f.source, 'video'), content: expect.stringContaining('Original instructions'), eof: true });
    expect(f.embedding).not.toHaveBeenCalled();
    expect(f.authorizePath).toHaveBeenCalledWith(expect.objectContaining({ operation: 'write' }));
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

  it('honors path denial and invalidated instances before publishing configuration', async () => {
    const f = await fixture('authorization');
    f.state.allowed = false;
    expect(await f.register()).toMatchObject({ ok: false });
    await expect(fs.stat(path.join(f.home, 'owner/skill-libraries/methods/library.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    f.state.allowed = true;
    f.authorizePath.mockImplementationOnce(async () => {
      f.state.current = false;
      return { allowed: true, isCurrent: () => false };
    });
    expect(await f.register()).toMatchObject({ errorCode: 'CANCELLED' });
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

  it('authorizes resolved junction targets before reading metadata or embedding it', async () => {
    const f = await fixture('junction');
    const outside = path.join(root, 'outside-method');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'SKILL.md'), '---\nname: external\ndescription: Private external method\n---\nInstructions\n');
    await fs.symlink(outside, path.join(f.source, 'linked'), 'junction');
    f.authorizePath.mockImplementation(async (request) => request.path === outside
      ? { allowed: false, reason: 'External target denied' }
      : { allowed: true, isCurrent: () => true });
    expect(await f.register()).toMatchObject({ ok: false, message: 'External target denied' });
    await expect(fs.stat(path.join(f.home, 'owner/skill-libraries/methods/index.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
