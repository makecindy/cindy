import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import { getSessionListCollapseView } from '../../lib/sessionListCollapse';
import type { SidebarSessionEntry } from '../../lib/automationSidebarGrouping';
import {
  loadManualSessionOrder,
  mergeVisibleSessionReorder,
  orderManualSidebarEntries,
  persistManualSessionOrder,
  reconcileManualSessionOrder,
} from '../sessionOrder';

const sessionEntryListSource = readFileSync(
  resolve(__dirname, '../SessionEntryList.tsx'),
  'utf8',
);

const nowMs = Date.parse('2026-09-14T12:00:00.000Z');
const oldActivityMs = nowMs - 7 * 24 * 60 * 60 * 1000;

describe('manual project session ordering', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps hidden sessions in place when visible sessions are reordered', () => {
    expect(
      mergeVisibleSessionReorder(
        ['visible-a', 'hidden', 'visible-b', 'visible-c'],
        ['visible-c', 'visible-a', 'visible-b'],
      ),
    ).toEqual(['visible-c', 'hidden', 'visible-a', 'visible-b']);
  });

  it('keeps saved IDs while remote status buckets are incomplete', () => {
    expect(
      reconcileManualSessionOrder(['archived-1', 'active-1'], [{ id: 'active-1' } as Session]),
    ).toEqual(['archived-1', 'active-1']);
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
      sessionEntryListSource.indexOf('if (onReorder)'),
    );
    expect(sessionEntryListSource).toContain('{isOverflowing && (');
    expect(sessionEntryListSource).toContain('showAllSessions');
  });

  it('keeps automation groups together while ordering project entries', () => {
    const group = {
      kind: 'automation-group' as const,
      group: {
        id: 'schedule-1',
        sessions: [{ id: 'run-1' }, { id: 'run-2' }],
      },
    } as unknown as SidebarSessionEntry;
    const plain = {
      kind: 'session' as const,
      session: { id: 'plain-1' },
    } as unknown as SidebarSessionEntry;

    expect(orderManualSidebarEntries([plain, group], ['run-1', 'run-2', 'plain-1'])).toEqual([
      group,
      plain,
    ]);
  });

  it('keeps the first drag based on the current full order and isolates native drag handles', () => {
    expect(sessionEntryListSource).toContain('initialOrder?: readonly string[];');
    expect(sessionEntryListSource).toContain('const baseOrder = manualOrder?.length');
    expect(sessionEntryListSource).toContain('a, [data-no-drag]');
    expect(sessionEntryListSource).toContain('handle="[data-sidebar-session-order-handle]"');
  });

  it('exposes automation group headers as session-order drag handles', () => {
    const automationGroupSource = readFileSync(
      resolve(__dirname, '../AutomationSessionGroupItem.tsx'),
      'utf8',
    );
    expect(automationGroupSource).toContain('data-sidebar-session-row="true"');
    expect(automationGroupSource).toContain('data-sidebar-session-order-handle');
    expect(automationGroupSource).toContain('sessionOrderHandle={false}');
  });

  it('isolates saved order by data owner', () => {
    persistManualSessionOrder('owner-a', 'project-1', ['a']);
    persistManualSessionOrder('owner-b', 'project-1', ['b']);

    expect(loadManualSessionOrder('owner-a', 'project-1')).toEqual(['a']);
    expect(loadManualSessionOrder('owner-b', 'project-1')).toEqual(['b']);
  });
});
