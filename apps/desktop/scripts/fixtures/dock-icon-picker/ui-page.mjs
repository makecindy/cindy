import assert from 'node:assert/strict';

export default {
  name: 'dock-icon-picker',
  entry: './dock-icon-picker-fixture.tsx',
  viewport: { width: 320, height: 240 },
  real: 'DockIconPicker, shared Tip, global focus styles, light/dark tokens and translations',
  notCovered: 'Native macOS Dock, real persistence and full App root keyboard listeners',
  cases: {
    default: {
      about:
        'Keyboard focus is independent of selection; arrow navigation keeps labels and roving tab stops',
    },
    hover: { about: 'Every icon-only option exposes its localized visible name on hover' },
  },
  async check(page, ui) {
    const icons = ['default', 'cat', 'wordmark', 'mark'];
    const option = async (icon) =>
      page.getByRole('radio', {
        name: await ui.t(`settings.appearance.appIcon.options.${icon}`),
        exact: true,
      });
    for (const icon of icons) {
      assert.equal(
        await (await option(icon)).getAttribute('data-setting-id'),
        'settings.appearance.appIcon.label',
        'Every Dock icon option must bind to the registered settings search definition',
      );
    }
    if (ui.case === 'hover') {
      for (const icon of icons) {
        await (await option(icon)).hover();
        const label = await ui.t(`settings.appearance.appIcon.options.${icon}`);
        const tooltip = page.getByRole('tooltip').filter({ hasText: label });
        await tooltip.waitFor({ timeout: 2000 });
        assert.equal(
          await tooltip.textContent(),
          await ui.t(`settings.appearance.appIcon.options.${icon}`),
        );
      }
      await ui.capture('option-name');
      return;
    }
    const selected = await option('default');
    const shadow = () => selected.evaluate((button) => getComputedStyle(button).boxShadow);
    const unfocusedShadow = await shadow();
    await page.getByTestId('before-picker').click();
    await page.keyboard.press('Tab');
    assert.equal(await selected.evaluate((button) => button === document.activeElement), true);
    assert.equal(await selected.evaluate((button) => button.matches(':focus-visible')), true);
    assert.notEqual(
      await shadow(),
      unfocusedShadow,
      'Keyboard focus must add a visible shadow independently of selection',
    );
    assert.match(await shadow(), /inset/, 'The separate selection shadow must remain');
    await page.getByRole('tooltip').waitFor({ timeout: 2000 });
    await ui.capture('keyboard-focus');
    await page.keyboard.press('ArrowRight');
    const cat = await option('cat');
    assert.equal(await cat.evaluate((button) => button === document.activeElement), true);
    assert.equal(await cat.getAttribute('aria-checked'), 'true');
    assert.equal(
      await page
        .getByRole('radio')
        .evaluateAll((buttons) => buttons.filter((button) => button.tabIndex === 0).length),
      1,
    );
    await page.keyboard.press('ArrowLeft');
    assert.equal(await selected.getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(
      await page
        .getByTestId('after-picker')
        .evaluate((button) => button === document.activeElement),
      true,
    );
    assert.equal(
      await shadow(),
      unfocusedShadow,
      'Focus ring must disappear when the group loses focus',
    );
  },
};
