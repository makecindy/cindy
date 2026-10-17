import assert from 'node:assert/strict';

const longName = 'Studio workstation with a very long device name 工作电脑';
const roster = {
  bots: [
    { id: 'cindy-default', name: 'Cindy', status: 'active', avatar: '', sessionId: 'fixture-chat' },
  ],
  remoteBots: [
    {
      id: 'cindy-default',
      deviceId: 'fixture-remote',
      deviceName: longName,
      name: 'Cindy',
      online: false,
      lastReplyAt: 20,
      readAt: 10,
      status: 'active',
      avatar: '',
    },
  ],
  devices: [{ deviceId: 'self', name: 'Local workstation', isSelf: true }],
  unread: { 'cindy-default': 3 },
};
const data = 'window.__uiPage.ctx.data';

/** DESIGN.md compact Cindy device navigation (replaces the former verify-device-picker.cjs). */
export default {
  name: 'device-picker',
  entry: './device-picker-fixture.tsx',
  viewport: { width: 1040, height: 520 },
  real: 'CindyDeviceRow, CindyDevicePicker, BotSessionContentHeader in the ContentHeader shell, shared Select/Radix menu, routing, theme, fonts and translations',
  notCovered:
    'Roster loading and unread state sources, device connections, workbench opening, row context menu',
  stubs: {
    'src/renderer/features/bots/botStore': {
      partial: `export const useBotProfiles=()=>${data}.bots;export const useBotUnreadCounts=()=>${data}.unread;`,
    },
    'src/renderer/features/bots/useRemoteBots': `export const useRemoteBots=()=>${data}.remoteBots;`,
    'src/renderer/features/device-link/useDeviceLinkDeviceList': `export const useDeviceLinkDeviceList=()=>${data}.devices;`,
    'src/renderer/features/right-sidebar/lib/openBotWorkbenchTab':
      'export const openBotWorkbenchTab=async()=>{};',
  },
  cases: {
    default: {
      about: 'This device is current and the row is selected; trigger stays compact',
      data: { ...roster, currentIndex: 0, selected: true },
    },
    'long-name': {
      about: 'Offline remote device with a long name is current; row not selected',
      data: { ...roster, currentIndex: 1, selected: false },
    },
  },
  async ready(page) {
    await page.getByTestId('cindy-device-row').getByRole('combobox').waitFor();
    await page.locator('header').getByRole('combobox').waitFor();
  },
  async check(page, ui) {
    const long = ui.case === 'long-name';
    const local = await ui.t('bots.devicePicker.local');
    const row = page.getByTestId('cindy-device-row');
    const trigger = row.getByRole('combobox');
    const header = page.locator('header');
    const headerTrigger = header.getByRole('combobox');
    const box = await trigger.boundingBox();
    const rowBox = await row.boundingBox();
    const headerBox = await headerTrigger.boundingBox();
    assert.equal(box.height, 24, 'trigger keeps 24px height');
    assert.ok(box.x + box.width <= rowBox.x + rowBox.width - 10, 'picker stays inside the row');
    if (!long)
      for (const [picker, name] of [
        [trigger, 'sidebar'],
        [headerTrigger, 'header'],
      ]) {
        // Compact = exactly its label, unread dot and chevron, in every locale.
        const { actual, natural } = await picker.evaluate((el) => {
          const actual = el.getBoundingClientRect().width;
          const previous = el.style.width;
          el.style.width = 'max-content';
          const natural = el.getBoundingClientRect().width;
          el.style.width = previous;
          return { actual, natural };
        });
        assert.ok(
          Math.abs(actual - natural) < 1,
          `${name} trigger fits its label (${actual} vs ${natural})`,
        );
      }
    assert.ok(headerBox.width <= 176, 'header trigger maximum 176px');
    if (long)
      for (const picker of [trigger, headerTrigger]) {
        assert.ok(
          await picker
            .locator('span')
            .first()
            .evaluate((el) => el.scrollWidth > el.clientWidth),
          'long device name truncates',
        );
        assert.equal(
          await picker.getAttribute('title'),
          longName,
          'truncated name keeps its title',
        );
      }
    // Blank row area opens the chat once and never the menu.
    await page.mouse.click(
      long ? rowBox.x + rowBox.width - 4 : box.x + box.width + 12,
      box.y + box.height / 2,
    );
    assert.equal(await page.getByTestId('opens').textContent(), '1', 'blank area opens chat once');
    assert.equal(await page.getByRole('listbox').count(), 0, 'blank area does not open the menu');
    await page.mouse.click(rowBox.x + 20, rowBox.y + 20);
    assert.equal(await page.getByTestId('opens').textContent(), '2', 'avatar opens chat');
    await trigger.hover();
    await ui.capture('hover');
    await trigger.click();
    const menu = page.getByRole('listbox');
    await menu.waitFor();
    const menuBox = await menu.boundingBox();
    assert.ok(
      menuBox.width >= 250 && menuBox.x >= 0 && menuBox.x + menuBox.width <= ui.viewport.width,
      'menu is readable and inside the window',
    );
    assert.equal(
      await page.getByTestId('opens').textContent(),
      '2',
      'menu does not also open chat',
    );
    const menuText = await menu.innerText();
    assert.ok(menuText.includes(await ui.t('bots.remote.offline')), 'offline state shown');
    assert.ok(menuText.includes('3'), 'unread count shown');
    assert.equal(
      await menu.getByRole('option', { name: new RegExp(longName) }).getAttribute('title'),
      longName,
    );
    await ui.capture('menu');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    await page.waitForFunction(() =>
      document.activeElement?.matches('[data-testid="cindy-device-row"] [role="combobox"]'),
    );
    await page.keyboard.press('Tab');
    assert.ok(
      await header
        .getByRole('button')
        .first()
        .evaluate((el) => el === document.activeElement),
      'Tab leaves the picker',
    );
    await trigger.focus();
    await page.keyboard.press('Enter');
    await menu.waitFor();
    await page.keyboard.press(long ? 'Home' : 'End');
    await page.waitForFunction(
      (label) => document.activeElement?.textContent?.includes(label),
      long ? local : longName,
    );
    await page.keyboard.press('Enter');
    await menu.waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('selections').textContent(), '1', 'keyboard selects once');
    assert.equal(await page.getByTestId('opens').textContent(), '2', 'selection never opens chat');
    await trigger.focus();
    await page.keyboard.press('Space');
    await menu.waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    await headerTrigger.click();
    await menu.getByRole('option', { name: long ? local : new RegExp(longName) }).click();
    const target = long ? '/bots/cindy-default' : '/bots/remote/fixture-remote/cindy-default';
    await page.waitForFunction(
      (route) => document.querySelector('[data-testid="route"]')?.textContent === route,
      target,
    );
    const ordinary = page.getByTestId('ordinary-select').getByRole('combobox');
    const ordinaryWidth = (await ordinary.boundingBox()).width;
    await ordinary.click();
    assert.equal(
      Math.round((await menu.boundingBox()).width),
      Math.round(ordinaryWidth),
      'ordinary Select keeps trigger-width menu',
    );
    await page.keyboard.press('Escape');
  },
};
