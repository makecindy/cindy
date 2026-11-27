import assert from 'node:assert/strict';
import companion from '../companion-composer/ui-page.mjs';

// Browser tier: measure the real ChatInput mount, not a reconstructed composer.
// Existing toolbar cases cannot detect a misplaced header or an empty layout gap.
// A truncated button must reveal its full label on hover and retain its accessible keyboard name.
// Checking the native title attribute alone missed the unusable overflow tooltip.
export default {
  name: 'plugin-composer-header',
  entry: '../companion-composer/companion-composer-fixture.tsx',
  viewport: { width: 760, height: 480 },
  real: 'ChatInput, RunningStatusBar, GoalIndicator, PlanModeIndicator, PendingQueuePanel, PluginUiProvider, PluginUiSlot, Button, Select, Popover shell and installed-plugin change subscription',
  notCovered: 'Live plugin process, installation, MCP App iframe and real plugin panel body; the popover uses a labelled sample body. Host IPC and installed metadata use scenario data. Slash/at panels are not rendered; their original sibling anchor is unchanged.',
  stubs: { ...companion.stubs,
    'src/renderer/hooks/useAgentCapabilities': { partial: 'export const useAgentCapabilities = () => ({ capabilities: { planMode: { supported: true } }, loading: false });' },
    'src/renderer/cindy-brain/PluginUiView': 'export const PluginUiView = () => <div data-header-view>验收样本，非产品界面</div>;',
  },
  cases: {
    empty: { about: 'No contribution leaves the input layout unchanged' },
    nonmatching: { about: 'Filtered contributions leave no header or layout gap', data: { pluginHeader: true, headerNoMatch: true } },
    hidden: { about: 'Hidden header and toolbar controls release their rows and flex gaps', data: { pluginHeader: true, pluginHidden: true, headerLong: true, headerInlineHidden: true } },
    default: { about: 'Native controls occupy the full-width lane above the input card', data: { pluginHeader: true } },
    feedback: { about: 'A plugin explicitly shows, updates and clears native progress or hint text without modifying the draft', data: { pluginHeader: true, headerFeedback: true, headerRuntime: true, headerRate: true } },
    dynamic: { about: 'An empty action collection leaves no space; twelve explicit items support selection, reorder and removal', data: { pluginHeader: true, headerDynamic: true } },
    'new-task-unchanged': { about: 'New-task drafts receive no new collection, state subscription or reserved space', data: { pluginHeader: true, headerDynamic: true, headerNewTask: true } },
    'dynamic-narrow': { about: 'A twelve-item collection uses the same compact overflow in a narrow window', viewport: { width: 320, height: 480 }, data: { pluginHeader: true, headerDynamic: true } },
    narrow: { about: 'Header controls remain usable in a narrow window', viewport: { width: 320, height: 480 }, data: { pluginHeader: true } },
    long: { about: 'Bounded content-width controls fill the available space and More opens a horizontal shelf', data: { pluginHeader: true, headerLong: true } },
    stacked: { about: 'Long header coexists with real goal, plan and merged queue components', viewport: { width: 760, height: 620 }, data: { pluginHeader: true, headerLong: true, headerStack: true } },
    'stacked-narrow': { about: 'Goal, plan, merged queue and the header overflow menu at 320px', viewport: { width: 320, height: 620 }, data: { pluginHeader: true, headerLong: true, headerStack: true } },
    'running-elapsed': { about: 'The real running label, plugin controls, and elapsed time stay on one line', data: { pluginHeader: true, headerLong: true, headerRuntime: true } },
    'running-rate-narrow': { about: 'A narrow running row folds plugin controls before covering token rate', viewport: { width: 320, height: 480 }, data: { pluginHeader: true, headerLong: true, headerRuntime: true, headerRate: true } },
    'running-with-center': { about: 'A centered plan and metrics do not overlap the plugin controls', viewport: { width: 480, height: 480 }, data: { pluginHeader: true, headerLong: true, headerRuntime: true, headerRate: true, headerCenter: true } },
    icons: { about: 'Icon and text buttons keep their shapes, height and center line inside and outside More', viewport: { width: 480, height: 480 }, data: { pluginHeader: true, headerLong: true, headerIcons: true } },
    'icons-narrow': { about: 'Mixed buttons fold beside running status and metrics in a narrow window', viewport: { width: 320, height: 480 }, data: { pluginHeader: true, headerLong: true, headerIcons: true, headerRuntime: true, headerRate: true } },
  },
  async ready(page) { await page.locator('[contenteditable="true"]').waitFor(); },
  async check(page, ui) {
    const header = page.locator('[data-plugin-composer-header]');
    const root = page.locator('[data-chat-input-root]');
    if (ui.data.headerNewTask) {
      assert.equal(await header.count(), 0);
      assert.equal(await page.locator('[data-header-control], [data-plugin-composer-toolbar]').count(), 0);
      const empty = await root.boundingBox(), card = await root.locator(':scope > div').last().boundingBox();
      assert.ok(empty && card && empty.height === card.height, 'new-task drafts keep their original layout');
      return;
    }
    if (ui.data.headerDynamic) {
      await header.waitFor({ state: 'hidden' });
      const empty = await root.boundingBox(), card = await root.locator(':scope > div').last().boundingBox();
      assert.ok(empty && card && empty.height === card.height, 'an unpopulated collection leaves no row or placeholder');
      assert.equal(await page.getByRole('button', { name: 'Do not display the template' }).count(), 0);
      await ui.capture('empty');
      const items = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, title: `Action ${index + 1}`,
        ...([0, 5].includes(index) ? { icon: index === 0 ? 'sparkles' : 'folder' } : {}) }));
      await page.evaluate(items => window.electronAPI.maker.mcpApps(null, { op: 'fixture-feedback', visible: true, items }), items);
      await header.waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[data-header-control]').length === 12);
      const layout = await header.evaluate(element => {
        const lane = element.getBoundingClientRect();
        const slots = [...element.querySelectorAll('[data-header-control]:not([inert])')];
        return { height: lane.height, widths: slots.map(slot => slot.getBoundingClientRect().width),
          contained: slots.every(slot => { const box = slot.getBoundingClientRect(); return box.left >= lane.left - 1 && box.right <= lane.right + 1; }) };
      });
      assert.ok(layout.height <= 32 && layout.contained && layout.widths.every(width => width === 24 || width >= 64 && width <= 144));
      await ui.capture('controls');
      const more = header.locator(':scope > button');
      if (!await page.getByRole('button', { name: 'Action 10', exact: true }).count()) await more.click();
      const action = page.getByRole('button', { name: 'Action 10', exact: true });
      await action.waitFor();
      if (await more.getAttribute('aria-expanded') === 'true') await ui.capture('overflow');
      await action.click();
      await page.waitForFunction(() => window.__pluginItemValues.includes('item-9'));
      const reordered = [{ ...items[9], disabled: true }, items[0], items[11]];
      await page.evaluate(items => window.electronAPI.maker.mcpApps(null, { op: 'fixture-feedback', visible: true, items }), reordered);
      await page.waitForFunction(() => document.querySelectorAll('[data-header-control]').length === 3);
      await page.waitForFunction(() => document.querySelectorAll('[data-header-control]:not([inert])').length === 3);
      assert.ok(await header.locator('[data-header-control]').first().getByRole('button', { name: 'Action 10' }).isDisabled());
      assert.equal(await more.getAttribute('aria-hidden'), 'true', 'More disappears when the remaining items fit');
      if (await more.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape');
      await ui.capture('reordered');
      await page.evaluate(() => window.electronAPI.maker.mcpApps(null, { op: 'fixture-feedback', visible: true, items: [] }));
      await header.waitFor({ state: 'hidden' });
      assert.equal((await root.boundingBox()).height, empty.height, 'clearing a collection releases all occupied space');
      await ui.capture('cleared');
      return;
    }
    if (!ui.data.pluginHeader || ui.data.headerNoMatch || ui.data.pluginHidden) {
      if (ui.data.pluginHidden) await header.waitFor({ state: 'hidden' });
      else assert.equal(await header.count(), 0);
      const empty = await root.boundingBox();
      const card = await root.locator(':scope > div').last().boundingBox();
      assert.ok(empty && card);
      assert.equal(empty.height, card.height);
      if (ui.data.headerInlineHidden) {
        const toolbar = page.locator('[data-plugin-composer-toolbar]');
        await toolbar.waitFor({ state: 'hidden' });
        assert.equal(await toolbar.evaluate(element => getComputedStyle(element).display), 'none', 'an empty toolbar must release its flex gap');
      }
      return;
    }
    const lane = await header.boundingBox();
    const input = await root.locator(':scope > div').last().boundingBox();
    assert.ok(lane && input && lane.y + lane.height <= input.y);
    if (ui.data.headerRuntime) {
      const status = page.getByText(await ui.t('ccAgent.agentStatus.generating'), { exact: true });
      const meta = page.locator('[data-running-status-meta]');
      await meta.getByText(ui.data.headerRate ? /64\s*tok/i : /\b1[2-9]s\b/).waitFor();
      const statusBox = await status.boundingBox(), metaBox = await meta.boundingBox();
      assert.ok(statusBox && metaBox);
      assert.ok(statusBox.x + statusBox.width <= lane.x && lane.x + lane.width <= metaBox.x, 'controls fit between running status and metrics');
      assert.ok([statusBox, metaBox].every(box => Math.abs(box.y + box.height / 2 - lane.y - lane.height / 2) <= 2), 'running status, controls and metrics share a baseline');
      assert.equal(await root.locator('[data-plugin-composer-header]').count(), 0);
      if (ui.data.headerCenter) {
        const plan = await page.locator('[data-header-center]').boundingBox();
        assert.ok(plan && plan.x >= statusBox.x + statusBox.width && plan.x + plan.width <= lane.x);
      }
    } else assert.equal(lane.width, input.width);
    assert.ok(lane.height <= 32, `header must stay one line, got ${lane.height}px`);
    const more = header.getByRole('button', { name: await ui.t('sidebar.navigation.more'), exact: true });
    const fit = await header.evaluate(element => {
      const slots = [...element.querySelectorAll('[data-header-control]:not(:empty)')];
      const widths = slots.map(slot => slot.getBoundingClientRect().width);
      const gap = parseFloat(getComputedStyle(element).columnGap);
      const triggerWidth = element.querySelector(':scope > button').getBoundingClientRect().width;
      const lane = element.getBoundingClientRect();
      const visible = slots.filter(slot => !slot.inert);
      const hiddenWidths = slots.filter(slot => slot.inert).map(slot => slot.getBoundingClientRect().width);
      const occupied = visible.reduce((sum, slot) => sum + slot.getBoundingClientRect().width, 0)
        + (hiddenWidths.length ? triggerWidth + visible.length * gap : Math.max(0, visible.length - 1) * gap);
      return { widths, visible: visible.length, hiddenWidths, gap, remaining: lane.width - occupied,
        contained: visible.every(slot => {
          const box = slot.getBoundingClientRect();
          return box.left >= lane.left - 1 && box.right <= lane.right + 1;
        }) };
    });
    assert.ok(fit.contained && fit.remaining >= -1, 'no visible control is clipped or overlaps the running metrics');
    assert.ok(fit.hiddenWidths.every(width => width + fit.gap > fit.remaining - 1), 'More contains only controls that cannot fit in the remaining space');
    assert.ok(fit.widths.every(width => width === 24 || width >= 64 && width <= 144), `bounded text widths and square icons: ${fit.widths}`);
    if (ui.data.headerIcons) {
      const buttons = await header.evaluate(element => {
        const center = element.getBoundingClientRect();
        return [...element.querySelectorAll('[data-header-control]:not([inert]) button:not([role="combobox"])')].map(button => {
          const box = button.getBoundingClientRect(), icon = button.querySelector('svg');
          return { icon: !button.textContent, width: box.width, height: box.height,
            centerOffset: Math.abs(box.y + box.height / 2 - center.y - center.height / 2),
            iconWidth: icon?.getBoundingClientRect().width, iconHeight: icon?.getBoundingClientRect().height };
        });
      });
      assert.ok(buttons.every(button => button.height === 24 && button.centerOffset <= 1), 'mixed buttons share height and vertical center');
      assert.ok(buttons.filter(button => button.icon).every(button => button.width === 24 && button.iconWidth === 14 && button.iconHeight === 14), 'icon hitboxes and glyphs keep consistent sizes');
      if (!ui.data.headerRuntime) assert.ok(buttons.some(button => button.icon) && buttons.some(button => !button.icon), 'the visible row mixes icons and text');
    }
    const show = async (item) => {
      if (await item.count() === 0 && await more.getAttribute('aria-expanded') !== 'true') await more.click();
      await item.waitFor();
    };
    const first = fit.visible ? header.locator('[data-header-control]:not([inert])').first() : more;
    const firstBounds = await first.boundingBox();
    assert.ok(firstBounds && Math.abs(firstBounds.x + firstBounds.width - (lane.x + lane.width)) <= 1);
    const refresh = page.getByRole('button', { name: /^Refresh/ });
    await show(refresh);
    if (ui.data.headerLong && fit.visible && !ui.data.headerIcons) assert.ok(await refresh.evaluate(button => {
      const label = button.querySelector('span.truncate');
      return label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis';
    }), 'long button title uses an ellipsis within its width cap');
    await refresh.click();
    await page.waitForFunction(() => window.__pluginActions.includes('refresh'));
    const scope = page.getByRole('combobox', { name: 'Scope' });
    await show(scope);
    await scope.click();
    await page.getByRole('option', { name: 'All', exact: true }).click();
    await page.waitForFunction(() => window.__pluginActions.includes('scope'));
    if (ui.data.headerLong) {
      await more.waitFor();
      assert.ok(await header.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      const extra = page.getByRole('button', { name: /^Extra 5 with a long title/ });
      await show(extra);
      const bounds = await page.locator(`[id=${JSON.stringify(await more.getAttribute('aria-controls'))}]`).boundingBox();
      assert.ok(bounds && bounds.x >= input.x - 1 && bounds.x + bounds.width <= input.x + input.width + 1, 'More stays within the composer');
      assert.ok(bounds.y + bounds.height <= lane.y + 1, 'More opens above the shared status row');
      assert.ok(bounds.width <= 416 && bounds.height <= 160, 'the floating shelf stays bounded with long titles and many items');
      const shelf = await page.locator(`[id=${JSON.stringify(await more.getAttribute('aria-controls'))}]`).evaluate(panel => {
        const children = [...panel.children];
        const boxes = children.map(child => child.getBoundingClientRect());
        const gap = parseFloat(getComputedStyle(panel).columnGap);
        return { width: panel.getBoundingClientRect().width, gap,
          contentWidth: boxes.reduce((sum, box) => sum + box.width, 0) + Math.max(0, boxes.length - 1) * gap,
          rows: new Set(boxes.map(box => Math.round(box.y))).size,
          sizes: children.map(child => ({ width: child.getBoundingClientRect().width, button: !!child.querySelector('button'),
            height: child.querySelector('button')?.getBoundingClientRect().height })),
          ordered: boxes.every((box, index) => !index || box.y > boxes[index - 1].y || box.right <= boxes[index - 1].left),
          contained: boxes.every(box => box.left >= panel.getBoundingClientRect().left && box.right <= panel.getBoundingClientRect().right),
        };
      });
      assert.ok(shelf.ordered && shelf.contained, 'overflow controls retain right-to-left order without horizontal clipping');
      assert.ok(shelf.sizes.filter(item => item.button).every(item => item.height === 24), 'overflow buttons retain the inline height');
      if (shelf.contentWidth + 10 <= bounds.width + 1) {
        assert.equal(shelf.rows, 1, 'overflow stays horizontal while all controls fit');
        assert.ok(Math.abs(shelf.contentWidth + 10 - bounds.width) <= 1, 'the shelf hugs its controls');
      } else assert.ok(shelf.rows > 1, 'overflow wraps only when the width cap is reached');
      assert.ok(await extra.evaluate(button => {
        const label = button.querySelector('span.truncate');
        return label.scrollWidth > label.clientWidth &&
          getComputedStyle(label).textOverflow === 'ellipsis' && getComputedStyle(label).whiteSpace === 'nowrap';
      }), 'a long title stays single-line');
      const style = await extra.evaluate(button => {
        const laneButton = document.querySelector('[data-header-control$=":extra-4"] button');
        const signature = element => {
          const style = getComputedStyle(element);
          return [style.fontSize, style.fontWeight, style.color];
        };
        return { lane: signature(laneButton), overflow: signature(button) };
      });
      assert.deepEqual(style.overflow, style.lane, 'an overflow row keeps its inline typography');
      await ui.capture('overflow');
      const fullTitle = await extra.locator('span.truncate').textContent();
      if (ui.data.headerIcons) {
        const icons = await page.locator(`[id=${JSON.stringify(await more.getAttribute('aria-controls'))}]`).evaluate(panel =>
          [...panel.querySelectorAll('button[aria-label]:not([role="combobox"])')].map(button => ({
            title: button.getAttribute('aria-label'), text: button.textContent,
            width: button.getBoundingClientRect().width, glyph: button.querySelector('svg')?.getBoundingClientRect().width,
            face: getComputedStyle(button).getPropertyValue('--button-face-bg').trim(),
            border: getComputedStyle(button).getPropertyValue('--button-face-border').trim(),
          })));
        assert.ok(icons.length > 0 && icons.every(icon => icon.title && !icon.text && icon.width === 24 && icon.glyph === 14 &&
          icon.face === 'transparent' && icon.border === 'transparent'), 'overflow preserves bare icon buttons and full accessible names');
      }
      const tooltip = page.locator('[data-side][data-state$="-open"]').filter({ has: page.getByRole('tooltip') });
      await extra.hover();
      await tooltip.waitFor({ state: 'visible', timeout: 2000 });
      assert.ok((await tooltip.innerText()).includes(fullTitle), 'hover reveals the complete truncated title');
      const tooltipBox = await tooltip.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(tooltipBox && tooltipBox.x >= 0 && tooltipBox.y >= 0 &&
        tooltipBox.x + tooltipBox.width <= viewport.width + 1 &&
        tooltipBox.y + tooltipBox.height <= viewport.height + 1, 'the full title stays inside the window');
      await ui.capture('overflow-tooltip');
      await page.mouse.move(0, 0);
      await tooltip.waitFor({ state: 'detached' });
      const overflowPanel = page.locator(`[id=${JSON.stringify(await more.getAttribute('aria-controls'))}]`);
      await page.waitForFunction(id => document.getElementById(id)?.contains(document.activeElement), await more.getAttribute('aria-controls'));
      const count = await overflowPanel.locator('button').count();
      for (let index = 0; index < count && !await extra.evaluate(button => button === document.activeElement); index++) {
        await page.keyboard.press('Tab');
      }
      assert.ok(await extra.evaluate(button => button === document.activeElement), 'the overflow action is reachable by keyboard');
      // The shared Radix tooltip closes on ancestor scroll, including focus scrolling.
      // Keyboard access retains the full name even when that transient tooltip closes.
      assert.equal(await extra.evaluate(button => button.getAttribute('aria-label') || button.textContent), fullTitle);
      await extra.click();
      await tooltip.waitFor({ state: 'detached' });
      await page.waitForFunction(() => window.__pluginActions.includes('extra-4'));
      const openPanel = page.getByRole('button', { name: 'Open panel', exact: true });
      await show(openPanel);
      await openPanel.click();
      const popup = page.locator('[data-header-view]');
      await popup.waitFor();
      const panel = await popup.boundingBox();
      assert.ok(panel && panel.y < lane.y && panel.height > lane.height / 2);
      await ui.capture('popover');
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'detached' });
    }
    if (await more.count() && await more.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape');
    if (ui.data.headerStack) {
      await page.getByText('验收目标', { exact: true }).waitFor();
      await page.getByText(await ui.t('planMode.indicator.title'), { exact: true }).waitFor();
      await page.getByText('验收排队消息', { exact: true }).waitFor();
      const goal = await page.locator('[data-header-goal]').boundingBox();
      assert.ok(goal && goal.y + goal.height <= lane.y);
    }
    if (ui.data.headerFeedback) {
      const draft = await page.locator('[contenteditable="true"]').innerText();
      assert.equal(await page.getByText('Ready', { exact: true }).count(), 0, 'a declared hidden status leaves no placeholder');
      await page.evaluate(() => window.electronAPI.maker.mcpApps(null, { op: 'fixture-feedback', title: '处理中 40%', visible: true }));
      const progress = page.getByRole('status', { name: '' }).filter({ hasText: '处理中 40%' });
      await progress.waitFor();
      const progressBox = await progress.boundingBox();
      assert.ok(progressBox && Math.abs(progressBox.y + progressBox.height / 2 - lane.y - lane.height / 2) <= 1,
        'plugin feedback shares the existing controls and running-status line');
      await ui.capture('progress');
      await page.evaluate(() => window.electronAPI.maker.mcpApps(null, { op: 'fixture-feedback', title: '请检查处理结果', visible: true }));
      await page.getByText('请检查处理结果', { exact: true }).waitFor();
      assert.equal(await page.getByText('处理中 40%', { exact: true }).count(), 0);
      await ui.capture('hint');
      await page.evaluate(() => window.electronAPI.maker.mcpApps(null, { op: 'fixture-feedback', visible: false }));
      await page.getByText('请检查处理结果', { exact: true }).waitFor({ state: 'detached' });
      assert.equal(await page.locator('[contenteditable="true"]').innerText(), draft, 'feedback does not write the draft');
    }
    await ui.capture('controls');
    const ghosts = await page.evaluate(() => window.electronAPI.ghosts.listSync().ghosts);
    await page.evaluate(() => window.__uiPage.emit('ghosts', { ghosts: [] }));
    await header.waitFor({ state: 'detached' });
    const empty = await root.boundingBox();
    const card = await root.locator(':scope > div').last().boundingBox();
    assert.ok(empty && card);
    if (!ui.data.headerStack) assert.equal(empty.height, card.height);
    await page.evaluate(ghosts => window.__uiPage.emit('ghosts', { ghosts }), ghosts);
    await header.waitFor();
    if (ui.case === 'running-elapsed') {
      const mounted = await header.elementHandle();
      await page.getByTestId('running').click();
      await page.locator('[data-running-status-label]').waitFor({ state: 'detached' });
      assert.ok(await header.evaluate((current, previous) => current === previous, mounted), 'the header stays mounted across turn completion');
    }
  },
};
