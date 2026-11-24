import { describe, expect, it } from 'vitest';

import {
  SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT,
  SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS,
  getSessionListCollapseView,
} from '../sessionListCollapse.js';

interface TestSessionEntry {
  kind: 'session';
  id: string;
  activityMs: number;
  active?: boolean;
  attention?: boolean;
}

interface TestAutomationEntry {
  kind: 'automation-group';
  id: string;
  sessions: Array<{
    id: string;
    activityMs: number;
    active?: boolean;
    attention?: boolean;
  }>;
}

type TestEntry = TestSessionEntry | TestAutomationEntry;

const nowMs = Date.parse('2026-06-04T12:00:00.000Z');
const recentMs = nowMs - 60 * 60 * 1000;
const oldMs = nowMs - SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS - 60 * 1000;

function session(id: string, activityMs = oldMs): TestSessionEntry {
  return { kind: 'session', id, activityMs };
}

function getActivityMs(entry: TestEntry): number {
  if (entry.kind === 'session') return entry.activityMs;
  return Math.max(0, ...entry.sessions.map((item) => item.activityMs));
}

function isActiveEntry(entry: TestEntry): boolean {
  if (entry.kind === 'session') return entry.active === true;
  return entry.sessions.some((item) => item.active === true);
}

function hasAttentionEntry(entry: TestEntry): boolean {
  if (entry.kind === 'session') return entry.attention === true;
  return entry.sessions.some((item) => item.attention === true);
}

function collapse(entries: readonly TestEntry[], overrides = {}) {
  return getSessionListCollapseView({
    entries,
    nowMs,
    showAll: false,
    disableCollapse: false,
    isFiltering: false,
    getActivityMs,
    isActiveEntry,
    hasAttentionEntry,
    ...overrides,
  });
}

describe('session list collapse view', () => {
  it('keeps the first five entries visible', () => {
    const entries = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => session(id));
    const view = collapse(entries);

    expect(view.isOverflowing).toBe(true);
    expect(view.hiddenCount).toBe(1);
    expect(view.totalCount).toBe(6);
    expect(view.visibleEntries.map((entry) => entry.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('keeps all entries within 24h visible even when there are more than five', () => {
    const entries = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => session(id, recentMs));
    const view = collapse(entries);

    expect(view.isOverflowing).toBe(false);
    expect(view.hiddenCount).toBe(0);
    expect(view.visibleEntries).toEqual(entries);
  });

  it('collapses old entries after the first five', () => {
    const entries = [
      session('s1', recentMs),
      session('s2', oldMs),
      session('s3', oldMs),
      session('s4', oldMs),
      session('s5', oldMs),
      session('s6', oldMs),
      session('s7', oldMs),
    ];
    const view = collapse(entries);

    expect(view.isOverflowing).toBe(true);
    expect(view.hiddenCount).toBe(2);
    expect(view.visibleEntries.map((entry) => entry.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('shows all entries after showAll is enabled', () => {
    const entries = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => session(id));
    const view = collapse(entries, { showAll: true });

    expect(view.isOverflowing).toBe(false);
    expect(view.hiddenCount).toBe(0);
    expect(view.visibleEntries).toEqual(entries);
  });

  it('does not collapse while content filtering or project search is active', () => {
    const entries = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => session(id));

    expect(collapse(entries, { disableCollapse: true })).toMatchObject({
      visibleEntries: entries,
      isOverflowing: false,
      hiddenCount: 0,
    });
    expect(collapse(entries, { isFiltering: true })).toMatchObject({
      visibleEntries: entries,
      isOverflowing: false,
      hiddenCount: 0,
    });
  });

  it('expands all entries when the active entry is in the collapsed region', () => {
    const entries = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => session(id));
    entries[5].active = true;
    const view = collapse(entries);

    expect(view.isOverflowing).toBe(false);
    expect(view.hiddenCount).toBe(0);
    expect(view.visibleEntries).toEqual(entries);
  });

  it('keeps attention entries visible even when they are old and after the first five', () => {
    const entries = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => session(id));
    entries[5].attention = true;
    const view = collapse(entries);

    expect(view.isOverflowing).toBe(false);
    expect(view.hiddenCount).toBe(0);
    expect(view.visibleEntries.map((entry) => entry.id)).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
    ]);
  });

  it('counts an automation group as one entry and uses the newest child activity', () => {
    const entries: TestEntry[] = [
      session('s1', oldMs),
      session('s2', oldMs),
      session('s3', oldMs),
      session('s4', oldMs),
      session('s5', oldMs),
      {
        kind: 'automation-group',
        id: 'group-1',
        sessions: [
          { id: 'run-old', activityMs: oldMs },
          { id: 'run-recent', activityMs: recentMs },
        ],
      },
      session('s6', oldMs),
    ];
    const view = collapse(entries);

    expect(view.totalCount).toBe(7);
    expect(view.hiddenCount).toBe(1);
    expect(view.visibleEntries.map((entry) => entry.id)).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      'group-1',
    ]);
  });

  it('uses caller-provided nowMs for deterministic recent-window decisions', () => {
    const entries = [
      session('s1', 100),
      session('s2', 100),
      session('s3', 100),
      session('s4', 100),
      session('s5', 100),
      session('s6', 100),
    ];
    const view = collapse(entries, {
      nowMs: 200,
      recentWindowMs: 150,
    });

    expect(view.isOverflowing).toBe(false);
    expect(view.visibleEntries).toEqual(entries);
  });

  it('exports the default product policy constants', () => {
    expect(SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT).toBe(5);
    expect(SESSION_LIST_COLLAPSE_RECENT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
