import { describe, expect, it, vi } from 'vitest';
import { createBotRemoteEditors, type BotRemoteEditorDeps } from '../botRemoteEditors.js';
import { createBotRemoteSettingsResource } from '../botRemoteSettingsResource.js';

function fixture() {
  let owner = 'a';
  const source = { id: 'bot-a', name: 'Cindy', description: '', avatar: '', avatarColor: '', status: 'active', canonicalSessionId: 'main-a', lastMessagePreview: null, lastMessageAt: null, lastMessageRole: null, needsAttention: false, hiddenAt: null, pinnedAt: null, activityAt: 1, currentVersion: 3, updatedAt: 1 };
  const settings = { source, identity: '', userContext: '', memory: true, permissions: 'auto', modelChain: [], followsDefault: true, skills: ['existing'], connections: [], toolsets: [] };
  let skill = { slug: 'learned', name: '写简报', description: '写简报时使用', body: '保留准确来源。', updatedAt: '1' };
  const catalog = [{ id: 'existing', name: 'Existing', description: 'A skill', available: false, joined: true }, { id: 'new', name: 'New', description: 'Available skill', available: true, joined: false }];
  const deps: BotRemoteEditorDeps = {
    owner: () => owner, assertOwner: captured => { if (captured !== owner) throw Error('OWNER_CHANGED'); },
    read: vi.fn(async () => settings), update: vi.fn(async () => { source.currentVersion++; }),
    create: vi.fn(async () => {}), avatar: vi.fn(async () => {}),
    skills: vi.fn(async () => [skill]), skill: vi.fn(async () => skill), saveSkill: vi.fn(async (_bot, value) => { skill = value; }),
    removeSkill: vi.fn(async () => {}), capabilities: vi.fn(async () => catalog),
  };
  const host = createBotRemoteSettingsResource({ ...deps, lifecycle: vi.fn(async () => ({})) });
  const get = createBotRemoteEditors(deps, host.bindResource);
  const context = { controllerDeviceId: 'phone' };
  const client = { protocolVersion: 1, primitives: ['form'] };
  const resource = (id: string) => get(context, id, 'zh-CN');
  const send = (resource: Awaited<ReturnType<typeof get>>, input: Record<string, unknown>, index = 0) => host.invoke(context, { collectionId: 'teammates', resourceRef: resource.ref, actionId: resource.actions![index].id, input, client });
  const entries = (resource: Awaited<ReturnType<typeof get>>) => (resource.blocks![0].data as { entries: Array<{ resourceId: string }> }).entries;
  return { resource, send, entries, deps, settings, catalog, changeSkill: () => { skill = { ...skill, body: '在电脑上修改后的正文。' }; }, owner: (next: string) => { owner = next; } };
}
describe('portable teammate editors', () => {
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
    const detail = await f.resource(f.entries(shelf)[0].resourceId);
    expect(detail.actions![1]).toMatchObject({ tone: 'destructive', confirmation: expect.any(Object) });
    await f.send(detail, { body: '新的写作步骤。' });
    expect(f.deps.saveSkill).toHaveBeenCalledWith('bot-a', expect.objectContaining({ slug: 'learned', name: '写简报', description: '写简报时使用', body: '新的写作步骤。' }));
  });
  it('keeps oversized skills read-only and labels the bounded preview', async () => {
    const f = fixture(); const body = '完整内容'.repeat(20_000);
    vi.mocked(f.deps.skill).mockResolvedValue({ slug: 'learned', name: 'Large', description: '', body, updatedAt: '1' });
    const detail = await f.resource('settings:bot-a/skills/learned');
    expect(detail.actions).toEqual([]);
    expect(detail.blocks![0].fallbackMarkdown).toContain('仅预览部分内容');
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(55_000);
    expect(f.deps.saveSkill).not.toHaveBeenCalled();
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
  it('binds avatar changes to the original profile and rejects cross-account saves', async () => {
    const f = fixture(); const panel = await f.resource('settings:bot-a/avatar'); f.owner('b');
    await expect(f.send(panel, { avatarImageBase64: 'aGVsbG8=' })).rejects.toThrow('OWNER_CHANGED');
    expect(f.deps.avatar).not.toHaveBeenCalled();
  });
});
