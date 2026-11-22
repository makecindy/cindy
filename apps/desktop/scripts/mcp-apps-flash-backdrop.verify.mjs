/**
 * Explicit Electron regression for the MCP App missing-frame backdrop.
 * The fixture uses the production sandbox document and backdrop helper, then
 * deliberately leaves a white outer iframe backing layer when its transparent
 * App child is hidden. This is the deterministic equivalent of a compositor
 * frame gap and keeps the assertion independent of GPU timing.
 *
 * Compatibility coverage uses the same production sandbox document with a
 * legacy wrapper (without the new color-scheme declaration). It compares the
 * final card pixels for single-scheme and opaque App pages in both themes.
 * A transparent page is used for the reverse wrapper mutation in the light
 * theme. This does not claim to reproduce a real Mac compositor gap.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '../..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-mcp-app-flash-backdrop-'));
const helper = path.resolve(scriptDir, '../src/renderer/components/chat/mcpAppBackdrop.ts');
const sandboxBridge = path.resolve(scriptDir, '../src/main/mcp-apps/sandboxBridge.ts');

try {
  const renderer = await build({
    bundle: true,
    write: false,
    format: 'iife',
    stdin: {
      resolveDir: root,
      contents: `
        import { findMcpAppBackdropColor } from ${JSON.stringify(helper)};
        window.paintMcpAppBackdrop = () => {
          const card = document.querySelector('#card');
          const frame = document.querySelector('#frame');
          frame.style.backgroundColor = findMcpAppBackdropColor(card);
        };
      `,
    },
  });
  const main = await build({
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    stdin: {
      resolveDir: root,
      contents: `
        const assert = require('node:assert/strict');
        const { app, BrowserWindow, nativeImage, nativeTheme, protocol } = require('electron');
        const { mcpAppDirectSandboxDocument } = require(${JSON.stringify(sandboxBridge)});
        const fs = require('node:fs');
        const path = require('node:path');
        const renderer = fs.readFileSync(${JSON.stringify(path.join(temporary, 'renderer.js'))}, 'utf8');
        const profile = ${JSON.stringify(path.join(temporary, 'profile'))};
        app.setPath('userData', profile);
        app.commandLine.appendSwitch('site-per-process');
        protocol.registerSchemesAsPrivileged([{scheme:'cindy-mcp-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
        const cardColors = { light: 'rgb(245, 245, 245)', dark: 'rgb(31, 31, 30)' };
        const compatibilityPages = {
          transparent: '<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;background:transparent}</style></head><body><main style="width:100%;height:100%;background:transparent"></main></body></html>',
          light: '<!doctype html><html><head><style>:root{color-scheme:light}html,body{margin:0;width:100%;height:100%;background:Canvas}</style></head><body><main style="width:100%;height:100%;background:Canvas"></main></body></html>',
          dark: '<!doctype html><html><head><style>:root{color-scheme:dark}html,body{margin:0;width:100%;height:100%;background:Canvas}</style></head><body><main style="width:100%;height:100%;background:Canvas"></main></body></html>',
          opaque: '<!doctype html><html><head></head><body style="margin:0;width:100%;height:100%;background:rgb(12, 34, 56)"><main style="width:100%;height:100%;background:inherit"></main></body></html>',
        };
        const compatibilityWrapper = (resourceUrl, bridgeUrl, kind) => {
          let html = mcpAppDirectSandboxDocument(resourceUrl, bridgeUrl);
          if (kind === 'legacy') html = html.replace(':root{color-scheme:light dark}', '');
          if (kind === 'opaque') html = html.replace('background:transparent', 'background:rgb(255,255,255)');
          return html;
        };
        const pixelAt = (image, x, y) => {
          const bitmap = image.toBitmap();
          const offset = (y * image.getSize().width + x) * 4;
          return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset], bitmap[offset + 3]];
        };
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        app.whenReady().then(async () => {
          protocol.handle('cindy-mcp-app', request => {
            const url = new URL(request.url);
            if (url.pathname === '/sandbox') {
              return new Response(mcpAppDirectSandboxDocument('cindy-mcp-app://flash-view/resource?missing=1', 'cindy-mcp-app://flash-view/bridge'), {headers:{'content-type':'text/html'}});
            }
            if (url.pathname === '/resource') {
              return new Response('<!doctype html><html><body style="margin:0;background:transparent"><main style="height:100%;background:transparent"></main><script>document.documentElement.style.visibility="hidden"</script></body></html>', {headers:{'content-type':'text/html'}});
            }
            if (url.pathname === '/compat-sandbox') {
              const variant = url.searchParams.get('variant') || 'transparent';
              const kind = url.searchParams.get('wrapper') || 'current';
              const resource = 'cindy-mcp-app://flash-view/compat-resource?variant=' + encodeURIComponent(variant);
              return new Response(compatibilityWrapper(resource, 'cindy-mcp-app://flash-view/bridge', kind), {headers:{'content-type':'text/html'}});
            }
            if (url.pathname === '/compat-resource') {
              const page = compatibilityPages[url.searchParams.get('variant')] || compatibilityPages.transparent;
              return new Response(page, {headers:{'content-type':'text/html'}});
            }
            if (url.pathname === '/bridge') return new Response('[]', {headers:{'content-type':'application/json'}});
            return new Response('not found', {status:404});
          });
          const window = new BrowserWindow({
            show: false,
            width: 220,
            height: 180,
            backgroundColor: '#1f1f1e',
            webPreferences: { contextIsolation: true, sandbox: true },
          });
          const html = '<!doctype html><html><body style="margin:0;width:220px;height:180px;background:transparent"><div id="card" style="position:absolute;left:20px;top:20px;width:180px;height:140px;overflow:hidden"><iframe id="frame" title="MCP App" style="width:100%;height:100%;display:block;border:0;background-color:rgb(255,255,255)" src="cindy-mcp-app://flash-view/sandbox"></iframe></div><script>'+renderer.replace(/<\\/script/gi, '<\\\\/script')+'</script></body></html>';
          await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
          await wait(300);
          for (const theme of ['light', 'dark']) {
            const color = cardColors[theme];
            await window.webContents.executeJavaScript('document.querySelector("#card").style.backgroundColor=' + JSON.stringify(color) + ';document.querySelector("#frame").style.backgroundColor="rgb(255,255,255)"');
            await wait(40);
            const baseline = await window.webContents.capturePage({x:0,y:0,width:220,height:180});
            const baselinePixel = pixelAt(baseline, 110, 90);
            assert.deepEqual(baselinePixel.slice(0, 3), [255, 255, 255], theme + ' baseline must expose the simulated missing-frame white backing');
            await window.webContents.executeJavaScript('window.paintMcpAppBackdrop(); new Promise(resolve => requestAnimationFrame(() => resolve()))');
            // Wait for the outer iframe compositor surface to consume the style
            // mutation before capturing.  The conformance suite runs several
            // Electron fixtures back-to-back, where one animation frame can
            // precede the surface commit even though the DOM style is updated.
            await wait(50);
            const fixed = await window.webContents.capturePage({x:0,y:0,width:220,height:180});
            const fixedPixel = pixelAt(fixed, 110, 90);
            const expected = theme === 'light' ? [245, 245, 245] : [31, 31, 30];
            assert.deepEqual(fixedPixel.slice(0, 3), expected, theme + ' fixed backdrop must match the card');
            console.log('FLASH_BACKDROP theme=' + theme + ' baseline=' + JSON.stringify(baselinePixel) + ' fixed=' + JSON.stringify(fixedPixel));
          }
          /*
           * 测试价值
           * - 生产入口与结果：sandboxBridge 生成的包装页加载真实跨源 App iframe，最终卡片像素可见。
           * - Bug／规则依据：包装页新增 color-scheme 不得改变存量插件页面的最终背景（插件兼容红线）。
           * - 现有覆盖缺口：单测只能检查字符串和 iframe 样式，不能观察嵌套 browsing context 的 UA 背景。
           * - 最小失败输入与 tier：透明页、只声明 light/dark、显式不透明 body，Light/Dark integration。
           */
          const compatibilityWindow = new BrowserWindow({
            show: false,
            width: 220,
            height: 180,
            backgroundColor: '#1f1f1e',
            webPreferences: { contextIsolation: true, sandbox: true },
          });
          const compatibilityPage = (wrapper, variant, theme) => '<!doctype html><html><body style="margin:0;width:220px;height:180px;background:transparent"><div id="compat-card" style="position:absolute;left:20px;top:20px;width:180px;height:140px;overflow:hidden;background-color:' + cardColors[theme] + '"><iframe style="width:100%;height:100%;display:block;border:0" src="cindy-mcp-app://flash-view/compat-sandbox?wrapper=' + wrapper + '&variant=' + variant + '"></iframe></div></body></html>';
          const compatibilityPixel = async (wrapper, variant, theme) => {
            nativeTheme.themeSource = theme;
            await compatibilityWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(compatibilityPage(wrapper, variant, theme)));
            await wait(200);
            const image = await compatibilityWindow.webContents.capturePage({x:0,y:0,width:220,height:180});
            return pixelAt(image, 110, 90);
          };
          for (const theme of ['light', 'dark']) {
            for (const variant of ['light', 'dark', 'opaque']) {
              const legacyPixel = await compatibilityPixel('legacy', variant, theme);
              const currentPixel = await compatibilityPixel('current', variant, theme);
              assert.deepEqual(currentPixel.slice(0, 3), legacyPixel.slice(0, 3), theme + ' ' + variant + ' page changed after wrapper color-scheme');
              console.log('FLASH_BACKDROP_COMPAT theme=' + theme + ' variant=' + variant + ' legacy=' + JSON.stringify(legacyPixel) + ' current=' + JSON.stringify(currentPixel));
            }
            if (theme === 'light') {
              const currentTransparent = await compatibilityPixel('current', 'transparent', theme);
              const intentionallyOpaque = await compatibilityPixel('opaque', 'transparent', theme);
              assert.notDeepEqual(intentionallyOpaque.slice(0, 3), currentTransparent.slice(0, 3), theme + ' reverse wrapper mutation must be detected');
            }
          }
          await compatibilityWindow.destroy();
          await window.destroy();
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `,
    },
  });
  await writeFile(path.join(temporary, 'renderer.js'), renderer.outputFiles[0].text, 'utf8');
  await writeFile(path.join(temporary, 'verify.cjs'), main.outputFiles[0].text, 'utf8');
  const electron = createRequire(import.meta.url)('electron');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(temporary, 'verify.cjs')], {
      env: {...process.env, ELECTRON_RUN_AS_NODE: undefined},
      windowsHide: true,
      stdio: 'inherit',
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('闪白隔离 Electron 验证超时。')); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, '闪白隔离 Electron 验证失败');
  console.log('FLASH_BACKDROP_VERDICT=passed (production sandbox wrapper, transparent App child, baseline mutation, Light/Dark pixels)');
} finally {
  await rm(temporary, {recursive: true, force: true});
}
