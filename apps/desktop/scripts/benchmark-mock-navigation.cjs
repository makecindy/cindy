/** Run against an already running, isolated --mock Desktop (never a signed-in instance).
 * node apps/desktop/scripts/benchmark-mock-navigation.cjs <label> <output-directory> [cdp-port]
 * Use the same script and fixture on both revisions; do not run builds/tests concurrently.
 */
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = createRequire(path.join(process.env.CINDY_BENCH_DESKTOP || path.resolve(__dirname, '..'), 'package.json'))('playwright-core');

async function main() {
  const [label, outputDirectory, port = '9347'] = process.argv.slice(2);
  if (!label || !/^[a-z0-9-]+$/i.test(label) || !outputDirectory) {
    throw new Error('Expected a simple label and an output directory outside the repository');
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = browser.contexts()[0].pages().find(p => p.url().includes('/#/cc-agent'));
    if (!page || !page.url().includes('/#/cc-agent/ui-mock-')) throw new Error('Open the isolated mock task page first');
    await page.reload();
    await page.locator('.tiptap[contenteditable=true]').first().waitFor();
    await page.bringToFront();
    await page.waitForTimeout(2000);
    await page.keyboard.press('Escape');
    const tasks = [
      ['星间花园 · 试玩复盘', 'ui-mock-showcase-feedback-zh'],
      ['下一轮试玩 · 交互计划', 'ui-mock-showcase-plan-zh'],
      ['引导流程 · 代码审查', 'ui-mock-showcase-review-zh'],
      ['试玩邀请 · 中英双语', 'ui-mock-showcase-release-zh'],
    ];
    for (const [name] of tasks) {
      await page.getByText(name, { exact: true }).first().click();
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => {
      window.__kfjs = { long: [], input: [] };
      new PerformanceObserver(list => window.__kfjs.long.push(...list.getEntries().map(e => ({
        at: e.startTime, ms: e.duration,
      })))).observe({ type: 'longtask' });
      new PerformanceObserver(list => window.__kfjs.input.push(...list.getEntries().map(e => ({
        type: e.name, ms: e.duration, delay: e.processingStart - e.startTime,
      })))).observe({ type: 'event', durationThreshold: 16 });
    });
    const switches = [];
    const profiler = process.argv[5] === 'profile' ? await page.context().newCDPSession(page) : null;
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
    for (let round = 0; round < 3; round++) {
      for (const [name, id] of tasks) {
        const start = performance.now();
        await page.getByText(name, { exact: true }).first().click();
        await page.waitForURL(`**/#/cc-agent/${id}`);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        switches.push(performance.now() - start);
        const editor = page.locator('.tiptap[contenteditable=true]').first();
        await editor.click();
        await editor.pressSequentially('mock performance check', { delay: 15 });
        await editor.press('Control+A');
        await editor.press('Backspace');
        await page.waitForTimeout(350);
      }
    }
    const events = await page.evaluate(() => window.__kfjs);
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop');
      fs.writeFileSync(path.join(outputDirectory, `${label}.cpuprofile`), JSON.stringify(profile));
      await profiler.detach();
    }
    await page.screenshot({ path: path.join(outputDirectory, `${label}.png`) });
    const result = { label, switches, ...events };
    fs.writeFileSync(path.join(outputDirectory, `${label}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ label, switches, long: events.long }));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
