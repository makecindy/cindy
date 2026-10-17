import { describe, expect, it, vi } from 'vitest';
import {
  applyTodoPatch,
  emptyTodoState,
  effectiveTodoDeadline,
  preflightTodoEvents,
  queryTodoItems,
  scheduleTodoDeferralRefresh,
  createTodoDueComparator,
  todoOverdue,
  todoVisible,
  validateTodoDeadline,
  type TodoPatch,
} from './teammateTodo';
const now = new Date('2026-10-10T12:00:00Z');
const patch: TodoPatch = {
  key: 'feedback:avatar',
  title: '修复头像丢失',
  outcome: '升级后的旧头像仍保留',
  origin: 'discovered',
  sources: [{ kind: 'mail', id: 'm1', label: '反馈邮件' }],
  next: {
    kind: 'advance',
    label: '准备修复',
    instruction: '按已授权范围排查并准备修复',
  },
};
describe('teammate affairs contract', () => {
  it('works without projects and merges source evidence into the same affair', () => {
    const s = emptyTodoState(),
      t = applyTodoPatch(s, patch, 'one', now);
    applyTodoPatch(
      s,
      {
        id: t.id,
        expectedRevision: 1,
        sources: [{ kind: 'feishu', id: 'f1', label: '同事反馈' }],
        associations: [{ kind: 'pr', id: '5729', label: '第一次修复' }],
      },
      'unused',
      now,
    );
    const latest = applyTodoPatch(
      s,
      {
        id: t.id,
        expectedRevision: 2,
        progress: '已合并，仍待升级验收',
        associations: [{ kind: 'pr', id: '5730', label: '补充修复' }],
      },
      'unused',
      now,
    );
    expect(s.items).toHaveLength(1);
    expect(latest.sources).toHaveLength(2);
    expect(latest.associations).toHaveLength(2);
    expect(latest.status).toBe('open');
    expect(() =>
      applyTodoPatch(s, { id: t.id, expectedRevision: 1, title: 'stale' }, 'unused', now),
    ).toThrow('CONFLICT');
  });
  it('requires real completion basis and retains history on reopening', () => {
    const s = emptyTodoState(),
      t = applyTodoPatch(s, patch, 'one', now);
    expect(() =>
      applyTodoPatch(s, { id: t.id, expectedRevision: 1, operation: 'complete' }, '', now),
    ).toThrow('COMPLETION_EVIDENCE_REQUIRED');
    expect(() =>
      applyTodoPatch(
        s,
        {
          id: t.id,
          expectedRevision: 1,
          operation: 'complete',
          completion: { summary: '  ' },
        },
        '',
        now,
      ),
    ).toThrow();
    const done = applyTodoPatch(
      s,
      {
        id: t.id,
        expectedRevision: 1,
        operation: 'complete',
        completion: {
          summary: '隔离升级验收通过',
          ref: 'https://example.test/proof',
        },
      },
      '',
      now,
    );
    const reopened = applyTodoPatch(
      s,
      { id: t.id, expectedRevision: done.revision, operation: 'reopen' },
      '',
      now,
    );
    expect(reopened.history).toEqual(done.history);
    expect(reopened.status).toBe('open');
  });
  it('preserves user date overrides and differentiates candidate / suggestion / deferral', () => {
    const s = emptyTodoState();
    let t = applyTodoPatch(
      s,
      {
        ...patch,
        sourceDeadline: {
          kind: 'date',
          date: '2026-10-10',
          timeZone: 'Asia/Shanghai',
          sourceVersion: 2,
          quote: '10月10日前',
        },
        deadlineCandidate: {
          value: {
            kind: 'date',
            date: '2026-10-16',
            timeZone: 'Asia/Shanghai',
          },
          reason: '周五前，日期待确认',
        },
        suggestedDate: '2026-10-12',
      },
      'one',
      now,
    );
    expect(todoOverdue(t, now)).toBe(false);
    t = applyTodoPatch(
      s,
      {
        id: t.id,
        expectedRevision: t.revision,
        deadlineOverride: { value: null },
        operation: 'later',
        until: '2026-10-11T12:00:00Z',
      },
      '',
      now,
    );
    expect(todoVisible(t, now)).toBe(false);
    expect(t.sourceDeadline?.date).toBe('2026-10-10');
    t = applyTodoPatch(
      s,
      {
        id: t.id,
        expectedRevision: t.revision,
        sourceDeadline: {
          kind: 'date',
          date: '2026-10-09',
          timeZone: 'Asia/Shanghai',
          sourceVersion: 3,
        },
      },
      '',
      now,
    );
    expect(effectiveTodoDeadline(t)).toBeNull();
    expect(() =>
      applyTodoPatch(
        s,
        {
          id: t.id,
          expectedRevision: t.revision,
          sourceDeadline: {
            kind: 'date',
            date: '2026-10-08',
            timeZone: 'Asia/Shanghai',
            sourceVersion: 1,
          },
        },
        '',
        now,
      ),
    ).toThrow('STALE_SOURCE');
    expect(t.deadlineCandidate?.reason).toBeTruthy();
  });
  it('filters duplicate, resolved, ignored and out-of-scope events before model work', () => {
    const s = emptyTodoState();
    let t = applyTodoPatch(s, patch, 'one', now);
    t = applyTodoPatch(s, { id: t.id, expectedRevision: 1, operation: 'mute' }, '', now);
    expect(
      preflightTodoEvents(
        s,
        [
          { source: 'mail', sequence: 2, key: patch.key! },
          { source: 'feishu', sequence: 7, key: patch.key! },
          { source: 'issues', sequence: 1, key: 'other', project: '/private' },
        ],
        ['/cindy'],
      ).map((x) => x.decision),
    ).toEqual(['suppressed', 'suppressed', 'outside-scope']);
    s.cursors.mail = 2;
    expect(
      preflightTodoEvents(s, [{ source: 'mail', sequence: 2, key: 'another' }], [])[0].decision,
    ).toBe('duplicate');
    expect(t.decision?.kind).toBe('muted');
  });
  it('rejects ambiguous or impossible exact dates and invalid zones', () => {
    for (const date of ['2026-02-30', '9999-99-99', 'bad'])
      expect(() => validateTodoDeadline({ kind: 'date', date, timeZone: 'UTC' })).toThrow();
    expect(() =>
      validateTodoDeadline({
        kind: 'date',
        date: '2026-10-10',
        timeZone: 'Imaginary/City',
      }),
    ).toThrow('INVALID_TIME_ZONE');
    expect(() =>
      validateTodoDeadline({
        kind: 'instant',
        date: '2026-10-10',
        timeZone: 'UTC',
        at: '2026-10-10',
      }),
    ).toThrow('INVALID_DATE');
    expect(() =>
      validateTodoDeadline({
        kind: 'instant',
        date: '2026-10-10',
        timeZone: 'Asia/Shanghai',
        at: '2026-10-10T23:00:00Z',
      }),
    ).toThrow('INVALID_DATE');
  });
  it('all 100 affairs are reachable and searchable beyond the first page', () => {
    const s = emptyTodoState();
    for (let n = 0; n < 100; n++)
      applyTodoPatch(s, { ...patch, key: 'k' + n, title: '事项 ' + n }, 'id' + n, now);
    const ids = new Set();
    for (let offset = 0; offset < 100; offset += 25)
      for (const t of queryTodoItems(s.items, { offset }).items) ids.add(t.id);
    expect(ids.size).toBe(100);
    expect(queryTodoItems(s.items, { query: '事项 99' }).total).toBe(1);
    expect(queryTodoItems(s.items, { offset: 100 }).offset).toBe(75);
  });
});

it('orders source versions only within their source, including the legacy stream', () => {
  const s = emptyTodoState();
  let t = applyTodoPatch(
    s,
    {
      ...patch,
      sourceDeadline: {
        kind: 'date',
        date: '2026-10-10',
        timeZone: 'UTC',
        sourceId: 'mail:A',
        sourceVersion: 100,
      },
    },
    'one',
    now,
  );
  t = applyTodoPatch(
    s,
    {
      id: t.id,
      expectedRevision: t.revision,
      deadlineOverride: {
        value: { kind: 'date', date: '2026-10-20', timeZone: 'UTC' },
      },
      sourceDeadline: {
        kind: 'date',
        date: '2026-10-11',
        timeZone: 'UTC',
        sourceId: 'issue:B',
        sourceVersion: 1,
      },
    },
    '',
    now,
  );
  expect(t.sourceDeadline?.sourceId).toBe('issue:B');
  expect(effectiveTodoDeadline(t)?.date).toBe('2026-10-20');
  expect(() =>
    applyTodoPatch(
      s,
      {
        id: t.id,
        expectedRevision: t.revision,
        sourceDeadline: { ...t.sourceDeadline!, sourceVersion: 0 },
      },
      '',
      now,
    ),
  ).toThrow('STALE_SOURCE');
  t = applyTodoPatch(
    s,
    {
      id: t.id,
      expectedRevision: t.revision,
      sourceDeadline: {
        kind: 'date',
        date: '2026-10-12',
        timeZone: 'UTC',
        sourceVersion: 2,
      },
    },
    '',
    now,
  );
  expect(() =>
    applyTodoPatch(
      s,
      {
        id: t.id,
        expectedRevision: t.revision,
        sourceDeadline: { ...t.sourceDeadline!, sourceVersion: 1 },
      },
      '',
      now,
    ),
  ).toThrow('STALE_SOURCE');
});

it('orders exact instants and source-local date ends, retaining creation/ID tie breakers', () => {
  const s = emptyTodoState();
  const add = (id: string, deadline: NonNullable<TodoPatch['sourceDeadline']>, created = now) =>
    applyTodoPatch(s, { ...patch, key: id, sourceDeadline: deadline }, id, created);
  add(
    'late',
    {
      kind: 'instant',
      date: '2026-10-10',
      timeZone: 'UTC',
      at: '2026-10-10T17:00:00Z',
    },
    new Date('2026-10-01'),
  );
  add('early', {
    kind: 'instant',
    date: '2026-10-10',
    timeZone: 'UTC',
    at: '2026-10-10T09:00:00Z',
  });
  add('date-shanghai', {
    kind: 'date',
    date: '2026-10-10',
    timeZone: 'Asia/Shanghai',
  });
  add('date-utc', { kind: 'date', date: '2026-10-10', timeZone: 'UTC' });
  add('next-local-date', {
    kind: 'instant',
    date: '2026-10-11',
    timeZone: 'Asia/Shanghai',
    at: '2026-10-11T01:00:00+08:00',
  });
  expect(queryTodoItems(s.items).items.map((t) => t.id)).toEqual([
    'early',
    'date-shanghai',
    'late',
    'next-local-date',
    'date-utc',
  ]);
  expect(queryTodoItems(s.items, { order: 'created' }).items[0].id).toBe('late');
  const compare = createTodoDueComparator();
  const dst = add('dst-date', {
    kind: 'date',
    date: '2026-11-01',
    timeZone: 'America/New_York',
  });
  const before = add('dst-before', {
    kind: 'instant',
    date: '2026-11-01',
    timeZone: 'America/New_York',
    at: '2026-11-02T04:30:00Z',
  });
  const after = add('dst-after', {
    kind: 'instant',
    date: '2026-11-02',
    timeZone: 'America/New_York',
    at: '2026-11-02T05:30:00Z',
  });
  expect(compare(before, dst)).toBeLessThan(0);
  expect(compare(dst, after)).toBeLessThan(0);
  expect(dst.sourceDeadline?.at).toBeUndefined();
});

it('a source label refresh retains its existing evidence and scope when optional metadata is omitted', () => {
  const s = emptyTodoState();
  const t = applyTodoPatch(
    s,
    {
      ...patch,
      sources: [
        {
          kind: 'mail',
          id: 'm1',
          label: '报价',
          ref: 'https://example.test/proof',
          project: '/cindy',
          version: 3,
        },
      ],
    },
    'one',
    now,
  );
  const latest = applyTodoPatch(
    s,
    {
      id: t.id,
      expectedRevision: 1,
      sources: [{ kind: 'mail', id: 'm1', label: '新报价', version: 4 }],
    },
    '',
    now,
  );
  expect(latest.sources[0]).toMatchObject({
    ref: 'https://example.test/proof',
    project: '/cindy',
    label: '新报价',
  });
});

it('normalizes problem keys before lookup and preflight rather than creating duplicate stored keys', () => {
  const s = emptyTodoState();
  const t = applyTodoPatch(s, { ...patch, key: 'quote:1' }, 'one', now);
  expect(() => applyTodoPatch(s, { ...patch, key: ' quote:1 ' }, 'two', now)).toThrow('CONFLICT');
  const ignored = applyTodoPatch(s, { id: t.id, expectedRevision: 1, operation: 'mute' }, '', now);
  expect(
    preflightTodoEvents(s, [{ source: 'mail', sequence: 1, key: ' quote:1 ' }], [])[0].decision,
  ).toBe('suppressed');
  expect(s.items).toHaveLength(1);
  expect(ignored.key).toBe('quote:1');
});

it('returns the next deferral boundary even outside a page and makes expired entries visible without changing deadlines', () => {
  const state = emptyTodoState();
  for (let n = 0; n < 36; n++) applyTodoPatch(state, { ...patch, key: 'k' + n }, 'todo-' + n, now);
  const later = applyTodoPatch(
    state,
    { id: 'todo-35', expectedRevision: 1, operation: 'later', until: '2026-10-10T12:02:00Z' },
    'unused',
    now,
  );
  applyTodoPatch(
    state,
    { id: 'todo-34', expectedRevision: 1, operation: 'later', until: '2026-10-10T12:03:00Z' },
    'unused',
    now,
  );
  const open = queryTodoItems(state.items, { limit: 25 }, now);
  expect(open.items).toHaveLength(25);
  expect(open.nextDeferredAt).toBe('2026-10-10T12:02:00Z');
  expect(queryTodoItems(state.items, { view: 'hidden' }, now).total).toBe(2);
  const after = new Date('2026-10-10T12:02:00Z');
  expect(queryTodoItems(state.items, {}, after).total).toBe(35);
  expect(queryTodoItems(state.items, { view: 'hidden' }, after).total).toBe(1);
  expect(queryTodoItems(state.items, {}, after).nextDeferredAt).toBe('2026-10-10T12:03:00Z');
  expect(effectiveTodoDeadline(later)).toEqual(effectiveTodoDeadline(state.items[0]));
});

it('refreshes once at a long deferral boundary and cancels without polling or executing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    const refresh = vi.fn();
    const until = new Date(now.getTime() + 2_147_483_647 + 5000).toISOString();
    const cancel = scheduleTodoDeferralRefresh(until, refresh);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledOnce();
    cancel();
    const cancelled = scheduleTodoDeferralRefresh(
      new Date(Date.now() + 5000).toISOString(),
      refresh,
    );
    cancelled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
