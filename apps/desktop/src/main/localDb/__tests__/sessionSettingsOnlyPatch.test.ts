/**
 * isSessionSettingsOnlyPatch: which `local-db:sessions:update` patches leave a task's updatedAt alone.
 *
 * Test value
 * - Production entry and observable result: `isSessionSettingsOnlyPatch` (localDb/sessionSettingsOnlyPatch.ts),
 *   which updateSessionInDb (localDb/ipc/sessions.ts) and the Node Host's /sessions/update both call to
 *   decide `bumpUpdatedAt`. The sidebar sorts tasks by updatedAt, so a field wrongly treated as activity
 *   moves the task to the top when the user only renamed, pinned, muted, moved or re-configured it; a
 *   field wrongly treated as a setting leaves the time behind after real activity (the check's own note:
 *   after a local /clear the sidebar time fell back on restart).
 * - Bug / rule basis: the SETTINGS_ONLY_FIELDS rule in updateSessionInDb, shared with the Host since the
 *   check moved out of sessions.ts (docs/host/personal-migration-release-table.md, row 甲 18).
 * - Coverage gap: sessionsUpdate.test.ts drives the handler but does not pin every field; dropping
 *   `title` from the set leaves the desktop handler tests green. Only the Host's session-update.test.mjs
 *   caught it, and the Host test is not part of the desktop suite.
 * - Minimal failing input: `{ title: 'x' }` returns false once `title` leaves the set; `{ status: 'archived' }`
 *   returns true once `status` is added to it.
 * - Tier: unit. The function is pure; no database, Electron or IPC is involved, unlike the handler tests,
 *   so it does not join sessionsUpdate.test.ts and its mocked Electron and in-memory database.
 * - Measured: about 2 s wall for `pnpm --dir apps/desktop exec vitest run` of this file alone.
 */

import { describe, expect, it } from 'vitest';

import { isSessionSettingsOnlyPatch } from '../sessionSettingsOnlyPatch';

describe('isSessionSettingsOnlyPatch', () => {
  // Each field the user changes without working in the task: composer settings, directory grants,
  // Orca role, pin, mute, move (project or dialogue) and rename.
  it.each([
    ['model', 'gpt-5'],
    ['effort', 'high'],
    ['permissionMode', 'default'],
    ['fastMode', true],
    ['planModeEnabled', true],
    ['providerId', 'xd'],
    ['contextWindowBudget', 200_000],
    ['orcaRole', 'worker'],
    ['extraDirs', ['/work/a']],
    ['writableDirs', ['/work/b']],
    ['pinnedAt', '2026-11-17T00:00:00.000Z'],
    ['notificationsMuted', true],
    ['workingDir', '/work/project'],
    ['workspaceKind', 'project'],
    ['title', 'Renamed'],
  ])('a %s-only patch leaves updatedAt alone', (field, value) => {
    expect(isSessionSettingsOnlyPatch({ [field]: value })).toBe(true);
  });

  // Activity: archiving or completing, a local /clear, and a new resume id.
  it.each([
    ['status', 'archived'],
    ['clearedAt', '2026-11-17T00:00:00.000Z'],
    ['sdkSessionId', 'sdk-1'],
  ])('a %s patch moves updatedAt', (field, value) => {
    expect(isSessionSettingsOnlyPatch({ [field]: value })).toBe(false);
  });

  it('a patch mixing a setting with activity moves updatedAt', () => {
    expect(isSessionSettingsOnlyPatch({ title: 'Renamed', status: 'archived' })).toBe(false);
  });
});
