import assert from 'node:assert/strict';

export default {
  name: 'codex-auth-error',
  entry: './codex-auth-error-fixture.tsx',
  viewport: { width: 560, height: 280 },
  real: 'ErrorBanner, source-specific connection settings navigation and localized authentication guidance',
  notCovered: 'Live OAuth login, account state changes and remote computers',
  cases: {
    default: { about: 'An OpenAI authentication failure offers its connection settings' },
    'changed-source': { about: 'Recovery still targets OpenAI after selecting another provider' },
    narrow: { about: 'Authentication guidance and action at 320 px', viewport: { width: 320, height: 360 } },
  },
  async check(page, ui) {
    const action = page.getByRole('button', { name: await ui.t('logic.confirm.goToSettings'), exact: true });
    assert.ok(await action.isVisible());
    assert.equal(await page.getByTitle(await ui.t('chat.errorBanner.retryTitle'), { exact: true }).count(), 0);
    await action.click();
    await page.waitForFunction(() => document.querySelector('[data-location]')?.getAttribute('data-location') === '/settings?tab=providers&connect=openai');
    assert.equal(await page.locator('[data-location]').getAttribute('data-location'), '/settings?tab=providers&connect=openai');
  },
};
