import assert from 'node:assert/strict';

const TARGET_LINE = 42;

export default {
  name: 'sidebar-file-line-anchor',
  entry: './fixture.tsx',
  viewport: { width: 460, height: 520 },
  real: 'FileBodyView with a 400-line file, opened with an explicit jump line',
  notCovered:
    'Chat link routing, rsb-window command transport and tab reveal state; covered by MarkdownRenderer, executeSidebarCommand and openInSidebarFileBrowser unit tests',
  cases: {
    default: { about: 'The preview opens scrolled to line 42 instead of the file top' },
    narrow: {
      about: 'The same anchor holds in a 320 px sidebar rail',
      viewport: { width: 320, height: 520 },
    },
  },
  async check(page, ui) {
    await page.locator('.cm-line').first().waitFor();

    // 一次性行锚点必须回报已消费，否则宿主会反复重新锚定。
    await page.locator('[data-consumed="yes"]').waitFor();

    const anchor = await page.evaluate((target) => {
      const scroller = document.querySelector('.cm-scroller');
      if (!(scroller instanceof HTMLElement)) return { error: 'no editor scroller' };
      const lines = [...document.querySelectorAll('.cm-line')];
      const line = lines.find((element) => element.textContent?.includes(`// line ${target}`));
      if (!line) return { error: `line ${target} is not rendered` };
      const scroll = scroller.getBoundingClientRect();
      const box = line.getBoundingClientRect();
      return {
        scrollTop: scroller.scrollTop,
        visible: box.top >= scroll.top - 1 && box.bottom <= scroll.bottom + 1,
        editable: Boolean(document.querySelector('.cm-content[contenteditable]')),
        firstVisibleLine: lines[0]?.textContent?.slice(0, 24) ?? null,
      };
    }, TARGET_LINE);

    assert.equal(anchor.error, undefined, String(anchor.error));
    assert.ok(anchor.scrollTop > 0, 'The preview must not stay at the top of the file');
    assert.equal(anchor.visible, true, `Line ${TARGET_LINE} must be inside the viewport`);
    assert.equal(anchor.editable, true, 'The anchored preview stays an editor, not a read-only pane');

    await ui.capture('verified');
  },
};
