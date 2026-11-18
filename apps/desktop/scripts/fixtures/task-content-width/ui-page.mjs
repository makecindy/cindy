import assert from 'node:assert/strict';
import composer from '../companion-composer/ui-page.mjs';

export default {
  name: 'task-content-width', entry: './fixture.tsx', viewport: { width: 1920, height: 1080 },
  real: 'MessageStream, AssistantMessage, MarkdownRenderer, ChatInput, useProportionalWidth, LayoutRoot and its production draggable divider; AppFrame header, fonts and themes',
  notCovered: 'Full session routing, new-task transition, native window resize, persistence and host IO; reference panel contents, sidebar navigation and model catalog are synthetic. Group and companion bubble widths are unchanged.',
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
      const prose = document.querySelector('[data-message-client-id="answer"] .msg-markdown > p').getBoundingClientRect();
      return { pane: pane.width, column: column.width, composer: composer.width, prose: prose.width,
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
      assert.ok(m.withinPane && m.overflow <= 1 && Math.abs(m.centerDelta) <= 5, JSON.stringify(m));
      assert.ok(Math.abs(m.composer - m.column - 20) <= 1, JSON.stringify(m));
      if (!ui.data.legacy && m.pane >= 1400) {
        assert.ok(m.column >= 1199, `Wide work column must use available space: ${JSON.stringify(m)}`);
        assert.ok(m.prose <= 915, `Prose retains its reading width: ${JSON.stringify(m)}`);
      }
      console.log('TASK_WIDTH', JSON.stringify({ case: ui.case, theme: ui.theme, ...m }));
    };
    await verify();
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
