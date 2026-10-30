import assert from 'node:assert/strict';
export default {
  name: 'codex-reset', entry: './codex-reset-fixture.tsx', viewport: { width: 700, height: 650 },
  real: 'CodexResetCredits, CodexResetAutoUseControl, production controls, five locales and themes',
  notCovered: 'Fixture settings RPC; actual redemption, account authentication, persistence and native mobile runtime are not exercised here',
  cases: {
    default: { about: 'Manual cards with compact automatic rules' },
    embedded: { about: 'Collapsed provider card entry' },
    modal: { about: 'Rules and nested selects remain clickable above the usage reset dialog' },
  },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('codexResets.autoUse.rules') }).click();
    await page.getByRole('combobox', { name: await ui.t('codexResets.autoUse.resetDistance') }).waitFor();
    await ui.capture('rules');
    await page.getByRole('combobox', { name: await ui.t('codexResets.autoUse.resetDistance') }).click();
    await page.getByRole('option', { name: await ui.t('codexResets.autoUse.custom'), exact: true }).click();
    const input = page.getByRole('spinbutton');
    await input.fill('7');
    await page.getByRole('button', { name: await ui.t('codexResets.autoUse.apply'), exact: true }).click();
    assert.equal(await input.inputValue(), '7');
    await ui.capture('custom-days');
    await page.keyboard.press('Escape');
    const toggle = page.getByRole('switch');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'true');
    await ui.capture('enabled');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'false');
  },
};
