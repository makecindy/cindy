// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { readCollapsedTeammateAvatars, writeCollapsedTeammateAvatars, readTeammatesViewMode, writeTeammatesViewMode, readTeammatesSectionCollapsed, writeTeammatesSectionCollapsed } from '../teammatesSectionPrefs';

beforeEach(() => localStorage.clear());

describe('teammates section collapse preference', () => {
  it('defaults to expanded and keeps each account separate', () => {
    expect(readTeammatesSectionCollapsed('owner-a')).toBe(false);
    writeTeammatesSectionCollapsed('owner-a', true);
    expect(readTeammatesSectionCollapsed('owner-a')).toBe(true);
    expect(readTeammatesSectionCollapsed('owner-b')).toBe(false);
    writeTeammatesSectionCollapsed('owner-a', false);
    expect(readTeammatesSectionCollapsed('owner-a')).toBe(false);
  });

  it('stays expanded without an account and never persists for it', () => {
    writeTeammatesSectionCollapsed(null, true);
    expect(readTeammatesSectionCollapsed(null)).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('treats unknown stored values as the expanded default', () => {
    localStorage.setItem('sidebar.teammatesSection.v1.owner.owner-a', 'sideways');
    expect(readTeammatesSectionCollapsed('owner-a')).toBe(false);
  });
});

// Display preference was previously inseparable from collapse. Keep account isolation
// and collapse independent at the production persistence boundary (unit tier).
it('stores icon mode independently from collapse and other accounts', () => {
  writeTeammatesViewMode('owner-a', 'icons');
  writeTeammatesSectionCollapsed('owner-a', true);
  expect(readTeammatesViewMode('owner-a')).toBe('icons');
  expect(readTeammatesViewMode('owner-b')).toBe('list');
  writeTeammatesSectionCollapsed('owner-a', false);
  expect(readTeammatesViewMode('owner-a')).toBe('icons');
});

// Unit: the new opt-in must persist per account without changing existing fold/style
// choices. Existing tests only cover those two preferences; two owners distinguish leakage.
it('defaults collapsed avatars off and stores the explicit choice independently per account', () => {
  expect(readCollapsedTeammateAvatars('owner-a')).toBe(false);
  writeTeammatesSectionCollapsed('owner-a', true);
  writeTeammatesViewMode('owner-a', 'icons');
  writeCollapsedTeammateAvatars('owner-a', true);
  expect(readCollapsedTeammateAvatars('owner-a')).toBe(true);
  expect(readCollapsedTeammateAvatars('owner-b')).toBe(false);
  expect(readTeammatesSectionCollapsed('owner-a')).toBe(true);
  expect(readTeammatesViewMode('owner-a')).toBe('icons');
  writeCollapsedTeammateAvatars('owner-a', false);
  expect(readCollapsedTeammateAvatars('owner-a')).toBe(false);
  writeCollapsedTeammateAvatars(null, true);
  expect(readCollapsedTeammateAvatars(null)).toBe(false);
});
