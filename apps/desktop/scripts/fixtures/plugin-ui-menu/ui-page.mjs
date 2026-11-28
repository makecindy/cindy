export default {
  name: 'plugin-ui-menu', entry: './menu-fixture.tsx',
  viewport: { width: 640, height: 360 },
  real: 'PluginUiProvider, PluginUiMenu, useInstalledGhosts, Button, DropdownMenu',
  notCovered: 'Native OS mouse hit testing and dragging the window; running plugin views or commands',
  cases: { default: { about: 'Approved task plugin launcher inside an Electron drag region (#13151)' } },
  async check(page, ui) {
    const button = page.getByRole('button', { name: await ui.t('pluginUi.menu'), exact: true });
    // Native Electron contract (#13151): a DOM click alone bypasses the OS drag region.
    // Assert the rendered hit-region property as well as opening the real menu.
    if (await button.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region')) !== 'no-drag')
      throw new Error('Plugin menu trigger must opt out of the native window drag region');
    if (await page.getByTestId('drag-header').evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region')) !== 'drag')
      throw new Error('Surrounding header must remain draggable');
    await button.click();
    await page.getByRole('menuitem', { name: 'View · Planner' }).waitFor();
    await ui.capture('menu-open');
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
  },
};
