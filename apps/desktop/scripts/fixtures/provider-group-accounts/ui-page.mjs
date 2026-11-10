import assert from 'node:assert/strict';

export default {
  name: 'provider-group-accounts',
  entry: './fixture.tsx',
  viewport: { width: 900, height: 620 },
  real: 'ProviderGroupSection, GroupMemberQuota, GroupMemberAccountList, QuotaHoverCard shared columns, translations and themes',
  notCovered:
    'Real subscription reads, sign-in and other computers over device link. Accounts and usage are fixture data.',
  stubs: {
    'src/renderer/hooks/useProviders': `export const useProviders = () => ({
      providers: [{
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        connected: true,
        auth: { method: 'oauth', native: 'claude' },
        routing: {},
      }],
    });`,
  },
  cases: {
    default: {
      about: 'Two signed-in accounts on one computer, one nearly out of weekly quota',
      data: {},
    },
    states: {
      about: 'A paused account and one that needs signing in again',
      data: { states: true },
    },
    'missing-usage': {
      about: 'An authenticated account whose first usage snapshot is unavailable',
      data: { missingUsage: true },
    },
    narrow: {
      about: 'Long account names at a narrow settings width',
      viewport: { width: 420, height: 760 },
      data: { long: true },
    },
    single: {
      about: 'One account keeps the original card with no account name',
      data: { single: true },
    },
    'single-added-paused': {
      about: 'One added account keeps its paused explanation without an account name',
      data: { singleAdded: 'paused' },
    },
    'single-added-signed-out': {
      about: 'One added account needs login and never borrows the unused default quota',
      data: { singleAdded: 'signed-out' },
    },
  },
  async ready(page) {
    await page.getByTestId('provider-group-member').first().waitFor();
    await page
      .locator('[data-testid="provider-group-member"] button[aria-expanded="false"]')
      .first()
      .click();
    await page
      .getByTestId('provider-group-member-quota')
      .locator('[role="progressbar"], [data-testid="provider-group-member-account"]')
      .first()
      .waitFor();
  },
  async check(page, ui) {
    assert.equal(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    const accounts = page.getByTestId('provider-group-member-account');
    if (ui.case === 'single') {
      await page.waitForTimeout(150);
      assert.equal(await accounts.count(), 0);
      return;
    }
    await accounts.first().waitFor();
    if (ui.case.startsWith('single-added-')) {
      assert.equal(await accounts.count(), 1);
      assert.equal(await accounts.getByText('second@example.com', { exact: true }).count(), 0);
      const paused = ui.case === 'single-added-paused';
      await accounts
        .getByText(
          await ui.t(
            paused ? 'providerGroup.member.status.paused' : 'subscriptionAccounts.signedOut',
          ),
          { exact: true },
        )
        .waitFor();
      assert.equal(await accounts.getByRole('progressbar').count(), paused ? 2 : 0);
      return;
    }
    assert.equal(await accounts.count(), ui.case === 'states' ? 3 : 2);
    // Every account's bars share one column, whatever each account's own labels and numbers are.
    const bars = await page.getByRole('progressbar').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return `${Math.round(box.left)}-${Math.round(box.right)}`;
      }),
    );
    assert.equal(new Set(bars).size, 1, bars.join(', '));
    if (ui.case === 'states') {
      await accounts
        .nth(1)
        .getByText(await ui.t('providerGroup.member.status.paused'), { exact: true })
        .waitFor();
      await accounts
        .nth(2)
        .getByText(await ui.t('subscriptionAccounts.signedOut'), { exact: true })
        .waitFor();
      assert.equal(await accounts.nth(2).getByRole('progressbar').count(), 0);
    }
    if (ui.case === 'missing-usage') {
      await accounts
        .nth(1)
        .getByText(await ui.t('quotaCard.noWindows'), { exact: true })
        .waitFor();
      assert.equal(await accounts.nth(1).getByRole('progressbar').count(), 0);
    }
  },
};
