/** Manual isolated --mock benchmark. No real account or message sending.
 * node apps/desktop/scripts/benchmark-task-switch-phases.cjs <label> <output-dir> [cdp-port] [profile]
 * Split switching, focusing, typing, selecting and deleting to identify the long task's cause.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.join(__dirname, '../package.json'))('playwright-core');

async function main() {
  const [label, out, port = '9367', profiling] = process.argv.slice(2);
  if (!label || !/^[a-z0-9-]+$/i.test(label) || !out)
    throw Error('Expected label and output directory');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = browser
      .contexts()[0]
      .pages()
      .find((p) => /#\/cc-agent\/ui-mock-/.test(p.url()));
    if (!page) throw Error('Open the isolated mock task page first');
    await page.reload();
    await page.locator('.tiptap[contenteditable=true]').first().waitFor();
    await page.bringToFront();
    await page.waitForTimeout(2000);
    const tasks = [
      ['星间花园 · 试玩复盘', 'ui-mock-showcase-feedback-zh'],
      ['下一轮试玩 · 交互计划', 'ui-mock-showcase-plan-zh'],
      ['引导流程 · 代码审查', 'ui-mock-showcase-review-zh'],
      ['试玩邀请 · 中英双语', 'ui-mock-showcase-release-zh'],
    ];
    const editor = page.locator('.tiptap[contenteditable=true]').first();
    const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
    const painted = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    for (const [name] of tasks) {
      await page.getByText(name, { exact: true }).first().click();
      await editor.click();
      await editor.press(selectAll);
      await editor.press('Backspace');
      await page.waitForTimeout(400);
    }
    const measuredDocument = await page.evaluate(() => {
      window.__switchLong = [];
      new PerformanceObserver((list) =>
        window.__switchLong.push(
          ...list.getEntries().map((e) => ({ at: e.startTime, ms: e.duration })),
        ),
      ).observe({ type: 'longtask' });
      return performance.timeOrigin;
    });
    const profiler = profiling === 'profile' ? await page.context().newCDPSession(page) : null;
    let profileStarted;
    if (profiler) {
      await profiler.send('Profiler.enable');
      profileStarted = await page.evaluate(() => performance.now());
      await profiler.send('Profiler.start');
    }
    const phases = [];
    async function phase(kind, task, operation) {
      const at = await page.evaluate(() => performance.now());
      const start = performance.now();
      await operation();
      const durationMs = performance.now() - start;
      const end = await page.evaluate(() => performance.now());
      phases.push({ kind, task, at, end, durationMs });
    }
    for (let round = 0; round < 3; round++)
      for (const [name, id] of tasks) {
        await phase('switch', id, async () => {
          await page.getByText(name, { exact: true }).first().click();
          await page.waitForURL(`**/#/cc-agent/${id}`);
          // Router location can update before React commits the destination. Wait
          // for the visible task header as well, otherwise its work is mislabelled
          // as the following focus/type phase.
          await page
            .locator('main')
            .getByText(name, { exact: true })
            .first()
            .waitFor({ state: 'visible' });
          await painted();
        });
        await phase('focus', id, () => editor.click());
        await phase('type', id, () =>
          editor.pressSequentially('mock performance check', { delay: 15 }),
        );
        await phase('select', id, () => editor.press(selectAll));
        await phase('clear', id, () => editor.press('Backspace'));
        await phase('settle', id, () => page.waitForTimeout(350));
      }
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop');
      fs.writeFileSync(path.join(out, `${label}.cpuprofile`), JSON.stringify(profile));
      await profiler.detach();
    }
    const longTasks = await page.evaluate(() => window.__switchLong);
    if (
      !Array.isArray(longTasks) ||
      (await page.evaluate(() => performance.timeOrigin)) !== measuredDocument
    ) {
      throw Error(
        'Renderer reloaded during measurement; discard this run and repeat after reload settles',
      );
    }
    fs.writeFileSync(
      path.join(out, `${label}.json`),
      JSON.stringify({ label, profileStarted, phases, longTasks }, null, 2),
    );
    const summary = {};
    for (const kind of ['switch', 'focus', 'type', 'select', 'clear', 'settle']) {
      const matching = phases.filter((p) => p.kind === kind),
        times = matching.map((p) => p.durationMs).sort((a, b) => a - b);
      summary[kind] = {
        median:
          (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2,
        long: longTasks.filter((t) => matching.some((p) => t.at >= p.at && t.at < p.end)),
      };
    }
    console.log(JSON.stringify({ label, summary }));
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
