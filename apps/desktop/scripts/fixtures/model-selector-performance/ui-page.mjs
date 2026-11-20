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
    'groups-unused': { about: 'No configured modes: no model-groups rail entry', data: { count: 20, groups: false } },
    'groups-configured': { about: 'Configured mode: model-groups rail remains usable', data: { count: 20, groups: true } },
    default: { about: '20 models; open All, then filter OpenAI with the hidden width probe', data: { count: 20 } },
    large: { about: '200 models across two engines', data: { count: 200 } },
    stress: { about: '600 models across two engines', data: { count: 600 } },
    scale: { about: '2,000 models across two engines', data: { count: 2000 } },
    keyboard: { about: 'A selected model deep in a long list, keyboard traversal and Chinese search', data: { count: 200, keyboard: true } },
    threshold: { about: 'Favoriting from an open configuration keeps the anchor when crossing the virtualization threshold', data: { count: 79 } },
    'offline-favorites': { about: 'Tab reaches a selectable model below a viewport of unavailable remote favorites', data: { count: 200, offlineFavorites: true } },
    'offline-favorites-readable': { about: 'The readable field picker retains keyboard access below unavailable remote favorites', data: { count: 200, offlineFavorites: true, readable: true } },
  },
  async check(page, ui) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => document.fonts.ready);
    const trigger = page.locator('[data-perf-trigger] button').first();
    // Browser regression for #11684: native Tab cannot enter the virtual list
    // when the first viewport contains only disabled options and the next selectable row is offscreen.
    if (ui.data.offlineFavorites) {
      const list = page.getByRole('listbox');
      await trigger.click();
      const search = page.getByPlaceholder(await ui.t('newChat.modelSelector.search.placeholderAll'));
      await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label,
        await search.getAttribute('aria-label'));
      await list.locator('[data-unified-anchor^="fav::"][aria-disabled="true"]').first().waitFor();
      const before = await list.evaluate(el => {
        const viewport = el.getBoundingClientRect();
        const rows = [...el.querySelectorAll('[data-unified-anchor]')];
        const visible = rows.filter(row => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
        return { visibleCount: visible.length, allUnavailable: visible.every(row => row.getAttribute('aria-disabled') === 'true') };
      });
      assert.ok(before.visibleCount > 0 && before.allUnavailable,
        `Expected a viewport of unavailable favorites: ${JSON.stringify(before)}`);
      const lastRail = page.locator('button[data-rail-item]').last();
      await lastRail.focus();
      await page.keyboard.press('Tab');
      const activeModel = () => page.evaluate(() => document.activeElement?.getAttribute('data-unified-anchor'));
      const first = await activeModel();
      assert.ok(first?.startsWith('model::'), 'Tab skipped all selectable model rows');
      const entryScroll = await list.evaluate(el => {
        const viewport = el.getBoundingClientRect();
        const focused = document.activeElement.getBoundingClientRect();
        return { offset: el.scrollTop, height: el.clientHeight,
          rowVisible: focused.bottom > viewport.top && focused.top < viewport.bottom };
      });
      assert.equal(entryScroll.rowVisible, true, 'Tab did not scroll the focused model into view');
      await ui.capture('keyboard-after-disabled-favorites');
      await page.keyboard.press('End');
      await page.waitForFunction(previous => {
        const active = document.activeElement?.getAttribute('data-unified-anchor');
        return active?.startsWith('model::') && active !== previous;
      }, first, { timeout: 2_000 });
      assert.ok(await list.evaluate(el => el.scrollTop) > entryScroll.offset + entryScroll.height,
        'End did not scroll beyond the entry viewport');
      await page.keyboard.press('Home');
      await page.waitForFunction(expected => document.activeElement?.getAttribute('data-unified-anchor') === expected, first, { timeout: 2_000 });
      await page.keyboard.press('Shift+Tab');
      assert.equal(await lastRail.evaluate(el => el === document.activeElement), true, 'Shift+Tab could not return to the rail');
      await page.keyboard.press('Tab');
      assert.ok((await activeModel())?.startsWith('model::'), 'Tab could not reenter the list');
      const focusedInList = () => page.evaluate(() => !!document.activeElement?.closest('[role="listbox"]'));
      for (let index = 0; index < 4 && await focusedInList(); index++) {
        await page.keyboard.press('Tab');
      }
      assert.equal(await focusedInList(), false, 'Tab could not leave the list');
      return;
    }
    if (ui.case === 'keyboard' || ui.case === 'threshold') {
      const search = page.getByPlaceholder(await ui.t('newChat.modelSelector.search.placeholderAll'));
      const list = page.getByRole('listbox');
      const row = (id) => list.locator(`[data-unified-anchor="model::openai::openai-model-${id}"]`);
      const assertFocused = async (locator) => assert.equal(
        await locator.evaluate(el => el === document.activeElement), true,
        `Expected focus on ${locator}`,
      );
      await trigger.click();
      await search.evaluate(el => new Promise(resolve => {
        if (document.activeElement === el) resolve();
        else el.addEventListener('focus', resolve, { once: true });
      }));
      const config = page.getByTestId('unified-model-config-flyout');
      if (ui.case === 'threshold') {
        await row(0).focus();
        await page.keyboard.press('ArrowLeft');
        await config.getByRole('button', { name: await ui.t('newChat.modelSelector.unified.addFavorite'), exact: true }).click();
        await list.locator('[data-unified-anchor^="fav::"]').waitFor();
        await page.keyboard.press('Escape');
        await config.waitFor({ state: 'detached' });
        await assertFocused(row(0));
        return;
      }
      await row(78).waitFor();
      const alignment = await row(78).evaluate(el => {
        const list = el.closest('[role="listbox"]').getBoundingClientRect();
        const row = el.getBoundingClientRect();
        return ((row.top + row.bottom) / 2 - list.top) / list.height;
      });
      assert.ok(Math.abs(alignment - 0.35) < 0.06, `Selected row aligned at ${alignment}`);
      const openAI = page.getByRole('button', { name: 'OpenAI', exact: true });
      await openAI.click();
      const focusedInList = () => list.evaluate(el => el.contains(document.activeElement));
      for (let i = 0; i < 10 && !(await focusedInList()); i++) {
        await page.keyboard.press('Tab');
      }
      assert.equal(await focusedInList(), true, 'Tab could not enter the model list');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focusedInList(), false, 'Shift+Tab could not leave the model list');
      await row(78).focus();
      await page.keyboard.press('Home');
      await assertFocused(row(0));
      await page.keyboard.press('End');
      await assertFocused(row(99));
      await page.keyboard.press('ArrowUp');
      await assertFocused(row(98));
      await page.keyboard.press('Home');
      await assertFocused(row(0));
      await page.keyboard.press('ArrowLeft');
      await config.waitFor();
      await ui.capture('keyboard-configuration');
      const flyoutTop = await config.evaluate(el => el.getBoundingClientRect().top);
      await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await row(99).waitFor();
      await page.waitForFunction(top => {
        const flyout = document.querySelector('[data-testid="unified-model-config-flyout"]');
        return flyout && Math.abs(flyout.getBoundingClientRect().top - top) > 20;
      }, flyoutTop, { timeout: 2_000 });
      assert.equal(await config.isVisible(), true, 'Scrolling dismissed the configuration');
      await page.keyboard.press('Escape');
      await config.waitFor({ state: 'detached' });
      await assertFocused(row(0));
      await search.fill('中文目标');
      await row(78).waitFor();
      assert.equal(await list.locator('[data-unified-anchor]').count(), 1);
      await page.keyboard.press('Home');
      assert.equal(await search.evaluate(el => el.selectionStart), 0, 'Home left the search field instead of moving its caret');
      await assertFocused(search);
      await page.keyboard.press('Escape');
      await list.waitFor({ state: 'detached' });
      await assertFocused(trigger);
      return;
    }
    if (ui.case.startsWith('groups-')) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await trigger.click();
      await page.getByRole('listbox').waitFor();
      const rail = page.locator('[data-rail-item="model-groups"]');
      assert.equal(await rail.count(), ui.case === 'groups-configured' ? 1 : 0);
      if (ui.case === 'groups-configured') {
        await rail.click();
        await page.getByText('Daily mode', { exact: true }).waitFor();
      }
      await ui.capture('model-groups-visibility');
      return;
    }
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    const samples = [];
    const rounds = process.env.CINDY_MODEL_PERF_OUTPUT ? Number(process.env.CINDY_MODEL_PERF_ROUNDS || 14) : 1;
    let shape, allShape;
    const readShape = () => page.evaluate(() => {
      const panel = document.querySelector('[data-morph-side]');
      const sizer = document.querySelector('[data-width-sizer]');
      return { width: panel.getBoundingClientRect().width, height: panel.getBoundingClientRect().height,
        nodes: panel.querySelectorAll('*').length,
        mountedRows: panel.querySelectorAll('[role="listbox"] [data-unified-anchor]').length,
        sizingNodes: sizer?.querySelectorAll('*').length ?? 0,
        sizingRows: sizer?.querySelectorAll('[data-unified-triple]').length ?? 0,
        sizingButtons: sizer?.querySelectorAll('button').length ?? 0 };
    });
    try {
      for (let i = 0; i < rounds; i++) {
        const before = await metrics();
        const timing = await trigger.evaluate(async el => {
          const start = performance.now();
          el.click();
          // One boundary after the open geometry and the first selectable row mount.
          const visible = await new Promise((resolve, reject) => {
            let frameMs;
            let openingFrameQueued = false;
            const tick = () => {
              if (performance.now() - start > 5000) { reject(new Error('Model panel did not open')); return; }
              const panel = document.querySelector('[data-morph-side]');
              if (panel?.getAttribute('data-state') === 'open') {
                if (!openingFrameQueued) {
                  openingFrameQueued = true;
                  requestAnimationFrame(() => { frameMs = performance.now() - start; });
                }
                if (panel.querySelector('[role="option"]:not([aria-disabled="true"])')) {
                  requestAnimationFrame(() => resolve({ frameMs, firstRowFrameMs: performance.now() - start }));
                  return;
                }
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          return visible;
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
        samples.push({ ...timing, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
          layoutCount: after.LayoutCount - before.LayoutCount,
          scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
          taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
          filterFrameMs, filterLayoutMs: (filterAfter.LayoutDuration - filterBefore.LayoutDuration) * 1000,
          filterLayoutCount: filterAfter.LayoutCount - filterBefore.LayoutCount,
          filterScriptMs: (filterAfter.ScriptDuration - filterBefore.ScriptDuration) * 1000 });
        if (i < rounds - 1) {
          samples.at(-1).closeFrameMs = await trigger.evaluate(async el => {
            const start = performance.now();
            el.click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return performance.now() - start;
          });
          await page.locator('[data-morph-side]').waitFor({ state: 'detached' });
        }
      }
      if (process.env.CINDY_MODEL_PERF_OUTPUT) {
        appendFileSync(process.env.CINDY_MODEL_PERF_OUTPUT, JSON.stringify({ case: ui.case, theme: ui.theme,
          count: ui.data.count, allShape, shape, cold: samples[0], samples: samples.slice(2) }) + '\n');
      }
      assert.ok(shape.sizingRows <= 1 && shape.sizingNodes < 40,
        `Filtering mounted ${shape.sizingRows} width-probe rows (${shape.sizingNodes} nodes)`);
      assert.equal(shape.sizingButtons, 0, 'Width measurement exposed interactive buttons');
      assert.ok(allShape.mountedRows <= 24 && shape.mountedRows <= 24,
        `Mounted ${allShape.mountedRows} All / ${shape.mountedRows} filtered rows for ${ui.data.count} models`);
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
