import assert from 'node:assert/strict';

// PR #10019: real FileBodyView/PlaintextEditor in Chromium. Unit tests cover
// hunk parsing but cannot prove generated Tailwind backgrounds or virtualization.
// Minimum failures: a dirty/saving chip, and +++counter;/---- below an offscreen
// hunk header. Tier: opt-in UI integration, no filesystem or network activity.
export default {
  name: 'diff-file-edit-status',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 500 },
  real: 'FileBodyView status, PlaintextEditor diff lines, and MarkdownRenderer diff/patch fences',
  notCovered: 'Real filesystem saves, remote devices, and full application lifecycle',
  cases: {
    default: { about: 'Unsaved status keeps its themed background over source text' },
    saving: { about: 'Saving status keeps its themed background during a slow save' },
    'patch-fence': { about: 'Patch fence hunk changes retain full-row and foreground colors' },
    'diff-fence': { about: 'Diff fence shares hunk classification and keeps file headers neutral' },
    'diff-scroll': {
      about: 'Header-like changes remain highlighted after the hunk header scrolls away',
    },
  },
  async check(page, ui) {
    if (ui.case === 'patch-fence' || ui.case === 'diff-fence') {
      const rows = page.locator('.diff-hscroll pre > div');
      await rows.first().waitFor();
      const observed = await rows.evaluateAll(elements => elements.map((row, i) => {
        const type = i === 3 || i === 4 ? 'del' : i === 5 ? 'add' : null;
        const content = row.children[2];
        const symbol = row.children[1];
        const probe = document.createElement('span');
        if (type) {
          probe.style.backgroundColor = 'var(--diff-' + type + '-bg)';
          probe.style.color = 'var(--diff-' + type + '-fg)';
        }
        row.append(probe);
        const result = {
          text: content.textContent,
          symbol: symbol.textContent,
          background: getComputedStyle(row).backgroundColor,
          foreground: getComputedStyle(content).color,
          symbolColor: getComputedStyle(symbol).color,
          expectedBackground: getComputedStyle(probe).backgroundColor,
          expectedForeground: getComputedStyle(probe).color,
          type,
        };
        probe.remove();
        return result;
      }));
      assert.deepEqual(observed.map(row => row.text), [
        '--- a/file', '+++ b/file', '@@ -1,2 +1 @@',
        '--counter;', '---', '++counter;', '--- a/next', '+++ b/next',
      ]);
      for (const row of observed) {
        assert.equal(row.background, row.expectedBackground, 'Hunk rows need themed full-row backgrounds; headers remain neutral');
        if (row.type) {
          assert.equal(row.foreground, row.expectedForeground);
          assert.equal(row.symbolColor, row.expectedForeground);
          assert.equal(row.symbol, row.type === 'add' ? '+' : '-');
        }
      }
      await ui.capture('verified');
      return;
    }
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
