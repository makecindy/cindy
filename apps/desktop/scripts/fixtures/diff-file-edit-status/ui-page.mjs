import assert from 'node:assert/strict';

// PR #10019: real FileBodyView/PlaintextEditor in Chromium. Unit tests cover
// hunk parsing but cannot prove generated Tailwind backgrounds or virtualization.
// Minimum failures: a dirty/saving chip, and +++counter;/---- below an offscreen
// hunk header. Tier: opt-in UI integration, no filesystem or network activity.
export default {
  name: 'diff-file-edit-status',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 500 },
  real: 'FileBodyView editing status and PlaintextEditor diff-file line backgrounds',
  notCovered: 'Real filesystem saves, remote devices, and full application lifecycle',
  cases: {
    default: { about: 'Unsaved status keeps its themed background over source text' },
    saving: { about: 'Saving status keeps its themed background during a slow save' },
    'diff-scroll': {
      about: 'Header-like changes remain highlighted after the hunk header scrolls away',
    },
  },
  async check(page, ui) {
    const content = page.locator('.cm-content');
    await content.waitFor();
    if (ui.case === 'diff-scroll') {
      await content.click();
      await page.keyboard.press(ui.platform === 'darwin' ? 'Meta+End' : 'Control+End');
      await page.locator('.cm-line').filter({ hasText: '+++counter;' }).waitFor();
      const rows = await page
        .locator('.cm-diff-add-line, .cm-diff-del-line')
        .evaluateAll((elements) =>
          elements.map((el) => ({
            text: el.textContent,
            background: getComputedStyle(el).backgroundColor,
          })),
        );
      assert.deepEqual(
        rows.map((row) => row.text),
        ['----', '+++counter;'],
      );
      assert.ok(
        rows.every((row) => row.background !== 'rgba(0, 0, 0, 0)'),
        'Both changed rows need full-row backgrounds',
      );
      assert.equal(
        await page.locator('.cm-line').filter({ hasText: '@@ -1,201' }).count(),
        0,
        'Hunk header must be outside the rendered viewport',
      );
    } else {
      await content.click();
      await page.keyboard.type('++');
      const status = page.getByRole('status');
      await status.waitFor();
      if (ui.case === 'saving') {
        await page.getByTestId('save').click();
        await status
          .filter({ hasText: await ui.t('ccAgent.workdirBrowse.fileBody.chip.saving') })
          .waitFor();
      }
      const percent = ui.case === 'saving' ? 85 : 95;
      const colors = await status.evaluate((el, percent) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor =
          'color-mix(in srgb, var(--cmd-palette-bg) ' + percent + '%, transparent)';
        el.append(probe);
        const actual = getComputedStyle(el).backgroundColor;
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { actual, expected };
      }, percent);
      assert.equal(
        colors.actual,
        colors.expected,
        'Compiled Tailwind background must match the intended themed opacity',
      );
    }
    await ui.capture('verified');
  },
};
