// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { useMainListEntries } from '../features/cc-agent/hooks/useMainListEntries';
import type { BuildMainListEntriesInput } from '../features/cc-agent/lib/mainListModel';

const a = { id: 'a', updatedAt: '2026-01-01', createdAt: '2026-01-01' } as Session;
const b = { id: 'b', updatedAt: '2026-01-02', createdAt: '2026-01-02' } as Session;
const context = (id: string) => ({ runningSessionIds: new Set([id]), attentionSessionIds: new Set<string>() });
const ids = (entries: ReturnType<typeof useMainListEntries>) => entries.map(e => e.kind === 'session' ? e.session.id : e.kind);
function input(sortBy: BuildMainListEntriesInput['sortBy']): BuildMainListEntriesInput {
  return { projects: [], dialogues: [a, b], groupBy: 'flat', groupDialogue: false,
    sortBy, manualProjectOrder: [], priorityContext: context('a') };
}
describe('sidebar sorting invalidation', () => {
  it.each(['recency', 'created'] as const)('reuses %s ordering when only viewed priority changes', (sortBy) => {
    const initial = input(sortBy);
    const { result, rerender } = renderHook(useMainListEntries, { initialProps: initial });
    const first = result.current;
    rerender({ ...initial, priorityContext: context('b') });
    expect(result.current).toBe(first);
    expect(ids(result.current)).toEqual(['b', 'a']);
    rerender({ ...initial, dialogues: [{ ...a, updatedAt: '2030-01-01', createdAt: '2030-01-01' }, b] });
    expect(ids(result.current)).toEqual(['a', 'b']);
  });
  it('reorders priority when running state changes and keeps time ordering when switching modes', () => {
    const initial = input('priority');
    const { result, rerender } = renderHook(useMainListEntries, { initialProps: initial });
    expect(ids(result.current)).toEqual(['a', 'b']);
    rerender({ ...initial, priorityContext: context('b') });
    expect(ids(result.current)).toEqual(['b', 'a']);
    rerender({ ...initial, sortBy: 'recency' });
    expect(ids(result.current)).toEqual(['b', 'a']);
  });
});
