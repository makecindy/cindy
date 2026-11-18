import assert from 'node:assert/strict';
import composer from '../companion-composer/ui-page.mjs';

export default {
  name: 'task-content-width', entry: './fixture.tsx', viewport: { width: 1920, height: 1080 },
  real: 'MessageStream, AssistantMessage, MarkdownRenderer, ChatInput, useProportionalWidth, LayoutRoot and its production draggable divider; AppFrame header, fonts and themes',
  notCovered: 'Full session routing, new-task transition, native OS scaling/window resize, persistence and host IO; reference panel contents, sidebar navigation and model catalog are synthetic. Viewports are effective CSS widths at100% page zoom; scaling cases model1920/125% or150% without changing the OS display. Group and companion bubble widths are unchanged.',
  stubs: {
    ...composer.stubs,
    'src/renderer/components/chat/GhostToolCard': 'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
    'src/renderer/cindy-brain/ghostDevTools': 'export const installGhostDevTools = () => {};',
    'src/renderer/cindy-brain/ghostPanels': 'export const ensureGhostPanelsRegistered = () => {}; export const useGhostPanelsSync = () => {};',
    'src/renderer/layout/layoutDevTools': 'export const installLayoutDevTools = () => {};',
  },
  cases: {
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
    'text-width-ultrawide': { about: 'Plain paragraphs keep the reading width and start edge on an ultrawide pane', data: { textOnly: true }, viewport: { width: 3440, height: 1440 } },
    'text-width-scale125': { about: 'Plain paragraphs at1536px effective scaled width', data: { textOnly: true }, viewport: { width: 1536, height: 864 } },
    'text-width-scale150': { about: 'Plain paragraphs at1280px effective scaled width', data: { textOnly: true }, viewport: { width: 1280, height: 720 } },
  },
  async ready(page) {
    await page.locator('.ProseMirror').waitFor();
    await page.locator('[data-message-client-id="answer"] .msg-markdown').waitFor();
    await page.locator('[data-scroll-container]').evaluate(el => { el.scrollTop = 0; });
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
        paneLayout: !['', 'auto'].includes(document.querySelector('[data-task-width]').style.getPropertyValue('--cindy-message-margin-start')),
        start: column.left - pane.left, inputStart: composer.left - pane.left,
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
      // --compare replays the original centered hook. Only the new pane layout
      // anchors the actual message column and independently fills the input row.
      assert.ok(m.withinPane && m.overflow <= 1, JSON.stringify(m));
      assert.ok(Math.abs(m.prose - m.column) <= 1, `Prose and blocks share one content edge: ${JSON.stringify(m)}`);
      for (const width of [m.table, m.code].filter(value => value !== undefined)) {
        assert.ok(Math.abs(width - m.column) <= 1, `Wide blocks share the prose column: ${JSON.stringify(m)}`);
      }
      assert.equal(m.pageScale, 1, 'Effective widths use100% page zoom');
      if (m.pane >= 1014) {
        assert.ok(Math.abs(m.column - 914) <= 1, `Reading width stays bounded: ${JSON.stringify(m)}`);
      }
      if (m.paneLayout) {
        const pad = m.pane < 700 ? 20 : 50;
        assert.ok(Math.abs(m.start - pad) <= 1, `Work column follows the pane start: ${JSON.stringify(m)}`);
        assert.ok(Math.abs(m.inputStart - (pad - 10)) <= 1, `Input shares the start hierarchy: ${JSON.stringify(m)}`);
        assert.ok(Math.abs(m.composer - (m.pane - 2 * (pad - 10))) <= 1, `Input uses available pane: ${JSON.stringify(m)}`);
      } else {
        assert.ok(Math.abs(m.composer - m.column - 20) <= 1 && Math.abs(m.centerDelta) <= 6.1, JSON.stringify(m));
      }
      console.log('TASK_WIDTH', JSON.stringify({ case: ui.case, theme: ui.theme, ...m }));
    };
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
    const scroll = page.locator('[data-scroll-container]');
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await ui.capture('code-and-composer');
    await scroll.evaluate(el => { el.scrollTop = 0; });
  },
};
