import assert from 'node:assert/strict';
export default {
  name: 'permission-modes', entry: './fixture.tsx', viewport: { width: 390, height: 470 },
  real: 'PermissionSelector chip, compact and settings-field variants, real menu, translations and themes',
  notCovered: 'Host permission enforcement and persistence; fixture supplies available modes, no live task is changed',
  cases: {
    default: { about: 'Composer permission menu with all four modes' },
    collapsed: { about: 'Collapsed triggers for all four modes' },
    field: { about: 'Settings permission field with explanations' },
    compact: { about: 'Narrow composer icon-only trigger and menu' },
  },
  async check(page, ui) {
    if (ui.case === 'collapsed') return;
    await page.locator('[data-picker] button').first().click();
    await page.getByRole('listbox').waitFor();
    assert.equal(await page.getByRole('option').count(), 4);
    await ui.capture('menu');
    await page.getByRole('option', { name: await ui.t('newChat.permissionSelector.modes.claude-code.bypassPermissions.label'), exact: true }).click();
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    await ui.capture('full-access-selected');
  },
};
