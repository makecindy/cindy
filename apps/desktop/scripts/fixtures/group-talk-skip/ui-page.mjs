import assert from 'node:assert/strict';
export default {
  name: 'group-talk-skip', entry: './fixture.tsx', viewport: { width: 600, height: 380 },
  real: 'BotGroupPlanCard, shared step-state/skip predicates, production buttons, translations and styles',
  notCovered: 'API, actual devices, leases and Mobile native runtime. Skip receipt is fixture data; server concurrency is tested separately.',
  cases: Object.fromEntries(['default', 'running', 'stopped', 'viewer', 'legacy', 'busy', 'waiting'].map(name => [name, { about: `Talk card: ${name}` }])),
  async ready(page) { await page.getByTestId('bot-group-plan').waitFor(); },
  async check(page, ui) {
    const skip = page.getByRole('button', { name: await ui.t('bots.groupChat.plan.skipTurnLabel', { name: 'Engineering Delivery Teammate' }), exact: true });
    assert.equal(await skip.count(), ['default', 'busy'].includes(ui.case) ? 1 : 0);
    assert.equal(await page.getByTestId('bot-group-plan-step').count(), 3);
    const fold = page.getByTestId('bot-group-plan-fold');
    await fold.click();
    assert.equal(await page.getByTestId('bot-group-plan-step').count(), 6);
    const future = page.getByRole('button', { name: await ui.t('bots.groupChat.plan.skipTurnLabel', { name: '代码审计' }), exact: true });
    assert.equal(await future.count(), ['default', 'running', 'busy', 'waiting'].includes(ui.case) ? 1 : 0);
    if (ui.case === 'busy') assert.equal(await future.isDisabled(), true);
    if (['default', 'running', 'waiting'].includes(ui.case)) {
      await future.click();
      await page.getByText(await ui.t('bots.groupChat.plan.stepSkipped'), { exact: true }).waitFor();
      assert.equal(await future.count(), 0);
      assert.equal(await skip.count(), ui.case === 'default' ? 1 : 0);
      await ui.capture('future-skipped-current-unchanged');
    }
    await fold.click();
    if (ui.case === 'busy') assert.equal(await skip.isDisabled(), true);
    if (ui.case === 'default') {
      await page.getByText(await ui.t('bots.groupChat.plan.stepQueued'), { exact: true }).last().waitFor();
      await skip.click();
      await page.getByText(await ui.t('bots.groupChat.plan.stepSkipped'), { exact: true }).waitFor();
      assert.equal(await skip.count(), 0);
      await ui.capture('skipped-next-running');
    }
  },
};
