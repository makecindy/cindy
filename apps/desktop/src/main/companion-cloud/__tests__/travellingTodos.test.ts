import { describe, expect, it } from 'vitest';
import { portableTodo, travellingTodos } from '../travel.js';

const day = 24 * 60 * 60_000;
const todo = (id: string, status: 'open' | 'done', updatedAt: number, extra: Record<string, unknown> = {}) => ({
  id, revision: 1, key: id, origin: 'assigned', title: id, progress: '', outcome: '', value: '', next: null, sources: [], associations: [],
  status, createdAt: new Date(0).toISOString(), updatedAt: new Date(updatedAt).toISOString(), sourceDeadline: null, deadlineCandidate: null,
  suggestedDate: null, decision: null, history: Array.from({ length: 30 }, (_, i) => ({ summary: `h${i}`, at: 'x' })),
  action: { requestId: 'req', revision: 1, state: 'received' }, legacyId: 'old', ...extra,
}) as never;

describe('todos that travel with a companion', () => {
  it('takes open, later and recently closed todos, newest first', () => {
    const now = 100 * day;
    const items = [todo('todo:old-done', 'done', now - 40 * day), todo('todo:open', 'open', now - 90 * day),
      todo('todo:recent-done', 'done', now - day), todo('todo:later', 'done', now - 60 * day, { decision: { kind: 'later' } })];
    expect(travellingTodos(items, now).map((item: { id: string }) => item.id)).toEqual(['todo:recent-done', 'todo:later', 'todo:open']);
  });

  it('leaves the delivery in flight and old history behind', () => {
    const value = portableTodo(todo('todo:a', 'open', 0));
    expect(value.action).toBeNull();
    expect(value.legacyId).toBeUndefined();
    expect((value.history as unknown[]).length).toBe(20);
  });
});
