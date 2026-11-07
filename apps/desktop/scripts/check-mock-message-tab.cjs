/** Native-keyboard smoke test for a verified isolated --mock Desktop, not a signed-in instance.
 * node apps/desktop/scripts/check-mock-message-tab.cjs [cdp-port]
 * Imports the production viewport through the running Vite server; fixture rows
 * are temporary DOM only, with no database writes. This is not an end-to-end performance benchmark.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.join(__dirname, '../package.json'))('playwright-core');

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || '9347'}`);
  let page;
  try {
    page = browser.contexts()[0].pages().find(p => p.url().includes('/#/cc-agent/ui-mock-'));
    if (!page) throw new Error('Open a demo task in the verified isolated mock instance first');
    await page.reload();
    await page.locator('.tiptap[contenteditable=true]').first().waitFor();
    await page.evaluate(async () => {
      const source = await (await fetch('/components/chat/MessageViewport.tsx')).text();
      const reactUrl = source.match(/from "([^"\n]*deps[^"\n]*react.js[^"\n]*)"/)[1].replaceAll('\\', '/');
      const React = (await import(reactUrl)).default;
      const { createRoot } = (await import(reactUrl.replace('react.js', 'react-dom_client.js'))).default;
      const { MessageViewport } = await import('/components/chat/MessageViewport.tsx');
      const previousInert = [...document.body.children].map(element => [element, element.inert]);
      for (const [element] of previousInert) element.inert = true;
      const host = document.createElement('div');
      host.id = 'bwg-keyboard-fixture';
      host.style.cssText = 'position:fixed;inset:0;z-index:99999;';
      document.body.append(host);
      const h = React.createElement;
      const entries = Array.from({ length: 80 }, (_, index) => ({ key: String(index), retain: false }));
      function Fixture() {
        const scrollRef = React.useRef(null), itemsRef = React.useRef(null);
        const apiRef = React.useRef(null), followRef = React.useRef(false);
        React.useLayoutEffect(() => { apiRef.current?.connect(); });
        const rows = viewport => h('div', { ref: itemsRef }, entries.map(entry => {
          const props = { key: entry.key, 'data-render-item-key': entry.key };
          return viewport.shouldMount(entry)
            ? h('div', { ...props, style: { height: 180 } }, h('button', { id: `row-${entry.key}` }, `Row ${entry.key}`))
            : h('div', { ...props, 'data-message-placeholder': '', style: { height: viewport.placeholderHeight(entry.key) } });
        }));
        const viewport = h(MessageViewport, { apiRef, options: {
          entries, scrollRef, itemsRef, followRef, disabled: false, initialAnchor: '40',
          initialHeights: Object.fromEntries(entries.map(entry => [entry.key, 180])),
        } }, rows);
        return h(React.Fragment, null, h('button', { id: 'before' }, 'Before'),
          h('div', { ref: scrollRef, style: { height: 600, overflow: 'auto' } }, viewport),
          h('button', { id: 'after' }, 'After'));
      }
      const root = createRoot(host);
      window.__cleanupMessageTabFixture = () => {
        root.unmount(); host.remove();
        for (const [element, inert] of previousInert) element.inert = inert;
      };
      root.render(h(Fixture));
    });
    await page.locator('#before').waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const results = [];
    for (const [start, key, expected] of [['before', 'Tab', [0, 1, 2]], ['after', 'Shift+Tab', [79, 78, 77]]]) {
      await page.locator(`#${start}`).focus();
      for (const row of expected) {
        await page.keyboard.press(key);
        const state = await page.evaluate(() => ({
          focus: document.activeElement.id,
          mounted: document.querySelectorAll('#bwg-keyboard-fixture [data-render-item-key]:not([data-message-placeholder])').length,
        }));
        results.push({ key, ...state });
        assert.equal(state.focus, `row-${row}`);
        assert.ok(state.mounted < 20, `Unexpected full history mount: ${state.mounted}`);
      }
    }
    console.log(JSON.stringify({ rows: 80, results }, null, 2));
  } finally {
    if (page) await page.evaluate(() => window.__cleanupMessageTabFixture?.());
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
