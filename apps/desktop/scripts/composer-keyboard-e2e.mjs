// Full App regression for #7158 / DESIGN §14.2. Component fixtures omit the
// window-capture/root listeners, so this integration tier uses an isolated dev App.
// Start: XDT_CDP_PORT=19459 pnpm restart:desktop:remote --region=global --mock --isolated=composer-tab-e2e --passive
// Run: node apps/desktop/scripts/composer-keyboard-e2e.mjs
// No host/shortcut/component stubs, sends or agent calls. The smallest old failure
// is: type '- parent', Shift+Enter, Tab; the empty second item stays at root level.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const started = performance.now();
const output = await mkdtemp(path.join(os.tmpdir(), 'cindy-composer-app-'));
const results = [];
let browser,
  page,
  editor,
  originalTheme,
  ownsDraft = false;
try {
  browser = await chromium.connectOverCDP(
    process.env.COMPOSER_E2E_CDP_URL ?? 'http://127.0.0.1:19459',
  );
  // Check the live main process against the repository's own provenance report
  // before changing a page. Refuse installed apps, other checkouts and profiles.
  const session = await browser.newBrowserCDPSession();
  let main;
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const mains = processInfo.filter((entry) => entry.type === 'browser');
    assert.equal(mains.length, 1);
    main = mains[0].id;
  } finally {
    await session.detach();
  }
  const report = JSON.parse(
    execFileSync(process.execPath, ['scripts/desktop-whoami.mjs', '--all', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
    }),
  );
  const instance = report.instances.find((entry) => entry.pid === main);
  assert.ok(
    instance?.ready && instance.isolated && instance.passive,
    'Expected a ready isolated passive dev App',
  );
  assert.equal(instance.rootDir, root.replace(/\/$/, ''));
  assert.equal(instance.profileKind, 'isolated-sandbox');
  assert.equal(path.basename(instance.userDataDir), 'CindyGlobal-dev2-composer-tab-e2e');
  page = browser
    .contexts()[0]
    .pages()
    .find(
      (entry) =>
        /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(entry.url()) &&
        !new URL(entry.url()).search,
    );
  assert.ok(page, 'Expected the real Vite App page');
  page.setDefaultTimeout(15000);
  assert.equal(
    await page.evaluate(async () => (await window.electronAPI.authInitialize()).mode),
    'local',
    'Refuse cloud accounts',
  );
  await page.evaluate(() => {
    location.hash = '/cc-agent/ui-mock-rich-answer';
  });
  await page.reload();
  editor = page.locator('.ProseMirror[contenteditable="true"]:visible');
  await editor.waitFor();
  assert.equal(await editor.count(), 1);
  assert.equal(
    await editor.evaluate((node) => node.editor.isEmpty),
    true,
    'Refuse to overwrite an existing draft',
  );
  ownsDraft = true;
  originalTheme = await page.evaluate(() => localStorage.getItem('theme'));
  const clear = async () => {
    await editor.click();
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
    assert.equal(await editor.evaluate((node) => node.editor.isEmpty), true);
  };
  for (const theme of ['light', 'dark']) {
    // Use the production cross-window preference listener, not CSS overrides.
    await page.evaluate((value) => {
      localStorage.setItem('theme', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: value }));
    }, theme);
    await page.waitForFunction(
      (value) => document.documentElement.classList.contains('dark') === (value === 'dark'),
      theme,
    );
    for (const [kind, parent, marker] of [
      ['bullet', '- parent', '-'],
      ['ordered', '7) parent', ')'],
      ['task', '- [x] parent', '-'],
      ['plus', '+ parent', '+'],
      ['cjk', '3、parent', '、'],
    ]) {
      await editor.click();
      await page.keyboard.type(parent);
      await editor.press('Shift+Enter');
      assert.equal(await editor.locator(':scope > ul > li, :scope > ol > li').count(), 2);
      await editor.press('Tab');
      assert.equal(
        await editor.locator('li li').count(),
        1,
        `${theme}/${kind}: Tab reaches list-item keymap through App listeners`,
      );
      assert.equal(
        await editor.evaluate((node) => node.contains(document.activeElement)),
        true,
        'Tab keeps editor focus',
      );
      const list = await editor.evaluate(
        (node) => node.editor.getJSON().content[0].content[0].content[1],
      );
      assert.equal(list.attrs.marker, marker, 'New child list retains source marker');
      if (kind === 'ordered' || kind === 'cjk') assert.equal(list.attrs.start, 1);
      await page.keyboard.type('child');
      assert.equal(
        await editor.locator('li li').innerText(),
        kind === 'task' ? '[ ] child' : 'child',
      );
      if (kind === 'plus') await page.screenshot({ path: path.join(output, `${theme}.png`) });
      results.push({ theme, kind, pass: true });
      await clear();
    }
    // Ordinary text must retain native Tab traversal through the same root.
    await page.keyboard.type('ordinary text');
    await editor.press('Tab');
    assert.equal(await editor.evaluate((node) => node.contains(document.activeElement)), false);
    assert.equal(await editor.textContent(), 'ordinary text');
    results.push({ theme, kind: 'plain-text-tab-traversal', pass: true });
    await clear();
  }
  console.log(
    `COMPOSER_APP_E2E passed ${results.length}/${results.length} (${((performance.now() - started) / 1000).toFixed(2)}s)`,
  );
} catch (error) {
  process.exitCode = 1;
  results.push({ pass: false, error: error.message });
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(`COMPOSER_APP_E2E failed: ${error.message}`);
} finally {
  // Clear only the draft this run owned (the empty-draft guard ran first).
  // Screenshots retain failures for diagnosis; no real messages were sent.
  if (ownsDraft) {
    try {
      await editor.click();
      await editor.press('ControlOrMeta+A');
      await editor.press('Backspace');
    } catch (error) {
      process.exitCode = 1;
      results.push({ pass: false, cleanupError: error.message });
    }
  }
  // Restore only the preference changed by this run.
  if (page && originalTheme !== undefined)
    await page
      .evaluate((value) => {
        if (value === null) localStorage.removeItem('theme');
        else localStorage.setItem('theme', value);
        window.dispatchEvent(
          new StorageEvent('storage', { key: 'theme', newValue: value ?? 'system' }),
        );
      }, originalTheme)
      .catch(() => {});
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ results, elapsedMs: performance.now() - started }, null, 2),
  );
  await browser?.close();
  console.log(`REPORT=${output}`);
}
