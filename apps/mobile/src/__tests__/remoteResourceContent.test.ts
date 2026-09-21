import { describe, expect, it, vi } from 'vitest';
import { getRemoteResource, MOBILE_REMOTE_RESOURCE_PRIMITIVES } from '../device-link/remoteResources';
import { normalizeRemoteActions, normalizeRemoteBlocks } from '../device-link/remoteResourceContent';
import { getRoutineActionId, parseRoutineDetail } from '../session/companionRoutines';
import type { RemoteInvoke } from '../device-link/mobileMakerTransport';
const ref = { collectionId: 'teammates', kind: 'bot', id: 'routine:b/r' };
const action = { id: 'opaque', label: 'Save', fields: [{ id: 'name', label: 'Name', kind: 'text' }] };
const block = { id: 'r', primitive: 'routine-detail', fallbackMarkdown: 'Daily', data: {
  id: 'r', revision: 1, editable: true, input: { name: 'Daily', prompt: 'Read updates', enabled: true, triggers: [{ id: 't', kind: 'interval', intervalMs: 60_000 }] },
  sources: [], history: [], operationActions: { 'routine-save': 'opaque' },
} };
describe('resource content through the actual mobile API boundary', () => {
  it('retains the complete routine and opaque actions instead of projecting them away as a list item', async () => {
    const invoke = vi.fn(async () => ({ ref, display: { title: 'Daily' }, revision: '1', links: [], actions: [action], blocks: [block] })) as RemoteInvoke;
    const result = await getRemoteResource(invoke, { deviceId: 'host', deviceName: 'Mac' }, ref, 'en', ['routine-detail']);
    expect(getRoutineActionId(result, 'routine-save')).toBe('opaque');
    expect(parseRoutineDetail(result.blocks![0]!.data).input).toEqual(block.data.input);
    expect(vi.mocked(invoke).mock.calls[0]![2]).toMatchObject([{ client: { primitives: [...MOBILE_REMOTE_RESOURCE_PRIMITIVES, 'routine-detail'] } }]);
  });
  it('keeps only public invitation progress for the ordinary teammate resolver', async () => {
    const invoke = vi.fn(async () => ({ ref, display: { title: 'Mimi' }, revision: '1', links: [], blocks: [{ id: 'invitation', primitive: 'status', fallbackMarkdown: '', data: { stage: 'skills', generatedDraft: 'private' } }] })) as RemoteInvoke;
    const result = await getRemoteResource(invoke, { deviceId: 'host', deviceName: 'Mac' }, ref, 'en');
    expect(result.blocks?.[0].data).toEqual({ stage: 'skills' });
  });
  it('does not advertise module-specific editors from the generic shell', () => {
    expect(MOBILE_REMOTE_RESOURCE_PRIMITIVES).toEqual(['status', 'session-link', 'session-controls']);
  });
  it('rejects the entire action when one editable field is unsupported or oversized', () => {
    expect(normalizeRemoteActions([{ ...action, fields: [...action.fields, { id: 'future', kind: 'future', label: 'Future' }] }])).toEqual([]);
    expect(normalizeRemoteActions([{ ...action, fields: Array.from({ length: 65 }, (_, i) => ({ id: String(i), kind: 'text', label: 'Field' })) }])).toEqual([]);
  });
  it('does not truncate editable JSON or retain prototype-bearing data', () => {
    expect(normalizeRemoteBlocks([{ ...block, data: { ...block.data, input: { ...block.data.input, prompt: 'x'.repeat(1_000_001) } } }])).toEqual([]);
    expect(normalizeRemoteBlocks([{ ...block, data: JSON.parse('{"__proto__":{"polluted":true}}') }])).toEqual([]);
    expect(normalizeRemoteBlocks([block])).toEqual([block]);
  });
  it('retains empty select choices and localized confirmations without inventing defaults', () => {
    const value = { ...action, confirmation: { title: { fallback: 'Remove', translations: { 'zh-CN': '删除' } } }, fields: [{ id: 'model', label: 'Model', kind: 'select', options: [{ value: '', label: 'None' }] }] };
    expect(normalizeRemoteActions([value])).toEqual([value]);
  });
});
