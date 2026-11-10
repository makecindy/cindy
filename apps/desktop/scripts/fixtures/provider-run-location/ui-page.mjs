import assert from 'node:assert/strict';
import base from '../provider-share-sources/ui-page.mjs';

/** Design check: choose which of your computers runs a provider (hidden with one computer). */
export default {
  name: 'provider-run-location',
  entry: './fixture.tsx',
  viewport: { width: 1000, height: 720 },
  real: 'ProvidersSection detail, ProviderRunLocationRow, shared Select, translations and themes',
  notCovered: 'Persisting the choice, routing new tasks, live device catalogs; computers and accounts are fixture data',
  stubs: {
    ...base.stubs,
    'src/renderer/hooks/useCodexAuth': 'export const useCodexAuth = () => (window.__uiPage.ctx.case === "borrowing" ? { state: { kind: "unauthenticated" }, recoveryCheck: "idle" } : { state: { kind: "authenticated", identity: "chris@example.com", authSource: "oauth" }, recoveryCheck: "idle" }); export const isChatGptConnectionConnected = () => window.__uiPage.ctx.case !== "borrowing";',
  },
  cases: {
    default: { about: 'This computer is signed in; Automatic keeps tasks here' },
    borrowing: { about: 'This computer is not signed in; new tasks run on MBP-M5 and the page reads as usable' },
    pinned: { about: 'Signed in here, but the user chose to run this provider on MBP-M5' },
    'never-signed-in': { about: 'Anthropic was never signed in here; it is still listed and runs on MBP-M5' },
    'single-computer': { about: 'No other computer offers the provider: the row is hidden' },
  },
  async ready(page) {
    await page.getByRole('heading').first().waitFor();
  },
  async check(page, ui) {
    const row = page.getByTestId('provider-run-location');
    if (ui.case === 'never-signed-in') {
      // Review #9740: a built-in provider only another computer offers must not vanish from the list.
      await page.getByRole('button', { name: /^Anthropic/ }).first().click();
      await row.waitFor();
      assert.match(await row.textContent() ?? '', /MBP-M5/);
      await ui.capture('row');
      return;
    }
    if (ui.case === 'single-computer') {
      assert.equal(await row.count(), 0);
      return;
    }
    await row.waitFor();
    await row.scrollIntoViewIfNeeded();
    await ui.capture('row');
    if (ui.case === 'borrowing') {
      await page.getByRole('button', { name: await ui.t('settings.providers.detail.moreActionsAria') }).click();
      await page.getByRole('menuitem', { name: await ui.t('settings.providers.detail.runLocation.signInHere') }).waitFor();
      await ui.capture('more');
      await page.keyboard.press('Escape');
      return;
    }
    if (ui.case !== 'default') return;
    await row.getByRole('combobox').click();
    await page.getByRole('option', { name: 'MBP-M5' }).waitFor();
    await ui.capture('menu');
    await page.keyboard.press('Escape');
  },
};
