/**
 * Electron integration for #12124. A single transparent App suffices to expose a
 * wrapper following system appearance instead of Cindy. jsdom cannot observe
 * Chromium's opaque iframe canvas or capture a missing child surface.
 * Hiding the inner iframe simulates a missing frame; it does not reproduce the
 * intermittent macOS compositor bug. McpAppCard's unit tests cover its wiring.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const pages = ['undeclared', 'light', 'dark', 'both', 'opaque', 'host', 'lightcanvas', 'darkcanvas', 'wallpaper', 'gap'];
const versions = ['before', 'after'];
const viewport = { width: 260, height: pages.length * 40 };
const themes = ['light', 'dark'];
const settle = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))';

function appPage(page, host) {
  const scheme = { light: 'light', dark: 'dark', both: 'light dark', host, lightcanvas: 'light', darkcanvas: 'dark' }[page];
  const background = { opaque: '#535353', lightcanvas: 'Canvas', darkcanvas: 'Canvas' }[page] ?? 'transparent';
  return `<!doctype html><html${scheme ? ` style="color-scheme:${scheme}"` : ''}><style>
    html,body{margin:0;height:100%}body{background:${background}}</style><body></body></html>`;
}

function hostPage(host) {
  const cards = pages.flatMap(page => versions.map(version => {
    const query = version === 'after' ? '?scheme=' + host : '';
    return `<div class="card ${page}"><iframe id="${version}-${page}" sandbox="allow-scripts allow-same-origin allow-forms"
      src="cindy-mcp-app://${version}-${page}/sandbox${query}"></iframe></div>`;
  }));
  return `<!doctype html><html style="color-scheme:${host}"><style>
    body{margin:0;display:grid;grid-template-columns:130px 130px}
    .card{box-sizing:border-box;padding:4px;height:40px;background:light-dark(#f5f5f5,#1f1f1e)}
    .wallpaper{background-image:linear-gradient(to right,#787878 50%,#999 50%)}
    iframe{border:0;display:block;width:100%;height:100%}
    </style><body>${cards.join('')}
    <div id="opaque-reference" style="position:absolute;left:0;top:${pages.indexOf('opaque') * 40}px;width:4px;height:4px;background:#535353"></div>
    </body></html>`;
}

async function verify(directory) {
  const { app, BrowserWindow, protocol, nativeTheme } = require('electron');
  const { mcpAppDirectSandboxDocument } = require(path.join(directory, 'wrapper.cjs'));
  app.setPath('userData', path.join(directory, 'profile'));
  app.commandLine.appendSwitch('site-per-process');
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  protocol.registerSchemesAsPrivileged([{ scheme: 'cindy-mcp-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  await app.whenReady();
  const renderer = await readFile(path.join(directory, 'renderer.js'), 'utf8');
  let host;
  protocol.handle('cindy-mcp-app', request => {
    const url = new URL(request.url);
    const [version, page] = url.hostname.split('-');
    if (url.pathname === '/bridge') return Response.json([]);
    let html;
    if (url.pathname === '/sandbox') {
      html = mcpAppDirectSandboxDocument(`cindy-mcp-app://${url.hostname}-view/resource`,
        `cindy-mcp-app://${url.hostname}/bridge`, url.searchParams.get('scheme'));
      // Hold the App and transport constant. This is the complete wrapper
      // stylesheet at fb88e2a754; CI shallow checkouts need no historical refs.
      if (version === 'before') html = html.replace(/<style>[^<]*<\/style>/,
        '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style>');
    } else if (url.pathname === '/resource') {
      html = appPage(page, host);
    } else return new Response(null, { status: 404 });
    return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  });

  const window = new BrowserWindow({ ...viewport, useContentSize: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const contents = window.webContents;
  // Sample in CSS pixels on both Retina and standard-density displays.
  async function capture() {
    await contents.executeJavaScript(settle);
    const image = (await contents.capturePage()).resize(viewport);
    const bitmap = image.toBitmap();
    return (x, y) => {
      const i = 4 * (y * viewport.width + x);
      return [bitmap[i + 2], bitmap[i + 1], bitmap[i]];
    };
  }
  // capturePage can still return the preceding compositor surface after a DOM paint.
  // Only wait for stable changes following the one-shot red freshness check.
  async function captureChange(gapY, ready, stage) {
    const deadline = performance.now() + 1_000;
    let gap, card;
    do {
      const pixel = await capture();
      gap = pixel(195, gapY);
      card = pixel(10, 1);
      if (ready(gap, card)) return pixel;
    } while (performance.now() < deadline);
    assert.fail(`${stage}: last gap RGB ${gap}, card RGB ${card}`);
  }
  try {
    for (const system of themes) {
      nativeTheme.themeSource = system;
      assert.equal(nativeTheme.shouldUseDarkColors, system === 'dark');
      for (host of themes) {
        await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(hostPage(host)));
        await contents.executeJavaScript(renderer);
        // Remove only the nested App surface for the simulated gap. The real
        // cross-origin wrapper stays visible and retains its own canvas.
        for (const version of versions) {
          const gap = contents.mainFrame.framesInSubtree.find(f => f.url.startsWith(`cindy-mcp-app://${version}-gap/sandbox`));
          assert.ok(gap, 'missing production wrapper for the gap');
          await gap.executeJavaScript('document.querySelector("iframe").style.visibility="hidden";' + settle);
        }
        const gapY = pages.indexOf('gap') * 40 + 20;
        await contents.executeJavaScript('document.getElementById("after-gap").style.backgroundColor="red"');
        const probe = await capture();
        const red = probe(195, gapY);
        // A display profile can transform CSS red (e.g. 234,51,35 on Mac).
        // No other content in the scene is red.
        assert.ok(red[0] > 200 && red[1] < 80 && red[2] < 80,
          `host=${host} system=${system}: red iframe not visible (${red}); capture stale or wrapper opaque`);
        await contents.executeJavaScript('paintBackdrops()');
        const pixel = await captureChange(gapY, equalRgb, 'missing frame must expose the painted card background');
        const card = pixel(10, 1);
        for (const [index, page] of pages.entries()) {
          if (page === 'gap') continue;
          const y = index * 40 + 20;
          const before = pixel(40, y), after = pixel(170, y);
          console.log(JSON.stringify({ host, system, page, before, after, card }));
          if (page === 'wallpaper') {
            for (const x of [40, 90]) {
              // Wherever the old App showed the underlying image, both stripes
              // must still be visible. The exposed padding is the pixel reference.
              const previous = pixel(x, y), stripe = pixel(x, index * 40 + 1);
              const current = pixel(x + 130, y);
              assert.ok(equalRgb(current, previous) || equalRgb(current, stripe));
            }
          } else if (page.endsWith('canvas')) {
            assert.deepEqual(after, before, `${host}/${system} must preserve the App's ${page} background`);
            assert.notDeepEqual(before, card, 'Canvas control must paint its own background');
          } else {
            // Display profiles shift sampled values (#535353 can read as 73,73,73), and
            // the host and App surfaces may convert slightly differently. Compare with
            // a same-capture reference, with the tolerance the red probe also allows.
            if (page === 'opaque') {
              const reference = pixel(1, index * 40 + 1);
              assert.ok(!equalRgb(before, card) && before.every((value, channel) => Math.abs(value - reference[channel]) <= 16),
                `${host}/${system}: opaque App must paint its own background (${before} vs reference ${reference})`);
            }
            assert.ok(equalRgb(after, before) || (page !== 'opaque' && equalRgb(after, card)),
              `${host}/${system} page ${page}: ${before} -> ${after}, card ${card}`);
          }
        }
        const wrapper = contents.mainFrame.framesInSubtree.find(f => f.url.startsWith('cindy-mcp-app://after-gap/sandbox'));
        assert.equal(await wrapper.executeJavaScript('getComputedStyle(document.documentElement).colorScheme'), host);
        // Chromium versions can resolve "light dark" differently in an embedded document.
        // Recreate the reviewer's failing condition by selecting the system scheme explicitly.
        if (host !== system) {
          await wrapper.executeJavaScript(`document.documentElement.style.colorScheme='${system}'; ${settle}`);
          const mismatched = await captureChange(gapY, gap => !equalRgb(gap, card),
            'a mismatched wrapper should obscure the fallback');
          console.log(JSON.stringify({ host, system, forcedMismatchGap: mismatched(195, gapY), card }));
          await wrapper.executeJavaScript("document.documentElement.style.removeProperty('color-scheme');" + settle);
        }
        const opposite = host === 'dark' ? 'light' : 'dark';
        await contents.executeJavaScript(`
          document.documentElement.style.colorScheme='${opposite}';
          paintBackdrops();
          document.getElementById('after-gap').contentWindow.postMessage(
            {type:'cindy:sandbox-color-scheme',scheme:'${opposite}'}, 'cindy-mcp-app://after-gap');
          ${settle}`);
        assert.equal(await wrapper.executeJavaScript('document.documentElement.style.colorScheme'), opposite);
        const switched = await captureChange(gapY, (gap, nextCard) => !equalRgb(nextCard, card) && equalRgb(gap, nextCard),
          'live wrapper must expose the new card color');
        console.log(JSON.stringify({ host, system, red, switchedGap: switched(195, gapY), gapBefore: pixel(65, gapY), gapAfter: pixel(195, gapY) }));
      }
    }
  } finally {
    window.destroy();
  }
}

function equalRgb(color, other) {
  return color.every((value, index) => value === other[index]);
}

if (process.versions.electron) {
  const { app } = require('electron');
  verify(process.argv[2]).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-mcp-app-flash-'));
  try {
    await build({ absWorkingDir: desktop, entryPoints: ['src/main/mcp-apps/sandboxBridge.ts'],
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'wrapper.cjs') });
    await build({ absWorkingDir: desktop, tsconfig: 'tsconfig.json', bundle: true, format: 'iife',
      stdin: { resolveDir: desktop, contents: `
        import { findMcpAppBackdropColor } from './src/renderer/components/chat/mcpAppBackdrop';
        window.paintBackdrops = () => {
          for (const frame of document.querySelectorAll('iframe[id^="after-"]'))
            frame.style.backgroundColor = findMcpAppBackdropColor(frame.parentElement);
        };
        paintBackdrops();` }, outfile: path.join(directory, 'renderer.js') });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [fileURLToPath(import.meta.url), directory], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, windowsHide: true, stdio: 'inherit' });
      const timer = setTimeout(() => { child.kill(); reject(new Error('闪白隔离 Electron 验证超时')); }, 30_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(result, 0, '闪白隔离 Electron 验证失败');
    console.log('FLASH_BACKDROP_VERDICT=passed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
