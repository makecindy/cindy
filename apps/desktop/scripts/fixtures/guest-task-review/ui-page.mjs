import assert from 'node:assert/strict';

export default {
  name: 'guest-task-review',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 540 },
  real: 'Shared task read-only worktree differences',
  notCovered: 'Account sign-in and device transport',
  cases: { default: { about: 'Expand a sibling directory file from the current repository differences', data: {} } },
  async check(page, ui) {
    await page.getByText('other/notes.txt', { exact: true }).click();
    const diff = page.locator('details[open]');
    await diff.getByText('Guest review', { exact: false }).last().waitFor();
    assert.match(await diff.textContent(), /Guest review/);
    await ui.capture('task-edit');
  },
};
