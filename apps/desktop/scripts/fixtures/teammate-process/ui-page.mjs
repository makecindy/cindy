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
    disclosure: { about: 'Frame-by-frame disclosure stability in a long companion conversation', data: { done: true, disclosure: true } },
    'disclosure-live': { about: 'Inspection survives completion, late updates and explicit follow', data: { disclosure: true } },
    'disclosure-reduced': { about: 'Reduced motion preserves the same reading position', data: { done: true, disclosure: true, reduced: true } },
    'live-refresh': { about: 'Loading work details does not add a row while the teammate is working', data: { refresh: true } },
    'history-refresh': { about: 'History detail loading uses the existing heading; failures can still be retried', data: { refresh: true, done: true } },
    'artifacts-wide': { about: 'Avatar, long reply, Excel preview and related file align in the production stream' },
    'artifacts-narrow': { about: 'A narrow companion column preserves card sizing', viewport: { width: 320, height: 850 } },
    'artifacts-thread': { about: 'The production topic panel and compact styles retain reply/artifact alignment', viewport: { width: 640, height: 950 } },
    'artifacts-no-avatar': { about: 'No avatar means no additional inset' },
    'artifacts-task': { about: 'Ordinary task layout stays unchanged' },
    'artifacts-cached': { about: 'Cached cards keep their height while remount stats are pending; confirmation enables them and deletion removes the entire row' },
    'artifacts-missing': { about: 'Missing files leave no empty avatar row' },
  },
  async check(page, ui) {
    if (ui.data.disclosure) {
      // Browser integration: a long history plus an expanded tail reproduces
      // scroll-range clamping. Sample animation frames; endpoint screenshots
      // alone missed the one-frame jumps in the user's recording.
      if (!ui.data.reduced) await page.emulateMedia({ reducedMotion: 'no-preference' });
      const heading = page.locator('[data-teammate-process] > button').last();
      const scroll = page.locator('[data-scroll-container]');
      await heading.waitFor();
      // Start with an expanded process at the actual scroll boundary, as in the recording.
      if (await heading.getAttribute('aria-expanded') === 'false') await heading.click();
      await page.evaluate(() => new Promise(resolve => {
        const start = performance.now();
        const tick = () => performance.now() - start > 400 ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
      }));
      await scroll.evaluate(root => { root.scrollTop = root.scrollHeight; });
      await page.waitForFunction(() => { const root = document.querySelector('[data-scroll-container]'); return Math.abs(root.scrollHeight - root.scrollTop - root.clientHeight) <= 1; });
      const sampleToggle = async (target, label, rapid = false, keyboard = false) => {
        await target.evaluate((button, rapid) => {
          window.disclosureFrames = new Promise(resolve => button.addEventListener('click', () => {
            const root = button.closest('[data-scroll-container]');
            const frames = [];
            const start = performance.now();
            const record = () => frames.push({ ms: Math.round(performance.now() - start), y: button.getBoundingClientRect().y, top: root.scrollTop, height: root.scrollHeight });
            record();
            let reversed = false;
            const tick = () => {
              record();
              if (rapid && !reversed && performance.now() - start >= 80) { reversed = true; button.click(); }
              if (performance.now() - start < 650) requestAnimationFrame(tick);
              else resolve(frames);
            };
            requestAnimationFrame(tick);
          }, { once: true }));
        }, rapid);
        if (keyboard) { await target.focus(); await target.press('Enter'); }
        else await target.click();
        const samples = await page.evaluate(() => window.disclosureFrames);
        const positions = samples.map(frame => frame.y);
        const displacement = Math.max(...positions) - Math.min(...positions);
        console.log(`DISCLOSURE_GEOMETRY ${label} ${JSON.stringify({ frames: samples.length, displacement })}`);
        assert.ok(displacement <= 1, `${label}: clicked header moved: ${JSON.stringify(samples)}`);
      };
      for (let cycle = 0; cycle < 4; cycle++) {
        await sampleToggle(heading, `toggle-${cycle}`, false, cycle >= 2);
      }
      const nested = page.locator('[data-teammate-segment] > button').first();
      await sampleToggle(nested, 'tool-expand');
      await sampleToggle(nested, 'tool-collapse');
      await sampleToggle(heading, 'rapid-reversal', true);
      await ui.capture('expanded-after-reversal');
      const beforeUpdate = (await heading.boundingBox()).y;
      await page.getByTestId('fixture-finish').click();
      assert.equal(await heading.getAttribute('aria-expanded'), 'true', 'Completion preserves inspected work');
      await page.getByTestId('fixture-update').click();
      await page.getByText('补充记录 1。', { exact: false }).waitFor();
      assert.ok(Math.abs((await heading.boundingBox()).y - beforeUpdate) <= 1, 'A late answer does not pull inspected work to the bottom');
      await sampleToggle(heading, 'final-collapse');
      await ui.capture('collapsed-in-place');
      const floor = await scroll.evaluate(root => parseFloat(root.firstElementChild.style.minHeight));
      await scroll.hover({ position: { x: 30, y: 100 } });
      await page.mouse.wheel(0, -400);
      await page.waitForFunction(previous => parseFloat(document.querySelector('[data-scroll-container]').firstElementChild.style.minHeight) < previous - 100, floor);
      await page.mouse.wheel(0, 10000);
      await page.waitForFunction(() => { const root = document.querySelector('[data-scroll-container]'); return Math.abs(root.scrollHeight - root.scrollTop - root.clientHeight) <= 1; });
      await page.mouse.wheel(0, 120);
      await page.waitForFunction(() => document.querySelector('[data-scroll-container]').firstElementChild.style.minHeight === '');
      await sampleToggle(heading, 'reopen-after-scroll');
      await sampleToggle(heading, 'recollapse-before-send');
      await page.getByTestId('fixture-send').click();
      await page.waitForFunction(() => {
        const root = document.querySelector('[data-scroll-container]');
        return root.firstElementChild.style.minHeight === '' && Math.abs(root.scrollHeight - root.scrollTop - root.clientHeight) <= 1;
      });
      if (!ui.data.done) {
        assert.equal(await page.getByText(await ui.t('chat.newMessageIndicator.label', { count: 0 }), { exact: true }).count(), 0, 'The departing unread indicator keeps its last count instead of flashing zero');
      }
      await ui.capture('follow-restored');
      // #9249 r4501358984: End at the reserved tail has no native movement to
      // restore following. Use real heading focus/keys and subsequent DOM growth.
      for (const key of ['End', 'Control+End']) {
        if (await heading.getAttribute('aria-expanded') === 'false') await sampleToggle(heading, `${key}-expand`);
        await scroll.evaluate(root => { root.scrollTop = root.scrollHeight; });
        await page.waitForFunction(() => {
          const root = document.querySelector('[data-scroll-container]');
          return Math.abs(root.scrollHeight - root.scrollTop - root.clientHeight) <= 1;
        });
        await sampleToggle(heading, `${key}-collapse-at-tail`);
        assert.ok(await scroll.evaluate(root => !!root.firstElementChild.style.minHeight), 'Collapse reserves the old tail');
        assert.ok(await scroll.evaluate(root => Math.abs(root.scrollHeight - root.scrollTop - root.clientHeight) <= 1), 'End starts at a tail with no remaining native scroll distance');
        await heading.focus();
        await heading.press(key);
        await page.waitForFunction(() => document.querySelector('[data-scroll-container]').firstElementChild.style.minHeight === '');
        await scroll.evaluate(root => {
          const answer = root.querySelector('[data-message-client-id="final_answer"]');
          answer.style.minHeight = `${answer.getBoundingClientRect().height + root.clientHeight * 2}px`;
        });
        await page.waitForFunction(() => {
          const root = document.querySelector('[data-scroll-container]');
          return Math.abs(root.scrollHeight - root.scrollTop - root.clientHeight) <= 1;
        });
        await ui.capture(`${key.replace('+', '-')}-restores-process-follow`);
        await scroll.evaluate(root => { root.querySelector('[data-message-client-id="final_answer"]').style.minHeight = ''; });
      }
      return;
    }
    // Browser integration: the existing static stream cases never changed deferred.loading.
    // A single visible note plus a detail refresh previously added a spinner row and shifted content.
    if (ui.data.refresh) {
      const journal = page.locator('[data-teammate-process]');
      const heading = journal.locator(':scope > button');
      if (await heading.getAttribute('aria-expanded') === 'false') await heading.click();
      await journal.getByText('正在核对任务进展。').waitFor();
      await page.evaluate(() => document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).forEach(a => a.finish()));
      const height = (await journal.boundingBox()).height;
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.getByTestId('refresh-start').click();
        await ui.capture(`refresh-${cycle}`);
        assert.equal((await journal.boundingBox()).height, height, 'Background loading must not change the process height');
        assert.equal(await heading.locator('.animate-spinner').count(), 1, 'Existing heading carries the loading state');
        assert.equal(await journal.getByText(await ui.t('chat.teammateProcess.thinking'), { exact: true }).count(), 0, 'No redundant thinking row after prose');
        await page.getByTestId('refresh-end').click();
        assert.equal((await journal.boundingBox()).height, height);
        assert.equal(await heading.locator('.animate-spinner').count(), ui.data.done ? 0 : 1);
      }
      await page.getByTestId('refresh-fail').click();
      await journal.getByRole('button', { name: await ui.t('chat.errorBanner.retry'), exact: true }).click();
      assert.equal(await heading.locator('.animate-spinner').count(), 1, 'Retry still starts a detail load');
      assert.equal((await journal.boundingBox()).height, height);
      return;
    }
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
    // #8864 regression: process -> reply must retain a single visible portrait
    // throughout completion and expansion, rather than splitting the turn visually.
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
    assert.equal(await page.getByTestId('fixture-partner-avatar').count(), 1, 'Process and final reply share one portrait');
    assert.equal(await processPortrait.isVisible(), true);
    await heading.click();
    assert.equal(await heading.getAttribute('aria-expanded'), 'false');
  },
};
