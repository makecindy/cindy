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
  cases: {
    default: { about: '#10114: independent RTL/LTR paragraphs, code, stream and editable text' },
    sources: { about: '#10188: expanded teammate letters and long IM message bodies retain paragraph direction and selection' },
    lists: { about: '#10188: typed/restored composer lists keep each marker beside its mixed-direction item' },
    orca: { about: '#10188: expanded Lead/Worker messages retain per-paragraph direction and original text' },
    context: { about: '#10188: attached IM replies, thread messages and group background retain paragraph direction' },
  },
  async check(page, ui) {
    const rtl = 'سلام، فایل index.html با API 123 آماده است.';
    const english = 'English paragraph: API 123 and https://example.com/docs.';
    if (ui.case === 'context') {
      // The real UserMessage -> HookTaskCard disclosure renders three distinct
      // context leaves. jsdom covers their text/counts, but cannot detect this
      // layout regression: a Persian-first context line remains left-aligned.
      const toggle = page.getByRole('button', { name: await ui.t('chat.threadContext.attachedContextCount', { count: 3 }), exact: true });
      await toggle.click();
      const replies = page.getByRole('region', { name: await ui.t('chat.threadContext.referencedMessages', { count: 2 }), exact: true });
      const group = page.getByRole('region', { name: await ui.t('chat.threadContext.groupBackgroundCount', { count: 1 }), exact: true });
      const bodies = [replies.locator(':scope > div').nth(0), replies.locator(':scope > div').nth(1), group.locator(':scope > div')];
      const originals = [];
      for (const [index, body] of bodies.entries()) {
        await aligned(body, index === 1 ? `[Alex] ${rtl}` : rtl, 'right');
        for (const [text, side] of [[english, 'left'], ['مرحبا، الإصدار API 123 جاهز.', 'right'],
          ['שלום, הקובץ index.html מוכן.', 'right'], ['中文段落：文件 index.html，版本 123。', 'left']]) {
          await aligned(body, text, side);
        }
        const original = await body.textContent(); originals.push(original);
        assert.equal(await body.evaluate(e => {
          const selection = window.getSelection(), range = document.createRange();
          range.selectNodeContents(e); selection.removeAllRanges(); selection.addRange(range);
          const text = selection.toString(); selection.removeAllRanges(); return text;
        }), original);
      }
      await ui.capture('context');
      await toggle.focus(); await toggle.press('Enter');
      await replies.waitFor({ state: 'hidden' }); await group.waitFor({ state: 'hidden' });
      await toggle.press('Enter');
      for (const [index, body] of bodies.entries()) assert.equal(await body.textContent(), originals[index]);
      return;
    }
    if (ui.case === 'orca') {
      // Orca bodies use a separate plain-text <pre>, not the normal bubble or
      // Markdown renderer. A Persian-first line reproduces the layout bug.
      // Existing messageLinkActions tests cover content, not browser geometry.
      for (const role of ['Lead', 'Worker']) {
        const toggle = page.getByRole('button', { name: await ui.t(`chat.userMessage.orcaFrom${role}`), exact: true });
        await toggle.click();
        const body = toggle.locator('..').locator('pre[data-selection-quote-body]');
        for (const [text, side] of [[rtl, 'right'], [english, 'left'],
          ['مرحبا، الإصدار API 123 جاهز.', 'right'], ['שלום, הקובץ index.html מוכן.', 'right'],
          ['中文段落：文件 index.html，版本 123。', 'left']]) {
          await aligned(body, text, side);
        }
        const original = await body.textContent();
        const selected = await body.evaluate(e => {
          const selection = window.getSelection(), range = document.createRange();
          range.selectNodeContents(e); selection.removeAllRanges(); selection.addRange(range);
          const text = selection.toString(); selection.removeAllRanges(); return text;
        });
        assert.equal(selected, original);
        await toggle.focus(); await toggle.press('Enter');
        await body.waitFor({ state: 'hidden' });
        await toggle.press('Enter');
        assert.equal(await body.textContent(), original);
      }
      await ui.capture('expanded');
      return;
    }
    if (ui.case === 'lists') {
      // Type through ChatInput's real input/key rules, then round-trip its own
      // clipboard serializer. jsdom cannot observe marker direction or clipping.
      const editor = page.locator('.ProseMirror');
      const texts = [rtl, english, 'مرحبا، الإصدار API 123 جاهز.', 'שלום, הקובץ index.html מוכן.'];
      const decimalSpaces = [];
      for (const [prefix, tag, marker, start] of [
        ['99. ', 'ol', '. ', 99], ['2. ', 'ol', '. ', 2], ['2、', 'ol', '、', 2], ['- ', 'ul', '- ', 0],
      ]) {
        await editor.fill('');
        await editor.pressSequentially(prefix);
        for (const [index, text] of texts.entries()) {
          if (index) await editor.press('Shift+Enter');
          await page.keyboard.insertText(text);
        }
        const items = editor.locator(`${tag} > li`);
        assert.equal(await items.count(), texts.length);
        const checkItems = async () => { for (const [index, text] of texts.entries()) {
          const item = items.nth(index), side = index === 1 ? 'left' : 'right';
          await aligned(item.locator('p').first(), text, side);
          const layout = await item.evaluate((e, { ordinal, marker }) => {
            const style = getComputedStyle(e), list = e.parentElement.getBoundingClientRect(), box = e.getBoundingClientRect();
            const markerStyle = getComputedStyle(e, '::marker');
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = `${markerStyle.fontWeight} ${markerStyle.fontSize} ${markerStyle.fontFamily}`;
            return { direction: style.direction, leftSpace: box.left - list.left, rightSpace: list.right - box.right,
              fontSize: parseFloat(style.fontSize),
              markerWidth: canvas.measureText(`${ordinal}${marker}`).width,
              decimalWidth: canvas.measureText(`${ordinal}. `).width };
          }, { ordinal: start + index, marker });
          assert.equal(layout.direction, side === 'right' ? 'rtl' : 'ltr', `marker direction for ${text}`);
          const space = layout[side === 'right' ? 'rightSpace' : 'leftSpace'];
          assert.ok(space >= layout.fontSize,
            `marker must have room on its item's starting side: ${JSON.stringify(layout)}`);
          if (marker === '. ' && start === 2) decimalSpaces[index] = space;
          if (marker === '、') {
            // #10188 CI regression: the old jsdom test inspected which CSS rule
            // contained a formula. Observe actual ChatInput geometry instead.
            // Minimal CJK input "2、" must fit its full-width glyph and ordinal;
            // deleting that extra space must fail even when selectors move.
            assert.ok(space >= layout.markerWidth, `CJK marker must fit: ${JSON.stringify(layout)}`);
            assert.ok(space - decimalSpaces[index] >= layout.markerWidth - layout.decimalWidth,
              `CJK marker needs additional room beyond the same ordinal: ${JSON.stringify(layout)}`);
          }
        } };
        await checkItems();
        await ui.capture(marker === '、' ? 'cjk' : `${tag}-${start}`);
        await editor.press('ControlOrMeta+A');
        const copied = await editor.evaluate(e => {
          const data = new DataTransfer();
          e.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
          return data.getData('text/plain');
        });
        assert.equal(copied, texts.map((text, index) => `${tag === 'ol' ? start + index : ''}${marker}${text}`).join('\n'));
        await editor.press('Backspace');
        await editor.evaluate((e, text) => {
          const data = new DataTransfer(); data.setData('text/plain', text);
          e.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        }, copied);
        assert.equal(await editor.locator(`${tag} > li`).count(), texts.length);
        await checkItems();
        await editor.focus();
        await items.first().locator('p').evaluate(async e => {
          const range = document.createRange(), selection = window.getSelection();
          range.setStart(e.firstChild, 0); range.collapse(true);
          selection.removeAllRanges(); selection.addRange(range);
          // Let the editor observe the browser selection before native typing.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await page.keyboard.insertText('English ');
        assert.ok((await items.first().textContent()).startsWith('English '));
        assert.equal(await items.first().evaluate(e => getComputedStyle(e).direction), 'ltr');
      }
      await ui.capture('restored');
      return;
    }
    if (ui.case === 'sources') {
      // These real UserMessage branches bypass the ordinary bubble. One mixed
      // paragraph pair reproduces the missing direction; long IM text also
      // exercises the collapse measurement mirror and selection after expansion.
      const letter = page.getByTestId('letter');
      const letterToggle = letter.getByRole('button', { expanded: false });
      await letterToggle.click();
      const body = letter.locator('.select-text.whitespace-pre-wrap');
      await aligned(body, rtl, 'right');
      await aligned(body, english, 'left');
      const hook = page.getByTestId('hook');
      const hookBody = hook.locator('[data-selection-quote-body]');
      const expand = hook.getByRole('button', { name: await ui.t('chat.userMessage.expandLongMessage'), exact: true });
      await expand.waitFor();
      const collapsedHeight = (await hookBody.boundingBox()).height;
      await aligned(hookBody, rtl, 'right');
      await aligned(hookBody, english, 'left');
      await aligned(hook.locator('div[aria-hidden="true"]').filter({ hasText: rtl }), rtl, 'right');
      await ui.capture('collapsed');
      await expand.click();
      assert.ok((await hookBody.boundingBox()).height > collapsedHeight);
      for (const text of ['مرحبا، الإصدار API 123 جاهز.', 'שלום, הקובץ index.html מוכן.']) {
        await aligned(body, text, 'right');
        await aligned(hookBody, text, 'right');
      }
      const selected = await hookBody.evaluate(element => {
        const selection = window.getSelection(), range = document.createRange();
        range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range);
        const text = selection.toString(); selection.removeAllRanges();
        return { text, original: element.textContent };
      });
      assert.equal(selected.text, selected.original);
      await ui.capture('expanded');
      await hook.getByRole('button', { name: await ui.t('chat.userMessage.collapseLongMessage'), exact: true }).click();
      assert.equal((await hookBody.boundingBox()).height, collapsedHeight);
      await letter.getByRole('button', { expanded: true }).click();
      await body.waitFor({ state: 'hidden' });
      return;
    }
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
