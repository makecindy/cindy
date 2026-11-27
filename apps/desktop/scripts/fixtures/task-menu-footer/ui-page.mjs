import assert from 'node:assert/strict';

export default {
  name: 'task-menu-footer',
  entry: './fixture.tsx',
  viewport: { width: 1280, height: 600 },
  real: 'SessionTaskMenu, Radix dropdown positioning and keyboard navigation',
  notCovered: 'Native OS drag regions, actual task deletion, remote writes and the surrounding sidebar',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export function useAuth() { return { dataOwnerId: "fixture-owner", isAuthenticated: true }; }',
    },
  },
  cases: {
    default: { about: 'Archive and Delete remain visible before scrolling a short menu' },
    context: { about: 'The same footer is visible when opening with a right click' },
  },
  async check(page, ui) {
    const trigger = page.getByRole('button', { name: 'Fixture task', exact: true });
    await trigger.click(ui.case === 'context' ? { button: 'right' } : {});
    const menu = page.getByRole('menu').first();
    await menu.waitFor();
    const remove = page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.sessionMenu.delete'), exact: true });
    const pin = page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.sessionMenu.pin'), exact: true });
    await ui.capture('initial');
    // Measure before Playwright can scroll an offscreen target into view.
    for (const target of [remove, pin]) {
      const box = await target.boundingBox();
      const bounds = await menu.boundingBox();
      assert.ok(box && bounds && box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height,
        'Both the first action and Delete must be visible without scrolling');
    }
    if (ui.role === 'before') return;
    await remove.click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Cancel fixture deletion' }).click();
    await trigger.click();
    await menu.waitFor();
    await pin.focus();
    await page.keyboard.press('End');
    await page.waitForFunction(label => document.activeElement?.textContent === label, await remove.textContent());
    await page.keyboard.press('Home');
    await page.waitForFunction(label => document.activeElement?.textContent === label, await pin.textContent());
    await ui.capture('final');
    const move = page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.sessionMenu.moveToProject'), exact: true }).first();
    await move.focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('menu').nth(1).waitFor();
    await page.keyboard.press('Escape');

  },
};
