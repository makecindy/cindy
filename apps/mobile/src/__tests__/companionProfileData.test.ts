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
