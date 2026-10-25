import assert from 'node:assert/strict';

export default {
  name: 'subscription-fast',
  entry: './subscription-fast-fixture.tsx',
  viewport: { width: 760, height: 800 },
  real: 'SubscriptionFastSetting, ProviderGroupSection, settings rows, switches, translations and themes',
  notCovered:
    'Real subscriptions, native Agent settings and cross-device delivery. Host APIs use fixture memory.',
  cases: {
    default: { about: 'Supplier and group allow Fast', data: { allowFast: true } },
    prohibited: { about: 'Both levels prohibit Fast', data: { allowFast: false } },
    pending: {
      about: 'Group reports an unconfirmed executor',
      data: { allowFast: false, pending: true },
    },
    narrow: {
      about: 'Subscription controls at 320 px',
      viewport: { width: 320, height: 950 },
      data: { allowFast: false, pending: true },
    },
  },
  async ready(page) {
    await page.getByTestId('subscription-fast-fixture').waitFor();
  },
  async check(page, ui) {
    const switches = page.getByRole('switch', {
      name: await ui.t('subscriptionFastPolicy.label'),
      exact: true,
    });
    assert.equal(await switches.count(), 2);
    for (let index = 0; index < 2; index++) {
      const control = switches.nth(index);
      const before = await control.getAttribute('aria-checked');
      await control.click();
      await page.waitForFunction(
        ({ name, index, before }) => {
          const controls = [...document.querySelectorAll('[role="switch"]')].filter(
            (el) => el.getAttribute('aria-label') === name,
          );
          return controls[index]?.getAttribute('aria-checked') !== before;
        },
        { name: await ui.t('subscriptionFastPolicy.label'), index, before },
      );
      await control.click();
      await page.waitForFunction(
        ({ name, index, before }) => {
          const controls = [...document.querySelectorAll('[role="switch"]')].filter(
            (el) => el.getAttribute('aria-label') === name,
          );
          return controls[index]?.getAttribute('aria-checked') === before;
        },
        { name: await ui.t('subscriptionFastPolicy.label'), index, before },
      );
      const box = await control.boundingBox();
      // Electron windows use the harness viewport; Playwright viewportSize() is null.
      assert.ok(box && box.x >= 0 && box.x + box.width <= ui.viewport.width);
    }
    if (ui.case === 'pending' || ui.case === 'narrow')
      await page.getByText(await ui.t('subscriptionFastPolicy.pending'), { exact: true }).waitFor();
  },
};
