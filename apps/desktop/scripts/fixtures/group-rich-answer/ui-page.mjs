import assert from 'node:assert/strict';
export default {
  name: 'group-rich-answer', entry: './fixture.tsx', viewport: { width: 800, height: 1000 },
  real: 'Production group message row, MarkdownRenderer, rich chart/SVG/image, controls, state and explicit submit',
  notCovered: 'Host/network execution and native Mobile rendering; PDF preview and account authentication are outside this scenario',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ user: { id: "group-rich-fixture" } }); export const useOptionalAuthDeviceId = () => undefined;',
    'src/renderer/features/cc-agent/workdir-browse/DrawioPreview': 'export const DrawioPreview = () => null;',
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview': 'export const PdfPreview = () => null;',
  },
  cases: { default: { about: 'Rich answer inside a group message' }, narrow: { about: '320px group message', viewport: { width: 320, height: 1000 } }, readonly: { about: 'Archived group keeps controls local and disables submit' } },
  async check(page, ui) {
    const button = page.getByRole('button', { name: '确认活动安排' });
    assert.equal(await page.getByTestId('sent-answer').innerText(), '');
    assert.equal(await page.locator('img[alt="活动插图"]').count(), 1);
    assert.equal(await page.locator('svg[aria-label="路线示意"]').count(), 1);
    if (ui.case === 'readonly') {
      assert.equal(await button.isDisabled(), true); return;
    }
    assert.equal(await button.isDisabled(), false);
    await page.getByLabel('同行人数').fill('3');
    await ui.capture('edited');
    await button.click();
    assert.equal(await page.getByTestId('sent-answer').innerText(), '请为 3 人安排周末活动。');
    await ui.capture('submitted');
  },
};
