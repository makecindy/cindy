import assert from 'node:assert/strict';

export default {
  name: 'provider-group-status',
  entry: './provider-group-status-fixture.tsx',
  viewport: { width: 1000, height: 680 },
  real: 'ProviderGroupSection, RemoteProviderGroupMembers, collapsed quota status, translations and themes',
  notCovered: 'Real subscription reads, account routing, cross-device transport and Windows. All states and reset times are fixture data.',
  cases: {
    default: { about: 'Idle, busy, quota exhausted with known/unknown reset, and generic cooldown' },
    remote: { about: 'The same collapsed statuses in the same-account read-only list' },
    narrow: { about: 'Long translated quota status wraps alongside the existing controls', viewport: { width: 540, height: 900 } },
  },
  async ready(page) {
    await page.getByText('XD-1254678', { exact: true }).waitFor();
  },
  async check(page, ui) {
    const rows = page.getByTestId(ui.case === 'remote' ? 'remote-provider-group-member' : 'provider-group-member');
    assert.equal(await rows.count(), 5);
    const exhausted = await ui.t('providerGroup.member.status.quotaExhausted');
    assert.equal(await rows.nth(2).getByText(exhausted, { exact: false }).count(), 1);
    assert.ok((await rows.nth(2).innerText()).includes(await ui.t('quotaCard.resetIn', {
      duration: `6${await ui.t('todaySpend.unit.day')} 1${await ui.t('todaySpend.unit.hour')}`,
    })));
    assert.equal(await rows.nth(3).getByText(exhausted, { exact: true }).count(), 1);
    assert.ok((await rows.nth(3).innerText()).includes(await ui.t('providerGroup.member.runningCount', { count: 2 })));
    assert.equal(await rows.nth(4).getByText(exhausted, { exact: false }).count(), 0);
    assert.equal(await page.locator('button[aria-expanded="true"]').count(), 0);
  },
};
