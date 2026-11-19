import assert from 'node:assert/strict';

// Browser integration tier: jsdom cannot establish narrow layout or theme rendering.
// Smallest case: one closed A2UI fence, two paragraphs, one bound input and a send.
export default {
  name: 'a2ui-answer', entry: './a2ui-answer-fixture.tsx',
  viewport: { width: 900, height: 850 },
  real: 'Production MarkdownRenderer, official A2UI processor/surface/binding, host controls, themes and fallback Markdown',
  notCovered: 'Authenticated host, queue delivery, actual tutor/model, learning progress or audio playback',
  stubs: { 'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ user: { id: "a2ui-ui-test" } }); export const useOptionalAuthDeviceId = () => null; export const useOptionalAuthUser = () => null;' },
  cases: {
    default: { about: 'Switch paragraph, inspect exact preview and explicitly submit to a test sender' },
    narrow: { about: 'Paragraph navigation and answer form at 320px', viewport: { width: 320, height: 850 } },
    mobile: { about: 'Paragraph navigation and answer form at 390px', viewport: { width: 390, height: 850 } },
    readonly: { about: 'History without a send port cannot submit' },
    invalid: { about: 'An unsupported wire version falls back without hiding adjacent Markdown or cindy-ui' },
    nested: { about: 'A list-nested A2UI example stays code, without an active form' },
  },
  async ready(page) { await page.getByText('普通 Markdown 继续显示。', { exact: true }).waitFor(); },
  async check(page, ui) {
    const submit = page.getByRole('button', { name: '提交主旨', exact: true });
    assert.equal(await page.getByTestId('received').innerText(), '');
    assert.equal(await page.getByText('普通 Markdown 继续显示。', { exact: true }).count(), 1);
    assert.equal(await page.getByText('现有 cindy-ui 继续显示。', { exact: true }).count(), 1);
    if (ui.case === 'nested') {
      await page.locator('pre').filter({ hasText: 'createSurface' }).waitFor();
      assert.equal(await page.locator('.cindy-a2ui').count(), 0);
      assert.equal(await page.getByLabel('中文主旨', { exact: true }).count(), 0);
      assert.equal(await submit.count(), 0);
      return;
    }
    if (ui.case === 'invalid') {
      await page.locator('.cindy-a2ui-fallback').waitFor();
      assert.equal(await page.getByRole('status').textContent(), await ui.t('richAnswer.incomplete'));
      assert.equal(await submit.count(), 0);
      return;
    }
    await submit.waitFor();
    if (ui.case === 'readonly') { assert.equal(await submit.isDisabled(), true); return; }
    await page.getByRole('button', { name: '第 2 段', exact: true }).click();
    await page.getByText('段落二：输入主旨后，先核对按钮上方的发送内容，再点击提交。', { exact: true }).waitFor();
    await page.getByLabel('中文主旨', { exact: true }).fill('这是界面验证输入，不是学习成绩。');
    assert.equal(await page.getByTestId('received').innerText(), '');
    const expected = '请反馈我的主旨\n\n' + JSON.stringify({ answer: '这是界面验证输入，不是学习成绩。' }, null, 2);
    assert.equal(await page.locator('.cindy-a2ui-preview').textContent(), expected);
    await ui.capture('edited');
    await submit.click();
    await page.getByRole('button', { name: await ui.t('richAnswer.sent'), exact: true }).waitFor();
    assert.equal(await page.getByTestId('received').textContent(), expected);
    await ui.capture('submitted');
    // The page harness intentionally clears storage on every page load. Assert
    // the real storage write here; full-window replay belongs to isolated Desktop.
    const saved = await page.evaluate(() => localStorage.getItem('cindy.a2ui.viewState.v1'));
    assert.ok(saved?.includes('这是界面验证输入，不是学习成绩。'));
  },
};
