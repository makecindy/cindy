import { describe, expect, it, vi } from 'vitest';
import { companionArtifactRows, loadCompanionProfile, parseCompanionProfileData, profileFormDirty } from '../session/companionProfileData';
const ref = { collectionId: 'teammates', kind: 'bot', id: 'bot-a' };
const raw = () => ({ ref, revision: 'v1', display: { title: 'Cindy' }, links: [], actions: [{ id: 'opaque-token', label: 'Save', fields: [{ id: 'name', kind: 'text', label: 'Name' }] }], blocks: [{ id: 'profile', primitive: 'form', fallbackMarkdown: 'Profile', data: { actionId: 'opaque-token', values: { name: 'Cindy', privateField: 'ignored' } } }] });
describe('companion profile finite resource primitives', () => {
  it('only binds fields explicitly advertised by the host', () => {
    const data = parseCompanionProfileData(raw(), ref);
    expect(data.panels[0].values).toEqual({ name: 'Cindy' });
    expect(data.panels[0].action?.id).toBe('opaque-token');
    expect(profileFormDirty(data.panels[0], { name: 'Cindy' })).toBe(false);
    expect(profileFormDirty(data.panels[0], { name: 'New' })).toBe(true);
  });
  it('keeps legacy hosts read-only and rejects wrong resource identities', () => {
    expect(parseCompanionProfileData({ ...raw(), actions: undefined, blocks: undefined }, ref).panels).toEqual([]);
    expect(() => parseCompanionProfileData(raw(), { ...ref, id: 'bot-b' })).toThrow();
  });
  it('unknown primitives and unknown field kinds cannot create writable controls', () => {
    const unknown = raw(); unknown.blocks[0].primitive = 'execute-script';
    expect(parseCompanionProfileData(unknown, ref).panels[0].action).toBeUndefined();
    const field = raw(); field.actions[0].fields[0].kind = 'password';
    expect(parseCompanionProfileData(field, ref).panels[0].action).toBeUndefined();
  });
  it('malformed confirmations cannot silently remove a required confirmation', () => {
    const input = { ...raw(), actions: [{ ...raw().actions[0], confirmation: { title: 123 } }] };
    expect(parseCompanionProfileData(input, ref).panels[0].action).toBeUndefined();
  });
  it('rejects the entire form when any value is oversized or has the wrong type', () => {
    const oversized = raw(); oversized.blocks[0].data.values.name = 'x'.repeat(65_537);
    expect(parseCompanionProfileData(oversized, ref).panels[0].action).toBeUndefined();
    const wrongType = raw(); wrongType.actions[0].fields[0].kind = 'toggle';
    expect(parseCompanionProfileData(wrongType, ref).panels[0].action).toBeUndefined();
  });
  it('indexes only this teammate’s real relative output files, excluding deleted files and host paths', () => {
    const row = { id: 'task-a', requestingBotId: 'bot-a', title: 'Report', childSessionId: 'child-a', artifacts: [
      { path: 'report.pdf', status: 'added', absolutePath: '/private/report.pdf' },
      { path: 'gone.pdf', status: 'deleted' }, { path: '/private/secret', status: 'added' },
      { path: 'C:\\private', status: 'added' }, { path: '../private', status: 'added' },
    ] };
    const result = companionArtifactRows({ ok: true, delegations: [row, { ...row, requestingBotId: 'bot-b' }] }, 'bot-a');
    expect(result).toEqual([{ id: 'task-a', title: 'Report', childSessionId: 'child-a', files: ['report.pdf'] }]);
    expect(companionArtifactRows({ ok: true, delegations: [{ id: 'old' }] }, 'bot-a')).toEqual([]);
  });
  it('reads only through the generic get channel and negotiates form support', async () => {
    const invoke = vi.fn(async () => raw());
    await loadCompanionProfile(invoke as never, 'host-a', ref, 'en');
    expect(invoke).toHaveBeenCalledWith('host-a', 'maker:remote-resources:get', [{ client: { protocolVersion: 1, primitives: ['status', 'session-link', 'markdown', 'form', 'action', 'list', 'search'], locale: 'en' }, ref }]);
  });
  it('sends a search query only when one is typed', async () => {
    const invoke = vi.fn(async () => raw());
    await loadCompanionProfile(invoke as never, 'host-a', ref, 'en', { query: '  ' });
    expect((invoke.mock.calls[0] as unknown[])[2]).toEqual([expect.not.objectContaining({ query: expect.anything() })]);
    await loadCompanionProfile(invoke as never, 'host-a', ref, 'en', { query: ' 咖啡 ' });
    expect((invoke.mock.calls[1] as unknown[])[2]).toEqual([expect.objectContaining({ query: '咖啡' })]);
  });
  it('keeps additive list metadata and the search block while ignoring malformed extras', () => {
    const list = { ...raw(), actions: [], blocks: [
      { id: 'search', primitive: 'search', fallbackMarkdown: '', data: { query: '咖啡', placeholder: { fallback: 'Search memories' } } },
      { id: 'memory-user', primitive: 'list', title: 'About you', fallbackMarkdown: '- Coffee', data: { count: 3, entries: [
        { id: 'user_coffee', title: 'Coffee', resourceId: 'settings:bot-a/memory/user_coffee', subtitle: 'Black, no sugar', timestamp: 1_000 },
        { id: 'user_tea', title: 'Tea', resourceId: 'settings:bot-a/memory/user_tea', subtitle: 42, timestamp: 'yesterday' },
      ] } },
    ] };
    const [search, group] = parseCompanionProfileData(list, ref).panels;
    expect(search).toMatchObject({ primitive: 'search', query: '咖啡', placeholder: { fallback: 'Search memories' } });
    expect(group).toMatchObject({ primitive: 'list', count: 3, title: 'About you' });
    expect(group.entries).toEqual([
      { id: 'user_coffee', title: 'Coffee', resourceId: 'settings:bot-a/memory/user_coffee', subtitle: 'Black, no sugar', timestamp: 1_000 },
      { id: 'user_tea', title: 'Tea', resourceId: 'settings:bot-a/memory/user_tea' },
    ]);
  });
});
it('preserves a host-disabled action rather than silently enabling it', () => {
  const input = { ...raw(), actions: [{ ...raw().actions[0], disabled: true }] };
  expect(parseCompanionProfileData(input, ref).panels[0].action?.disabled).toBe(true);
});

it('recognizes creation model support without exposing a raw JSON form field to legacy clients', () => {
  const input = raw();
  input.blocks[0].id = 'create';
  Object.assign(input.blocks[0].data, { creationModelChain: '[]' });
  const panel = parseCompanionProfileData(input, ref).panels[0];
  expect(panel.creationModelChain).toBe('[]');
  expect(panel.action?.fields?.map(field => field.id)).toEqual(['name']);
  expect(parseCompanionProfileData(raw(), ref).panels[0].creationModelChain).toBeUndefined();
});

// Review regression: use the production host form and mobile parser, not a copied JSON schema.
// Legal maximum route IDs (including escaped characters) must remain editable on older clients.
// vi.importActual loads the pure host projection once without adding desktop types to the app graph.
const { createBotRemoteSettingsResource } = await vi.importActual<{ createBotRemoteSettingsResource: (deps: any) => any }>(
  '../../../desktop/src/main/localDb/ipc/botRemoteSettingsResource.ts');
it('round-trips maximum media route IDs through real host grants and the mobile parser', async () => {
  const route = { providerId: 'p'.repeat(512), modelId: '\u0001'.repeat(2048) };
  const settings: any = { source: { id: 'bot-a', name: 'Cindy', avatar: '', avatarColor: 'teal', description: 'Assistant', currentVersion: 1, status: 'active' }, identity: '', userContext: '', memory: true, permissions: 'ask', modelChain: [], followsDefault: true, skills: [], connections: [], toolsets: [] };
  const update = vi.fn(async (input: any) => { Object.assign(settings, input.capabilities); settings.source.currentVersion++; });
  const deps: any = { owner: () => 'owner', assertOwner() {}, read: async () => settings, update, skills: async () => [], lifecycle: async () => ({}),
    mediaModels: async () => ({ vision: [{ ...route, label: 'Vision' }], image: [{ ...route, label: 'Image' }], video: [{ ...route, label: 'Video' }] }) };
  const host = createBotRemoteSettingsResource(deps);
  const context = { controllerDeviceId: 'phone' };
  const get = async () => parseCompanionProfileData(await host.get(context, 'bot-a'), ref);
  const panel = (await get()).panels.find(item => item.id === 'media')!;
  expect(panel.action).toBeDefined();
  const input = Object.fromEntries(panel.action!.fields!.map(field => {
    expect(field.options!.every(option => option.value.length <= 160)).toBe(true);
    return [field.id, field.options![1].value];
  }));
  const invoke = (actionId: string, input: object) => host.invoke(context, { collectionId: 'teammates', resourceRef: ref, actionId, input, client: { protocolVersion: 1, primitives: ['form'] } });
  await invoke(panel.action!.id, input);
  expect(settings.mediaModels).toEqual({ vision: { primary: route, fallback: null }, image: route, video: route });
  deps.mediaModels = async () => { throw new Error('catalog offline'); };
  const saved = (await get()).panels.find(item => item.id === 'media')!;
  expect(saved.notice).toMatchObject({ fallback: expect.stringContaining('unavailable'), translations: expect.objectContaining({ ja: expect.any(String) }) });
  expect(saved.action!.fields!.map(field => field.id)).toContain('fallback');
  await expect(invoke(saved.action!.id, { image: 'not-an-issued-option' })).rejects.toThrow('Invalid media selection');
  await invoke(saved.action!.id, { vision: 'inherit', image: 'inherit', video: 'inherit' });
  expect(settings.mediaModels).toBeNull();
});
