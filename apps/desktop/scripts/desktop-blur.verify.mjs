/** macOS runtime verification of the production addon and backdrop dispatcher.
 * Owns an isolated Electron profile and fixture windows. If screen recording is
 * already granted, crops only the fixture from a desktop frame in memory: a
 * single-window capture substitutes a flat color for native backdrop blur.
 * Does not prompt for permissions or open a user's Cindy profile.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildDesktopBlur } from '../native/desktop-blur/build.mjs';

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('This runtime check requires macOS');
if (!process.versions.electron) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-desktop-blur-'));
  const output = path.resolve(process.argv[2] || path.join(desktop, '../../artifacts/desktop-blur-runtime'));
  try {
    buildDesktopBlur(path.join(temp, 'blur.node'));
    require('esbuild').buildSync({
      entryPoints: [path.join(desktop, 'src/main/macosDesktopBlur.ts')],
      outfile: path.join(temp, 'backdrop.cjs'), bundle: true, platform: 'node',
      format: 'cjs', external: ['electron'],
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(require('electron'), [fileURLToPath(import.meta.url), temp, output],
      { env, stdio: 'inherit', timeout: 45000 });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
} else {
  void (async () => {
  const { app, BrowserWindow, desktopCapturer, screen, systemPreferences } = require('electron');
  const temp = process.argv[2], output = process.argv[3];
  app.setPath('userData', path.join(temp, 'profile'));
  const timer = setTimeout(() => app.exit(1), 40000);
  const windows = [];
  try {
    await app.whenReady();
    const addon = require(path.join(temp, 'blur.node'));
    const { applyMacWindowBackdrop, setMacSidebarWidth } = require(path.join(temp, 'backdrop.cjs'));
    const display = screen.getPrimaryDisplay();
    const area = display.workArea;
    const bounds = { x: area.x + 60, y: area.y + 60, width: 900, height: 300 };
    const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false,
      plugins: false, navigateOnDragDrop: false };
    const back = new BrowserWindow({ ...bounds, frame: false, show: false, alwaysOnTop: true,
      webPreferences: preferences });
    windows.push(back);
    await back.loadURL('data:text/html,' + encodeURIComponent('<style>html{background:repeating-linear-gradient(90deg,#000 0px,#000 16px,#fff 16px,#fff 32px)}</style>'));
    back.showInactive();
    // Match the production window: AppKit owns the rounded titlebar/frame mask.
    const front = new BrowserWindow({ ...bounds, titleBarStyle: 'hidden', transparent: true,
      backgroundColor: '#00000000', show: false, parent: back, alwaysOnTop: true,
      webPreferences: preferences });
    windows.push(front);
    await front.loadURL('data:text/html,' + encodeURIComponent('<style>body{margin:0;background:transparent}p{color:red;font:700 26px sans-serif;margin:110px 24px}</style><p>Sharp foreground — desktop blur verification</p>'));
    front.showInactive();
    const trace = [];
    const sidebarTrace = [];
    const native = { setSidebar(handle, width, dark) {
      const ok = addon.setSidebar(handle, width, dark);
      sidebarTrace.push({ width, dark, ok });
      assert.equal(ok, true, `native sidebar width ${width} accepted`);
      return ok;
    }, apply(handle, radius) {
      const ok = addon.apply(handle, radius);
      trace.push({ radius, ok });
      assert.equal(ok, true, `native radius ${radius} accepted`);
      return ok;
    } };
    assert.throws(() => addon.apply(front.getNativeWindowHandle(), -1));
    assert.throws(() => addon.apply(front.getNativeWindowHandle(), NaN));
    assert.equal(addon.apply(Buffer.alloc(8), 5), false);
    const canCapture = systemPreferences.getMediaAccessStatus('screen') === 'granted';
    const contrast = [];
    fs.mkdirSync(output, { recursive: true });
    for (const radius of [0, 5, 20, 0, 5]) {
      applyMacWindowBackdrop(front, { vibrancy: radius > 0 ? 'under-window' : null,
        backgroundColor: '#00000000', desktopBlurRadius: radius }, () => native);
      await new Promise(resolve => setTimeout(resolve, 700));
      if (canCapture) {
        const sources = await desktopCapturer.getSources({ types: ['screen'],
          thumbnailSize: { width: display.size.width * display.scaleFactor,
            height: display.size.height * display.scaleFactor } });
        const source = sources.find(item => item.display_id === String(display.id));
        assert(source && !source.thumbnail.isEmpty(), 'desktop frame available');
        const size = source.thumbnail.getSize();
        const sx = size.width / display.bounds.width, sy = size.height / display.bounds.height;
        const crop = source.thumbnail.crop({
          x: Math.round((bounds.x - display.bounds.x) * sx),
          y: Math.round((bounds.y - display.bounds.y) * sy),
          width: Math.round(bounds.width * sx), height: Math.round(bounds.height * sy),
        });
        fs.writeFileSync(path.join(output, `${trace.length}-radius-${radius}.png`), crop.toPNG());
        const pixels = crop.toBitmap(), width = crop.getSize().width;
        const row = Math.round(50 * sy);
        const values = [];
        for (let x = Math.round(80 * sx); x < Math.round(820 * sx); x++) values.push(pixels[(row * width + x) * 4]);
        const mean = values.reduce((a,b) => a+b, 0) / values.length;
        contrast.push(Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length));
      }
    }
    // Removing the canvas override clears a previous radius on the same native window.
    applyMacWindowBackdrop(front, { vibrancy: null, backgroundColor: '#ffffff' }, () => native);
    assert.equal(trace.at(-1).radius, 0);
    // The sidebar has a material even when the shared background is clear.
    const sidebarConfig = { vibrancy: null, backgroundColor: '#00000000', desktopBlurRadius: 0, sidebarMaterial: 'light' };
    applyMacWindowBackdrop(front, sidebarConfig, () => native);
    for (const width of [260, 78, 0, 300]) setMacSidebarWidth(front, width, () => native);
    applyMacWindowBackdrop(front, { ...sidebarConfig, sidebarMaterial: 'dark', desktopBlurRadius: 20 }, () => native);
    front.setSize(960, 340);
    setMacSidebarWidth(front, 280, () => native);
    applyMacWindowBackdrop(front, { vibrancy: null, backgroundColor: '#ffffff' }, () => native);
    assert.equal(sidebarTrace.at(-1).width, 0);
    assert.throws(() => addon.setSidebar(front.getNativeWindowHandle(), -1, false));
    assert.equal(addon.setSidebar(Buffer.alloc(8), 260, false), false);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ trace, sidebarTrace, canCapture, contrast }, null, 2));
    console.log(JSON.stringify({ trace, sidebarTrace, canCapture, contrast }));
    if (canCapture) {
      assert(contrast[0] > contrast[1] + 10, '5 softens the stripe edges');
      assert(contrast[1] > contrast[2] + 10, '20 is more blurred than 5');
      assert(Math.abs(contrast[0] - contrast[3]) < 10, 'zero restores clear transparency');
      assert(Math.abs(contrast[1] - contrast[4]) < 10, 'blur works again after zero');
      console.log('DESKTOP_BLUR_VISUAL_VERIFIED');
    } else console.log('DESKTOP_BLUR_NATIVE_CALLS_ONLY: screen recording not granted; no prompt requested');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const window of windows.reverse()) if (!window.isDestroyed()) window.destroy();
    clearTimeout(timer);
    app.exit(process.exitCode || 0);
  }
  })();
}
