#!/usr/bin/env node
// E2E, explicitly invoked: node apps/desktop/scripts/check-region-snapping.mjs
// Bug: Chrome's first of two equal UIA containers was empty, so hovering its
// document selected the entire browser. Unit/fixture checks fake native replies.
// This checks a headed Chrome, the shipping native helper and production overlay
// using real replies. IPC sender validation remains in windows.test.ts.
// Optional --position=2700,100 exercises a secondary display; --helper=<binary>
// permits running the exact same regression against a pre-fix helper.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { buildPage, desktop } from './ui-page/build.mjs';
import { adhocPage } from './ui-page/registry.mjs';
import { pageResponse, origin } from './ui-page/run.mjs';

assert.equal(process.platform, 'win32', 'This native regression requires an interactive Windows desktop');
const option = (name) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const position = (option('position') ?? '80,80').split(',').map(Number);
assert.ok(position.length === 2 && position.every(Number.isFinite));
const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-region-blackbox-'));
const browserPath = option('browser') ?? path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe');
assert.ok(existsSync(browserPath), 'Chrome is required (or pass --browser=<path>)');
let browser, renderer, helper, nativeWindow;
const pending = new Map();
let sequence = 0;
const ask = (payload) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Native timeout: ${payload.op}`)); }, 5000);
  pending.set(id, { resolve: (reply) => { clearTimeout(timeout); resolve(reply); }, reject, timeout });
  helper.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
});
try {
  let binary = option('helper');
  if (!binary) {
    execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(desktop, 'native/region-screenshot/windows-snapshot/Cargo.toml')], { stdio: 'inherit', windowsHide: true });
    binary = path.join(desktop, 'native/region-screenshot/windows-snapshot/target/release/cindy-windows-screenshot-snapshot.exe');
  }
  helper = spawn(binary, [], { windowsHide: true, stdio: 'pipe' });
  createInterface({ input: helper.stdout }).on('line', line => {
    const reply = JSON.parse(line), task = pending.get(reply.id);
    if (task) { pending.delete(reply.id); task.resolve(reply); }
  });
  helper.on('error', error => { for (const task of pending.values()) { clearTimeout(task.timeout); task.reject(error); } pending.clear(); });
  // Real HWND hierarchy proves the snapshot path independently of Chromium
  // versions that render the whole page into one native window.
  nativeWindow = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', `
    Add-Type -AssemblyName System.Windows.Forms
    $form = New-Object System.Windows.Forms.Form
    $form.StartPosition = 'Manual'
    $form.Location = New-Object System.Drawing.Point(100,100)
    $form.ClientSize = New-Object System.Drawing.Size(500,400)
    $panel = New-Object System.Windows.Forms.Panel
    $panel.Bounds = New-Object System.Drawing.Rectangle(30,60,350,250)
    $inner = New-Object System.Windows.Forms.Panel
    $inner.Bounds = New-Object System.Drawing.Rectangle(20,30,180,100)
    $panel.Controls.Add($inner)
    $form.Controls.Add($panel)
    $form.Show()
    $form.Hide()
    $form.Show()
    $r = $inner.RectangleToScreen($inner.ClientRectangle)
    $json = @{ hwnd=$form.Handle.ToInt64(); rect=@($r.Left,$r.Top,$r.Right,$r.Bottom) } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    [System.Windows.Forms.Application]::Run($form)
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const nativeGeometry = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native fixture did not open')), 10000);
    createInterface({ input: nativeWindow.stdout }).once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
    nativeWindow.once('error', error => { clearTimeout(timer); reject(error); });
  });
  let nativeSnapshot;
  const nativeDeadline = Date.now() + 3000;
  do {
    nativeSnapshot = (await ask({ op: 'windows' })).windows.find(w => w.hwnd === nativeGeometry.hwnd);
    if (nativeSnapshot) break;
    await delay(20);
  } while (Date.now() < nativeDeadline);
  assert.ok(nativeSnapshot, `native test window is captured: ${JSON.stringify(nativeGeometry)}`);
  const center = { x: (nativeGeometry.rect[0] + nativeGeometry.rect[2]) / 2, y: (nativeGeometry.rect[1] + nativeGeometry.rect[3]) / 2 };
  assert.deepEqual(nativeSnapshot.snapRects.find(r => r[0] <= center.x && center.x < r[2] && r[1] <= center.y && center.y < r[3]),
    nativeGeometry.rect, 'native snapshot hits the inner child before its parent');
  nativeWindow.kill();
  nativeWindow = undefined;
  browser = await chromium.launchPersistentContext(path.join(temp, 'chrome'), {
    executablePath: browserPath, headless: false, viewport: null,
    args: ['--force-device-scale-factor=1', `--window-position=${position.join(',')}`, '--window-size=1000,800', '--no-first-run'],
  });
  const source = browser.pages()[0];
  await source.setContent('<!doctype html><title>Region snapping regression</title><style>body{margin:0;font:18px sans-serif}header{padding:30px}main{padding:40px}button{padding:18px}section{height:260px;border:1px solid}</style><header><button>Code</button></header><main><section>File list</section><p>Document body</p></main>');
  await source.bringToFront();
  const geometry = await source.evaluate(() => ({ x: screenX, y: screenY, outerWidth, outerHeight, width: innerWidth, height: innerHeight }));
  // Independently measure the webpage viewport from browser geometry, never from
  // the helper reply being tested. Chrome's invisible resize border is symmetric.
  const border = (geometry.outerWidth - geometry.width) / 2;
  const content = { x: geometry.x + border, y: geometry.y + geometry.outerHeight - geometry.height - border, width: geometry.width, height: geometry.height };
  const windows = (await ask({ op: 'windows' })).windows;
  const target = windows.find(({ rect: r }) => Math.abs(r[0] - geometry.x) <= 10
    && Math.abs(r[1] - geometry.y) <= 10 && Math.abs(r[2] - r[0] - geometry.outerWidth) <= 20);
  assert.ok(target, 'Headed Chrome is visible');
  const [left, top, right, bottom] = target.rect;
  const viewport = { width: right - left, height: bottom - top };
  const local = (r) => ({ x: r[0] - left, y: r[1] - top, width: r[2] - r[0], height: r[3] - r[1] });
  const closeRect = (actual, expected, label) => {
    assert.ok(actual, `${label}: missing region`);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) <= 2, `${label} ${key}: ${actual[key]} != ${expected[key]}`);
  };
  assert.ok(Array.isArray(target.snapRects), 'native window snapshot includes default regions');
  const contentLocal = { ...content, x: content.x - left, y: content.y - top };
  const samples = [];
  for (const selector of ['button', 'section', 'p']) {
    const box = await source.locator(selector).boundingBox();
    const point = { x: Math.round(content.x + box.x + box.width / 2), y: Math.round(content.y + box.y + box.height / 2) };
    // A new Chrome starts accessibility lazily after its first UIA query. Poll
    // the observable result with a deadline; an old helper still fails here.
    let hit;
    const deadline = Date.now() + 4000;
    do {
      hit = await ask({ op: 'elements', hwnd: target.hwnd, ...point });
      if (hit.preferredRect && Math.abs(hit.preferredRect[1] - content.y) <= 2) break;
      await delay(100);
    } while (Date.now() < deadline);
    const expected = { ...content, x: content.x - left, y: content.y - top };
    closeRect(local(hit.preferredRect ?? hit.rects[0] ?? target.rect), expected, selector);
    if (selector === 'button') assert.ok(hit.rects.some(r => r[2] - r[0] < content.width && r[3] - r[1] < content.height), 'native button branch must remain reachable');
    samples.push({ selector, point, expected, native: hit });
  }
  const chromeHit = await ask({ op: 'elements', hwnd: target.hwnd, x: Math.round(left + viewport.width / 2), y: top + 25 });
  closeRect(local(chromeHit.preferredRect ?? chromeHit.rects[0] ?? target.rect), { x: 0, y: 0, ...viewport }, 'browser-chrome');
  // Some Chromium versions expose content only through UIA, without child HWNDs.
  // Keep the actual native snapshot; never fabricate regions from expected DOM geometry.
  const captured = (await ask({ op: 'windows' })).windows.find(w => w.hwnd === target.hwnd);
  assert.ok(captured, 'browser remains available for capture');
  // Playwright's bringToFront activates the tab but Windows can refuse focus
  // stealing. Keep only our disposable Chrome above other apps during capture.
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class RegionTestWindow { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags); }'; if (![RegionTestWindow]::SetWindowPos([IntPtr]${target.hwnd}, [IntPtr](-1), 0, 0, 0, 0, 0x13)) { exit 1 }`], { windowsHide: true });
  const visible = (await ask({ op: 'windows' })).windows.find(({ rect: r }) => r[0] <= content.x + 50 && content.x + 50 < r[2] && r[1] <= content.y + 50 && content.y + 50 < r[3]);
  assert.equal(visible?.hwnd, target.hwnd, 'Native capture must show the tested Chrome, not an occluding app');
  // Wait for Windows to compose the newly exposed native window (E2E only).
  await delay(100);
  const frame = await ask({ op: 'frame', x: left, y: top, ...viewport, edge: 1600 });
  assert.ok(frame.pixels, 'Native screenshot is available');
  const bundle = await buildPage(adhocPage(path.join(desktop, 'scripts/fixtures/region-capture/native-overlay.tsx')));
  renderer = await chromium.launch({ executablePath: browserPath, headless: true });
  const report = [];
  for (const theme of ['light', 'dark']) {
    const context = await renderer.newContext({ viewport });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const queried = [];
    // Hold actual native replies to expose intermediate fallback frames. The
    // expected geometry is used only by assertions, never supplied to the UI.
    let releaseElements;
    let elementsReady = Promise.resolve();
    await page.exposeFunction('nativeElements', async (x, y) => {
      await elementsReady;
      const hit = await ask({ op: 'elements', hwnd: target.hwnd, x: Math.round(x + left), y: Math.round(y + top) });
      queried.push({ x, y, hit });
      return { window: { id: 0, rect: { x: 0, y: 0, ...viewport } }, rects: hit.rects.map(local), ...(hit.preferredRect ? { preferredRect: local(hit.preferredRect) } : {}) };
    });
    await page.addInitScript(begin => { window.nativeBegin = begin; }, {
      token: 'native-blackbox', locale: 'en', viewport, safeArea: { x: 0, y: 0, ...viewport }, scaleFactor: 1,
      frame: { width: frame.width, height: frame.height, data: Array.from(Buffer.from(frame.pixels, 'base64')) },
      windows: [{ id: 0, rect: { x: 0, y: 0, ...viewport }, snapRects: captured.snapRects.map(local) }], cursor: null, lastRegion: null,
    });
    await page.route('**/*', route => {
      const response = pageResponse(route.request().url(), bundle, { page: 'native-region', case: 'default', theme, locale: 'en', platform: 'win32', viewport, data: {} });
      return response ? route.fulfill(response) : route.abort();
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.__uiPage?.ready);
    await page.mouse.move(contentLocal.x + 25, contentLocal.y + 35);
    await page.getByText(`${Math.round(content.width)} × ${Math.round(content.height)}`, { exact: true }).waitFor();
    elementsReady = new Promise(resolve => { releaseElements = resolve; });
    // Observe DOM commits and painted frames across continuous movement, not
    // just the final result after an async wait (the gap in the original test).
    await page.evaluate(() => {
      window.regionTrace = [];
      const sample = () => {
        const outline = document.querySelector('div[style*="100000px"]');
        if (outline) {
          const { x, y, width, height } = outline.getBoundingClientRect();
          window.regionTrace.push({ x, y, width, height });
        }
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.body, { attributes: true, childList: true, subtree: true });
      let frame;
      const tick = () => { sample(); frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
      window.stopRegionTrace = () => { observer.disconnect(); cancelAnimationFrame(frame); sample(); return window.regionTrace; };
    });
    for (let step = 0; step < 40; step++) {
      await page.mouse.move(contentLocal.x + 30 + step * 10, contentLocal.y + 40 + step * 4);
      closeRect(await page.locator('div[style*="100000px"]').boundingBox(), contentLocal, `${theme}/pending-move-${step}`);
    }
    const trace = await page.evaluate(() => window.stopRegionTrace());
    assert.ok(trace.length >= 40, 'observe each move while native queries are pending');
    trace.forEach((rect, index) => closeRect(rect, contentLocal, `${theme}/frame-${index}`));
    await writeFile(path.join(temp, `${theme}-movement.json`), JSON.stringify(trace));
    // Crossing the content boundary is synchronous even with the query held.
    await page.mouse.move(viewport.width / 2, 25);
    closeRect(await page.locator('div[style*="100000px"]').boundingBox(), { x: 0, y: 0, ...viewport }, `${theme}/pending-boundary`);
    releaseElements();
    for (const sample of samples) {
      await page.mouse.move(sample.point.x - left, sample.point.y - top);
      await page.getByText(`${Math.round(content.width)} × ${Math.round(content.height)}`, { exact: true }).waitFor();
      // Observe the actual rendered outline, not a test-only selection accessor.
      const outline = page.locator('div[style*="100000px"]');
      closeRect(await outline.boundingBox(), sample.expected, `${theme}/${sample.selector}`);
      await page.screenshot({ path: path.join(temp, `${theme}-${sample.selector}.png`) });
    }
    const before = queried.length;
    await page.mouse.move(viewport.width / 2, 25);
    await page.getByText(`${viewport.width} × ${viewport.height}`, { exact: true }).waitFor();
    // Return to the button and exercise both finer and coarser candidates.
    const first = samples[0];
    const buttonQueries = queried.length;
    await page.mouse.move(first.point.x - left, first.point.y - top);
    await page.getByText(`${Math.round(content.width)} × ${Math.round(content.height)}`, { exact: true }).waitFor();
    // The default is now immediate; wheel checks must wait for fine elements,
    // rather than treating the content outline as proof that UIA has completed.
    const fineDeadline = Date.now() + 5000;
    const fineReady = () => queried.slice(buttonQueries).some(({ x, y, hit }) =>
      Math.abs(x - (first.point.x - left)) < 1 && Math.abs(y - (first.point.y - top)) < 1
      && hit.rects.some(r => r[2] - r[0] < content.width && r[3] - r[1] < content.height));
    while (!fineReady() && Date.now() < fineDeadline) await delay(20);
    assert.ok(fineReady(), 'fresh native fine elements are available at the button');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.wheel(0, 120);
    await page.getByText(`${Math.round(content.width)} × ${Math.round(content.height)}`, { exact: true }).waitFor({ state: 'hidden' });
    await page.mouse.wheel(0, -120);
    await page.getByText(`${Math.round(content.width)} × ${Math.round(content.height)}`, { exact: true }).waitFor();
    await page.mouse.click(first.point.x - left, first.point.y - top);
    await page.mouse.move(viewport.width - 20, 25);
    assert.equal(await page.getByText(`${Math.round(content.width)} × ${Math.round(content.height)}`, { exact: true }).count(), 1, 'click locks content selection');
    assert.ok(queried.length > before, 'moving from chrome into content performs a fresh native query');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(temp, `${theme}-selected.png`) });
    report.push({ theme, content, window: target.rect, nativeRegions: captured.snapRects.length, movementSamples: trace.length, checks: ['pending-movement', 'pending-boundary', 'button', 'file-list', 'body', 'browser-chrome', 'wheel', 'click'] });
    await context.close();
  }
  await writeFile(path.join(temp, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`REGION_BLACKBOX=passed evidence=${temp}`);
} finally {
  await renderer?.close();
  await browser?.close();
  helper?.kill();
  nativeWindow?.kill();
  for (const task of pending.values()) clearTimeout(task.timeout);
  // Keep only reviewable screenshots/report; remove the isolated browser profile.
  await rm(path.join(temp, 'chrome'), { recursive: true, force: true });
}
