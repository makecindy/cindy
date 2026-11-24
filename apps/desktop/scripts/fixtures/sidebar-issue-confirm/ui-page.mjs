import assert from 'node:assert/strict';

export default {
  name: 'sidebar-issue-confirm',
  entry: './fixture.tsx',
  viewport: { width: 960, height: 600 },
  real: 'SessionItem, SessionCard, IssueConfirmCard, makerChatStore interaction ingress and cancel routing',
  notCovered: 'Electron preload and main-process receipt validation, channel delivery, publication and top-level workspace navigation',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});',
    },
  },
  cases: {
    default: { about: 'Background feedback request and its cancellation in the text sidebar' },
    list: { about: 'Background feedback request and its cancellation in the list sidebar' },
  },
  async check(page, ui) {
    const row = page.locator('[data-session-id="fixture-feedback"]');
    const waiting = row.locator('[data-sidebar-right-status="awaiting"]');
    const card = page.getByRole('heading', { name: 'Synthetic feedback draft', exact: true });
    const emit = (dataOwnerId) => page.evaluate((owner) =>
      window.__uiPage.emit('issue-request', { dataOwnerId: owner }), dataOwnerId);
    const cancel = page.getByRole('button', { name: await ui.t('issueAgent.confirm.cancel'), exact: true });
    await row.waitFor({ state: 'visible' });
    assert.equal(await page.locator('main').getAttribute('data-active-task'), 'fixture-foreground');
    assert.equal(await emit('another-owner'), 1);
    assert.equal(await waiting.count(), 0, 'The other owner’s request does not mark the task');
    await row.click();
    assert.equal(await card.count(), 0, 'The other owner’s request never enters this task');
    await page.locator('[data-session-id="fixture-foreground"]').click();
    assert.equal(await emit('fixture'), 1);
    assert.equal(await emit('fixture'), 1);
    await page.waitForFunction(() => document.querySelector('main')?.dataset.activeTask === 'fixture-foreground');
    const hadWaitingStatus = await waiting.isVisible();
    assert.equal(await card.count(), 0, 'The draft stays in its original task');
    await ui.capture('background-request');

    await row.click();
    await card.waitFor({ state: 'visible' });
    assert.equal(await page.locator('main').getAttribute('data-active-task'), 'fixture-feedback');
    assert.equal(await card.count(), 1, 'Duplicate delivery still displays one card');
    assert.equal(await page.evaluate(() => window.__uiPage.emit('issue-dismissed', 'different-request')), 1);
    assert.ok(await card.isVisible(), 'A dismissal for another request leaves this card open');
    await ui.capture('opened-original-task');
    await cancel.click();
    await card.waitFor({ state: 'detached' });
    assert.equal(await page.locator('html').getAttribute('data-issue-cancelled'), 'fixture-issue-confirm');
    assert.equal(await page.locator('html').getAttribute('data-issue-cancel-count'), '1');
    await page.locator('[data-session-id="fixture-foreground"]').click();
    await waiting.waitFor({ state: 'detached' });
    await ui.capture('cancelled');
    assert.ok(hadWaitingStatus, 'A pending feedback request must be visible in its background task row');
  },
};
