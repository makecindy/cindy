import assert from 'node:assert/strict';

export default {
  name: 'transcript-scroll', entry: './fixture.tsx', viewport: { width: 900, height: 700 },
  stubs: {
    'src/renderer/components/chat/GhostToolCard': 'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
  },
  real: 'Production MessageStream and subagent ConversationStream, Markdown, native wheel scrolling',
  notCovered: 'Host transcript transport, model execution, mobile',
  cases: { default: { about: '300 historical main-thread messages' }, subagent: { about: '300 historical subagent replies' }, tools: { about: 'Expanded 300-step work group' }, header: { about: 'Reading position after the preceding thread header shrinks' } },
  async check(page, ui) {
    const scroll = page.locator('[data-scroll-container]').first();
    await scroll.waitFor();
    if (ui.case === 'header') {
      await scroll.hover();
      await page.mouse.wheel(0, -1440);
      await page.waitForTimeout(100);
      await page.getByRole('button', { name: 'Resize header', exact: true }).click();
      await scroll.hover();
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(100);
      await page.getByRole('button', { name: 'Read saved position', exact: true }).click();
      const saved = JSON.parse(await page.getByTestId('saved-position').textContent());
      const visible = await scroll.evaluate(root => {
        const top = root.getBoundingClientRect().top;
        const row = [...root.querySelector('.msg-stream-items').children].find(row => {
          const rect = row.getBoundingClientRect();
          return rect.height > 0 && rect.bottom > top;
        });
        return { key: row?.getAttribute('data-render-item-key'), offset: top - row.getBoundingClientRect().top };
      });
      assert.equal(saved.viewportTopKey, visible.key, 'Resized header must not leave a stale saved reading row');
      assert.ok(Math.abs(saved.offset - visible.offset) < 1, 'Saved reading offset matches the actual visible row');
      await ui.capture('header-resized');
      return;
    }
    const disclosure = page.locator('[data-scroll-disclosure-header][aria-expanded="false"]').first();
    if (await disclosure.count()) { await disclosure.click(); await page.waitForTimeout(400); }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => {
      const original = Element.prototype.getBoundingClientRect;
      const stats = window.__transcriptScroll = { reads: 0, readMs: 0, frames: [], long: [], active: true };
      Element.prototype.getBoundingClientRect = function () {
        const start = performance.now();
        const result = original.call(this);
        if (stats.active) { stats.reads++; stats.readMs += performance.now() - start; }
        return result;
      };
      const observer = new PerformanceObserver(list => stats.long.push(...list.getEntries().map(e => e.duration)));
      observer.observe({ type: 'longtask' });
      let last = performance.now();
      const frame = now => { if (!stats.active) return; stats.frames.push(now - last); last = now; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      window.__stopTranscriptScroll = () => { stats.active = false; observer.disconnect(); Element.prototype.getBoundingClientRect = original; };
    });
    await scroll.hover();
    for (let i = 0; i < 50; i++) {
      await page.mouse.wheel(0, i < 25 ? -480 : 480);
      await page.waitForTimeout(20);
    }
    const report = await page.evaluate(() => {
      window.__stopTranscriptScroll();
      const s = window.__transcriptScroll;
      const sorted = s.frames.slice().sort((a, b) => a - b);
      const root = document.querySelector('[data-scroll-container]');
      return { reads: s.reads, readMs: s.readMs, frameP95: sorted[Math.floor(sorted.length * .95)], longTasks: s.long,
        nodes: root.querySelectorAll('*').length, textLength: root.textContent.length, top: root.scrollTop, height: root.scrollHeight };
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
    console.log('TRANSCRIPT_SCROLL', JSON.stringify({ case: ui.case, theme: ui.theme, cpuRate: 4, ...report }));
    assert.ok(report.height > 700, 'Long transcript remains scrollable');
    assert.ok(report.reads < 4000, `Reading-position capture must not scan preceding history: ${report.reads} DOM reads`);
    await ui.capture('scrolled');
  },
};
