/** Production viewport + MarkdownRenderer, synthetic long history in a verified
 * isolated --mock instance. No database or clipboard writes. Native selection
 * and focus must stay correct; run both revisions with this exact fixture.
 * node benchmark-message-keyboard.cjs <label> <outside-repo-output-dir> [cdp-port]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.join(process.env.CINDY_BENCH_DESKTOP || path.resolve(__dirname, '..'), 'package.json'))('playwright-core');

async function main() {
  const [label, output, port = '9347'] = process.argv.slice(2);
  if (!label || !/^[a-z0-9-]+$/i.test(label) || !output) throw Error('Expected label and output directory');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  try {
    page = browser.contexts()[0].pages().find(p => p.url().includes('/#/cc-agent/ui-mock-'));
    if (!page) throw Error('Open a demo task in the verified isolated mock instance first');
    await page.bringToFront();
    const results = [];
    for (const key of ['Tab', 'Control+A', 'Tab', 'Control+A', 'Tab', 'Control+A']) {
      await page.reload();
      await page.locator('.tiptap[contenteditable=true]').first().waitFor();
      await page.evaluate(async () => {
        const source = await (await fetch('/components/chat/MessageViewport.tsx')).text();
        const reactUrl = source.match(/from "([^"\n]*deps[^"\n]*react.js[^"\n]*)"/)[1].replaceAll('\\', '/');
        const React = (await import(reactUrl)).default;
        const { createRoot } = (await import(reactUrl.replace('react.js', 'react-dom_client.js'))).default;
        const { MessageViewport } = await import('/components/chat/MessageViewport.tsx');
        const { MarkdownRenderer } = await import('/components/chat/MarkdownRenderer.tsx');
        const previous = [...document.body.children].map(element => [element, element.inert]);
        for (const [element] of previous) element.inert = true;
        const host = document.createElement('div');
        host.id = 'keyboard-perf-fixture';
        host.style.cssText = 'position:fixed;inset:0;z-index:99999;';
        document.body.append(host);
        const h = React.createElement;
        const entries = Array.from({ length: 80 }, (_, index) => ({ key: String(index), retain: false }));
        const content = entry => `## Message-${entry.key}-sentinel\n\n` + Array.from({ length: 8 }, (_, n) =>
          `Paragraph ${n}: **Performance fixture** preserves native selection across the entire history. ` +
          'This text has emphasis, multiple paragraphs and list items, without external resources.\n\n' +
          '- First item with *emphasis*\n- Second item with ordinary text.\n\n').join('');
        function Fixture() {
          const scrollRef = React.useRef(null), itemsRef = React.useRef(null);
          const apiRef = React.useRef(null), followRef = React.useRef(false);
          React.useLayoutEffect(() => { apiRef.current?.connect(); });
          return h(React.Fragment, null, h('button', { id: 'fixture-before' }, 'Before'),
            h('div', { ref: scrollRef, style: { height: 600, overflow: 'auto', width: 800, maxWidth: '100%' } },
              h(MessageViewport, { apiRef, options: { entries, scrollRef, itemsRef, followRef,
                disabled: false, initialAnchor: '40', initialHeights: Object.fromEntries(entries.map(e => [e.key, 1600])) } },
              viewport => h('div', { ref: itemsRef }, entries.map(entry => {
                const props = { key: entry.key, 'data-render-item-key': entry.key };
                return viewport.shouldMount(entry)
                  ? h('div', props, h('button', { id: `fixture-row-${entry.key}` }, `Row ${entry.key}`),
                    h(MarkdownRenderer, { content: content(entry), allowPrivilegedLinks: false }))
                  : h('div', { ...props, 'data-message-placeholder': '', style: { height: viewport.placeholderHeight(entry.key) } });
              })))));
        }
        const root = createRoot(host);
        window.__keyboardBenchmark = { long: [] };
        const observer = new PerformanceObserver(list => window.__keyboardBenchmark.long.push(...list.getEntries().map(e => e.duration)));
        window.__cleanupKeyboardBenchmark = () => {
          observer.disconnect();
          root.unmount(); host.remove(); document.getSelection()?.removeAllRanges();
          for (const [element, inert] of previous) element.inert = inert;
        };
        root.render(h(Fixture));
        // Measure wall time + browser long tasks. An event listener registered
        // after production capture listeners misses their synchronous work.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        observer.observe({ type: 'longtask' });
      });
      await page.locator('#fixture-before').focus();
      await page.waitForTimeout(500);
      await page.evaluate(() => { window.__keyboardBenchmark.long = []; });
      const start = performance.now();
      await page.keyboard.press(key);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const wallMs = performance.now() - start;
      const result = await page.evaluate(() => {
        const selected = document.getSelection()?.toString() ?? '';
        return { ...window.__keyboardBenchmark,
        mounted: document.querySelectorAll('#keyboard-perf-fixture [data-render-item-key]:not([data-message-placeholder])').length,
        focus: document.activeElement.id,
        selectedRows: Array.from({ length: 80 }, (_, n) => selected.includes(`Message-${n}-sentinel`)).filter(Boolean).length,
      }; });
      if (key === 'Tab') assert.equal(result.focus, 'fixture-row-0');
      else assert.equal(result.selectedRows, 80, 'Native select-all must include the entire history');
      results.push({ key, wallMs, ...result });
      await page.evaluate(() => window.__cleanupKeyboardBenchmark());
    }
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `${label}-keyboard.json`), JSON.stringify({ label, rows: 80, results }, null, 2));
    console.log(JSON.stringify({ label, rows: 80, results }));
  } finally {
    if (page) await page.evaluate(() => window.__cleanupKeyboardBenchmark?.()).catch(() => {});
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
