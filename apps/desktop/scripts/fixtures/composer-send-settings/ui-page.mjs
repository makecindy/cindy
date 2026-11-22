import assert from 'node:assert/strict';

export default {
  name: 'composer-send-settings',
  entry: './send-settings-fixture.tsx',
  viewport: { width: 900, height: 360 },
  real: 'ComposerSendShortcutSection (send shortcut + running-send choice), SegmentedControl, DefaultOverrideControls, follow-up preference storage, settings rows, themes and translations',
  notCovered:
    'Settings page navigation and search highlighting, cross-window sync and the real composer (covered by the companion-composer page and unit tests); Windows runtime',
  cases: {
    default: { about: 'Queue is the default; choosing Steer then Queue rewrites the hint and leaves no badge or restore control', data: {} },
    'modifier-send': { about: 'Cmd+Enter is the send key: the row names only that key', data: { followUp: 'steer', sendKey: 'modifier-enter' } },
    narrow: { about: 'Long localized copy wraps inside a 360px column', data: { followUp: 'steer', narrow: true }, viewport: { width: 400, height: 460 } },
  },
  async check(page, ui) {
    const queue = page.getByRole('radio', { name: await ui.t('settings.composer.followUp.options.queue'), exact: true });
    const steer = page.getByRole('radio', { name: await ui.t('settings.composer.followUp.options.steer'), exact: true });
    const stored = () => page.evaluate(() => localStorage.getItem('chat.followUpBehavior'));
    // Neither row shows an override badge or a restore control.
    assert.equal(await page.getByRole('button', { name: await ui.t('settings.defaults.restore'), exact: true }).count(), 0);
    assert.equal(await page.getByText(await ui.t('settings.defaults.customizedBadge'), { exact: true }).count(), 0);
    if (ui.case === 'default') {
      assert.equal(await queue.getAttribute('aria-checked'), 'true');
      assert.equal(await stored(), null);
      await steer.click();
      await page.waitForFunction(() => localStorage.getItem('chat.followUpBehavior') === 'steer');
      await ui.capture('steer-selected');
      await queue.click();
      await page.waitForFunction(() => localStorage.getItem('chat.followUpBehavior') === null);
      await ui.capture('queue-selected');
      return;
    }
    assert.equal(await steer.getAttribute('aria-checked'), 'true');
    // Only the configured send key is named; no other key appears for the other mode.
    const text = await page.locator('body').innerText();
    if (ui.case === 'modifier-send') assert.ok(!text.includes('Shift+Enter'), 'no reverse key is advertised');
  },
};
