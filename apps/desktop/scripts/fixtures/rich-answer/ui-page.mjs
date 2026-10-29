import assert from 'node:assert/strict';
export default {
  name: 'rich-answer',
  entry: './rich-answer-fixture.tsx',
  viewport: { width: 560, height: 480 },
  real: 'RichAnswer controls, message preview, explicit click, submitted state and theme tokens',
  notCovered: 'Real host sending, queue delivery and model continuation; covered separately in isolated Desktop.',
  stubs: { 'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ user: { id: "rich-fixture" } });' },
  cases: { default: { about: 'Edit values and explicitly submit the displayed message' }, narrow: { about: 'Controls and submitted message at 320px', viewport: { width: 320, height: 520 } }, readonly: { about: 'Read-only history cannot send a message' } },
  async check(page, ui) {
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
