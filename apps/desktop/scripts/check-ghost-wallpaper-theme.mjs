#!/usr/bin/env node
// Run: node apps/desktop/scripts/check-ghost-wallpaper-theme.mjs
// Browser integration regression for PR #8471: jsdom cannot resolve CSS variables,
// so its off -> on -> off comparison could accept the wrong initial theme color.
// Exercise the production injector and observer in separate host/guest documents;
// assert concrete light/dark canvas and control colors, not an unchecked baseline.
// Also cover ordinary author background-image rules: a host background shorthand
// used to erase them on every injection, despite the main-view image contract.
// Uses the installed Electron in a hidden, isolated profile; no network or user data.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import electron from 'electron';
import { _electron } from 'playwright-core';

const started = performance.now();
const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-ghost-theme-'));
let app;
try {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/renderer/cindy-brain/ghostPanelTheme.ts', import.meta.url))],
    bundle: true, write: false, format: 'iife', globalName: 'ghostTheme',
  });
  const entry = path.join(temp, 'main.cjs');
  await writeFile(entry, `
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
    app.whenReady().then(() => {
      app.dock?.hide();
      const win = new BrowserWindow({ show: false, webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
        webSecurity: true, allowRunningInsecureContent: false,
        experimentalFeatures: false, plugins: false, navigateOnDragDrop: false
      }});
      win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({cancel: !details.url.startsWith('about:')}));
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.loadURL('about:blank');
    });
    app.on('window-all-closed', () => app.quit());
  `, 'utf8');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: electron, args: [entry], env });
  const page = await app.firstWindow();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const theme of [
    { scheme: 'light', surface: '#f2f2ed', elevated: '#ffffff', canvas: 'rgb(242, 242, 237)', control: 'rgb(255, 255, 255)' },
    { scheme: 'dark', surface: '#181818', elevated: '#303030', canvas: 'rgb(24, 24, 24)', control: 'rgb(48, 48, 48)' },
  ]) {
    const result = await page.evaluate(async ({ scheme, surface, elevated }) => {
      const root = document.documentElement;
      root.style.cssText = `color-scheme:${scheme};--surface:${surface};--panel-bg:var(--surface);--surface-elevated:${elevated}`;
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const guest = frame.contentWindow;
      guest.document.head.innerHTML = `<style>
        html {background:var(--surface)}
        body {background-image:linear-gradient(rgb(10, 20, 30), rgb(40, 50, 60));background-size:12px 24px;background-repeat:no-repeat}
        input {background:var(--surface-elevated)}
      </style>`;
      guest.document.body.innerHTML = '<input>';
      let id = 0;
      const styles = new Map();
      const injector = ghostTheme.createGhostThemeInjector({
        async insertCSS(css) {
          const style = guest.document.createElement('style');
          style.textContent = css;
          guest.document.head.append(style);
          const key = String(++id);
          styles.set(key, style);
          return key;
        },
        async removeInsertedCSS(key) { styles.get(key)?.remove(); styles.delete(key); },
      }, ghostTheme.buildGhostMainViewThemeCss);
      const unobserve = ghostTheme.observeHostTheme(injector.inject);
      const settle = () => new Promise(resolve => setTimeout(resolve, 0));
      const colors = () => [guest.document.documentElement, guest.document.body, guest.document.querySelector('input')]
        .map(element => guest.getComputedStyle(element).backgroundColor);
      const artwork = () => {
        const style = guest.getComputedStyle(guest.document.body);
        return [style.backgroundImage, style.backgroundSize, style.backgroundRepeat];
      };
      try {
        injector.onDomReady();
        await settle();
        const off = colors();
        const artworkOff = artwork();
        root.setAttribute('data-wallpaper-active', 'true');
        await settle();
        const on = colors();
        const artworkOn = artwork();
        root.removeAttribute('data-wallpaper-active');
        await settle();
        return { off, on, restored: colors(), artwork: [artworkOff, artworkOn, artwork()], styles: styles.size };
      } finally {
        unobserve();
        injector.dispose();
        frame.remove();
        root.removeAttribute('data-wallpaper-active');
        root.removeAttribute('style');
      }
    }, theme);
    assert.deepEqual(result.off, [theme.canvas, theme.canvas, theme.control], `${theme.scheme}: initial theme colors`);
    assert.deepEqual(result.on, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', theme.control], `${theme.scheme}: wallpaper canvas and opaque control`);
    assert.deepEqual(result.restored, [theme.canvas, theme.canvas, theme.control], `${theme.scheme}: restored theme colors`);
    for (const artwork of result.artwork) {
      assert.deepEqual(artwork, [
        'linear-gradient(rgb(10, 20, 30), rgb(40, 50, 60))', '12px 24px', 'no-repeat',
      ], `${theme.scheme}: author background image and layout survive every wallpaper state`);
    }
    assert.equal(result.styles, 1, `${theme.scheme}: stale injected styles removed`);
    console.log(`PASS ${theme.scheme}: concrete canvas/control colors across off -> on -> off`);
  }
} finally {
  try { if (app) await app.close(); }
  finally { await rm(temp, { recursive: true, force: true }); }
}
console.log(`Ghost wallpaper browser regression passed in ${((performance.now() - started) / 1000).toFixed(2)}s`);
