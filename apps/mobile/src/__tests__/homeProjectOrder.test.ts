import { describe, expect, it } from 'vitest';
import {
  mergeVisibleReorder,
  moveVisibleProjectOrder,
  normalizeManualProjectOrder,
  projectDropIndexFromY,
  reorderVisibleProjectToIndex,
  snapshotManualProjectOrder,
} from '@/session/homeProjectOrder';

describe('normalizeManualProjectOrder', () => {
  it('keeps known keys and appends new ones', () => {
    expect(normalizeManualProjectOrder(['b', 'a'], ['a', 'c', 'b'])).toEqual(['b', 'a', 'c']);
  });

  it('drops keys that are no longer active', () => {
    expect(normalizeManualProjectOrder(['gone', 'a'], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('snapshotManualProjectOrder', () => {
  it('fills visible slots with the pre-switch visual order and keeps hidden keys in place', () => {
    expect(
      snapshotManualProjectOrder(['local:b', 'local:a'], ['local:a', 'local:hidden', 'local:b']),
    ).toEqual(['local:b', 'local:hidden', 'local:a']);
  });

  it('falls back to baseline when the visual snapshot is empty', () => {
    expect(snapshotManualProjectOrder([], ['local:a', 'local:b'])).toEqual(['local:a', 'local:b']);
  });
});

describe('mergeVisibleReorder', () => {
  it('reorders only the visible subset in place', () => {
    expect(mergeVisibleReorder(['a', 'hidden', 'b'], ['b', 'a'])).toEqual(['b', 'hidden', 'a']);
  });
});

describe('moveVisibleProjectOrder', () => {
  it('swaps a visible project with its neighbor and keeps hidden keys', () => {
    expect(moveVisibleProjectOrder(['a', 'hidden', 'b'], ['a', 'b'], 'a', 1))
      .toEqual(['b', 'hidden', 'a']);
    expect(moveVisibleProjectOrder(['a', 'hidden', 'b'], ['a', 'b'], 'a', -1)).toBeNull();
  });
});

describe('reorderVisibleProjectToIndex', () => {
  it('moves a visible project to an arbitrary index and keeps hidden keys', () => {
    expect(reorderVisibleProjectToIndex(['a', 'hidden', 'b', 'c'], ['a', 'b', 'c'], 'c', 0))
      .toEqual(['c', 'hidden', 'a', 'b']);
    expect(reorderVisibleProjectToIndex(['a', 'hidden', 'b'], ['a', 'b'], 'a', 0)).toBeNull();
  });
});

describe('projectDropIndexFromY', () => {
  const layouts = [
    { height: 56, y: 100 },
    { height: 56, y: 160 },
    { height: 56, y: 220 },
  ];

  it('uses midpoints so crossing the lower half of a row targets the next slot', () => {
    expect(projectDropIndexFromY(layouts, 110)).toBe(0);
    expect(projectDropIndexFromY(layouts, 190)).toBe(2);
    expect(projectDropIndexFromY(layouts, 400)).toBe(2);
  });
});
