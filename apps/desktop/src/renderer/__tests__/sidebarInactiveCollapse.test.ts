import { describe, expect, it } from 'vitest';
import {
  getSessionListCollapseView,
  getSidebarSessionCollapseView,
} from '../features/cc-agent/lib/sessionListCollapse';

// #11282: opt-in replaces the task count floor with the shorter activity window.
// Shared tests do not exercise this preference. One 31-minute-old task in a
// project with the default floor reproduces the difference. Tier: unit.
// Standalone Vitest duration: 833ms (2026-11-18, --exclude '**/*.test.tsx').
type Entry = { id: string; activity: number; container?: boolean };
const now = Date.parse('2026-11-18T04:00:00Z');
function view(entries: Entry[], overrides = {}) {
  return getSidebarSessionCollapseView({
    entries,
    nowMs: now,
    showAll: false,
    disableCollapse: false,
    isFiltering: false,
    getActivityMs: (entry) => entry.activity,
    isActiveEntry: (entry) => entry.id === 'active',
    hasAttentionEntry: (entry) => entry.id === 'attention',
    ...overrides,
  });
}

describe('desktop sidebar idle folding (#11233)', () => {
  it.each([
    [30 * 60_000 - 1, 0],
    [30 * 60_000, 0],
    [30 * 60_000 + 1, 1],
  ])('with opt-in and an idle age of %i ms, hides %i rows even in a small group', (age, hidden) => {
    expect(view([{ id: 'task', activity: now - age }], {
      idleCollapseEnabled: true,
    }).hiddenCount).toBe(hidden);
  });

  it('keeps the count floor and 24h activity window when the preference is off', () => {
    const floor = Array.from({ length: 5 }, (_, i) => ({ id: `old-${i}`, activity: 0 }));
    const recent = { id: 'hour-old', activity: now - 60 * 60_000 };
    const old = { id: 'old-sixth', activity: 0 };
    expect(view([...floor, recent, old]).visibleEntries).toEqual([...floor, recent]);
    expect(view([...floor, recent, old], { idleCollapseEnabled: true }).visibleEntries).toEqual([]);
  });

  it('keeps the current and attention rows without expanding unrelated old tasks', () => {
    const entries = ['old', 'active', 'attention'].map((id) => ({ id, activity: 0 }));
    expect(view(entries, { idleCollapseEnabled: true }).visibleEntries.map((entry) => entry.id)).toEqual(['active', 'attention']);
  });

  it('keeps empty project headers and applies the count limit only to containers', () => {
    const entries = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `idle-${i}`, activity: 0 })),
      { id: 'project-a', activity: 0, container: true },
      { id: 'recent', activity: now },
      { id: 'project-b', activity: 0, container: true },
      { id: 'project-c', activity: 0, container: true },
    ];
    const result = view(entries, {
      minVisibleCount: 2,
      idleCollapseEnabled: true,
      isContainerEntry: (entry: Entry) => entry.container === true,
    });
    expect(result.visibleEntries.map((entry) => entry.id)).toEqual(['project-a', 'recent', 'project-b']);
    expect(result).toMatchObject({ totalCount: 10, hiddenCount: 7, isOverflowing: true });
  });

  it.each(['showAll', 'disableCollapse', 'isFiltering'])('shows every match when %s is enabled', (key) => {
    const entries = [{ id: 'idle', activity: 0 }];
    expect(view(entries, { minVisibleCount: 0, [key]: true }).visibleEntries).toEqual(entries);
  });

  it('leaves the shared mobile policy unchanged', () => {
    const entries = [{ id: 'hour-old', activity: now - 60 * 60_000 }];
    expect(view(entries, { idleCollapseEnabled: true }).hiddenCount).toBe(1);
    const shared = getSessionListCollapseView({
      entries, nowMs: now, minVisibleCount: 0, showAll: false,
      disableCollapse: false, isFiltering: false,
      getActivityMs: (entry) => entry.activity,
      isActiveEntry: () => false, hasAttentionEntry: () => false,
    });
    expect(shared.visibleEntries).toEqual(entries);
  });
});
