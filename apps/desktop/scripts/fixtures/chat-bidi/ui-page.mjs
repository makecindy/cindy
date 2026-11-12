import assert from 'node:assert/strict';
import composer from '../companion-composer/ui-page.mjs';

// #10114: real Chromium layout, not a CSS/dir attribute assertion. Existing
// jsdom/Markdown tests cannot observe bidi line alignment. This UI integration
// regression fails on a single Persian-first line in the old production UI.
async function aligned(locator, text, side) {
  const measured = await locator.evaluate((element, { text, side }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const start = element.textContent.indexOf(text);
    if (start < 0) throw Error(`Missing text: ${text}`);
    let offset = 0;
    let node;
    const range = document.createRange();
    while ((node = walker.nextNode())) {
      const end = offset + node.textContent.length;
      if (start >= offset && start < end) range.setStart(node, start - offset);
      if (start + text.length > offset && start + text.length <= end) {
        range.setEnd(node, start + text.length - offset);
        // Link previews include zero-size anchors; they are not text glyphs.
        const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (side === 'center') {
          return Math.abs((Math.min(...rects.map(r => r.left)) + Math.max(...rects.map(r => r.right))) / 2
            - (bounds.left + bounds.right) / 2);
        }
        return side === 'right'
          ? Math.abs(Math.max(...rects.map(r => r.right)) - (bounds.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)))
          : Math.abs(Math.min(...rects.map(r => r.left)) - (bounds.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)));
      }
      offset = end;
    }
    throw Error(`Incomplete range: ${text}`);
  }, { text, side });
  assert.ok(measured < 2, `${text}: expected ${side} alignment, gap ${measured}px`);
}

export default {
  name: 'chat-bidi', entry: './fixture.tsx', viewport: { width: 760, height: 1200 },
  real: 'UserMessage, MarkdownRenderer, RichAnswer, streaming and ChatInput/Tiptap text layout',
  notCovered: 'Live model sending, OS clipboard/input methods and remote synchronization. Clipboard events exercise the real editor serializer; OS clipboard is checked in the full mock app. Host/model/voice data use the existing composer fixture stubs.',
  stubs: {
    ...composer.stubs,
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth = () => ({ user: { id: "bidi-fixture" } });' },
  },
  cases: { default: { about: '#10114: independent RTL/LTR paragraphs, code, stream and editable text' } },
  async check(page, ui) {
    const rtl = 'سلام، فایل index.html با API 123 آماده است.';
    const english = 'English paragraph: API 123 and https://example.com/docs.';
    await aligned(page.locator('[data-testid="markdown"] p').filter({ hasText: rtl }), rtl, 'right');
    await aligned(page.locator('[data-testid="markdown"] p').filter({ hasText: english }), english, 'left');
    const user = page.locator('[data-testid="user"] [data-selection-quote-body]');
    await aligned(user, rtl, 'right');
    await aligned(user, english, 'left');
    const rich = page.locator('[data-testid="rich"] .rich-answer-text').filter({ hasText: rtl });
    await aligned(rich, rtl, 'right');
    await aligned(rich, english, 'left');
    // PR #10188: caption leaves were omitted from paragraph-direction handling.
    // A Persian caption must align right without overriding explicit alignment.
    await aligned(page.locator('[data-rich-node="captioned-markdown"] .rich-answer-caption'), 'سلام، توضیح API 123.', 'right');
    await aligned(page.locator('[data-rich-node="centered-markdown"] .rich-answer-caption'), 'مرحبا، وصف API 123.', 'center');
    await aligned(page.locator('[data-rich-node="inherited-markdown"] .rich-answer-caption'), 'Container-aligned caption.', 'right');
    // Defaults must not override explicit Markdown or inherited container alignment.
    await aligned(page.locator('[data-rich-node="centered-markdown"] h1'), 'Centered', 'center');
    await aligned(page.locator('[data-rich-node="centered-markdown"] p'), 'English paragraph', 'center');
    await aligned(page.locator('[data-rich-node="aligned-group"] .rich-answer-heading'), 'Container-aligned heading', 'right');
    await aligned(page.locator('[data-rich-node="aligned-group"] .rich-answer-text'), 'Container-aligned English text.', 'right');
    await aligned(page.locator('[data-rich-node="inherited-markdown"] p'), 'Container-aligned Markdown.', 'right');
    for (const text of ['مرحبا، الإصدار API 123 جاهز.', 'שלום, הקובץ index.html מוכן.']) {
      await aligned(page.locator('[data-testid="markdown"] p').filter({ hasText: text }), text, 'right');
      await aligned(user, text, 'right');
    }
    await aligned(page.locator('[data-testid="markdown"] li').first(), 'سلام، مورد اول API 123.', 'right');
    await aligned(page.locator('[data-testid="markdown"] li').last(), 'English list item 456.', 'left');
    await aligned(page.locator('[data-testid="markdown"] td').first(), 'سلام API 123.', 'right');
    assert.equal(await page.locator('[data-testid="markdown"] pre').evaluate(e => getComputedStyle(e).direction), 'ltr');
    assert.equal(await page.locator('[data-testid="markdown"] pre code').textContent(), 'const greeting = "سلام";\nconsole.log(greeting, 123);\n');
    await ui.capture('messages');
    await page.getByTestId('stream-next').click();
    const streamed = page.locator('[data-testid="stream"] p').filter({ hasText: '... سلام API 123.' });
    await streamed.waitFor();
    // Streaming spans split text nodes, so measure the rendered paragraph's
    // complete range rather than matching one word/span from the animation.
    assert.ok(await streamed.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return Math.abs(range.getBoundingClientRect().right - element.getBoundingClientRect().right) < 2;
    }));
    const editor = page.locator('.ProseMirror');
    await editor.fill(rtl);
    await editor.press('Shift+Enter');
    await editor.press('E');
    await aligned(editor.locator('p').first(), rtl, 'right');
    await aligned(editor.locator('p').last(), 'E', 'left');
    await editor.press('ControlOrMeta+A');
    const copied = await editor.evaluate(element => {
      const data = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
      return data.getData('text/plain');
    });
    assert.equal(copied, `${rtl}\nE`);
    await editor.press('Backspace');
    assert.equal(await editor.textContent(), '');
    await editor.evaluate((element, text) => {
      const data = new DataTransfer(); data.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, copied);
    await aligned(editor.locator('p').first(), rtl, 'right');
    await ui.capture('composer');
  },
};
