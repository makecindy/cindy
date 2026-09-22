import { describe, expect, it, vi } from 'vitest';
import { createBotRemoteSettingsResource, type BotRemoteSettingsDeps } from '../botRemoteSettingsResource.js';

function fixture() {
  let owner = 'owner-a';
  let time = 1;
  const source = { id: 'bot-a', name: 'Cindy', description: 'Assistant', avatar: '', avatarColor: 'teal', status: 'active', canonicalSessionId: 'canonical-a', lastMessagePreview: null, lastMessageAt: null, lastMessageRole: null, needsAttention: false, hiddenAt: null, pinnedAt: null, activityAt: 1, currentVersion: 3, updatedAt: 1 };
  const settings = { source, identity: 'User-maintained personality', userContext: 'Prefers concise replies', memory: true, permissions: 'ask', modelChain: [{ harness: 'pi' as const, model: 'user-selected-model', providerId: 'connected-source', effort: 'high', fastMode: true }], followsDefault: false, skills: ['reference'], connections: ['connection'], toolsets: [], systemPrompt: 'PRIVATE', homeDir: '/PRIVATE', credentials: 'PRIVATE' };
  const deps: BotRemoteSettingsDeps = {
    owner: () => owner, assertOwner: captured => { if (captured !== owner) throw new Error('OWNER_CHANGED'); },
    read: vi.fn(async () => settings), update: vi.fn(async () => { source.currentVersion++; }),
    lifecycle: vi.fn(async (_id, _op, _name, guard) => { await guard(); return {}; }),
    skills: vi.fn(async () => [{ slug: 'learned', name: 'Learned', description: 'Real skill', updatedAt: 1 }]),
    directHistory: vi.fn(async () => 'Cindy: hello'), now: () => time,
  };
  const host = createBotRemoteSettingsResource(deps);
  const context = { controllerDeviceId: 'phone-a' };
  const ref = { collectionId: 'teammates', kind: 'bot', id: source.id };
  const get = () => host.get(context, source.id);
  const request = (actionId: string, input = {}) => ({ collectionId: 'teammates', resourceRef: ref, actionId, input, client: { protocolVersion: 1, primitives: ['form'] } });
  return { host, context, source, settings, deps, get, request, owner: (next: string) => { owner = next; }, time: (next: number) => { time = next; } };
}
function actionId(resource: Awaited<ReturnType<ReturnType<typeof fixture>['get']>>, id: string) {
  return (resource.blocks!.find(block => block.id === id)!.data as { actionId: string }).actionId;
}
describe('opaque teammate settings actions', () => {
  it('detects display-only edits without treating arriving chat messages as a settings conflict', async () => {
    const f = fixture(); const original = await f.get();
    f.source.activityAt++; f.source.updatedAt++;
    expect((await f.get()).revision).toBe(original.revision);
    f.source.name = 'Renamed on desktop';
    await expect(f.host.invoke(f.context, f.request(actionId(original, 'profile'), { name: 'Stale phone name' }))).rejects.toThrow();
    expect(f.deps.update).not.toHaveBeenCalled();
  });
  it('projects only explicit display fields, preserving the complete model route and real shelves', async () => {
    const f = fixture();
    const resource = await f.get();
    expect(JSON.stringify(resource)).not.toContain('PRIVATE');
    expect(resource.blocks?.find(block => block.id === 'models')?.fallbackMarkdown).toContain('user-selected-model · connected-source · pi · high · Fast: true');
    expect(resource.blocks?.find(block => block.id === 'skills')?.fallbackMarkdown).toContain('Learned');
    expect(resource.blocks?.find(block => block.id === 'direct')?.fallbackMarkdown).toBe('Cindy: hello');
  });
  it('saves through the existing profile version service without model or credential overrides', async () => {
    const f = fixture(); const resource = await f.get();
    const response = await f.host.invoke(f.context, f.request(actionId(resource, 'profile'), { name: 'New name', description: 'About', identity: 'Personality' }));
    expect(f.deps.update).toHaveBeenCalledWith({ id: 'bot-a', name: 'New name', description: 'About', identitySource: 'Personality' }, 3);
    expect(response.effects.some(effect => effect.kind === 'toast')).toBe(true);
  });
  it('patches only edited fields after refresh, preserving unrelated settings', async () => {
    const f = fixture(); const resource = await f.get();
    await f.host.invoke(f.context, f.request(actionId(resource, 'memory'), { userContext: 'Changed note' }));
    expect(f.deps.update).toHaveBeenCalledWith({ id: 'bot-a', userContextSource: 'Changed note' }, 3);
  });
  it('rejects stale versions and cross-controller, cross-bot and cross-owner grants', async () => {
    const f = fixture(); const resource = await f.get();
    const request = f.request(actionId(resource, 'memory'), { memory: false, userContext: '' });
    await expect(f.host.invoke({ controllerDeviceId: 'phone-b' }, request)).rejects.toThrow();
    await expect(f.host.invoke(f.context, { ...request, resourceRef: { ...request.resourceRef, id: 'bot-b' } })).rejects.toThrow();
    f.source.currentVersion++;
    await expect(f.host.invoke(f.context, request)).rejects.toThrow();
    f.owner('owner-b');
    await expect(f.host.invoke(f.context, request)).rejects.toThrow('OWNER_CHANGED');
    expect(f.deps.update).not.toHaveBeenCalled();
  });
  it('rejects injected fields and invalid permissions before writes', async () => {
    const f = fixture(); const resource = await f.get();
    await expect(f.host.invoke(f.context, f.request(actionId(resource, 'profile'), { systemPrompt: 'injected' }))).rejects.toThrow();
    await expect(f.host.invoke(f.context, f.request(actionId(resource, 'permissions'), { permissions: 'invented' }))).rejects.toThrow();
    expect(f.deps.update).not.toHaveBeenCalled();
  });
  it('admits only one concurrent invocation of a one-use action', async () => {
    const f = fixture(); const resource = await f.get();
    vi.mocked(f.deps.update).mockImplementation(async () => undefined);
    const request = f.request(actionId(resource, 'memory'), { memory: false, userContext: '' });
    const result = await Promise.allSettled([f.host.invoke(f.context, request), f.host.invoke(f.context, request)]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(f.deps.update).toHaveBeenCalledTimes(1);
  });
  it('serializes two settings grants even when a display-only change keeps the runtime version', async () => {
    const f = fixture(); const first = await f.get(); const second = await f.get();
    vi.mocked(f.deps.update).mockImplementation(async () => undefined);
    const results = await Promise.allSettled([
      f.host.invoke(f.context, f.request(actionId(first, 'profile'), { name: 'First' })),
      f.host.invoke(f.context, f.request(actionId(second, 'profile'), { name: 'Second' })),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.deps.update).toHaveBeenCalledTimes(1);
  });
  it('keeps oversized file-imported profiles read-only rather than saving truncated text', async () => {
    const f = fixture(); f.settings.identity = 'x'.repeat(12_001);
    const resource = await f.get();
    expect(resource.blocks?.find(block => block.id === 'profile')?.primitive).toBe('markdown');
    expect(resource.actions?.some(action => action.fields?.some(field => field.id === 'identity'))).toBe(false);
  });
  it('expires grants and never replays a write after an ambiguous response', async () => {
    const f = fixture(); const resource = await f.get();
    const request = f.request(actionId(resource, 'memory'), { memory: false, userContext: '' });
    vi.mocked(f.deps.update).mockRejectedValueOnce(new Error('write acknowledgement lost'));
    await expect(f.host.invoke(f.context, request)).rejects.toThrow();
    await expect(f.host.invoke(f.context, request)).rejects.toThrow();
    expect(f.deps.update).toHaveBeenCalledTimes(1);
    f.time(16 * 60_000);
    await expect(f.host.invoke(f.context, f.request(actionId(resource, 'restart')))).rejects.toThrow();
    expect(f.deps.lifecycle).not.toHaveBeenCalled();
  });
  it('uses the registered lifecycle coordinator and does not leak raw cleanup errors', async () => {
    const f = fixture(); const resource = await f.get();
    vi.mocked(f.deps.lifecycle).mockResolvedValueOnce({ warnings: ['PRIVATE/path/token'] });
    const result = await f.host.invoke(f.context, f.request(actionId(resource, 'delete'), { confirmName: 'Cindy' }));
    expect(f.deps.lifecycle).toHaveBeenCalledWith('bot-a', 'delete', 'Cindy', expect.any(Function));
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.effects.some(effect => effect.kind === 'refresh-resource')).toBe(false);
  });
  it('does not misreport shelf failure as an empty shelf', async () => {
    const f = fixture(); vi.mocked(f.deps.skills).mockRejectedValue(new Error('unavailable'));
    const result = await f.get();
    expect(result.blocks?.some(block => block.id === 'skills')).toBe(false);
    expect(result.blocks?.some(block => block.id === 'profile')).toBe(true);
  });
  it('wraps fixed inner routine ids in opaque, revision-bound, single-use capabilities', async () => {
    const f = fixture();
    let revision = '1';
    const run = vi.fn(async () => ({ effects: [] }));
    const ref = { collectionId: 'teammates', kind: 'bot', id: 'routine:bot-a/rule-a' };
    const resource = { ref, display: { title: 'Rule' }, revision, links: [], actions: [{ id: 'routine-run', label: 'Run' }], blocks: [{ id: 'routine', primitive: 'routine-detail', fallbackMarkdown: 'Rule', data: {} }] };
    const wrapped = await f.host.bindResource(f.context, resource, async () => revision, run);
    const opaque = wrapped.actions[0]!.id;
    expect(opaque).not.toBe('routine-run');
    expect((wrapped.blocks![0]!.data as { operationActions: Record<string, string> }).operationActions['routine-run']).toBe(opaque);
    const request = { ...f.request(opaque), resourceRef: ref };
    await expect(f.host.invoke(f.context, { ...request, actionId: 'routine-run' })).rejects.toThrow();
    await expect(f.host.invoke({ controllerDeviceId: 'other' }, request)).rejects.toThrow();
    revision = '2';
    await expect(f.host.invoke(f.context, request)).rejects.toThrow();
    revision = '1';
    await f.host.invoke(f.context, request);
    expect(run).toHaveBeenCalledWith({ ...request, actionId: 'routine-run' });
    await expect(f.host.invoke(f.context, request)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects account changes, expiry, and kind changes for generic capabilities', async () => {
    const f = fixture(); const run = vi.fn(async () => ({ effects: [] }));
    const resource = { ref: { collectionId: 'teammates', kind: 'bot', id: 'create' }, display: { title: 'Create' }, revision: '1', links: [], actions: [{ id: 'create', label: 'Create' }] };
    const wrapped = await f.host.bindResource(f.context, resource, async () => '1', run);
    const request = { ...f.request(wrapped.actions[0]!.id), resourceRef: resource.ref };
    await expect(f.host.invoke(f.context, { ...request, resourceRef: { ...resource.ref, kind: 'other' } })).rejects.toThrow();
    f.owner('b'); await expect(f.host.invoke(f.context, request)).rejects.toThrow();
    f.owner('owner-a'); f.time(16 * 60_000); await expect(f.host.invoke(f.context, request)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('drops owner-stale reads before disclosing settings', async () => {
    const f = fixture(); vi.mocked(f.deps.read).mockImplementation(async () => { f.owner('owner-b'); return f.settings; });
    await expect(f.get()).rejects.toThrow('OWNER_CHANGED');
  });
});

it('saves the complete model chain and can restore application defaults', async () => {
  const f = fixture();
  const route = { harness: 'pi', model: 'selected', providerId: 'source', effort: 'high', fastMode: false };
  const resource = await f.get();
  await f.host.invoke(f.context, f.request(actionId(resource, 'models'), { followsDefault: false, modelChain: JSON.stringify([route]) }));
  expect(f.deps.update).toHaveBeenLastCalledWith({ id: 'bot-a', capabilities: { modelChainOverride: [route], modelOverride: null } }, 3);
  const fresh = await f.get();
  await f.host.invoke(f.context, f.request(actionId(fresh, 'models'), { followsDefault: true }));
  expect(f.deps.update).toHaveBeenLastCalledWith({ id: 'bot-a', capabilities: { modelChainOverride: null, modelOverride: null } }, 4);
});
it('rejects invalid, duplicate and oversized model chains without modifying the profile', async () => {
  const f = fixture(); const resource = await f.get();
  const route = { harness: 'pi', model: 'selected', providerId: null, effort: '', fastMode: false };
  for (const value of ['not json', '{}', '[]', JSON.stringify([route, route]), JSON.stringify(Array.from({ length: 6 }, (_, index) => ({ ...route, model: String(index) }))), JSON.stringify([{ ...route, harness: 'unknown' }])]) {
    await expect(f.host.invoke(f.context, f.request(actionId(resource, 'models'), { followsDefault: false, modelChain: value }))).rejects.toThrow();
  }
  expect(f.deps.update).not.toHaveBeenCalled();
});
