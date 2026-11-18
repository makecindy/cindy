import { describe, expect, it } from 'vitest';
import {
  getSessionListCollapseView,
  getSidebarSessionCollapseView,
} from '../features/cc-agent/lib/sessionListCollapse';

// #11233: the production sidebar filter must fold even the first idle task,
// keep only the active/attention exception, and retain project headers. Existing
// shared tests exercise the mobile 24h/count policy, not this desktop policy.
// Minimal input: one task older than 30m. Tier: unit (pure view projection).
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
    minVisibleCount: 10,
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
  ])('with an idle age of %i ms, hides %i tasks including the first row', (age, hidden) => {
    expect(view([{ id: 'task', activity: now - age }]).hiddenCount).toBe(hidden);
  });

  it('keeps the current and attention rows without expanding unrelated old tasks', () => {
    const entries = ['old', 'active', 'attention'].map((id) => ({ id, activity: 0 }));
    expect(view(entries).visibleEntries.map((entry) => entry.id)).toEqual(['active', 'attention']);
  });

  it('keeps empty project headers and applies the count limit only to containers', () => {
    const entries = [
      { id: 'idle', activity: 0 },
      { id: 'project-a', activity: 0, container: true },
      { id: 'recent', activity: now },
      { id: 'project-b', activity: 0, container: true },
      { id: 'project-c', activity: 0, container: true },
    ];
    const result = view(entries, {
      minVisibleCount: 2,
      isContainerEntry: (entry: Entry) => entry.container === true,
    });
    expect(result.visibleEntries.map((entry) => entry.id)).toEqual(['project-a', 'recent', 'project-b']);
    expect(result).toMatchObject({ totalCount: 5, hiddenCount: 2, isOverflowing: true });
  });

  it.each(['showAll', 'disableCollapse', 'isFiltering'])('shows every match when %s is enabled', (key) => {
    const entries = [{ id: 'idle', activity: 0 }];
    expect(view(entries, { [key]: true }).visibleEntries).toEqual(entries);
  });

  it('leaves the shared mobile policy unchanged', () => {
    const entries = [{ id: 'hour-old', activity: now - 60 * 60_000 }];
    expect(view(entries).hiddenCount).toBe(1);
    const shared = getSessionListCollapseView({
      entries, nowMs: now, minVisibleCount: 0, showAll: false,
      disableCollapse: false, isFiltering: false,
      getActivityMs: (entry) => entry.activity,
      isActiveEntry: () => false, hasAttentionEntry: () => false,
    });
    expect(shared.visibleEntries).toEqual(entries);
  });
});
