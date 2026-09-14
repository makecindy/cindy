import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSessionListCollapseView } from '../../lib/sessionListCollapse';
import { mergeVisibleSessionReorder } from '../sessionOrder';

const sessionEntryListSource = readFileSync(
  resolve(__dirname, '../SessionEntryList.tsx'),
  'utf8',
);

const nowMs = Date.parse('2026-09-14T12:00:00.000Z');
const oldActivityMs = nowMs - 7 * 24 * 60 * 60 * 1000;

describe('manual project session ordering', () => {
  it('keeps hidden sessions in place when visible sessions are reordered', () => {
    expect(
      mergeVisibleSessionReorder(
        ['visible-a', 'hidden', 'visible-b', 'visible-c'],
        ['visible-c', 'visible-a', 'visible-b'],
      ),
    ).toEqual(['visible-c', 'hidden', 'visible-a', 'visible-b']);
  });

  it('keeps manual ordering behind the existing collapse view and footer', () => {
    const entries = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => ({
      kind: 'session' as const,
      session: { id },
    }));
    const collapseView = getSessionListCollapseView({
      entries,
      minVisibleCount: 5,
      showAll: false,
      disableCollapse: false,
      isFiltering: false,
      nowMs,
      getActivityMs: () => oldActivityMs,
      isActiveEntry: () => false,
      hasAttentionEntry: () => false,
    });

    expect(collapseView.visibleEntries).toHaveLength(5);
    expect(collapseView.isOverflowing).toBe(true);
    expect(collapseView.totalCount).toBe(6);
    expect(sessionEntryListSource.indexOf('getSessionListCollapseView')).toBeLessThan(
      sessionEntryListSource.indexOf('if (manualOrder && onReorder)'),
    );
    expect(sessionEntryListSource).toContain('{isOverflowing && (');
    expect(sessionEntryListSource).toContain('showAllSessions');
  });
});
