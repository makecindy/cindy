import assert from 'node:assert/strict';
import composer from '../companion-composer/ui-page.mjs';

export default {
  name: 'task-content-width', entry: './fixture.tsx', viewport: { width: 1920, height: 1080 },
  real: 'MessageStream, AssistantMessage, MarkdownRenderer, ChatInput, useProportionalWidth, LayoutRoot, SplitGroup and their production draggable dividers; AppFrame header, fonts and themes',
  notCovered: 'Full session routing, new-task transition, native OS scaling/window resize, persistence and host IO; reference panel contents, sidebar navigation and model catalog are synthetic. Viewports are effective CSS widths at100% page zoom; scaling cases model1920/125% or150% without changing the OS display. Group and companion bubble widths are unchanged. SplitGroup uses a synthetic session catalog and replaces CCAgentSessionView with the same real MessageStream/ChatInput test body; complete session routing is not mounted.',
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
      viewport: { width: 800, height: 900 }, data: { splitWidth: width, collapsed: true },
    }])),
    'width-min-window': { about: 'Native minimum800px window with the expanded260px sidebar', viewport: { width: 800, height: 700 } },
    default: { about: 'Large desktop, sidebar expanded' },
    'width-normal': { about: 'Ordinary laptop, sidebar expanded', viewport: { width: 1280, height: 900 } },
    'width-large': { about: 'Large desktop, sidebar expanded' },
    'width-ultrawide': { about: 'Ultrawide desktop', viewport: { width: 3440, height: 1440 } },
    'width-collapsed': { about: 'Large desktop, sidebar collapsed', data: { collapsed: true } },
    'width-panel': { about: 'Reference panel at 50/50 and divider extremes', data: { panel: true } },
    'width-legacy': { about: 'Original 914px width for design comparison', data: { legacy: true } },
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
    const measure = async () => page.evaluate(() => {
      const pane = document.querySelector('[data-task-pane]').getBoundingClientRect();
      const stream = document.querySelector('[data-scroll-container]');
      const column = stream.firstElementChild.getBoundingClientRect();
      const composer = document.querySelector('[data-width-composer]').getBoundingClientRect();
      const markdown = document.querySelector('[data-message-client-id="answer"] .msg-markdown');
      const paragraph = markdown.querySelector(':scope > p');
      const prose = paragraph.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(paragraph).lineHeight);
      return { pane: pane.width, column: column.width, composer: composer.width, prose: prose.width,
        supportedWideCap: Number(document.querySelector('[data-task-width]').dataset.wideCap),
        proseLines: Math.round(prose.height / lineHeight),
        table: markdown.querySelector('table')?.getBoundingClientRect().width,
        code: markdown.querySelector('pre')?.getBoundingClientRect().width,
        cssViewport: innerWidth, pageScale: visualViewport?.scale, dpr: devicePixelRatio,
        centerDelta: (composer.left + composer.right - column.left - column.right) / 2,
        overflow: document.documentElement.scrollWidth - innerWidth,
        withinPane: composer.left >= pane.left && composer.right <= pane.right };
    });
    const verify = async () => {
      await page.waitForFunction(() => {
        const pane = document.querySelector('[data-task-pane]');
        const el = document.querySelector('[data-task-width]');
        return parseFloat(el.style.getPropertyValue('--cindy-message-width')) <= pane.getBoundingClientRect().width;
      });
      const m = await measure();
      // --compare loads the original production hook, with no wide-cap export.
      // Preserve its known6px one-sided gutter in before evidence; the new
      // ordinary-task layout must share the composer's exact center axis.
      const original = m.supportedWideCap === 914;
      assert.ok(m.withinPane && m.overflow <= 1 && Math.abs(m.centerDelta) <= (original ? 6.1 : 1), JSON.stringify(m));
      assert.ok(Math.abs(m.composer - m.column - 20) <= 1, JSON.stringify(m));
      assert.ok(Math.abs(m.prose - m.column) <= 1, `Prose and blocks share one content edge: ${JSON.stringify(m)}`);
      for (const width of [m.table, m.code].filter(value => value !== undefined)) {
        assert.ok(Math.abs(width - m.column) <= 1, `Wide blocks share the prose column: ${JSON.stringify(m)}`);
      }
      assert.equal(m.pageScale, 1, 'Effective widths use100% page zoom');
      if (!original && !ui.data.legacy && m.pane >= 1600) {
        assert.ok(Math.abs(m.column - 1120) <= 1, `Pure text and wide blocks use the bounded wide column: ${JSON.stringify(m)}`);
      }
      if (m.pane >= 1014 && m.pane <= 1200) {
        assert.ok(Math.abs(m.column - 914) <= 1, `Laptop reading width remains unchanged: ${JSON.stringify(m)}`);
      }
      console.log('TASK_WIDTH', JSON.stringify({ case: ui.case, theme: ui.theme, ...m }));
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
      await ui.capture('narrow-split');
    }
    await verify();
    const process = page.locator('[data-scroll-disclosure-header][aria-expanded="false"]').first();
    if (await process.count()) {
      await process.click();
      await ui.capture('expanded-process');
      await page.locator('[data-scroll-disclosure-header][aria-expanded="true"]').first().click();
    }
    if (ui.case === 'width-panel') {
      const divider = page.getByTestId('layout-divider');
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
    const scroll = page.locator('[data-scroll-container]').first();
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await ui.capture('code-and-composer');
    await scroll.evaluate(el => { el.scrollTop = 0; });
  },
};
