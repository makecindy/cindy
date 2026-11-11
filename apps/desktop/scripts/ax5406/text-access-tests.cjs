// Actual navigation callback + real browser geometry, then the built MessageStream.
// Usage: node text-access-tests.cjs <fresh component artifact root> <output directory>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { chromium } = require('playwright-core');
const source = path.resolve(__dirname, '../../src/renderer');
const read = file => fs.readFileSync(path.join(source, file), 'utf8');
const stream = read('components/chat/MessageStream.tsx');
const helper = read('lib/scrollRangeIntoView.ts');
const access = read('lib/pageTextAccess.ts');
const func = (text, name) => ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  .statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText().replace(/^export /, '');
const callback = stream.slice(stream.indexOf('    const navigateText ='), stream.indexOf('    root.addEventListener(PAGE_TEXT_NAVIGATION_EVENT'));
const code = ts.transpileModule(func(helper, 'getRangeRect') + '\n' + func(helper, 'scrollRangeIntoView') + '\n' +
  func(stream, 'resolveChipJumpTargetScrollTop') + '\n' + func(access, 'requestPageTextNavigation') + '\n' + callback,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
  const results = { navigation: [], accessibility: [] };
  try {
    const p = await browser.newPage({ viewport: { width: 1000, height: 760 } });
    for (const nested of [false, true]) {
      await p.setContent(`<div id="root" style="width:300px;height:400px;overflow:auto"><div style="height:900px"></div><div data-message-client-id="message"><div id="vertical" style="${nested ? 'height:100px;overflow-y:auto;' : ''}"><div style="height:${nested ? 700 : 0}px"></div><pre id="code" style="overflow-x:auto;white-space:pre"><span>${'long_line_'.repeat(25)}</span><span id="needle">NEEDLE</span></pre></div></div><div style="height:900px"></div></div>`);
      const result = await p.evaluate(code => {
        const root = document.querySelector('#root'), scroll = document.querySelector('#code'), vertical = document.querySelector('#vertical');
        const range = document.createRange(); range.selectNodeContents(document.querySelector('#needle'));
        const PAGE_TEXT_NAVIGATION_EVENT = 'cindy-page-text-navigation';
        const api = new Function('root', 'PAGE_TEXT_NAVIGATION_EVENT', 'cancelFocusJump', 'unpinAutoFollowForUserUpIntent', 'beginChipJump', 'syncMessageViewport',
          code + '\nreturn {navigateText,requestPageTextNavigation}')(root, PAGE_TEXT_NAVIGATION_EVENT, () => {}, () => {}, () => {}, () => {});
        root.addEventListener(PAGE_TEXT_NAVIGATION_EVENT, api.navigateText);
        const handled = api.requestPageTextNavigation(range);
        const r = range.getBoundingClientRect(), x = scroll.getBoundingClientRect(), y = vertical.getBoundingClientRect(), outer = root.getBoundingClientRect();
        return { handled, scrollLeft: scroll.scrollLeft, nestedTop: vertical.scrollTop, outerTop: root.scrollTop,
          visible: r.left >= x.left && r.right <= x.right && r.top >= y.top && r.bottom <= y.bottom && r.top >= outer.top && r.bottom <= outer.bottom };
      }, code);
      results.navigation.push(result); assert.ok(result.handled && result.visible); assert.ok(result.scrollLeft > 0);
      if (nested) assert.ok(result.nestedTop > 0);
    }
    const url = require('node:url').pathToFileURL(path.join(process.argv[2], 'component/component.html')).href;
    for (const initial of ['off', 'on']) {
      await p.goto(url + '?workload=visual&rows=200&accessibility=' + initial);
      await p.waitForFunction(() => window.ax5406Visual);
      await p.evaluate(() => window.ax5406Visual.streamFinish());
      await p.waitForTimeout(500);
      const cdp = await p.context().newCDPSession(p); await cdp.send('Accessibility.enable');
      const snapshot = async () => {
        const dom = await p.locator('.msg-stream-items').evaluate(e => ({
          count: e.children.length, keys: [...e.children].map(e => e.dataset.messageClientId),
          hidden: e.querySelectorAll('[data-message-placeholder]').length,
        }));
        const tree = await cdp.send('Accessibility.getFullAXTree');
        return { ...dom, exposed: [...new Set(tree.nodes.flatMap(n => n.role?.value === 'StaticText' ? [...(n.name?.value || '').matchAll(/Synthetic row (\d+)/g)].map(m => Number(m[1])) : []))].sort((a, b) => a - b) };
      };
      const before = await snapshot();
      if (initial === 'off') assert.ok(before.hidden > 0); else assert.equal(before.hidden, 0);
      await p.evaluate(() => window.ax5406Accessibility(true)); await p.waitForTimeout(500);
      const enabled = await snapshot(); assert.deepEqual(enabled.keys, before.keys); assert.equal(enabled.count, 80);
      assert.equal(enabled.hidden, 0); assert.deepEqual(enabled.exposed, Array.from({ length: 80 }, (_, i) => i + 120));
      await p.evaluate(() => window.ax5406Accessibility(false)); await p.waitForTimeout(500);
      const disabled = await snapshot(); assert.deepEqual(disabled.keys, before.keys); assert.ok(disabled.hidden > 0);
      results.accessibility.push({ initial, before, enabled, disabled }); await cdp.detach();
    }
    fs.writeFileSync(path.join(process.argv[3], 'text-access.json'), JSON.stringify(results, null, 2));
    console.log('TEXT_ACCESS_PASS', JSON.stringify(results.navigation));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
