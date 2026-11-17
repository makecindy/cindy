import assert from 'node:assert/strict';
export default {
  name: 'settings-navigation', entry: './fixture.tsx', viewport: { width: 360, height: 240 },
  real: 'SettingsLinkChip, shared InlineReferenceChip, device label and theme tokens',
  notCovered: 'Actual device-link navigation, OS remote screen and mobile native text; behavior covered by unit tests.',
  cases: { default: { about: 'Two settings entries with an explicit target computer in a narrow conversation' } },
  async ready(page) { await page.getByRole('button', { name: /Mac Studio/ }).first().waitFor(); },
  async check(page) {
    assert.equal(await page.getByRole('button', { name: /Mac Studio/ }).count(), 2);
    const decoration = await page.getByRole('button').first().evaluate(el => getComputedStyle(el).textDecorationLine);
    assert.equal(decoration, 'underline');
  },
};
