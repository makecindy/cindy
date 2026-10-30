#!/usr/bin/env node
// Real Chromium drag gestures against production sorting components and CSS.
// Run: node apps/desktop/scripts/check-pinned-native-drag.mjs <Chromium executable>
// Add --stylesheet-ref=<pre-fix commit> to demonstrate the CSS regression.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig.js';
import { chromium } from 'playwright-core';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '../..');
const renderer = path.join(desktop, 'src/renderer');
const fixture = path.join(desktop, 'scripts/fixtures/pinned-native-drag.tsx');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cindy-pinned-native-drag-'));
const stylesheetRef = process.argv
  .find((arg) => arg.startsWith('--stylesheet-ref='))
  ?.split('=')[1];
let browser;

try {
  const config = loadConfig(path.join(desktop, 'tailwind.config.ts'));
  config.content = [
    fixture,
    path.join(renderer, 'components/sidebar/SortableList.tsx'),
    path.join(renderer, 'features/cc-agent/sidebar/{CardMasonry,DraggableCardColumns}.tsx'),
  ];
  const globals = stylesheetRef
    ? execFileSync(
        'git',
        ['show', `${stylesheetRef}:apps/desktop/src/renderer/styles/globals.css`],
        { cwd: root, encoding: 'utf8' },
      )
    : readFileSync(path.join(renderer, 'styles/globals.css'), 'utf8');
  const css = (
    await postcss([tailwind(config)]).process(
      readFileSync(path.join(renderer, 'styles/generated/tokens.css'), 'utf8') +
        '\n' +
        globals.replace(/^@import.*$/gm, ''),
      { from: undefined },
    )
  ).css;
  const bundle = await esbuild.build({
    entryPoints: [fixture],
    bundle: true,
    write: false,
    outfile: path.join(temp, 'fixture.js'),
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    tsconfig: path.join(desktop, 'tsconfig.json'),
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  });
  const script = bundle.outputFiles[0].text;
  browser = await chromium.launch({
    headless: true,
    ...(process.argv[2] && !process.argv[2].startsWith('--')
      ? { executablePath: process.argv[2] }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    route.request().url().startsWith('http://fixture.local/')
      ? route.fulfill({
          contentType: 'text/html',
          body:
            '<!doctype html><html><head><meta charset="utf-8">' +
            `<style>${css}</style></head><body><main id="root"></main><script>${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`,
        })
      : route.abort(),
  );

  const buckets = () =>
    page
      .getByTestId('pins')
      .locator('[data-sortable-native-dnd]')
      .evaluateAll((lists) =>
        lists.map((list) =>
          Array.from(list.children).map(
            (row) => row.getAttribute('data-sortable-id') ?? row.getAttribute('data-card-id'),
          ),
        ),
      );
  async function drag(source, target, finish = 'inside') {
    const before = await buckets();
    const a = await source.boundingBox();
    const b = await target.boundingBox();
    assert(a && b, 'drag endpoints must be visible');
    const x = a.x + Math.min(32, a.width / 2),
      y = a.y + a.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 10, y, { steps: 5 });
    await page.mouse.move(b.x + Math.min(32, b.width / 2), b.y + b.height / 2, { steps: 20 });
    await page.waitForTimeout(180); // Allow Sortable's native dragover loop to settle.
    if (finish !== 'inside') {
      assert.notDeepEqual(await buckets(), before, 'cancellation must follow a temporary DOM move');
      if (finish === 'escape') await page.keyboard.press('Escape');
      else {
        const outside = await page.getByTestId('outside').boundingBox();
        await page.mouse.move(outside.x + outside.width / 2, outside.y + outside.height / 2, {
          steps: 10,
        });
      }
    }
    await page.mouse.up();
    if (finish !== 'inside') {
      assert.deepEqual(await buckets(), before, 'cancelled/external drops must restore the DOM');
    }
  }
  const order = async () => JSON.parse(await page.getByTestId('order').textContent());
  const initial = ['project-a', 'task', 'project-b', 'project-c'];
  for (const theme of ['light', 'dark']) {
    let textRowHeight;
    for (const [mode, columns] of [
      ['text', 1],
      ['list', 1],
      ['card', 1],
      ['card', 2],
      ['card', 3],
    ]) {
      const url = `http://fixture.local/?theme=${theme}&mode=${mode}&columns=${columns}`;
      await page.goto(url);
      await page.getByTestId('order').waitFor();
      const rowHeight = (await page.getByTestId('task').boundingBox()).height;
      const preview = page.getByTestId('task-preview');
      if (mode === 'text') {
        assert.equal(await preview.count(), 0, 'compact text rows must not have a preview');
        textRowHeight = rowHeight;
      } else {
        assert.equal(await preview.textContent(), 'Latest task message preview');
        if (mode === 'list') {
          assert(rowHeight > textRowHeight, 'list rows must include a separate preview line');
        }
      }
      const title = page.getByTestId('project-a-title');
      await drag(title, page.getByTestId('project-c-title'));
      await page.waitForFunction(
        () => Number(document.querySelector('[data-testid="writes"]').textContent) > 0,
      );
      assert.notDeepEqual(
        await order(),
        initial,
        `${theme}/${mode}/${columns}: project must reorder`,
      );

      await page.goto(url);
      await drag(
        page.getByTestId(mode === 'text' ? 'task-title' : 'task-preview'),
        page.getByTestId('project-c-title'),
      );
      await page.waitForFunction(
        () => Number(document.querySelector('[data-testid="writes"]').textContent) > 0,
      );
      assert.notEqual(
        (await order()).indexOf('task'),
        initial.indexOf('task'),
        `${theme}/${mode}/${columns}: task title/preview must start a reorder`,
      );

      await page.goto(url);
      await page
        .getByTestId('project-a')
        .getByRole('button', { name: 'Action', exact: true })
        .click();
      assert.equal(await page.getByTestId('clicks').textContent(), '1');
      await page.getByRole('textbox', { name: 'project-a rename' }).fill('Edited');
      await drag(page.getByTestId('project-a-child'), page.getByTestId('project-c-title'));
      assert.deepEqual(await order(), initial, 'child rows must not reorder the project');
      assert.equal(await page.getByTestId('writes').textContent(), '0');

      // First move through the list, then leave it; the temporary move must not save.
      await drag(title, page.getByTestId('project-c-title'), 'escape');
      assert.deepEqual(await order(), initial, 'Escape must restore the original order');
      assert.equal(await page.getByTestId('writes').textContent(), '0');
      await drag(title, page.getByTestId('project-c-title'), 'outside');
      assert.deepEqual(await order(), initial, 'outside drops must not save');
      assert.equal(await page.getByTestId('writes').textContent(), '0');
      console.log(
        `PASS ${theme}/${mode}/${columns}: row structure, project/task reorder, controls, child boundary, Escape, outside drop`,
      );
    }
  }
  assert.deepEqual(errors, [], 'browser page errors');
} finally {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
}
