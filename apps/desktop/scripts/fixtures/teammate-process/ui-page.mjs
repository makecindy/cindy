import assert from 'node:assert/strict';
export default {
  name: 'teammate-process', entry: './process-fixture.tsx', viewport: { width: 720, height: 850 },
  stubs: { 'src/renderer/components/chat/GhostToolCard': 'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";', 'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";' },
  real: 'MessageStream, teammate grouping, WorkGroupBlock, Markdown, theme and i18n',
  notCovered: 'Host execution, native mobile layout and transport',
  cases: { default: { about: 'Live private turn with stage notes and initial thinking', data: { done: false } }, finished: { about: 'Completed private turn with final answer outside', data: { done: true } }, retry: { about: 'Two failed attempts followed by a running read: current action stays visible', data: { done: false, retry: true } } },
  async check(page, ui) {
    const definition = this.cases[ui.case];
    const journal = page.locator('[data-teammate-process]');
    await journal.waitFor();
    assert.equal(await journal.count(), 1, 'One disclosure owns all intermediate notes');
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
    await heading.click();
    assert.equal(await heading.getAttribute('aria-expanded'), 'false');
  },
};
