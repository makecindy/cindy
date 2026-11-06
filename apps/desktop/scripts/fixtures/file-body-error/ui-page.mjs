import assert from 'node:assert/strict';

// Issue #8954: real FileBodyView geometry in Chromium; jsdom selection tests do
// not exercise wrapping or scrolling. A continuous path in a 180px pane used
// to overflow horizontally. Short height also protects access to both ends.
// Tier: opt-in UI integration, outside the unit suite.
export default {
  name: 'file-body-error',
  entry: './fixture.tsx',
  viewport: { width: 180, height: 160 },
  real: 'FileBodyView error branch, product typography, themes and translations',
  notCovered: 'Filesystem/IPC, full sidebar interaction and OS clipboard; these require full mock-client acceptance',
  cases: {
    default: {
      about: 'Continuous Windows path wraps in a narrow pane and scrolls from start to end',
      data: { message: `Error: ENOENT: no such file or directory, realpath 'C:\\projects\\${'VeryLongDirectoryName'.repeat(12)}\\missing.txt'` },
    },
    posix: {
      about: 'A long POSIX path with Unicode and spaces remains readable',
      data: { message: `Error: ENOENT: no such file or directory, realpath '/projects/测试 project/${'nested-directory/'.repeat(18)}missing.txt'` },
    },
    short: {
      about: 'Short friendly errors stay centered and do not need scrolling',
      viewport: { width: 360, height: 240 },
      data: { message: '[DEVICE_LINK_DEVICE_OFFLINE]' },
    },
  },
  async check(page, ui) {
    const viewport = page.locator('[data-error-viewport]');
    const error = viewport.locator(':scope > div');
    const geometry = await error.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const box = el.getBoundingClientRect();
      const rects = [...range.getClientRects()].filter(r => r.width && r.height);
      return {
        clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
        firstTop: Math.min(...rects.map(r => r.top)) - box.top,
        lastBottom: Math.max(...rects.map(r => r.bottom)) - box.top,
        horizontalOverflow: rects.some(r => r.left < box.left - 1 || r.right > box.right + 1),
      };
    });
    assert.equal(geometry.horizontalOverflow, false, 'Every text fragment must fit horizontally');
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'No hidden horizontal text');
    assert.ok(geometry.firstTop >= 0, 'The beginning must be reachable at scrollTop=0');
    if (ui.case === 'short') {
      assert.equal(geometry.scrollHeight, geometry.clientHeight);
      assert.ok(Math.abs((geometry.firstTop + geometry.lastBottom) / 2 - geometry.clientHeight / 2) <= 2);
    } else {
      assert.ok(geometry.scrollHeight > geometry.clientHeight, 'Fixture must require vertical scrolling');
      await error.hover();
      await page.mouse.wheel(0, 10000);
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-error-viewport] > div');
        return el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
      });
      assert.equal(await error.evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let last;
        while (walker.nextNode()) last = walker.currentNode;
        const range = document.createRange();
        range.setStart(last, last.length - 1);
        range.setEnd(last, last.length);
        const rect = range.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return rect.top >= box.top && rect.bottom <= box.bottom + 1;
      }), true, 'The final character must be visible after scrolling');
      await ui.capture('scrolled-to-end');
      await error.evaluate(el => { el.scrollTop = 0; });
    }
    // Use a real pointer gesture, not Range.addRange(), to catch inherited
    // user-select:none. Triple click selects the whole error paragraph.
    const point = await error.evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y, { clickCount: 3 });
    assert.equal(await page.evaluate(() => getSelection()?.toString().trim()), (await error.textContent()).trim());
    await ui.capture('selected-full-error');
    await page.evaluate(() => getSelection()?.removeAllRanges());
  },
};
