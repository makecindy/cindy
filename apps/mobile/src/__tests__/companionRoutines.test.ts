import { describe, expect, it } from 'vitest';
import { emptyRoutineDefinition, getRoutineActionId, parseRoutineDefinition, parseRoutineDetail, parseRoutineSummaries, routineDraftValid } from '../session/companionRoutines';

describe('companion automation data boundary', () => {
  it('does not treat an empty new draft as a saved rule', () => {
    const draft = emptyRoutineDefinition();
    expect(routineDraftValid(draft)).toBe(false);
    expect(routineDraftValid({ ...draft, name: 'Daily brief', prompt: 'Summarize my inbox' })).toBe(true);
  });
  it('keeps mixed OR triggers and event filters intact while editing', () => {
    const draft = { name: 'Brief', prompt: 'Check', enabled: true, triggers: [
      { id: 'a', kind: 'cron', expression: '30 8 * * 1-5', timezone: 'Asia/Shanghai' },
      { id: 'b', kind: 'interval', intervalMs: 60_000 },
      { id: 'c', kind: 'event', sourceId: 'mail', eventType: 'new', filters: [{ field: 'sender', operator: 'contains', value: 'team' }] },
    ] };
    expect(parseRoutineDefinition(draft)).toEqual(draft);
  });
  it('rejects unsupported trigger types rather than dropping them from a saved rule', () => {
    expect(parseRoutineDefinition({ ...emptyRoutineDefinition(), triggers: [{ id: 'future', kind: 'future-trigger' }] })).toBeNull();
    expect(parseRoutineDefinition({ ...emptyRoutineDefinition(), triggers: [{ id: 'invalid', kind: 'interval', intervalMs: 1 }] })).toBeNull();
  });
  it('separates activity from enabled state and never derives running from a title', () => {
    expect(parseRoutineSummaries({ items: [{ id: 'a', name: 'Running daily', enabled: true, revision: 2, triggers: [] }] })[0]?.activity).toBeUndefined();
    expect(parseRoutineSummaries({ items: [{ id: 'a', name: 'Daily', enabled: false, revision: 2, activity: 'running', triggers: [] }] })[0]?.activity).toBe('running');
  });
  it('requires an explicit operation-to-capability mapping, not a guessed fixed operation id', () => {
    const resource = { ref: { collectionId: 'teammates', kind: 'bot', id: 'routine:b/r' }, display: { title: 'Daily' }, links: [], revision: '1',
      actions: [{ id: 'opaque-token', label: 'Save' }], blocks: [{ id: 'r', primitive: 'routine-detail', fallbackMarkdown: 'Daily', data: { operationActions: { 'routine-save': 'opaque-token' } } }] };
    expect(getRoutineActionId(resource, 'routine-save')).toBe('opaque-token');
    expect(getRoutineActionId({ ...resource, actions: [] }, 'routine-save')).toBeNull();
    expect(getRoutineActionId({ ...resource, blocks: [], actions: [{ id: 'routine-save', label: 'Save' }] }, 'routine-save')).toBeNull();
  });
  it('keeps oversized definitions read-only and omits malformed source/history entries', () => {
    const detail = parseRoutineDetail({ id: 'a', revision: 1, editable: false, input: null, sources: [null], history: [null] });
    expect(detail).toMatchObject({ editable: false, input: null, sources: [], history: [] });
    expect(() => parseRoutineDetail({ id: 'a', revision: 1, editable: true, input: { bad: true }, sources: [], history: [] })).toThrow();
  });
});
