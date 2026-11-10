import assert from 'node:assert/strict';

// PR #8799: a persistent copy button must not cover the first line. Existing
// Markdown fixtures do not exercise code-block layout. This UI/e2e fixture uses
// real MarkdownRenderer text rectangles (including highlighted spans), since
// jsdom cannot observe overlap. A single long plain-text line is the minimum
// failing input; short and highlighted blocks protect the adjacent render paths.
const longLine = 'const message = "' + 'readable_code_'.repeat(12) + '";';
const multiline = longLine + '\n  console.log(message);\n\n// 保留缩进和换行';

export default {
  name: 'code-copy-visibility',
  entry: './fixture.tsx',
  viewport: { width: 840, height: 480 },
  real: 'MarkdownRenderer, CodeBlockPre, syntax highlighting, copy button and success feedback',
  notCovered:
    'Full application, OS clipboard readback, mobile native rendering. Clipboard writes are captured at navigator.clipboard.',
  cases: {
    default: {
      about: 'A short code block retains its visible copy action',
      data: { code: 'echo hello' },
    },
    long: {
      about: 'A wrapped plain-text first line stays clear of the copy button',
      data: { code: multiline },
    },
    highlighted: {
      about: 'Highlighted long code remains readable and copies complete text',
      data: { language: 'javascript', code: multiline },
    },
  },
  async check(page, ui) {
    const copy = page.getByRole('button', {
      name: await ui.t('chat.markdownRenderer.copyCode'),
      exact: true,
    });
    await page.mouse.move(0, 0);
    assert.equal(await copy.count(), 1);
    assert.equal(
      await copy.evaluate((button) => getComputedStyle(button).opacity),
      '1',
      'Copy must be visible without hover',
    );

    const overlap = await copy.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const code = button.parentElement.querySelector('pre code');
      if (!code) throw new Error('Missing rendered code');
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let count = 0;
      let node;
      while ((node = walker.nextNode())) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left < bounds.right &&
            rect.right > bounds.left &&
            rect.top < bounds.bottom &&
            rect.bottom > bounds.top
          )
            count++;
        }
      }
      return count;
    });
    assert.equal(overlap, 0, 'Copy button must not overlap rendered code text');

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            document.documentElement.dataset.copiedCode = text;
          },
        },
      });
    });
    if (ui.case === 'default') {
      await copy.focus();
      await page.keyboard.press('Enter');
    } else {
      await copy.click();
    }
    await page
      .getByRole('button', { name: await ui.t('chat.markdownRenderer.codeCopied'), exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.copiedCode),
      ui.data.code + '\n',
    );
    await page.mouse.move(0, 0);
  },
};
