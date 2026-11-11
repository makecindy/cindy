import assert from 'node:assert/strict';

export default {
  name: 'provider-group-accounts',
  entry: './fixture.tsx',
  viewport: { width: 900, height: 620 },
  real: 'ProviderGroupSection, RemoteProviderGroupMembers, GroupMemberQuota, GroupMemberAccountList, QuotaHoverCard shared columns, translations and themes',
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
      about: 'A paused account is excluded and cannot restore the default quota card',
      data: { singleAdded: 'paused' },
    },
    'single-added-signed-out': {
      about: 'One added account needs login and never borrows the unused default quota',
      data: { singleAdded: 'signed-out' },
    },
    // 2026-11-11: jsdom and settled screenshots missed an empty quota block
    // shrinking the clicked row. Hold the real account read and sample browser
    // geometry on every animation frame, through opening, loading and completion.
    'pending-accounts': {
      about: 'The local row never shrinks while its account list is pending',
      data: { pending: true },
    },
    'pending-remote-accounts': {
      about: 'The remote row keeps its height through mouse and keyboard expansion',
      data: { pending: true, remote: true },
    },
  },
  async ready(page) {
    if (await page.locator('main[data-pending-accounts]').count()) {
      await page.locator('[data-member-state="available"]').first().waitFor();
      return;
    }
    await page.getByTestId('provider-group-member').first().waitFor();
    await page
      .locator('[data-testid="provider-group-member"] button[aria-expanded="false"]')
      .first()
      .click();
    await page
      .getByTestId('provider-group-member-quota')
      .locator('[role="progressbar"], [data-testid="provider-group-member-account"], p')
      .first()
      .waitFor();
  },
  async check(page, ui) {
    assert.equal(
      await page.locator('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    if (ui.data.pending) {
      const rowSelector = ui.data.remote
        ? '[data-testid="remote-provider-group-member"]'
        : '[data-testid="provider-group-member"]';
      const row = page.locator(rowSelector).first();
      const button = row.locator('button[aria-expanded]').first();
      for (const interaction of ['mouse', 'keyboard']) {
        await row.evaluate((element) => {
          const button = element.querySelector('button[aria-expanded]');
          const probe = {
            initial: element.getBoundingClientRect().height,
            initialContainer: element.parentElement.getBoundingClientRect().height,
            samples: [], running: true,
          };
          window.__quotaHeightProbe = probe;
          const sample = () => {
            probe.samples.push({
              height: element.getBoundingClientRect().height,
              container: element.parentElement.getBoundingClientRect().height,
              button: button.getBoundingClientRect().height,
              accounts: element.querySelectorAll('[data-testid="provider-group-member-account"]').length,
              bars: element.querySelectorAll('[role="progressbar"]').length,
            });
            if (probe.running) requestAnimationFrame(sample);
          };
          sample();
        });
        if (interaction === 'mouse') await button.click();
        else { await button.focus(); await button.press('Enter'); }
        await page.evaluate(() => new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await ui.capture(`${interaction}-opening`);
        await row.getByText(await ui.t('providerGroup.member.quota.loading'), { exact: true }).waitFor();
        await ui.capture(`${interaction}-loading`);
        await ui.emit('accountsReady', null);
        await row.getByTestId('provider-group-member-account').nth(1).waitFor();
        await ui.capture(`${interaction}-loaded`);
        const probe = await page.evaluate(() => {
          window.__quotaHeightProbe.running = false;
          return window.__quotaHeightProbe;
        });
        assert.ok(probe.samples.length > 2, 'sampled intermediate browser frames');
        const minimum = Math.min(...probe.samples.map(sample => sample.height));
        assert.ok(minimum >= probe.initial - 0.5,
          `${interaction} row shrank from ${probe.initial}px to ${minimum}px`);
        const minimumContainer = Math.min(...probe.samples.map(sample => sample.container));
        assert.ok(minimumContainer >= probe.initialContainer - 0.5,
          `${interaction} cell border shrank from ${probe.initialContainer}px to ${minimumContainer}px`);
        assert.ok(probe.samples.every(sample => Math.abs(sample.button - probe.samples[0].button) < 0.5),
          `${interaction} changed the header height`);
        assert.ok(probe.samples.every(sample => sample.bars === 0 || sample.accounts === 2),
          'never paints a standalone default card before the account list');
        await button.click();
        await row.locator('button[aria-expanded="false"]').first().waitFor();
        assert.equal((await row.boundingBox()).height, probe.initial);
      }
      return;
    }
    const accounts = page.getByTestId('provider-group-member-account');
    if (ui.case === 'single') {
      await page.waitForTimeout(150);
      assert.equal(await accounts.count(), 0);
      return;
    }
    if (ui.case === 'single-added-paused') {
      assert.equal(await accounts.count(), 0);
      assert.equal(await page.getByRole('progressbar').count(), 0);
      return;
    }
    await accounts.first().waitFor();
    if (ui.case.startsWith('single-added-')) {
      assert.equal(await accounts.count(), 1);
      assert.equal(await accounts.getByText('second@example.com', { exact: true }).count(), 0);
      await accounts
        .getByText(
          await ui.t(
            'subscriptionAccounts.signedOut',
          ),
          { exact: true },
        )
        .waitFor();
      assert.equal(await accounts.getByRole('progressbar').count(), 0);
      return;
    }
    assert.equal(await accounts.count(), 2);
    // Every account's bars share one column, whatever each account's own labels and numbers are.
    const bars = await page.getByRole('progressbar').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return `${Math.round(box.left)}-${Math.round(box.right)}`;
      }),
    );
    assert.equal(new Set(bars).size, 1, bars.join(', '));
    if (ui.case === 'states') {
      assert.equal(await page.getByText('second@example.com', { exact: true }).count(), 0);
      await accounts.nth(1).getByText(await ui.t('subscriptionAccounts.signedOut'), { exact: true }).waitFor();
      assert.equal(await accounts.nth(1).getByRole('progressbar').count(), 0);
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
