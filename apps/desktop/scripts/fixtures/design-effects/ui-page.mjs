import assert from 'node:assert/strict';

const settle = (page) => page.waitForTimeout(260);

export default {
  name: 'design-effects',
  entry: './design-effects-fixture.tsx',
  viewport: { width: 760, height: 720 },
  real: 'JumpToBottomChip, NewMessageIndicator, PrevMessageJumpChip, Tip, PermissionSelector, ChatAudioCard, SidebarIconButton, AgentActionRow, UserMessage, ChromeIconButton, theme tokens and translations',
  notCovered: 'Other floating layers changed by the same class rewrite (find bar, terminal notices, schedule panels); non-Cindy themes',
  cases: { default: { about: 'Floating shadow, field panel shadow, title-bar icon colour and the HSL colours that used to be invalid; create-agent states are token samples' } },
  async check(page, ui) {
    // shadow-none computes to transparent layers rather than `none`; --shadow-menu has a 16px blur.
    const hasMenuShadow = (locator) => locator.evaluate((el) => getComputedStyle(el).boxShadow.includes('16px'));
    const resolve = (color) => page.evaluate((value) => {
      const probe = document.createElement('i');
      probe.style.color = value;
      document.body.append(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();
      return computed;
    }, color);

    const chipShadows = [
      await hasMenuShadow(page.locator('[data-chip] button').first()),
      await hasMenuShadow(page.locator('[data-chip] button').last()),
      await hasMenuShadow(page.locator('button[title="上一条提问的内容"]')),
    ];
    const titleIcon = await page.locator('button[aria-label="settings"]').last().evaluate((el) => getComputedStyle(el).color);

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

    const sidebarIcon = page.locator('[data-sidebar-icon] button');
    await sidebarIcon.hover();
    await settle(page);
    const sidebarHover = await sidebarIcon.evaluate((el) => getComputedStyle(el, '::before').backgroundColor);
    await ui.capture('sidebar-icon-hover');
    await page.mouse.move(2, 2);
    await settle(page);

    await page.locator('[data-tool-input] button[aria-expanded]').first().click();
    await page.locator('[data-orca-message] button[aria-expanded]').first().click();
    const toolInputColor = await page.locator('[data-tool-input] pre').first().evaluate((el) => getComputedStyle(el).color);
    const orcaColor = await page.locator('[data-orca-message] pre').first().evaluate((el) => getComputedStyle(el).color);
    await settle(page);
    await ui.capture('expanded-text');

    // Assert after every capture so the --compare "before" side still photographs each state.
    assert.deepEqual(chipShadows, [true, true, true], 'Jump and new-message chips carry --shadow-menu');
    assert.ok(tooltipShadow, 'Tooltip carries --shadow-menu');
    assert.ok(panelShadow, 'Field panel carries --shadow-menu');
    assert.equal(titleIcon, await resolve('hsl(var(--titlebar-icon))'), 'Title-bar icon uses its own colour');
    assert.equal(sidebarHover, await resolve('hsl(var(--sidebar-item-hover))'), 'Sidebar icon hover shows its fill');
    const foreground = await resolve('hsl(var(--foreground))');
    assert.equal(toolInputColor, foreground, 'Tool input text uses --foreground');
    assert.equal(orcaColor, foreground, 'Orca message text uses --foreground');
  },
};
