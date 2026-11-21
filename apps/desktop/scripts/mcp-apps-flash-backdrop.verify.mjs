/**
 * Explicit Electron regression for the MCP App missing-frame backdrop.
 * The fixture uses the production sandbox document and backdrop helper, then
 * deliberately leaves a white outer iframe backing layer when its transparent
 * App child is hidden. This is the deterministic equivalent of a compositor
 * frame gap and keeps the assertion independent of GPU timing.
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
        const { app, BrowserWindow, nativeImage, protocol } = require('electron');
        const { mcpAppDirectSandboxDocument } = require(${JSON.stringify(sandboxBridge)});
        const fs = require('node:fs');
        const path = require('node:path');
        const renderer = fs.readFileSync(${JSON.stringify(path.join(temporary, 'renderer.js'))}, 'utf8');
        const profile = ${JSON.stringify(path.join(temporary, 'profile'))};
        app.setPath('userData', profile);
        app.commandLine.appendSwitch('site-per-process');
        protocol.registerSchemesAsPrivileged([{scheme:'cindy-mcp-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
        const cardColors = { light: 'rgb(245, 245, 245)', dark: 'rgb(31, 31, 30)' };
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
