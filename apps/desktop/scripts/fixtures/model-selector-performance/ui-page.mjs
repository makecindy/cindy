import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

// Opt-in timings are component benchmarks, not an end-to-end application or GPU test.
// Run with CINDY_MODEL_PERF_OUTPUT=<outside-repo JSONL path>, --engine electron --compare HEAD.
export default {
  name: 'model-selector-performance', entry: './fixture.tsx',
  viewport: { width: 1100, height: 800 },
  real: 'Production ModelSelector, UnifiedModelPanel/Row, MorphPopover, fonts and themes',
  notCovered: 'Real accounts, network discovery, whole-app load, macOS native input and GPU presentation',
  cases: {
    default: { about: '20 models; open All, then filter OpenAI with the hidden width probe', data: { count: 20 } },
    large: { about: '200 models across two engines', data: { count: 200 } },
    stress: { about: '600 models across two engines', data: { count: 600 } },
  },
  async check(page, ui) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => document.fonts.ready);
    const trigger = page.locator('[data-perf-trigger] button').first();
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    const samples = [];
    const rounds = process.env.CINDY_MODEL_PERF_OUTPUT ? 14 : 1;
    let shape, allShape;
    const readShape = () => page.evaluate(() => {
      const panel = document.querySelector('[data-morph-side]');
      const sizer = document.querySelector('[data-width-sizer]');
      return { width: panel.getBoundingClientRect().width, height: panel.getBoundingClientRect().height,
        nodes: panel.querySelectorAll('*').length, sizingNodes: sizer?.querySelectorAll('*').length ?? 0,
        sizingButtons: sizer?.querySelectorAll('button').length ?? 0 };
    });
    try {
      for (let i = 0; i < rounds; i++) {
        const before = await metrics();
        const timing = await trigger.evaluate(async el => {
          const start = performance.now();
          el.click();
          // First rAF with the opening geometry applied, then one frame boundary.
          const visible = await new Promise((resolve, reject) => {
            const tick = () => {
              if (performance.now() - start > 5000) { reject(new Error('Model panel did not open')); return; }
              const panel = document.querySelector('[data-morph-side]');
              if (panel?.getAttribute('data-state') === 'open') requestAnimationFrame(() => resolve(performance.now() - start));
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          return { frameMs: visible };
        });
        await page.waitForTimeout(280); // Real animation/ResizeObserver settling; opt-in browser benchmark.
        const after = await metrics();
        allShape = await readShape();
        const filterBefore = await metrics();
        const filterFrameMs = await page.getByRole('button', { name: 'OpenAI', exact: true }).evaluate(async el => {
          const start = performance.now();
          el.click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return performance.now() - start;
        });
        await page.waitForTimeout(280);
        const filterAfter = await metrics();
        shape = await readShape();
        assert.ok(shape.sizingNodes > 0, 'Filter did not exercise the width probe');
        samples.push({ ...timing, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
          layoutCount: after.LayoutCount - before.LayoutCount,
          scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
          taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
          filterFrameMs, filterLayoutMs: (filterAfter.LayoutDuration - filterBefore.LayoutDuration) * 1000,
          filterLayoutCount: filterAfter.LayoutCount - filterBefore.LayoutCount,
          filterScriptMs: (filterAfter.ScriptDuration - filterBefore.ScriptDuration) * 1000 });
        if (i < rounds - 1) {
          await trigger.click();
          await page.locator('[data-morph-side]').waitFor({ state: 'detached' });
        }
      }
      if (process.env.CINDY_MODEL_PERF_OUTPUT) {
        appendFileSync(process.env.CINDY_MODEL_PERF_OUTPUT, JSON.stringify({ case: ui.case, theme: ui.theme,
          count: ui.data.count, allShape, shape, cold: samples[0], samples: samples.slice(2) }) + '\n');
      }
      await ui.capture('provider-filter');
      const width = shape.width;
      await page.getByRole('button', { name: await ui.t('newChat.modelSelector.unified.railAll'), exact: true }).click();
      await page.waitForTimeout(280);
      const allWidth = await page.locator('[data-morph-side]').evaluate(el => el.getBoundingClientRect().width);
      assert.ok(Math.abs(width - allWidth) <= 1, `Switching rail changed width: ${width} -> ${allWidth}`);
      await ui.capture('all-models');
      await page.keyboard.press('Escape');
      await page.locator('[data-morph-side]').waitFor({ state: 'detached' });
      // #9403: the old rail check compared widths only after the first expansion.
      // Exercise the real ModelSelector from a fresh All view: the first query,
      // an empty result and clearing the query must preserve its initial width.
      // Browser-tier regression: jsdom cannot measure native scrollbar gutters.
      await trigger.click();
      await page.waitForTimeout(280);
      const initialWidth = (await readShape()).width;
      const search = page.getByPlaceholder(await ui.t('newChat.modelSelector.search.placeholderAll'));
      for (const query of ['Model 0', 'no-match-9403', '']) {
        await search.fill(query);
        await page.waitForTimeout(280);
        const searchWidth = (await readShape()).width;
        assert.ok(Math.abs(searchWidth - initialWidth) <= 1,
          `Search ${JSON.stringify(query)} changed width: ${initialWidth} -> ${searchWidth}`);
        if (query === 'Model 0') await ui.capture('first-search');
      }
      assert.ok(Math.abs(shape.width - allShape.width) <= 1,
        `First provider filter changed width: ${allShape.width} -> ${shape.width}`);
      // Empty-state guidance must wrap inside the model-sized panel, not widen it.
      await page.getByRole('button', { name: await ui.t('newChat.modelSelector.unified.railFavorites'), exact: true }).click();
      await page.waitForTimeout(280);
      assert.ok(Math.abs((await readShape()).width - initialWidth) <= 1,
        `Empty favorites changed width: ${initialWidth} -> ${(await readShape()).width}`);
      await ui.capture('empty-favorites');
      await page.keyboard.press('Escape');
      await page.locator('[data-morph-side]').waitFor({ state: 'detached' });
      // A faster reveal must still interpolate the real CSS width transition.
      // This is outside the timed samples; jsdom cannot verify animation geometry.
      // Observe from the click itself: large lists may finish the transition
      // before a separate Playwright command starts looking for it.
      await trigger.evaluate(async el => {
        el.click();
        const start = performance.now();
        await new Promise((resolve, reject) => {
          const tick = () => {
            if (document.querySelector('[data-morph-side]')?.getAnimations()
              .some(animation => animation.transitionProperty === 'width'
                && animation.playState === 'running')) { resolve(); return; }
            if (performance.now() - start > 5000) { reject(new Error('No opening width transition')); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      });
      await page.keyboard.press('Escape');
      await page.locator('[data-morph-side]').waitFor({ state: 'detached' });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await trigger.click();
      await page.locator('[data-morph-side][data-state="open"]').waitFor();
      assert.equal(await page.locator('[data-morph-side]').evaluate(el => el.getAnimations()
        .some(animation => animation.transitionProperty === 'width')), false);
      await page.keyboard.press('Escape');
      await page.locator('[data-morph-side]').waitFor({ state: 'detached' });
    } finally { await session.detach(); }
  },
};
