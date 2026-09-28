#!/usr/bin/env node
// Isolated production-component layout regression; no Electron or device connections.
// Run: node apps/desktop/scripts/check-group-control-layout.mjs [Chromium executable] [screenshot directory]
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
const temp = mkdtempSync(path.join(os.tmpdir(), 'cindy-group-control-'));
const screenshots = process.argv[3];
if (screenshots) mkdirSync(screenshots, { recursive: true });
// Stub only host-facing/unrendered dependencies. The page, composer, banner,
// theme tokens and CSS are production implementations.
const stubs = {
  '@/components/chat/MarkdownRenderer': 'export const MarkdownRenderer=({content})=>content;',
  '@/contexts/dataOwnerGeneration':
    'export const getDataOwnerGeneration=()=>1;export const isDataOwnerGenerationCurrent=()=>true;export const isDataOwnerPushCurrent=()=>true;',
  '@/state/agentIslandActivity': 'export const useAgentIslandActivity=()=>null;',
  '@/lib/logger': 'export const createLogger=()=>({debug(){},info(){},warn(){},error(){}});',
  '@/lib/toast': 'export const toast={error(){},success(){}};',
  './BotGroupPendingInteraction': 'export const BotGroupPendingInteraction=()=>null;',
};
let browser;
try {
  const config = loadConfig(path.join(desktop, 'tailwind.config.ts'));
  config.content = [
    path.join(renderer, 'features/bots/*.tsx'),
    path.join(renderer, 'features/remote-device/ControlledBanner.tsx'),
    path.join(renderer, 'components/ui/*.tsx'),
    path.join(renderer, 'components/new-chat/SendButton.tsx'),
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
    entryPoints: [path.join(desktop, 'scripts/fixtures/group-control/group-control-fixture.tsx')],
    write: false,
    outfile: path.join(temp, 'group-control.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    tsconfig: path.join(desktop, 'tsconfig.json'),
    loader: { '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' },
    plugins: [
      {
        name: 'fixture-stubs',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            stubs[args.path] ? { path: args.path, namespace: 'fixture-stub' } : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: 'fixture-stub' }, (args) => ({
            contents: stubs[args.path],
            loader: 'tsx',
          }));
        },
      },
    ],
  });
  const shellCss = `
    body{margin:0;color:var(--text-primary);background:var(--surface);font-family:Inter,-apple-system,sans-serif}
    .fixture-caption{height:36px;padding:8px 16px;font-size:12px;border-bottom:1px solid var(--border-default)}
    .fixture-shell{display:flex;height:calc(100vh - 36px)}
    aside{flex-shrink:0;padding:20px;overflow:hidden;border-right:1px solid var(--border-default)}
    aside[style="width: 0px;"]{padding:0;border:0}
    .fixture-content{flex:1;min-width:0;display:flex;flex-direction:column}
    header{height:52px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 20px;border-bottom:1px solid var(--border-default)}
    .fixture-view{flex:1;min-height:0}`;
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const componentCss = bundle.outputFiles
    .filter((file) => file.path.endsWith('.css'))
    .map((file) => file.text)
    .join('');
  browser = await chromium.launch({
    headless: true,
    ...(process.argv[2] ? { executablePath: process.argv[2] } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    route.request().url().startsWith('http://fixture.local/')
      ? route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><meta charset="utf-8"><style>${css}${componentCss}${shellCss}</style><div id="root"></div><script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`,
        })
      : route.abort(),
  );
  const connect = async (connected = true, long = false) => {
    await page.evaluate(
      ({ connected, long }) =>
        window.fixturePush({
          controllers: connected
            ? [
                {
                  deviceId: 'fixture',
                  name: long
                    ? 'Mac Studio · A very long device name for layout verification'
                    : 'Mac Studio',
                },
              ]
            : [],
        }),
      { connected, long },
    );
    await page
      .locator('main [data-controlled-banner-chip]')
      .waitFor({ state: connected ? 'visible' : 'detached' });
  };
  const bottomGap = () =>
    page
      .locator('main > div')
      .first()
      .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  const collapse = async () => {
    await page.locator('[data-controlled-banner-collapse]').click();
    await page.locator('[data-controlled-banner="collapsed"]').waitFor();
    assert.equal(await page.locator('[data-controlled-banner-chip]').count(), 0);
  };
  const expand = async () => {
    await page.locator('[data-controlled-banner="collapsed"]').click();
    await page.locator('[data-controlled-banner-chip]').waitFor();
  };
  const activateWithKeyboard = async (selector, key) => {
    // Reach the notice through normal tab order, not locator.focus().
    await page.locator('textarea').focus();
    await page.keyboard.press('Shift+Tab');
    const target = page.locator(selector);
    assert(
      await target.evaluate((element) => element === document.activeElement),
      `Keyboard cannot reach ${selector}`,
    );
    assert(
      await target.evaluate(
        (element) =>
          Boolean(element.getAttribute('aria-label')) &&
          element.matches(':focus-visible') &&
          getComputedStyle(element).boxShadow !== 'none',
      ),
      `Missing accessible focus: ${selector}`,
    );
    await page.keyboard.press(key);
  };
  let layouts = 0;
  for (const theme of ['light', 'dark']) {
    for (const width of [720, 800, 1280])
      for (const sidebar of [0, 280])
        for (const lines of [1, 8]) {
          const scenario = JSON.stringify({ theme, width, sidebar, lines });
          await page.setViewportSize({ width, height: width === 800 ? 600 : 800 });
          await page.goto(
            `http://fixture.local/?theme=${theme}&sidebar=${sidebar}&stage=regression`,
          );
          await page.locator('textarea').waitFor();
          await connect(true, width === 800);
          await page
            .locator('textarea')
            .fill(Array(lines).fill('只检查布局，不发送消息。').join('\n'));
          const result = await page.evaluate(() => {
            const chip = document.querySelector('[data-controlled-banner-chip]');
            const input = document.querySelector('textarea');
            const send = input.parentElement.querySelector('button[aria-label="发送消息"]');
            const revoke = chip.querySelector('button');
            const cr = chip.getBoundingClientRect(),
              card = input.parentElement.getBoundingClientRect();
            const accessible = (element) => {
              const r = element.getBoundingClientRect();
              return element.contains(
                document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
              );
            };
            return {
              centerDelta: Math.abs(cr.x + cr.width / 2 - card.x - card.width / 2),
              noticeAbove: cr.bottom <= card.y,
              actionsAccessible: [
                input,
                send,
                revoke,
                chip.querySelector('[data-controlled-banner-collapse]'),
              ].every(accessible),
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert(result.centerDelta < 1, `Notice is not centered: ${scenario}`);
          assert(
            result.noticeAbove && result.actionsAccessible && !result.overflow,
            `Overlap/overflow: ${scenario}`,
          );
          const capture =
            screenshots &&
            sidebar === 280 &&
            ((theme === 'light' && width === 1280 && lines === 1) ||
              (theme === 'dark' && width === 720 && lines === 8));
          const imageName = `group-control-${theme}-${width === 1280 ? 'wide' : 'narrow'}`;
          if (capture) await page.screenshot({ path: path.join(screenshots, `${imageName}.png`) });
          await collapse();
          const collapsed = await page.evaluate(() => {
            const dot = document.querySelector('[data-controlled-banner="collapsed"]');
            const r = dot.getBoundingClientRect();
            const card = document.querySelector('textarea').parentElement.getBoundingClientRect();
            return {
              centerDelta: Math.abs(r.x + r.width / 2 - card.x - card.width / 2),
              above: r.bottom <= card.y,
              accessible: dot.contains(
                document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
              ),
            };
          });
          assert(
            collapsed.centerDelta < 1 && collapsed.above && collapsed.accessible,
            `Collapsed indicator misplaced or blocked: ${scenario}`,
          );
          if (capture)
            await page.screenshot({ path: path.join(screenshots, `${imageName}-collapsed.png`) });
          await expand();
          // Both native button activation keys must preserve the full UI-only cycle.
          for (const key of ['Enter', 'Space']) {
            await activateWithKeyboard('[data-controlled-banner-collapse]', key);
            await page.locator('[data-controlled-banner="collapsed"]').waitFor();
            assert.equal(await page.locator('[data-controlled-banner-chip]').count(), 0);
            await activateWithKeyboard('[data-controlled-banner="collapsed"]', key);
            await page.locator('[data-controlled-banner-chip]').waitFor();
            assert.equal(await page.locator('[data-controlled-banner="collapsed"]').count(), 0);
          }
          // Revocation remains a separate button before X in the tab order.
          await page.locator('textarea').focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Shift+Tab');
          assert(
            await page
              .locator('[data-controlled-banner-chip] button')
              .first()
              .evaluate((element) => element === document.activeElement),
            'Revoke is not separately reachable',
          );
          assert.deepEqual(
            await page.evaluate(() => window.fixtureMutations),
            [],
            `Folding/restoring invoked a host mutation: ${scenario}`,
          );
          assert.equal(await page.getByRole('dialog').count(), 0);
          layouts++;
        }
    // A real long thread: connecting changes only the scroller viewport, not content.
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(`http://fixture.local/?theme=${theme}&sidebar=280&thread=long`);
    await page.locator('textarea').waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('main > div');
      return (
        el &&
        el.scrollHeight > el.clientHeight &&
        el.scrollHeight - el.clientHeight - el.scrollTop < 1
      );
    });
    await connect();
    assert((await bottomGap()) < 1, `Connection lost bottom pin (${theme})`);
    await collapse();
    assert((await bottomGap()) < 1, `Collapse lost bottom pin (${theme})`);
    await expand();
    assert((await bottomGap()) < 1, `Expand lost bottom pin (${theme})`);
    await connect(false);
    assert((await bottomGap()) < 1, `Disconnection lost bottom pin (${theme})`);
    const scroller = page.locator('main > div').first();
    const before = await scroller.evaluate((element) => {
      element.scrollTop = 180;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      return element.scrollTop;
    });
    await connect();
    assert.equal(
      await scroller.evaluate((element) => element.scrollTop),
      before,
      `Connection jumped away from history (${theme})`,
    );
    await collapse();
    assert.equal(
      await scroller.evaluate((element) => element.scrollTop),
      before,
      `Collapse jumped away from history (${theme})`,
    );
    await expand();
    assert.equal(
      await scroller.evaluate((element) => element.scrollTop),
      before,
      `Expand jumped away from history (${theme})`,
    );
    await connect(false);
    assert.equal(
      await scroller.evaluate((element) => element.scrollTop),
      before,
      `Disconnection jumped away from history (${theme})`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${layouts} expanded/collapsed layouts with click, Tab, Enter and Space; no host mutations; bottom pin and history position survive connection and collapse changes in both themes.`,
  );
} finally {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
}
