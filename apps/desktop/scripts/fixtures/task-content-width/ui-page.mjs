import assert from 'node:assert/strict';
import composer from '../companion-composer/ui-page.mjs';

const widePreference = ratio => ({ 'chat.layoutMode': 'wide', 'chat.layoutWidthPercent': String(ratio) });

export default {
  name: 'task-content-width', entry: './fixture.tsx', viewport: { width: 1920, height: 1080 },
  real: 'MessageStream, AssistantMessage, MarkdownRenderer, ChatInput, useProportionalWidth, LayoutRoot, SplitGroup and their production draggable dividers; AppFrame header, fonts and themes',
  notCovered: 'Full session routing, new-task transition, native OS scaling/window resize, persistence and host IO; reference panel contents, sidebar navigation and model catalog are synthetic. Viewports are effective CSS widths at100% page zoom; scaling cases model1920/125% or150% without changing the OS display. Companion cases mount the production simplified MessageStream and ChatInput, with synthetic task data. SplitGroup uses a synthetic session catalog and replaces CCAgentSessionView with the same real MessageStream/ChatInput test body; complete session routing is not mounted.',
  stubs: {
    ...composer.stubs,
    'src/renderer/features/cc-agent/CCAgentSessionView': 'export { Task as CCAgentSessionView } from "./scripts/fixtures/task-content-width/fixture";',
    'src/renderer/hooks/useCCSessions': { partial: `const sessions = ['width-a', 'width-b'].map(id => ({ id, title: id, name: id, agentKind: 'codex', status: 'idle', createdAt: 1 })); export const useCCSessions = () => ({ sessions, isLoading: false, error: null, refreshSessions: async () => {}, patchLocal: () => {} });` },
    'src/renderer/components/chat/GhostToolCard': 'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
    'src/renderer/cindy-brain/ghostDevTools': 'export const installGhostDevTools = () => {};',
    'src/renderer/cindy-brain/ghostPanels': 'export const ensureGhostPanelsRegistered = () => {}; export const useGhostPanelsSync = () => {};',
    'src/renderer/layout/layoutDevTools': 'export const installLayoutDevTools = () => {};',
  },
  cases: {
    ...Object.fromEntries([280, 320, 360, 400].map(width => [`width-split-${width}`, {
      about: 'Real task splitter at a narrow pane width within the supported800px window',
      viewport: { width: 800, height: 900 }, storage: widePreference(100),
      data: { splitWidth: width, collapsed: true, ratio: 100 },
    }])),
    'width-min-window': { about: 'Native minimum800px window with the expanded260px sidebar', viewport: { width: 800, height: 700 } },
    default: { about: 'Large desktop, sidebar expanded' },
    'width-normal': { about: 'Ordinary laptop, sidebar expanded', viewport: { width: 1280, height: 900 } },
    'width-large': { about: 'Large desktop, sidebar expanded' },
    ...Object.fromEntries([1860, 3440].flatMap(width => [false, true].map(companion => [
      companion ? `companion-wide-${width}` : width === 3440 ? 'width-ultrawide' : 'width-cap',
      { about: 'Opt-in wide pane and compact short tables for a task or companion',
        viewport: { width, height: 1080 }, storage: widePreference(75), data: { companion, shortTable: true, ratio: 75 } },
    ]))),
    'width-live': { about: 'Adjust real settings controls against the mounted task without navigating away',
      viewport: { width: 1860, height: 1080 }, data: { shortTable: true, interactive: true } },
    'width-live-ultrawide': { about: 'All slider positions change the chat column on an ultrawide pane',
      viewport: { width: 3440, height: 1080 }, data: { shortTable: true, interactive: true } },
    'companion-width-55': { about: 'The companion conversation uses the same 55% width as a task',
      viewport: { width: 1860, height: 1080 }, storage: widePreference(55),
      data: { companion: true, shortTable: true, ratio: 55 } },
    'width-maximum': { about: '100% of the ultrawide pane retains normal margins',
      viewport: { width: 3440, height: 1080 }, storage: widePreference(100), data: { shortTable: true, ratio: 100 } },
    'width-collapsed': { about: 'Large desktop, sidebar collapsed', data: { collapsed: true } },
    'width-panel': { about: 'Reference panel at 50/50 and divider extremes with 100% selected',
      storage: widePreference(100), data: { panel: true, ratio: 100 } },
    'width-legacy': { about: 'Default standard layout retains the original 914px limit' },
    'width-streaming': { about: 'Live Markdown prose retains the completed reply reading width', data: { streaming: true } },
    'width-notebook': { about: '1440px effective laptop width retains the mature914px column', viewport: { width: 1440, height: 900 } },
    'width-scale125': { about: '1536px effective width, equivalent to1920px at125% system scale', viewport: { width: 1536, height: 864 } },
    'width-scale150': { about: '1280px effective width, equivalent to1920px at150% system scale', viewport: { width: 1280, height: 720 } },
    'text-width-large': { about: 'Plain paragraphs at the same1920px window as the mixed content', data: { textOnly: true } },
    'text-width-notebook': { about: 'Plain paragraphs retain the914px laptop baseline', data: { textOnly: true }, viewport: { width: 1440, height: 900 } },
    'text-width-normal': { about: 'Plain paragraphs at1280px effective width', data: { textOnly: true }, viewport: { width: 1280, height: 900 } },
    'text-width-ultrawide': { about: 'Plain paragraphs remain bounded on an ultrawide pane', data: { textOnly: true }, viewport: { width: 3440, height: 1440 } },
    'text-width-scale125': { about: 'Plain paragraphs at1536px effective scaled width', data: { textOnly: true }, viewport: { width: 1536, height: 864 } },
    'text-width-scale150': { about: 'Plain paragraphs at1280px effective scaled width', data: { textOnly: true }, viewport: { width: 1280, height: 720 } },
  },
  async ready(page) {
    await page.locator('.ProseMirror').first().waitFor();
    await page.locator('[data-message-client-id="answer"] .msg-markdown').first().waitFor();
    await page.locator('[data-scroll-container]').evaluateAll(elements => elements.forEach(el => { el.scrollTop = 0; }));
  },
  async check(page, ui) {
    // UI tier. Feedback #12: a 1920px desktop was still capped at 914px.
    // Existing narrow-pane fixtures never measured a wide task column or the
    // relationship between prose, wide blocks and the composer.
    const measure = async (index = 0) => page.evaluate(index => {
      const paneElement = document.querySelectorAll('[data-task-pane]')[index];
      const pane = paneElement.getBoundingClientRect();
      const stream = paneElement.querySelector('[data-scroll-container]');
      const column = stream.firstElementChild.getBoundingClientRect();
      const composer = paneElement.querySelector('[data-width-composer]').getBoundingClientRect();
      const markdown = paneElement.querySelector('[data-message-client-id="answer"] .msg-markdown');
      const paragraph = markdown.querySelector(':scope > p');
      const prose = paragraph.getBoundingClientRect();
      const [table, shortTable] = markdown.querySelectorAll('table');
      const bubble = markdown.closest('[data-bot-reply-bubble]');
      const tableViewport = table?.parentElement;
      const headerLines = table ? Math.max(...Array.from(table.querySelectorAll('th'), th => {
        const range = document.createRange();
        range.selectNodeContents(th);
        return Math.ceil(range.getBoundingClientRect().height / parseFloat(getComputedStyle(th).lineHeight));
      })) : undefined;
      const lineHeight = parseFloat(getComputedStyle(paragraph).lineHeight);
      return { pane: pane.width, column: column.width, composer: composer.width, prose: prose.width,
        proseLines: Math.round(prose.height / lineHeight),
        table: table?.getBoundingClientRect().width, tableViewport: tableViewport?.clientWidth, headerLines,
        bubble: bubble?.getBoundingClientRect().width,
        shortTable: shortTable?.getBoundingClientRect().width,
        code: markdown.querySelector('pre')?.getBoundingClientRect().width,
        cssViewport: innerWidth, pageScale: visualViewport?.scale, dpr: devicePixelRatio,
        centerDelta: (composer.left + composer.right - column.left - column.right) / 2,
        overflow: document.documentElement.scrollWidth - innerWidth,
        withinPane: composer.left >= pane.left && composer.right <= pane.right };
    }, index);
    const verify = async (index = 0, ratio = ui.data.ratio) => {
      await page.waitForFunction(({ index, ratio }) => {
        const pane = document.querySelectorAll('[data-task-pane]')[index];
        const el = pane.querySelector('[data-task-width]');
        const width = pane.getBoundingClientRect().width;
        const available = width - 40 - Math.min(60, Math.max(0, (width - 700) / 2));
        const expected = ratio === undefined ? Math.min(914, available) : Math.min(available, Math.max(660, available * ratio / 100));
        return Math.abs(parseFloat(el.style.getPropertyValue('--cindy-message-width')) - expected) <= 1;
      }, { index, ratio });
      const m = await measure(index);
      const available = m.pane - 40 - Math.min(60, Math.max(0, (m.pane - 700) / 2));
      const expected = ratio === undefined ? Math.min(914, available) : Math.min(available, Math.max(660, available * ratio / 100));
      assert.ok(Math.abs(m.column - expected) <= 1, JSON.stringify({ ratio, expected, ...m }));
      assert.ok(m.withinPane && m.overflow <= 1 && Math.abs(m.centerDelta) <= 1, JSON.stringify(m));
      assert.ok(Math.abs(m.composer - m.column - 20) <= 1, JSON.stringify(m));
      if (ui.data.companion) {
        assert.ok(m.bubble > 0 && m.bubble <= 721 && m.prose < m.bubble, JSON.stringify(m));
      } else {
        assert.ok(Math.abs(m.prose - m.column) <= 1, `Prose stays in the content column: ${JSON.stringify(m)}`);
      }
      for (const width of [m.code].filter(value => value !== undefined)) {
        assert.ok(Math.abs(width - m.prose) <= 1, `Wide blocks share the prose column: ${JSON.stringify(m)}`);
      }
      if (m.table !== undefined) {
        assert.ok(m.tableViewport <= m.prose + 1 && m.table >= m.tableViewport - 1,
          `The table scrollport shares the content column: ${JSON.stringify(m)}`);
        // UI regression2026-11-19: a280px task pane stacked seven labels
        // character by character; the earlier wide-column checks missed it.
        if (m.pane < 700) assert.equal(m.headerLines, 1, `Narrow table labels remain readable: ${JSON.stringify(m)}`);
      }
      if (ui.data.shortTable) {
        assert.ok(m.table > m.shortTable * 2 && m.shortTable >= 70 && m.shortTable < 240,
          `Short table columns stay adjacent: ${JSON.stringify(m)}`);
      }
      assert.equal(m.pageScale, 1, 'Effective widths use100% page zoom');
      console.log('TASK_WIDTH', JSON.stringify({ case: ui.case, theme: ui.theme, paneIndex: index, ratio, ...m }));
      return m;
    };
    if (ui.data.splitWidth) {
      // User requested extremely narrow views. Top-level task panes stop at400,
      // but the real inner task splitter permits280. Exercise its actual gutter
      // instead of shrinking an impossible native desktop window to280px.
      const gutter = page.locator('[data-split-branch] > [role="separator"]').first();
      const canvas = await page.locator('[data-split-canvas]').boundingBox();
      const box = await gutter.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(canvas.x + ui.data.splitWidth + box.width / 2, box.y + 100, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(width => Math.abs(document.querySelector('[data-task-pane]').getBoundingClientRect().width - width) < 1, ui.data.splitWidth);
      await verify();
      await verify(1);
      await ui.capture('narrow-split');
      const tableViewport = page.locator('[data-task-pane]').first().locator('.msg-markdown table').locator('..');
      await tableViewport.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      const rightEdge = await tableViewport.evaluate(el => ({
        scrolled: el.scrollLeft > 0,
        right: el.getBoundingClientRect().right,
        last: el.querySelector('tr').lastElementChild.getBoundingClientRect().right,
      }));
      assert.ok(rightEdge.scrolled && rightEdge.last <= rightEdge.right + 1, 'Last columns remain reachable inside the table');
      await ui.capture('table-last-columns');
      await tableViewport.evaluate(el => { el.scrollLeft = 0; });
      if (ui.data.splitWidth === 280) {
        await gutter.press('End');
        await verify();
        await verify(1);
        await ui.capture('other-pane-min');
        await gutter.press('Home');
      }
    }
    await verify();
    if (ui.data.interactive) {
      await ui.capture('standard');
      await page.getByRole('radio', { name: await ui.t('settings.appearance.chatLayout.wide'), exact: true }).click();
      const slider = page.getByRole('slider', { name: await ui.t('settings.appearance.chatLayout.width'), exact: true });
      await slider.waitFor();
      await verify(0, 75);
      await ui.capture('wide-75');
      const thumb = await slider.boundingBox();
      const track = await page.locator('[data-setting-id="appearance.chatWidth"]').boundingBox();
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
      await page.mouse.down();
      await page.mouse.move(track.x + track.width - 1, track.y + track.height / 2, { steps: 8 });
      await verify(0, 100);
      assert.equal(await page.evaluate(() => localStorage.getItem('chat.layoutWidthPercent')), null);
      await page.mouse.up();
      await ui.capture('wide-100');
      await slider.press('Home');
      let previousWidth = 0;
      for (let ratio = 50; ratio <= 100; ratio += 5) {
        const { column } = await verify(0, ratio);
        assert.ok(column > previousWidth, 'Each slider step changes the real chat column');
        previousWidth = column;
        if (ratio <= 60) await ui.capture(`wide-${ratio}`);
        if (ratio < 100) await slider.press('ArrowRight');
      }
      return;
    }
    const process = page.locator('[data-scroll-disclosure-header][aria-expanded="false"]').first();
    if (await process.count()) {
      await process.click();
      await ui.capture('expanded-process');
      await page.locator('[data-scroll-disclosure-header][aria-expanded="true"]').first().click();
    }
    if (ui.case === 'width-panel') {
      const divider = page.getByTestId('layout-divider');
      let previousWidth = 0;
      for (const paneWidth of [699, 700, 701, 819, 820, 821]) {
        const box = await divider.boundingBox();
        const { pane } = await measure();
        await page.mouse.move(box.x + box.width / 2, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + paneWidth - pane, box.y + 100, { steps: 8 });
        await page.mouse.up();
        await page.waitForFunction(width => Math.abs(document.querySelector('[data-task-pane]').getBoundingClientRect().width - width) <= 1, paneWidth);
        const { column } = await verify();
        assert.ok(column >= previousWidth, 'Growing the pane never narrows the chat');
        previousWidth = column;
      }
      for (const edge of ['left', 'right']) {
        const box = await divider.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(edge === 'left' ? 0 : ui.viewport.width - 1, box.y + 100, { steps: 12 });
        await page.mouse.up();
        await verify();
        await ui.capture(`divider-${edge}`);
      }
      await page.getByTestId('toggle-sidebar').click();
      await verify();
      await ui.capture('sidebar-collapsed');
    }
    if (ui.data.textOnly) return;
    const scroll = page.locator('[data-scroll-container]').first();
    const box = await scroll.boundingBox();
    await page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height / 2, ui.viewport.height - 150));
    // Use actual user scroll intent; assigning scrollTop can be reconciled back
    // to MessageStream's saved viewport anchor before the next screenshot.
    await page.mouse.wheel(0, 10000);
    console.log('TASK_SCROLL', JSON.stringify(await scroll.evaluate(el => {
      const pre = el.querySelector('pre').getBoundingClientRect();
      return { top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight, codeTop: pre.top, codeBottom: pre.bottom };
    })));
    await page.waitForFunction(() => {
      const pane = document.querySelector('[data-task-pane]');
      const scroll = pane.querySelector('[data-scroll-container]');
      const pre = scroll.querySelector('pre').getBoundingClientRect();
      const composer = pane.querySelector('[data-width-composer]').getBoundingClientRect();
      return pre.top < composer.top && pre.bottom > scroll.getBoundingClientRect().top
        && (scroll.scrollHeight <= scroll.clientHeight + 1 || scroll.scrollTop > 0);
    });
    await ui.capture('code-and-composer');
    await page.mouse.wheel(0, -10000);
    await page.waitForFunction(() => document.querySelector('[data-scroll-container]').scrollTop < 1);
  },
};
