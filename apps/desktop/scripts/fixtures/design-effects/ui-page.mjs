import assert from 'node:assert/strict';

const settle = (page) => page.waitForTimeout(260);

export default {
  name: 'design-effects',
  entry: './design-effects-fixture.tsx',
  viewport: { width: 760, height: 500 },
  real: 'JumpToBottomChip, NewMessageIndicator, PrevMessageJumpChip, Tip, PermissionSelector, ChatAudioCard, ChromeIconButton, theme tokens and translations',
  notCovered: 'Other floating layers changed by the same class rewrite (find bar, terminal notices, schedule panels); non-Cindy themes',
  cases: { default: { about: 'Registered floating shadow, field panel shadow, title-bar icon colour and create-agent states' } },
  async check(page, ui) {
    // shadow-none computes to transparent layers rather than `none`; --shadow-menu has a 16px blur.
    const hasMenuShadow = (locator) => locator.evaluate((el) => getComputedStyle(el).boxShadow.includes('16px'));
    const chipShadow = await hasMenuShadow(page.locator('button[title="上一条提问的内容"]'));

    await page.locator('[data-tip-target]').hover();
    await page.getByRole('tooltip').first().waitFor();
    const tooltipShadow = await hasMenuShadow(page.locator('[data-radix-popper-content-wrapper] > *').first());
    await ui.capture('tooltip');
    await page.mouse.move(2, 2);
    await settle(page);

    await page.locator('[data-permission-field] button').first().click();
    const panel = page.locator('[data-radix-popper-content-wrapper] > *').first();
    await panel.waitFor();
    await settle(page);
    const panelShadow = await hasMenuShadow(panel);
    await ui.capture('permission-panel');
    await page.keyboard.press('Escape');
    await settle(page);

    // Assert after every capture so the --compare "before" side still photographs each state.
    assert.ok(chipShadow, 'Jump chips carry --shadow-menu');
    assert.ok(tooltipShadow, 'Tooltip carries --shadow-menu');
    assert.ok(panelShadow, 'Field panel carries --shadow-menu');
  },
};
