import assert from 'node:assert/strict';
export default {
  name: 'rich-answer',
  entry: './rich-answer-fixture.tsx',
  viewport: { width: 560, height: 480 },
  real: 'RichAnswer controls, message preview, explicit click, submitted state and theme tokens',
  notCovered: 'Real host sending, queue delivery and model continuation; covered separately in isolated Desktop.',
  stubs: { 'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ user: { id: "rich-fixture" } });' },
  cases: {
    default: { about: 'Edit values and explicitly submit the displayed message' },
    narrow: { about: 'Controls and submitted message at 320px', viewport: { width: 320, height: 520 } },
    readonly: { about: 'Read-only history cannot send a message' },
    'invalid-image': { about: '#9158: invalid image references offer explicit redelivery rather than reloading the placeholder' },
    'invalid-image-narrow': { about: 'Invalid image recovery wraps at 320px', viewport: { width: 320, height: 520 } },
    'invalid-image-readonly': { about: 'Read-only invalid images cannot submit recovery messages' },
  },
  async check(page, ui) {
    if (ui.case.startsWith('invalid-image')) {
      assert.equal(await page.getByRole('status').innerText(), await ui.t('richAnswer.invalidImageReference'));
      const button = page.getByRole('button', { name: await ui.t('richAnswer.requestImageAgain'), exact: true });
      assert.equal(await page.getByTestId('sent-messages').innerText(), '');
      assert.equal(await page.locator('img').count(), 0);
      if (ui.case.endsWith('readonly')) { assert.equal(await button.isDisabled(), true); return; }
      const message = await ui.t('richAnswer.requestImageAgainMessage', { name: JSON.stringify('图片对比'), source: JSON.stringify('cindy-media://__SCALE__') });
      assert.equal(await page.getByText(message, { exact: true }).count(), 1);
      await ui.capture('invalid-image');
      await button.click();
      await page.getByRole('button', { name: await ui.t('richAnswer.sent'), exact: true }).waitFor();
      assert.equal(await page.getByTestId('sent-messages').innerText(), message);
      await ui.capture('requested');
      return;
    }
    const button = page.getByRole('button', { name: '请帮我安排' });
    if (await button.isDisabled()) { assert.equal(await page.getByTestId('sent-messages').innerText(), ''); return; }
    await page.getByLabel('目的地').selectOption('博物馆');
    assert.equal(await page.getByTestId('sent-messages').innerText(), '');
    await ui.capture('edited');
    await button.click();
    await page.getByRole('button', { name: await ui.t('richAnswer.sent'), exact: true }).waitFor();
    assert.equal(await page.getByTestId('sent-messages').innerText(), '请安排周末去博物馆。慢慢逛，不赶时间');
    await ui.capture('submitted');
  },
};
