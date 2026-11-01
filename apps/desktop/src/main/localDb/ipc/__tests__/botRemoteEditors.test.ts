import { describe, expect, it, vi } from 'vitest';
import { createBotRemoteEditors, type BotRemoteEditorDeps } from '../botRemoteEditors.js';
import { createBotRemoteSettingsResource } from '../botRemoteSettingsResource.js';
import { RemoteResourceRegistryError } from '../../../device-link/remoteResourceRegistry.js';
import { createIpcError } from '../../../../shared/ipc-errors.js';
import type { BotMemoryDetail } from '../../../../shared/botMemory.js';
import type { BotSkillDetail } from '../../../../shared/botSkill.js';
import type { BotSystemSkillId } from '../../../../shared/botSystemSkills.js';

function fixture() {
  let owner = 'a';
  const source = { id: 'bot-a', name: 'Cindy', description: '', avatar: '', avatarColor: '', status: 'active', canonicalSessionId: 'main-a', lastMessagePreview: null, lastMessageAt: null, lastMessageRole: null, needsAttention: false, hiddenAt: null, pinnedAt: null, activityAt: 1, currentVersion: 3, updatedAt: 1 };
  const settings = { source, identity: '', userContext: '', memory: true, permissions: 'auto', modelChain: [], followsDefault: true, skills: ['existing'], connections: [], toolsets: [], systemSkillsOff: undefined as BotSystemSkillId[] | undefined };
  let skill: BotSkillDetail = { slug: 'learned', name: '写简报', description: '写简报时使用', body: '保留准确来源。', updatedAt: '1' };
  const catalog = [{ id: 'existing', name: 'Existing', description: 'A skill', available: false, joined: true }, { id: 'new', name: 'New', description: 'Available skill', available: true, joined: false }];
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 8, 1, 0, 0, clock++)).toISOString();
  const memories = new Map<string, BotMemoryDetail>([
    ['user_coffee.md', { filename: 'user_coffee.md', type: 'user', title: '喝咖啡', body: '早上喝美式，不加糖。', updatedAt: stamp() }],
    ['feedback_short.md', { filename: 'feedback_short.md', type: 'feedback', title: '简短回复', body: '回复先给结论。'.repeat(40), updatedAt: stamp() }],
    ['feedback_sources.md', { filename: 'feedback_sources.md', type: 'feedback', title: '注明来源', body: '引用要带链接。', updatedAt: stamp() }],
  ]);
  const gone = () => createIpcError('NOT_FOUND', 'Memory not found');
  const changed = () => createIpcError('PRECONDITION_FAILED', 'bot-memory-changed');
  const memory: BotRemoteEditorDeps['memory'] = {
    list: vi.fn(async (_botId: string, query?: string) => [...memories.values()]
      .filter(item => !query || item.title.includes(query) || item.body.includes(query))
      .map(({ body, ...item }) => ({ ...item, preview: body }))),
    read: vi.fn(async (_botId: string, filename: string) => { const item = memories.get(filename); if (!item) throw gone(); return { ...item }; }),
    update: vi.fn(async input => {
      const item = memories.get(input.filename); if (!item) throw gone(); if (item.updatedAt !== input.expectedUpdatedAt) throw changed();
      const next = { ...item, title: input.title, body: input.body, updatedAt: stamp() }; memories.set(input.filename, next); return next;
    }),
    delete: vi.fn(async input => {
      const item = memories.get(input.filename); if (!item) throw gone(); if (item.updatedAt !== input.expectedUpdatedAt) throw changed();
      memories.delete(input.filename);
    }),
  };
  const deps: BotRemoteEditorDeps = {
    owner: () => owner, assertOwner: captured => { if (captured !== owner) throw Error('OWNER_CHANGED'); },
    read: vi.fn(async () => settings), update: vi.fn(async (input: Record<string, unknown>) => {
      const capabilities = input.capabilities as { systemSkillsOff?: BotSystemSkillId[] } | undefined;
      if (capabilities?.systemSkillsOff) settings.systemSkillsOff = capabilities.systemSkillsOff;
      source.currentVersion++;
    }),
    modelDefaults: vi.fn(async () => []),
    create: vi.fn(async () => {}), avatar: vi.fn(async () => {}),
    skills: vi.fn(async () => [skill]), skill: vi.fn(async () => skill), saveSkill: vi.fn(async (_bot, value) => { skill = value; }),
    removeSkill: vi.fn(async () => {}), capabilities: vi.fn(async () => catalog), memory,
    setSkillEnabled: vi.fn(async (_bot: string, _slug: string, enabled: boolean) => { skill = { ...skill, enabled }; }),
    coreGuide: vi.fn((off: readonly string[]) => `## teammate-guide\nOff: ${off.join(',')}`),
  };
  const host = createBotRemoteSettingsResource({ ...deps, lifecycle: vi.fn(async () => ({})) });
  const get = createBotRemoteEditors(deps, host.bindResource);
  const context = { controllerDeviceId: 'phone' };
  const client = { protocolVersion: 1, primitives: ['form'] };
  const resource = (id: string) => get(context, id, 'zh-CN');
  const send = (resource: Awaited<ReturnType<typeof get>>, input: Record<string, unknown>, index = 0) => host.invoke(context, { collectionId: 'teammates', resourceRef: resource.ref, actionId: resource.actions![index].id, input, client });
  const entries = (resource: Awaited<ReturnType<typeof get>>, id?: string) => ((id ? resource.blocks!.find(block => block.id === id)! : resource.blocks![0]).data as { entries: Array<{ id: string; resourceId: string; subtitle?: unknown }> }).entries;
  const teammateWrites = (filename: string) => { memories.set(filename, { ...memories.get(filename)!, body: '伙伴刚写入的新内容。', updatedAt: stamp() }); };
  return { resource, get, context, send, entries, deps, settings, catalog, memories, teammateWrites, changeSkill: () => { skill = { ...skill, body: '在电脑上修改后的正文。' }; }, owner: (next: string) => { owner = next; } };
}
describe('portable teammate editors', () => {
  it('accepts one explicit creation model without changing the default or losing intent identity', async () => {
    const f = fixture();
    const route = { harness: 'pi', model: 'available', providerId: 'provider', effort: '', fastMode: false };
    const input = { name: 'Nova', avatarImageBase64: 'aGVsbG8=', requestId: 'model-intent-12345678', modelChain: JSON.stringify([route]) };
    await f.send(await f.resource('create'), input);
    expect(f.deps.create).toHaveBeenCalledWith(expect.objectContaining({ capabilities: { modelChainOverride: [route] } }));
    expect(f.deps.update).not.toHaveBeenCalled();
    await expect(f.send(await f.resource('create'), { ...input, modelChain: '[]' })).rejects.toThrow();
    await expect(f.send(await f.resource('create'), { ...input, modelChain: JSON.stringify([route, route]) })).rejects.toThrow();
  });

  it('keeps the same durable create identity across a lost ACK, but separates paired controllers and owners', async () => {
    const f = fixture(); const input = { name: '小助手', avatarImageBase64: 'aGVsbG8=', requestId: 'same-intent-12345678' };
    await f.send(await f.resource('create'), input); await f.send(await f.resource('create'), input);
    const calls = vi.mocked(f.deps.create).mock.calls;
    expect(calls[0][0]).toEqual(calls[1][0]);
    expect(calls[0][0]).toMatchObject({ name: '小助手', locale: 'zh-CN' });
    f.owner('b'); await f.send(await f.resource('create'), input);
    expect(vi.mocked(f.deps.create).mock.calls[2][0].id).not.toBe(calls[0][0].id);
  });
  it('rejects hidden create fields, empty names and missing intent identity', async () => {
    const f = fixture();
    for (const input of [{ name: '', requestId: 'same-intent-12345678', avatarImageBase64: 'x' }, { name: 'Cindy', avatarImageBase64: 'x' }, { name: 'Cindy', requestId: 'same-intent-12345678', avatarImageBase64: 'x', permissions: 'trusted' }])
      await expect(f.send(await f.resource('create'), input)).rejects.toThrow();
    expect(f.deps.create).not.toHaveBeenCalled();
  });
  it('opens learned skill content, patches just edited fields and preserves its stable slug', async () => {
    const f = fixture(); const shelf = await f.resource('settings:bot-a/skills');
    const detail = await f.resource(f.entries(shelf, 'skills')[0].resourceId);
    expect(detail.actions![1]).toMatchObject({ tone: 'destructive', confirmation: expect.any(Object) });
    await f.send(detail, { body: '新的写作步骤。' });
    expect(f.deps.saveSkill).toHaveBeenCalledWith('bot-a', expect.objectContaining({ slug: 'learned', name: '写简报', description: '写简报时使用', body: '新的写作步骤。' }));
  });
  it('keeps oversized skill content read-only, labels the bounded preview and offers only the on/off switch', async () => {
    const f = fixture(); const body = '完整内容'.repeat(5_000);
    vi.mocked(f.deps.skill).mockResolvedValue({ slug: 'learned', name: 'Large', description: '', body, updatedAt: '1' });
    const detail = await f.resource('settings:bot-a/skills/learned');
    expect(detail.actions!.map(action => action.fields?.map(field => field.id))).toEqual([['enabled']]);
    expect(detail.blocks![0].fallbackMarkdown).toContain('仅预览部分内容');
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(55_000);
    await expect(f.send(detail, { body: 'clipped' })).rejects.toThrow();
    expect(f.deps.saveSkill).not.toHaveBeenCalled();
    await f.send(await f.resource('settings:bot-a/skills/learned'), { enabled: false });
    expect(f.deps.setSkillEnabled).toHaveBeenCalledExactlyOnceWith('bot-a', 'learned', false);
    // Greptile #8330: turning a skill off only moves its folder, so even a body over the store's
    // rewrite limit keeps a working switch.
    vi.mocked(f.deps.skill).mockResolvedValue({ slug: 'learned', name: 'Huge', description: '', body: 'x'.repeat(70 * 1024), updatedAt: '1' });
    expect((await f.resource('settings:bot-a/skills/learned')).actions![0].disabled).toBe(false);
  });
  it('does not overwrite a skill changed by another writer or delete after that conflict', async () => {
    const f = fixture(); const detail = await f.resource('settings:bot-a/skills/learned'); f.changeSkill();
    await expect(f.send(detail, { body: 'stale' })).rejects.toThrow();
    await expect(f.send(detail, {}, 1)).rejects.toThrow();
    expect(f.deps.saveSkill).not.toHaveBeenCalled(); expect(f.deps.removeSkill).not.toHaveBeenCalled();
  });
  it('deletes only the selected personal skill through its owner service', async () => {
    const f = fixture(); await f.send(await f.resource('settings:bot-a/skills/learned'), {}, 1);
    expect(f.deps.removeSkill).toHaveBeenCalledWith('bot-a', 'learned');
  });
  it('keeps unavailable selected references removable and changes only the requested category', async () => {
    const f = fixture(); const list = await f.resource('settings:bot-a/connections/skill');
    const detail = await f.resource(f.entries(list)[0].resourceId);
    await f.send(detail, { joined: false });
    expect(f.deps.update).toHaveBeenCalledWith({ id: 'bot-a', capabilities: { skills: [], skillMode: 'allowlist' } }, 3);
    expect(f.deps.removeSkill).not.toHaveBeenCalled();
  });
  it('rejects a stale capability selection and arbitrary resource paths', async () => {
    const f = fixture(); const list = await f.resource('settings:bot-a/connections/skill');
    const detail = await f.resource(f.entries(list)[1].resourceId); f.settings.source.currentVersion++;
    await expect(f.send(detail, { joined: true })).rejects.toThrow();
    for (const id of ['settings:bot-a/skills/../../secret', 'settings:bot-a/connections/credentials', 'settings:bot-a/unknown']) await expect(f.resource(id)).rejects.toThrow();
    expect(f.deps.update).not.toHaveBeenCalled();
  });
  // Skill layers (cindy-bots-runtime.md §6「伙伴技能分层」) on the phone's generic settings pages. Unit, in-memory deps.
  // Gap: the page listed learned skills only. Minimal input: one learned skill turned off, `routine` off.
  it('lists the read-only core, the three system Skills and every learned skill, marking the ones turned off', async () => {
    const f = fixture(); f.settings.systemSkillsOff = ['routine'];
    await f.deps.setSkillEnabled('bot-a', 'learned', false);
    const shelf = await f.resource('settings:bot-a/skills');
    expect(shelf.blocks!.map(block => block.id)).toEqual(['core', 'system', 'skills']);
    expect(f.entries(shelf, 'core')).toMatchObject([{ resourceId: 'settings:bot-a/skills/_core', subtitle: { translations: { 'zh-CN': '所有伙伴共用 · 始终开启 · 随 Cindy 更新' } } }]);
    expect(f.entries(shelf, 'system').map(entry => [entry.resourceId, !!entry.subtitle])).toEqual([
      ['settings:bot-a/skills/_todo', false], ['settings:bot-a/skills/_routine', true], ['settings:bot-a/skills/_follow', false]]);
    expect(f.entries(shelf, 'skills')).toMatchObject([{ resourceId: 'settings:bot-a/skills/learned', subtitle: { fallback: 'Off' } }]);
    const core = await f.resource('settings:bot-a/skills/_core');
    expect(core.actions ?? []).toEqual([]);
    expect(core.blocks!.map(block => block.fallbackMarkdown)).toEqual([expect.stringContaining('了解自己'), '## teammate-guide\nOff: routine']);
    expect(f.deps.coreGuide).toHaveBeenCalledWith(['routine']);
    // `_` never collides with a learned slug, and only the three system ids exist.
    await expect(f.resource('settings:bot-a/skills/_memory')).rejects.toThrow();
  });
  it('turns a system Skill off and on against the profile version the page was opened at', async () => {
    const f = fixture();
    const todo = await f.resource('settings:bot-a/skills/_todo');
    expect(todo.blocks![0]).toMatchObject({ id: 'capability', data: { values: { enabled: true } } });
    expect(todo.blocks![0].fallbackMarkdown).toContain('到期提醒你');
    await expect(f.send(todo, { enabled: 'no' })).rejects.toThrow();
    await f.send(await f.resource('settings:bot-a/skills/_todo'), { enabled: false });
    expect(f.deps.update).toHaveBeenLastCalledWith({ id: 'bot-a', capabilities: { systemSkillsOff: ['todo'] } }, 3);
    const follow = await f.resource('settings:bot-a/skills/_follow');
    f.settings.source.currentVersion++;
    await expect(f.send(follow, { enabled: false })).rejects.toThrow();
    expect(f.deps.update).toHaveBeenCalledTimes(1);
    await f.send(await f.resource('settings:bot-a/skills/_todo'), { enabled: true });
    expect(f.deps.update).toHaveBeenLastCalledWith({ id: 'bot-a', capabilities: { systemSkillsOff: [] } }, 5);
  });
  it('turns a learned skill off without rewriting it and back on together with an edit', async () => {
    const f = fixture();
    const detail = await f.resource('settings:bot-a/skills/learned');
    expect(detail.blocks![0].data).toMatchObject({ values: { enabled: true, body: '保留准确来源。' } });
    await f.send(detail, { enabled: false });
    expect(f.deps.setSkillEnabled).toHaveBeenLastCalledWith('bot-a', 'learned', false);
    expect(f.deps.saveSkill).not.toHaveBeenCalled();
    expect(f.entries(await f.resource('settings:bot-a/skills'), 'skills')[0].subtitle).toBeDefined();
    const off = await f.resource('settings:bot-a/skills/learned');
    expect(off.blocks![0].data).toMatchObject({ values: { enabled: false } });
    await f.send(off, { enabled: true, body: '新的步骤。' });
    expect(f.deps.saveSkill).toHaveBeenCalledWith('bot-a', expect.objectContaining({ slug: 'learned', body: '新的步骤。' }));
    expect(f.deps.setSkillEnabled).toHaveBeenLastCalledWith('bot-a', 'learned', true);
    expect(f.deps.setSkillEnabled).toHaveBeenCalledTimes(2);
  });
  it('binds avatar changes to the original profile and rejects cross-account saves', async () => {
    const f = fixture(); const panel = await f.resource('settings:bot-a/avatar'); f.owner('b');
    await expect(f.send(panel, { avatarImageBase64: 'aGVsbG8=' })).rejects.toThrow('OWNER_CHANGED');
    expect(f.deps.avatar).not.toHaveBeenCalled();
  });
});

describe('portable teammate memory pages', () => {
  type Group = { id: string; data: { count: number; entries: Array<{ id: string; title: string; subtitle: string; timestamp?: number; resourceId: string }> } };
  const groups = (resource: { blocks?: unknown[] }) => (resource.blocks as Group[]).filter(block => block.id.startsWith('memory-'));
  it('lists far more than a fixed page of memories and stays inside one device-link frame', async () => {
    const f = fixture(); f.memories.clear();
    for (let i = 0; i < 1200; i++) f.memories.set(`project_m${i}.md`, { filename: `project_m${i}.md`, type: 'project', title: `Project ${i}`, body: 'x'.repeat(140), updatedAt: new Date(Date.UTC(2026, 8, 1) + i).toISOString() });
    const [project] = groups(await f.resource('settings:bot-a/memory'));
    expect(project.data.count).toBe(1200);
    expect(project.data.entries).toHaveLength(1200);
    expect(project.data.entries.every(entry => entry.subtitle === 'x'.repeat(140))).toBe(true);
    f.memories.clear();
    for (let i = 0; i < 3000; i++) f.memories.set(`project_m${i}.md`, { filename: `project_m${i}.md`, type: 'project', title: `Project ${i}`, body: '记'.repeat(200), updatedAt: new Date(Date.UTC(2026, 8, 1) + i).toISOString() });
    const large = await f.resource('settings:bot-a/memory');
    const [bounded] = groups(large);
    // Previews stop first; the mobile per-list ceiling (2000) bounds the rest.
    expect(bounded.data.count).toBe(3000);
    expect(bounded.data.entries).toHaveLength(2000);
    expect(bounded.data.entries[0].subtitle).toBeTruthy();
    expect(bounded.data.entries.at(-1)).not.toHaveProperty('subtitle');
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(2 * 1024 * 1024);
  });
  it('groups saved memories by kind with counts and excerpts, and offers search only to declaring controllers', async () => {
    const f = fixture();
    const plain = await f.resource('settings:bot-a/memory');
    expect(groups(plain).map(group => [group.id, group.data.count])).toEqual([['memory-user', 1], ['memory-feedback', 2]]);
    expect(plain.blocks!.some(block => block.id === 'search')).toBe(false);
    const [coffee] = groups(plain)[0].data.entries;
    expect(coffee).toMatchObject({ id: 'user_coffee', title: '喝咖啡', subtitle: '早上喝美式，不加糖。', resourceId: 'settings:bot-a/memory/user_coffee' });
    expect(typeof coffee.timestamp).toBe('number');
    expect(Array.from(groups(plain)[1].data.entries[0].subtitle).length).toBeLessThanOrEqual(141);
    expect(plain.actions ?? []).toEqual([]);
    expect(JSON.stringify(plain)).not.toMatch(/filename|\.md|digest/);
    const searched = await f.get(f.context, 'settings:bot-a/memory', 'zh-CN', { query: '链接', primitives: ['form', 'search'] });
    expect(f.deps.memory.list).toHaveBeenLastCalledWith('bot-a', '链接');
    expect(searched.blocks![0]).toMatchObject({ id: 'search', primitive: 'search', data: { query: '链接' } });
    expect(groups(searched).map(group => group.data.entries.map(entry => entry.id))).toEqual([['feedback_sources']]);
    expect(searched.revision).not.toBe(plain.revision);
  });
  it('saves only against the updatedAt it was opened at and never overwrites or deletes a newer teammate write', async () => {
    const f = fixture();
    const detail = await f.resource('settings:bot-a/memory/user_coffee');
    const opened = f.memories.get('user_coffee.md')!.updatedAt;
    expect(detail.revision).toBe(opened);
    expect(detail.display).toMatchObject({ title: '喝咖啡', subtitle: { fallback: 'About you' } });
    expect(detail.blocks![0].data).toMatchObject({ values: { title: '喝咖啡', body: '早上喝美式，不加糖。' } });
    const receipt = await f.send(detail, { body: '只喝美式。' });
    expect(f.deps.memory.update).toHaveBeenCalledWith({ botId: 'bot-a', filename: 'user_coffee.md', title: '喝咖啡', body: '只喝美式。', expectedUpdatedAt: opened });
    expect(receipt.effects).toContainEqual({ kind: 'refresh-resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'settings:bot-a/memory' } });
    const stale = await f.resource('settings:bot-a/memory/user_coffee');
    f.teammateWrites('user_coffee.md');
    await expect(f.send(stale, { body: '手机上的旧草稿' })).rejects.toThrow();
    await expect(f.send(stale, {}, 1)).rejects.toThrow();
    expect(f.deps.memory.update).toHaveBeenCalledTimes(1);
    expect(f.deps.memory.delete).not.toHaveBeenCalled();
    expect(f.memories.get('user_coffee.md')!.body).toBe('伙伴刚写入的新内容。');
  });
  it('confirms deletion with the teammate and memory names and deletes through the service', async () => {
    const f = fixture();
    const detail = await f.resource('settings:bot-a/memory/feedback_sources');
    expect(detail.actions![1]).toMatchObject({ tone: 'destructive', confirmation: { body: { translations: { 'zh-CN': 'Cindy之后不会再参考「注明来源」。' } } } });
    // #8157/r4427953333: the real remote resource previously tested only zh-CN;
    // a named teammate + titled entry must also carry localized consequences (unit tier).
    const body = detail.actions![1].confirmation!.body!;
    expect(typeof body).toBe('object');
    for (const locale of ['es', 'fr', 'de', 'pt-PT', 'pt-BR']) {
      const translated = typeof body === 'object' ? body.translations?.[locale] : undefined;
      expect(translated, locale).toEqual(expect.stringContaining('Cindy'));
      expect(translated, locale).toEqual(expect.stringContaining('注明来源'));
      expect(translated, locale).not.toBe(typeof body === 'object' ? body.fallback : body);
    }
    await f.send(detail, {}, 1);
    expect(f.deps.memory.delete).toHaveBeenCalledWith({ botId: 'bot-a', filename: 'feedback_sources.md', expectedUpdatedAt: detail.revision });
    await expect(f.resource('settings:bot-a/memory/feedback_sources')).rejects.toBeInstanceOf(RemoteResourceRegistryError);
  });
  it('rejects internal kinds, traversal and fields outside the memory form before writes', async () => {
    const f = fixture();
    for (const id of ['settings:bot-a/memory/digest_x', 'settings:bot-a/memory/../secret', 'settings:bot-a/memory/user_coffee.md', 'settings:bot-a/memory/user_coffee/x', 'settings:bot-a/memory/hzzzz'])
      await expect(f.resource(id)).rejects.toThrow();
    for (const input of [{ description: 'hidden digest' }, {}, { filename: 'feedback_short.md', body: 'x' }, { body: 42 }])
      await expect(f.send(await f.resource('settings:bot-a/memory/user_coffee'), input)).rejects.toThrow();
    await expect(f.send(await f.resource('settings:bot-a/memory/user_coffee'), { confirm: true }, 1)).rejects.toThrow();
    expect(f.deps.memory.update).not.toHaveBeenCalled();
    expect(f.deps.memory.delete).not.toHaveBeenCalled();
  });
  it('keeps entries of a long teammate id addressable within the protocol id limit', async () => {
    const f = fixture(); const botId = `bot_${'x'.repeat(124)}`;
    const list = await f.resource(`settings:${botId}/memory`);
    const ids = groups(list).flatMap(group => group.data.entries.map(entry => entry.resourceId));
    expect(ids.every(id => id.length <= 160)).toBe(true);
    const hashed = ids.find(id => /\/h[a-f0-9]{12}$/.test(id));
    expect(hashed).toBeDefined();
    const detail = await f.resource(hashed!);
    expect(detail.ref.id).toBe(hashed);
    expect(f.deps.memory.read).toHaveBeenLastCalledWith(botId, expect.stringMatching(/\.md$/));
  });
  it('drops a memory read that finishes after the account changed', async () => {
    const f = fixture();
    vi.mocked(f.deps.memory.read).mockImplementationOnce(async () => { f.owner('b'); return { ...f.memories.get('user_coffee.md')! }; });
    await expect(f.resource('settings:bot-a/memory/user_coffee')).rejects.toThrow('OWNER_CHANGED');
  });
});

// Existing opaque grants must bind follow-up consent to this owner, computer and current choice.
it('keeps follow-up off until chosen and rejects an invitation made stale by another explicit choice', async () => {
  const f = fixture();
  let choice = { schedulerBotId: null as string | null, isCustomized: false, defaults: { schedulerBotId: null } };
  f.deps.followUp = { get: vi.fn(async () => choice), set: vi.fn(async id => {
    choice = { ...choice, isCustomized: true, schedulerBotId: id }; return choice;
  }) };
  const read = () => f.resource('settings:bot-a/follow-up');
  const invitation = await read();
  expect((invitation.blocks![0].data as any).invitationAvailable).toBe(true);
  expect(f.deps.followUp.set).not.toHaveBeenCalled();
  await f.send(invitation, {}, 1);
  expect(choice).toMatchObject({ schedulerBotId: null, isCustomized: true });
  expect((await read()).blocks![0].data).toMatchObject({ invitationAvailable: false });
  await expect(f.send(invitation, { enabled: true })).rejects.toThrow();
  await f.send(await read(), { enabled: true });
  expect(choice.schedulerBotId).toBe('bot-a');
  const enabled = await read();
  expect(enabled.actions![0].confirmation).toBeUndefined();
  await f.send(enabled, { enabled: false });
  expect(choice.schedulerBotId).toBeNull();
  const stale = await read(); f.owner('b');
  await expect(f.send(stale, { enabled: true })).rejects.toThrow();
});

// Restored project links use existing opaque settings actions. Minimal input: two projects and a stale save.
// Covers list/detail/save, device paths withheld and owner-bound rejection; unit, no network.
it('links multiple projects through settings while keeping paths private and rejecting stale or foreign saves', async () => {
  const f = fixture();
  const projects = [
    { id: 'a'.repeat(64), name: 'First', path: '/PRIVATE/first', linked: true, available: true },
    { id: 'b'.repeat(64), name: 'Second', path: '/PRIVATE/second', linked: false, available: true },
    { id: 'c'.repeat(64), name: 'Remote', path: '/PRIVATE/remote', deviceId: 'other', linked: true, available: false },
  ];
  f.deps.projects = { list: vi.fn(async () => projects.map(project => ({ ...project }))), set: vi.fn(async (_bot, id, linked) => { projects.find(p => p.id === id)!.linked = linked; }) };
  const list = await f.resource('settings:bot-a/projects');
  expect(f.entries(list)).toHaveLength(3);
  expect(JSON.stringify(list)).not.toContain('/PRIVATE');
  const id = 'settings:bot-a/projects/' + projects[1].id;
  const detail = await f.resource(id);
  expect(JSON.stringify(detail)).not.toContain('/PRIVATE');
  expect(f.deps.projects.set).not.toHaveBeenCalled();
  await f.send(detail, { linked: true });
  expect(projects.map(p => p.linked)).toEqual([true, true, true]);
  await expect(f.send(detail, { linked: false })).rejects.toThrow();
  const foreign = await f.resource(id); f.owner('other');
  await expect(f.send(foreign, { linked: false })).rejects.toThrow();
  expect(projects[1].linked).toBe(true);
  f.owner('a');
  await f.send(await f.resource(id), { linked: false });
  expect(projects.map(p => p.linked)).toEqual([true, false, true]);
});

// PR #6813: equal carried paths on different devices previously had identical phone labels.
// Unit: real resource/action projection, two device-specific links; existing path privacy retained.
it('distinguishes equal project paths on different devices in the list and toggle detail', async () => {
  const f = fixture();
  const projects = ['desk-a', 'desk-b'].map((deviceId, index) => ({
    id: String(index).repeat(64), name: 'app', path: '/PRIVATE/app', deviceId, linked: true, available: false,
  }));
  f.deps.projects = {
    list: async () => projects.map(project => ({ ...project })),
    set: async (_bot, id, linked) => { projects.find(project => project.id === id)!.linked = linked; },
  };
  const list = await f.resource('settings:bot-a/projects');
  expect(f.entries(list)).toMatchObject([
    { title: expect.stringContaining('desk-a') }, { title: expect.stringContaining('desk-b') },
  ]);
  const detail = await f.resource(f.entries(list)[0].resourceId);
  expect(detail.display.title).toContain('desk-a');
  expect(JSON.stringify([list, detail])).not.toContain('/PRIVATE');
  await f.send(detail, { linked: false });
  expect(projects.map(project => project.linked)).toEqual([false, true]);
});
