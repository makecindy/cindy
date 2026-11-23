import assert from 'node:assert/strict';

export default {
  name: 'input-handoff', entry: './fixture.tsx', viewport: { width: 720, height: 600 },
  real: 'InputHandoffDialog, InputHandoffStepForm, native HTML inputs, translations and themes',
  notCovered: 'Native target extraction, secure transport and mobile sheets; verified separately in the running app',
  cases: {
    default: { about: 'Short account and password form', data: { count: 2 } },
    long: { about: 'Forty fields scroll without hiding the Continue button', data: { count: 40 } },
    description: { about: 'Maximum purpose and note leave fields and Continue reachable', data: { count: 2, description: true } },
  },
  async check(page, ui) {
    const dialog = page.getByTestId('input-handoff-dialog');
    await dialog.waitFor();
    const button = page.locator('[data-input-handoff-continue]');
    const before = await button.boundingBox();
    const inputs = page.locator('[data-input-handoff-field]');
    await inputs.last().focus();
    const after = await button.boundingBox();
    const last = await inputs.last().boundingBox();
    assert(before && after && last);
    assert(Math.abs(before.y - after.y) < 1, 'Continue stays fixed while the fields scroll');
    assert(last.y >= 0 && last.y + last.height <= after.y, 'Focused final field is visible above Continue');
    assert(after.y + after.height <= await page.evaluate(() => window.innerHeight), 'Continue stays inside the window');
    await dialog.getByRole('heading').scrollIntoViewIfNeeded();
    await ui.capture('details');
    const detailsButton = await button.boundingBox();
    assert(detailsButton && Math.abs(detailsButton.y - before.y) < 1, 'Continue stays fixed while reading the description');
    await inputs.first().focus();
  },
};
