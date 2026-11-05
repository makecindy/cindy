import assert from 'node:assert/strict';
export default {
  name: 'teammate-process', entry: './process-fixture.tsx', viewport: { width: 720, height: 850 },
  stubs: {
    'src/renderer/components/chat/GhostToolCard': 'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth = () => ({ dataOwnerId: "fixture", isAuthenticated: false });' },
  },
  real: 'MessageStream, ThreadPanel with compact styles, BotSessionTaskResultCard, teammate grouping, WorkGroupBlock, GeneratedFilesCard and SheetPreview, Markdown, theme and i18n',
  notCovered: 'Full CCAgentSessionView, login, host execution, document opening, native mobile layout and transport',
  cases: { default: { about: 'Live private turn with stage notes and initial thinking', data: { done: false } }, finished: { about: 'Completed private turn with final answer outside', data: { done: true } }, retry: { about: 'Two failed attempts followed by a running read: current action stays visible', data: { done: false, retry: true } },
    'artifacts-wide': { about: 'Avatar, long reply, Excel preview and related file align in the production stream' },
    'artifacts-narrow': { about: 'A narrow companion column preserves card sizing', viewport: { width: 320, height: 850 } },
    'artifacts-thread': { about: 'The production topic panel and compact styles retain reply/artifact alignment', viewport: { width: 640, height: 950 } },
    'artifacts-no-avatar': { about: 'No avatar means no additional inset' },
    'artifacts-task': { about: 'Ordinary task layout stays unchanged' },
    'artifacts-cached': { about: 'Cached cards keep their height while remount stats are pending; confirmation enables them and deletion removes the entire row' },
    'artifacts-missing': { about: 'Missing files leave no empty avatar row' },
  },
  async check(page, ui) {
    // Layout regression tier: the full MessageStream must align confirmed
    // deliverables with its reply. Card-only jsdom tests cannot measure columns.
    // Minimal failure: one assistant avatar followed by a generated file.
    if (ui.case.startsWith('artifacts-')) {
      const artifacts = page.getByTestId('bot-generated-artifacts');
      if (ui.case === 'artifacts-missing') {
        await page.waitForFunction(() => Number(document.documentElement.dataset.fixtureFileStats) >= 2);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await artifacts.count(), 0);
        const heights = await page.locator('[data-render-item-key="genfiles-ask-artifacts"]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        assert.ok(heights.every(height => height === 0), 'Absent files leave no avatar-sized blank row');
        return;
      }
      const sheet = page.getByRole('button', { name: /本周交付清单/ });
      await sheet.waitFor();
      if (ui.case === 'artifacts-task') {
        assert.equal(await artifacts.count(), 0);
        const origin = await page.locator('.msg-stream-items').evaluate(node => node.getBoundingClientRect().x);
        const box = await sheet.boundingBox();
        assert.ok(Math.abs(box.x - origin) <= 0.5, 'Ordinary task artifacts retain their original column');
        return;
      }
      if (ui.case === 'artifacts-cached') {
        // PR #8601 P2: card-only seed tests miss the parent hiding cached chips.
        // Renderer integration tier: remount the real stream with deferred host
        // stats; assert geometry and disabled state, then resolve each outcome.
        await page.waitForFunction(() => !document.querySelector('button[title="/repo/deliveries.xlsx"]').disabled);
        const before = await artifacts.boundingBox();
        for (const outcome of ['confirm', 'remove']) {
          const stats = await page.evaluate(() => Number(document.documentElement.dataset.fixtureFileStats));
          await page.getByTestId('fixture-remount').click();
          await page.waitForFunction(previous => Number(document.documentElement.dataset.fixtureFileStats) >= previous + 2, stats);
          const pending = await artifacts.boundingBox();
          assert.ok(pending, 'Cached pending artifacts remain visible before stat completes');
          assert.ok(Math.abs(pending.height - before.height) <= 0.5, 'Pending cache retains card height');
          const replyX = await page.locator('[data-bot-reply-bubble]').evaluate(node => node.getBoundingClientRect().x);
          assert.ok(Math.abs(pending.x - replyX) <= 0.5, 'Pending cache shares the reply column');
          console.log(`CACHED_ARTIFACT_LAYOUT ${outcome} ${JSON.stringify({ before, pending, replyX })}`);
          assert.equal(await sheet.isDisabled(), true, 'Cache is not a fresh existence confirmation');
          await ui.capture(`pending-${outcome}`);
          await page.getByTestId(`fixture-${outcome}`).click();
          if (outcome === 'confirm') {
            await page.waitForFunction(() => !document.querySelector('button[title="/repo/deliveries.xlsx"]').disabled);
            assert.equal((await artifacts.boundingBox()).height, before.height);
          } else {
            await artifacts.waitFor({ state: 'detached' });
            const heights = await page.locator('[data-render-item-key="genfiles-ask-artifacts"]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
            assert.ok(heights.every(height => height === 0), 'Deleted cached files leave no avatar row');
          }
        }
        return;
      }
      const related = page.getByRole('button', { name: await ui.t('chat.generatedFiles.relatedFiles', { count: 1 }) });
      const layout = await page.evaluate(() => {
        const reply = document.querySelector('[data-bot-reply-bubble]').getBoundingClientRect();
        const artifacts = document.querySelector('[data-testid="bot-generated-artifacts"]');
        const title = artifacts.firstElementChild.getBoundingClientRect();
        const sheetNode = artifacts.querySelector('button[title="/repo/deliveries.xlsx"]');
        const sheet = sheetNode.getBoundingClientRect();
        const related = artifacts.querySelector('button[aria-expanded]').getBoundingClientRect();
        const summary = document.querySelector('[data-bot-task-card]').getBoundingClientRect();
        return { replyX: reply.x, replyRight: reply.right, titleX: title.x, sheetX: sheet.x, relatedX: related.x, summaryX: summary.x, sheetWidth: sheet.width, maxSheetWidth: parseFloat(getComputedStyle(sheetNode).maxWidth), sheetRight: sheet.right, viewport: innerWidth };
      });
      console.log(`ARTIFACT_LAYOUT ${ui.case} ${JSON.stringify(layout)}`);
      assert.ok([layout.titleX, layout.sheetX, layout.relatedX, layout.summaryX].every(x => Math.abs(x - layout.replyX) <= 0.5), `Deliverables share the reply column: ${JSON.stringify(layout)}`);
      if (ui.case === 'artifacts-wide' || ui.case === 'artifacts-no-avatar')
        assert.equal(layout.sheetWidth, layout.maxSheetWidth, 'Wide cards keep their existing maximum width');
      assert.ok(layout.sheetRight <= layout.viewport, 'Sheet stays within the narrow column');
      // Screenshot bug: a long learning row sized the footer to its text and ran past the column.
      const footer = await page.locator('[data-bot-learning-footer]').evaluate(node => {
        const box = node.getBoundingClientRect();
        const text = node.querySelector('span');
        return { x: box.x, right: box.right, truncated: text.scrollWidth > text.clientWidth };
      });
      assert.ok(Math.abs(footer.x - layout.replyX) <= 0.5 && footer.right <= layout.replyRight + 0.5 && footer.truncated, `Learning footer truncates inside the reply bubble column: ${JSON.stringify({ footer, replyRight: layout.replyRight })}`);
      await related.click();
      const file = page.getByRole('button', { name: 'prepare.py', exact: true });
      await file.waitFor();
      assert.ok(Math.abs((await file.boundingBox()).x - layout.replyX) <= 0.5, 'Expanded related files share the same column');
      await ui.capture('related-expanded');
      return;
    }
    const definition = this.cases[ui.case];
    const journal = page.locator('[data-teammate-process]');
    await journal.waitFor();
    assert.equal(await journal.count(), 1, 'One disclosure owns all intermediate notes');
    // Visible UI regression: process and reply each own a portrait; expansion
    // must not repeat it in tool details. Hidden spacers failed this check.
    const processPortrait = journal.locator('xpath=../..').getByTestId('fixture-partner-avatar');
    assert.equal(await processPortrait.count(), 1);
    assert.equal(await processPortrait.isVisible(), true, 'The process portrait is visible');
    const heading = journal.locator(':scope > button');
    if (definition.data.retry) {
      const action = journal.locator('[data-teammate-segment] > button');
      assert.match(await action.innerText(), /skills\.md/);
      assert.doesNotMatch(await action.innerText(), /失败|failed|失敗|실패/);
      assert.equal(await action.evaluate(el => getComputedStyle(el).color), await heading.evaluate(el => getComputedStyle(el).color), 'Prior failures do not turn the current action red');
      await ui.capture('current-action');
      await action.click();
      await journal.getByText('helper', { exact: false }).first().waitFor();
      assert.ok(await journal.getByText('helper', { exact: false }).count() > 0, 'Original tool attempts remain inspectable');
      await ui.capture('attempts');
      return;
    }
    if (definition.data.done) {
      assert.equal(await heading.getAttribute('aria-expanded'), 'false');
      assert.equal(await journal.getByText('任务与 PR 的进展已整理。未处理完的事项和需要你判断的部分，已分别列出。').count(), 0);
      await ui.capture('collapsed');
      await heading.click();
    }
    assert.equal(await heading.getAttribute('aria-expanded'), 'true');
    await journal.getByText('我先核对任务的最近进展，再看未完成 PR 的阻塞点。').waitFor();
    await ui.capture('expanded');
    const geometry = await journal.evaluate(root => {
      const rail = root.querySelector('[data-process-guide]').getBoundingClientRect();
      const body = root.querySelector('[data-process-guide] + div').getBoundingClientRect();
      const title = root.querySelector(':scope > button > span:nth-child(2)').getBoundingClientRect();
      return { end: Math.abs(rail.bottom - body.bottom), start: Math.abs(rail.top - body.top), indent: Math.abs(title.x - body.x) };
    });
    assert.ok(geometry.end <= 0.5 && geometry.start <= 0.5, `Guide follows content bounds: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.indent <= 0.5, 'Title and progress share a text origin');
    assert.equal(await journal.getByText('Inspecting task records', { exact: true }).count(), 0, 'Raw reasoning is represented by a phase label');
    const segments = journal.locator('[data-teammate-segment]');
    assert.ok(await segments.count() >= 3, 'Initial thought and both tool segments stay between notes');
    const records = segments.locator('button').first();
    await records.click();
    await journal.getByText('tasks.md', { exact: false }).first().waitFor();
    if (!definition.data.done) {
      await page.getByTestId('fixture-finish').click();
      assert.equal(await heading.getAttribute('aria-expanded'), 'true', 'Keep inspected work open on completion');
    }
    await ui.capture('records');
    assert.equal(await page.getByTestId('fixture-partner-avatar').count(), 2, 'Expanded process and final reply each have one portrait');
    assert.equal(await processPortrait.isVisible(), true);
    await heading.click();
    assert.equal(await heading.getAttribute('aria-expanded'), 'false');
  },
};
