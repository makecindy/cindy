import assert from 'node:assert/strict';

// Batfree feedback / UI-e2e: real messages and table DOM must retain Chinese,
// spaces, paragraph breaks, an empty cell and wrapped cell text through native
// selection and actual clipboard paste. jsdom cannot test these browser ranges.
const longCell = '说明开始：这段中文包含 空格，并在单元格中自动换行，复制后仍须完整保留。说明结束';
const content = `表格前正文：完整起点。\n\n表格前第二段包含 中文 空格。\n\n| 名称 | 内容 | 说明 |\n| --- | --- | --- |\n| 项目甲 Alpha | 中文 空格 42 | ${longCell} |\n| 项目乙 Beta | | 末行 Final |\n\n表格后正文：完整终点。\n\n表格后第二段保留换行。`;
const tableText = `名称\t内容\t说明\n项目甲 Alpha\t中文 空格 42\t${longCell}\n项目乙 Beta\t\t末行 Final`;

export default {
  name: 'table-text-selection',
  entry: './fixture.tsx',
  viewport: { width: 900, height: 800 },
  real: 'AssistantMessage, MarkdownRenderer, native mouse selection, table TSV range copy, chat clipboard handlers, MessageActionBar and SelectionQuoteButton',
  notCovered: 'Full application and virtualized/offscreen history. Existing table image-copy toolbar cannot rasterize under the isolated host CSP (base-uri/connect-src); it requires full-client acceptance. Clipboard permissions are scoped to this isolated test origin; no clipboard values are mocked.',
  stubs: {
    'src/renderer/components/chat/GhostToolCard': 'export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle"; export const GhostToolCard = () => null; export const MailCardEditor = () => null;',
  },
  cases: {
    default: { about: 'One complete message: Chinese, spaces, paragraph breaks and a two-row three-column table', data: { content } },
    'multiple-messages': { about: 'Drag from the previous message through the table into the following message', data: { content } },
  },
  async check(page, ui) {
    // Explicit permission for this test origin exercises real OS/browser writes,
    // unlike replacing navigator.clipboard with a value-capturing mock.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const paste = page.getByRole('textbox', { name: 'Paste target' });
    const point = async (text, end) => page.getByText(text, { exact: true }).evaluate((node, end) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), leaves = [];
      while (walker.nextNode()) leaves.push(walker.currentNode);
      const range = document.createRange(); range.selectNodeContents(end ? leaves.at(-1) : leaves[0]);
      const rects = [...range.getClientRects()], rect = end ? rects.at(-1) : rects[0];
      return { x: end ? rect.right - 0.1 : rect.left + 0.1, y: rect.top + rect.height / 2 };
    }, end);
    const select = async (from, to) => {
      const start = await point(from, false), end = await point(to, true);
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 20 }); await page.mouse.up();
      return page.evaluate(() => getSelection().toString());
    };
    const pasteClipboard = async () => {
      await paste.fill(''); await paste.focus(); await page.keyboard.press(`${modifier}+v`);
      return paste.inputValue();
    };
    const copyAndPaste = async () => { await page.keyboard.press(`${modifier}+c`); return pasteClipboard(); };
    const from = ui.case === 'multiple-messages' ? '上一条消息正文：跨消息起点。' : '表格前正文：完整起点。';
    const to = ui.case === 'multiple-messages' ? '下一条消息正文：跨消息终点。' : '表格后第二段保留换行。';
    const selected = await select(from, to);
    for (const text of [from, '表格前第二段包含 中文 空格。', '名称', '项目甲 Alpha', '中文 空格 42', longCell, '项目乙 Beta', '末行 Final', '表格后正文：完整终点。', to]) {
      assert.ok(selected.includes(text), `Selection must include ${text}`);
    }
    assert.ok(selected.includes('\n'), 'Selection must retain paragraph/row breaks');
    await ui.capture('cross-table-selection');
    const pasted = await copyAndPaste();
    assert.equal(pasted, selected, 'Actual clipboard paste must match the complete selected range');
    // The fixture itself says “复制后仍须完整保留”; detect control-only labels.
    for (const label of ['从这里开启新任务', '分享这条消息']) {
      assert.ok(!pasted.includes(label), `Message control must not leak: ${label}`);
    }

    // Whole table by its existing native range, including the empty cell.
    const cells = await select('名称', '末行 Final');
    assert.equal(await copyAndPaste(), cells);
    assert.equal(cells, tableText, 'Whole-table range TSV must preserve all rows/columns, spaces and empty cell');
    const tableMessage = page.locator('[data-copy-message="table"]');

    const word = await point('项目甲 Alpha', false);
    await page.mouse.dblclick(word.x + 56, word.y);
    const local = await page.evaluate(() => getSelection().toString());
    assert.ok(local && '项目甲 Alpha'.includes(local) && local.length < '项目甲 Alpha'.length);
    assert.equal(await copyAndPaste(), local, 'Cell-local selection must remain partial');

    await select(from, to);
    await page.getByRole('button', { name: await ui.t('chat.quote.addToChat'), exact: true }).click();
    const draft = await page.locator('[data-quote-draft]').textContent();
    for (const text of [from, '项目甲 Alpha', '末行 Final', to]) assert.ok(draft.includes(text));

    await tableMessage.hover();
    await tableMessage.getByRole('button', { name: await ui.t('chat.messageActionBar.copy'), exact: true }).click();
    assert.equal(await pasteClipboard(), content, 'Complete-message copy must actually paste the complete Markdown');
    await ui.capture('copy-complete');
  },
};
