import assert from 'node:assert/strict';

export default {
  name: 'provider-share-insights',
  entry: './provider-share-insights-fixture.tsx',
  viewport: { width: 1220, height: 900 },
  real: 'ProviderShareManagePage, ProviderShareReceivedDetail, visibility switches, quota cards, ProviderUsageSection, translations and themes',
  notCovered:
    'Live cross-account transport, persisted permissions, real upstream quota, Windows. All numbers and names are fixture data.',
  stubs: {
    'src/renderer/hooks/useProviders': {
      partial: `export const useProviders = () => ({ providers: [{ id: 'xd', name: 'Cindy AI', source: 'builtin', auth: { method: 'oauth', native: 'claude' }, routing: {}, models: {}, subscriptionFastPolicy: { allowFast: true } }], loading: false });`,
    },
    'src/renderer/hooks/useDeviceProviders': {
      partial: `export const useDeviceProviders = () => ({ providers: [{ id: 'xd', name: 'Cindy AI', source: 'builtin', auth: { method: 'oauth', native: 'claude' }, subscriptionFastPolicy: { allowFast: true }, routing: {}, models: { 'claude-code': [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }, { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }], codex: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] } }], loading: false, error: null, unsupported: false });`,
    },
  },
  cases: {
    owner: {
      about: 'Owner detail with a two-computer subscription group and independent visibility switches; writes affect fixture memory only',
    },
    'owner-remote': {
      about: 'Same-account remote group management retains a visible, uncompressed account Fast setting',
    },
    default: { about: 'Both capabilities; usage collapsed, models visible at desktop height' },
    expanded: {
      about: 'Explicitly expanded usage with charts by person and model',
      viewport: { width: 1220, height: 2100 },
    },
    subscription: { about: 'Read-only subscription windows with existing remaining bars' },
    organization: { about: 'Organization remaining balance and known budget' },
    warning: {
      about: '15% remaining uses the existing quota warning',
      data: { remainingPercent: 15 },
    },
    critical: {
      about: '10% remaining uses the existing quota danger',
      data: { remainingPercent: 10 },
    },
    low: {
      about: '5% remaining keeps the danger state and true fill',
      data: { remainingPercent: 5 },
    },
    full: {
      about: '100% remaining fills the track without warning',
      data: { remainingPercent: 100 },
    },
    unknown: { about: 'Unknown total has no fabricated percentage' },
    zero: { about: 'True zero balance has a zero progress bar' },
    'quota-only': { about: 'Only remaining allowance shared' },
    'usage-only': { about: 'Only usage details shared' },
    closed: { about: 'Both permissions disabled without disabling model use' },
    group: { about: 'Two anonymous own accounts; borrowed accounts excluded' },
    'subscription-pool': { about: 'Each account of a shared multi-account subscription lists all of its own windows' },
  },
  async ready(page) {
    await page
      .getByTestId('provider-share-visibility')
      .or(page.getByTestId('provider-share-insights'))
      .waitFor();
  },
  async check(page, ui) {
    if (ui.case.startsWith('owner')) {
      // 2026-11-11: a duplicate account Fast card shrank into a line below the page title.
      // Render the real page with a subscription group (previous fixture had no provider).
      // UI tier: local account control stays in provider details; remote management keeps its account control.
      const fast = page.getByRole('switch', { name: await ui.t('subscriptionFastPolicy.label'), exact: true });
      assert.equal(await fast.count(), ui.case === 'owner-remote' ? 2 : 1);
      if (ui.case === 'owner-remote') {
        // A switch inside the collapsed card still has a box, but cannot actually be hit.
        assert.equal(await fast.first().evaluate(element => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return hit === element || element.contains(hit);
        }), true);
      }
      // The owner page reads run limits (including idle reclaim) on mount. A missing fixture
      // reply would turn that read into a forbidden operation and render an error.
      const idleMinutes = page.getByTestId('remote-agent-limit-idleMinutes');
      await idleMinutes.waitFor();
      assert.equal(await idleMinutes.inputValue(), '30');
      assert.equal(await page.getByRole('alert').count(), 0);
      const quota = page.getByRole('switch', {
        name: await ui.t('providerShare.insights.allowQuota'),
        exact: true,
      });
      const usage = page.getByRole('switch', {
        name: await ui.t('providerShare.insights.allowUsage'),
        exact: true,
      });
      await quota.waitFor();
      const descriptionId = await usage.getAttribute('aria-describedby');
      assert.ok(descriptionId);
      const description = page.locator(`[id="${descriptionId}"]`);
      assert.equal(
        await description.textContent(),
        await ui.t('providerShare.insights.allowUsageDescription'),
      );
      assert.equal(await description.isVisible(), true);
      assert.equal(await quota.getAttribute('aria-describedby'), null);
      assert.equal(await quota.isEnabled(), true);
      await quota.click();
      assert.equal(await quota.getAttribute('aria-checked'), 'false');
      assert.equal(await usage.getAttribute('aria-checked'), 'true');
      await quota.click();
      await ui.capture('owner-switches');
    } else {
      const body = await page.getByTestId('provider-share-insights').textContent();
      assert.ok(!body.includes('Private device name'));
      const models = page.getByTestId('provider-share-received-models');
      assert.equal(await models.getByRole('listitem').count(), 3);
      if (ui.case === 'default') {
        const bounds = await models.getByRole('listitem').last().boundingBox();
        assert.ok(
          bounds && bounds.y + bounds.height <= ui.viewport.height,
          'Default view shows models without scrolling',
        );
        await ui.capture('collapsed-models');
      }
      const progress = page.getByRole('progressbar');
      if (
        ['default', 'organization', 'zero', 'warning', 'critical', 'low', 'full'].includes(ui.case)
      ) {
        const sizes = await progress.evaluateAll((tracks) =>
          tracks.map((track) => {
            const row = track.parentElement;
            const style = row.ownerDocument.defaultView.getComputedStyle(row);
            const bounds = track.getBoundingClientRect();
            return {
              track: bounds.width,
              leftOffset: track.firstElementChild.getBoundingClientRect().left - bounds.left,
              fill: track.firstElementChild.getBoundingClientRect().width,
              content:
                row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
              belowDetail:
                bounds.top >= track.previousElementSibling.getBoundingClientRect().bottom,
            };
          }),
        );
        assert.ok(sizes.length > 0);
        const remaining =
          ui.case === 'default'
            ? [(24.8 / 60) * 100, 100, 100]
            : [ui.data.remainingPercent ?? (ui.case === 'zero' ? 0 : 64.8)];
        for (const [index, size] of sizes.entries()) {
          assert.ok(Math.abs(size.leftOffset) <= 1, 'Remaining fill starts at the left edge');
          assert.ok(
            Math.abs(size.fill - (size.track * remaining[index]) / 100) <= 1,
            'Fill preserves the actual remaining ratio',
          );
          assert.ok(Math.abs(size.track - size.content) <= 1, 'Balance track spans row content');
          assert.ok(size.belowDetail, 'Balance track sits below the amount description');
        }
      }
      if (ui.case === 'default') {
        assert.equal(await progress.count(), 3);
        assert.ok(
          Math.abs(
            Number(await progress.first().getAttribute('aria-valuenow')) -
              Math.round((24.8 / 60) * 100),
          ) < 0.01,
        );
      }
      if (ui.case === 'organization')
        assert.equal(await progress.first().getAttribute('aria-valuenow'), '65');
      if (ui.case === 'group') assert.equal(await progress.count(), 5);
      if (ui.case === 'subscription-pool') {
        assert.equal(await progress.count(), 5);
        for (const number of [1, 2])
          await page.getByText(await ui.t('providerShare.insights.account', { number }), { exact: true }).waitFor();
        await page.getByText('Fable', { exact: false }).first().waitFor();
      }
      if (ui.case === 'unknown') assert.equal(await progress.count(), 0);
      if (ui.case === 'zero')
        assert.equal(await progress.first().getAttribute('aria-valuenow'), '0');
      if (ui.case === 'subscription') {
        assert.equal(await progress.count(), 2);
        assert.equal(await progress.first().getAttribute('aria-valuenow'), '43');
      }
      if (!['closed', 'quota-only'].includes(ui.case)) {
        const toggle = page.getByRole('button', {
          name: await ui.t('providerShare.insights.usageTitle'),
          exact: true,
        });
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        const tabs = page.getByRole('tablist', { name: await ui.t('providerGroup.usage.title') });
        assert.equal(await tabs.count(), 0);
        if (ui.case === 'expanded') {
          await toggle.click();
          await tabs.waitFor();
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          assert.equal(await tabs.getByRole('tab').count(), 2);
          await ui.capture('by-person');
          await tabs
            .getByRole('tab', { name: await ui.t('providerGroup.usage.stack.model') })
            .click();
          assert.equal(await page.getByTestId('provider-usage-model').count(), 2);
          await ui.capture('by-model');
        }
      }
    }
  },
};
