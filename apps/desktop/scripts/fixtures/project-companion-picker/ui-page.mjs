import assert from 'node:assert/strict';

export default {
  name: 'project-companion-picker',
  entry: './fixture.tsx',
  viewport: { width: 480, height: 320 },
  real: 'DraftProjectCompanionPicker, Radix Select, production themes and translations',
  notCovered: 'Task creation, session switching, model replies and persistence',
  cases: { default: { about: 'Select a partner before sending the first message' } },
  async check(page) {
    const trigger = page.getByRole('combobox');
    await trigger.click();
    await page.getByRole('option', { name: '代码伙伴' }).click();
    assert.equal(await trigger.textContent(), '代码伙伴');
    await trigger.click();
    await page.getByRole('listbox').waitFor();
  },
};
