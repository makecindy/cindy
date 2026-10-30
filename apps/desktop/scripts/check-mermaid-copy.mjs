#!/usr/bin/env node
/* global process, URL, window, Image, Blob, document, Buffer, console */
// Real production components + Mermaid + browser decoding/canvas. Only the
// native clipboard sink is replaced. No Electron, account, disk media or network.
// node apps/desktop/scripts/check-mermaid-copy.mjs [Chromium path] [source file] [evidence directory]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig.js';
import { chromium } from 'playwright-core';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = path.join(desktop, 'src/renderer');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cindy-mermaid-copy-'));
const sourceOverride = process.argv[3] ? readFileSync(process.argv[3], 'utf8').trim() : undefined;
const evidence = process.argv[4];
if (evidence) mkdirSync(evidence, { recursive: true });
let browser;
try {
  const config = loadConfig(path.join(desktop, 'tailwind.config.ts'));
  config.content = [
    path.join(renderer, 'components/chat/*.tsx'),
    path.join(renderer, 'components/ui/*.tsx'),
  ];
  const css = (
    await postcss([tailwind(config)]).process(
      readFileSync(path.join(renderer, 'styles/generated/tokens.css'), 'utf8') +
        '\n' +
        readFileSync(path.join(renderer, 'styles/globals.css'), 'utf8').replace(
          /^@import.*$/gm,
          '',
        ),
      { from: undefined },
    )
  ).css;
  const bundle = await esbuild.build({
    entryPoints: [path.join(desktop, 'scripts/fixtures/mermaid-copy/mermaid-copy-fixture.tsx')],
    write: false,
    outfile: path.join(temp, 'mermaid-copy.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    tsconfig: path.join(desktop, 'tsconfig.json'),
    loader: {
      '.svg': 'dataurl',
      '.png': 'dataurl',
      '.woff2': 'dataurl',
      '.woff': 'dataurl',
      '.ttf': 'dataurl',
    },
    define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' },
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const styles =
    css +
    bundle.outputFiles
      .filter((file) => file.path.endsWith('.css'))
      .map((file) => file.text)
      .join('\n');
  browser = await chromium.launch({
    headless: true,
    ...(process.argv[2] ? { executablePath: process.argv[2] } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // This is stricter than production network policy; same data: image allowance,
  // no inline scripts and no bypassCSP / disable-web-security / clipboard grants.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://fixture.local') return route.abort();
    if (url.pathname === '/mermaid-copy.js')
      return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/mermaid-copy.css')
      return route.fulfill({ contentType: 'text/css', body: styles });
    return route.fulfill({
      contentType: 'text/html',
      headers: {
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'",
      },
      body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/mermaid-copy.css"><style>body{margin:24px;background:var(--surface);color:var(--text-primary);font-family:var(--app-font-ui-default)}</style><div id="root"></div><div id="editor"></div><script type="module" src="/mermaid-copy.js"></script>',
    });
  });
  await page.goto('http://fixture.local/');
  await page.waitForFunction(() => Boolean(window.fixture));
  const raw = sourceOverride ?? (await page.evaluate(() => window.fixture.source));
  const diagram = '#root svg[viewBox]:not([class*="lucide"])';
  const label = (key) => page.evaluate((k) => window.fixture.label(k), key);
  async function mount(simplified = false, dark = false, locale = 'zh-CN') {
    await page.evaluate((args) => window.fixture.render(...args), [raw, simplified, dark, locale]);
    await page.waitForSelector(`${diagram} .nodes foreignObject`);
  }
  async function copyCount(count) {
    await page.waitForFunction(
      (expected) =>
        window.fixture.copies.length === expected ||
        window.fixture.getToastSnapshot().some((item) => !item.exiting && item.variant === 'error'),
      count,
    );
    assert.equal(
      await page.evaluate(() => window.fixture.copies.length),
      count,
      'The production copy button must reach the native sink without a failure toast',
    );
  }
  async function validatePng(selector, copyIndex = 0) {
    const result = await page.evaluate(
      async ({ selector, copyIndex }) => {
        const { png, plainText } = window.fixture.copies[copyIndex];
        const image = new Image();
        const url = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: 'image/png' }));
        try {
          image.src = url;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(image, 0, 0);
          const svg = document.querySelector(selector);
          const svgRect = svg.getBoundingClientRect();
          // Each HTML label's interior must contain actual rendered glyphs, not
          // just an empty rectangle. Compare pixel variation inside its bounds.
          const labelPixels = [...svg.querySelectorAll('.nodes foreignObject')].map((node) => {
            const r = node.getBoundingClientRect();
            const x = Math.max(
              0,
              Math.floor(((r.left - svgRect.left) / svgRect.width) * canvas.width),
            );
            const y = Math.max(
              0,
              Math.floor(((r.top - svgRect.top) / svgRect.height) * canvas.height),
            );
            const w = Math.max(1, Math.floor((r.width / svgRect.width) * canvas.width));
            const h = Math.max(1, Math.floor((r.height / svgRect.height) * canvas.height));
            const pixels = ctx.getImageData(x, y, w, h).data;
            let varied = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (
                Math.abs(pixels[i] - pixels[0]) +
                  Math.abs(pixels[i + 1] - pixels[1]) +
                  Math.abs(pixels[i + 2] - pixels[2]) >
                60
              )
                varied++;
            }
            return varied;
          });
          return {
            signature: png.slice(0, 8),
            bytes: png.length,
            width: canvas.width,
            height: canvas.height,
            labelPixels,
            plainText,
          };
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      { selector, copyIndex },
    );
    assert.deepEqual(result.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
    assert(result.bytes > 1000);
    assert(result.width > 100 && result.height > 100);
    assert(result.width <= 4096 && result.height <= 4096);
    assert(
      result.labelPixels.length >= 5 && result.labelPixels.every((count) => count > 20),
      JSON.stringify(result),
    );
    assert.equal(result.plainText, selector.startsWith('#editor') ? raw : raw + '\n');
    return result;
  }
  const results = [];
  for (const simplified of [false, true]) {
    for (const dark of [false, true]) {
      await mount(simplified, dark);
      // Independent control: the old raw HTML-as-SVG algorithm fails before
      // clipboard access. No mocked Mermaid/image/canvas success path.
      const oldFailure = await page.evaluate(async (selector) => {
        const rawSvg = document.querySelector(selector).outerHTML;
        const image = new Image();
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rawSvg)}`;
        try {
          await image.decode();
          return null;
        } catch (error) {
          return error.name;
        }
      }, diagram);
      assert.equal(oldFailure, 'EncodingError');
      await page
        .getByRole('button', { name: await label('chat.mermaid.copy'), exact: true })
        .click();
      await copyCount(1);
      const png = await validatePng(diagram);
      await page
        .getByRole('button', { name: await label('chat.mermaid.copied'), exact: true })
        .waitFor();
      await page.locator(diagram).click({ button: 'right' });
      await page
        .getByRole('menuitem', { name: await label('chat.media.copyImage'), exact: true })
        .click();
      await copyCount(2);
      await page.getByRole('menuitem').waitFor({ state: 'hidden' });
      await validatePng(diagram, 1);
      if (evidence && simplified) {
        const suffix = dark ? 'dark' : 'light';
        await page.screenshot({ path: path.join(evidence, `mermaid-panel-${suffix}.png`) });
        const bytes = await page.evaluate(() => window.fixture.copies[0].png);
        writeFileSync(path.join(evidence, `mermaid-export-${suffix}.png`), Buffer.from(bytes));
      }
      await page
        .getByRole('button', { name: await label('chat.mermaid.zoom'), exact: true })
        .click();
      await page
        .getByRole('button', { name: await label('chat.mermaid.copy'), exact: true })
        .last()
        .click();
      await copyCount(3);
      await validatePng(diagram, 2);
      results.push({
        simplified,
        dark,
        bytes: png.bytes,
        size: [png.width, png.height],
        labelPixels: png.labelPixels,
      });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.body.style.overflow !== 'hidden');
    }
  }
  // Native failures remain localized, never become false copied feedback.
  for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
    await mount(true, false, locale);
    await page.evaluate(() => window.fixture.setRejectCopy(true));
    await page.getByRole('button', { name: await label('chat.mermaid.copy'), exact: true }).click();
    await page.waitForFunction(() =>
      window.fixture
        .getToastSnapshot()
        .some(
          (item) => !item.exiting && item.message === window.fixture.label('ipcError.INTERNAL'),
        ),
    );
    assert.equal(await page.evaluate(() => window.fixture.copies.length), 0);
    assert.equal(
      await page
        .getByRole('button', { name: await label('chat.mermaid.copied'), exact: true })
        .count(),
      0,
    );
    assert(
      await page.evaluate(() =>
        window.fixture.logs.some((entry) => String(entry[2]).includes('"stage":"clipboard"')),
      ),
    );
  }
  await mount();
  await page.evaluate(() => window.fixture.setDecodeFailure(true));
  await page.getByRole('button', { name: await label('chat.mermaid.copy'), exact: true }).click();
  await page.waitForFunction(() =>
    window.fixture
      .getToastSnapshot()
      .some(
        (item) => !item.exiting && item.message === window.fixture.label('chat.media.copyFailed'),
      ),
  );
  assert.equal(await page.evaluate(() => window.fixture.copies.length), 0);
  assert(
    await page.evaluate(() =>
      window.fixture.logs.some((entry) => String(entry[2]).includes('"stage":"rasterize"')),
    ),
  );
  await page.evaluate(() => window.fixture.setDecodeFailure(false));
  // The third shared consumer: actual CodeMirror Mermaid preview toolbar.
  await mount();
  await page.evaluate((raw) => window.fixture.renderEditor(raw), raw);
  await page.waitForSelector('#editor svg .nodes foreignObject');
  await page
    .locator('#editor')
    .getByRole('button', {
      name: await label('ccAgent.workdirBrowse.mermaidEditor.toolbarCopy'),
      exact: true,
    })
    .click();
  await copyCount(1);
  await validatePng('#editor svg[viewBox]:not([class*="lucide"])');
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        browser: browser.version(),
        results,
        localizedFailures: 5,
        rasterizeFailure: true,
        editorCopy: true,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
}
