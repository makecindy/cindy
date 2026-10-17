#!/usr/bin/env node
// Isolated production-component layout regression; no Electron or device connections.
// Run: node apps/desktop/scripts/check-permission-focus.mjs [Chromium executable] [screenshot directory]
// --split-only isolates dual-mounted requests; --expect-split-broken checks their pre-fix failure.
// --cards-only checks all six decision-card consumers; --expect-cards-broken records the baseline.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync as fsWrite } from 'node:fs';
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
const temp = mkdtempSync(path.join(os.tmpdir(), 'cindy-permission-focus-'));
const screenshots = process.argv[3];
const baseline = process.argv.includes('--expect-broken');
const splitOnly = process.argv.includes('--split-only');
const filesOnly = process.argv.includes('--files-only');
const cardsOnly = process.argv.includes('--cards-only');
const cardsBaseline = process.argv.includes('--expect-cards-broken');
const filesBaseline = process.argv.includes('--expect-files-broken');
const splitBaseline = process.argv.includes('--expect-split-broken');
if (screenshots) mkdirSync(screenshots, { recursive: true });
// Stub host data only. Rows, cards, masonry, menus, permissions, keyboard guards
// and theme styles are production code; the surrounding page is a synthetic shell.
const stubs = {
  '@/contexts/AuthContext':
    'export const useAuth=()=>({dataOwnerId:"synthetic",isAuthenticated:true});',
  '@/contexts/PrRefsContext':
    'const empty=[];const actions={registerPrConsumer:()=>()=>{}};export const usePrRefsForSession=()=>empty;export const usePrActions=()=>actions;export const usePrStatus=()=>undefined;export const usePrStatuses=()=>({statuses:new Map(),fetchStatusesForSession(){}});',
  '@/features/scheduler/lib/scheduleSessionBinding':
    'const empty=[];export const useSessionBoundSchedules=()=>empty;export const scheduleFocusPath=()=>"/";',
  '@/features/scheduler/lib/scheduleSidebarIndexRuns':
    'export const loadScheduleSidebarIndexRuns=async()=>[];export const findLatestSidebarIndexRunForSession=()=>undefined;',
  '@/components/sidebar/WorktreeBadge': 'export const WorktreeBadge=()=>null;',
  '@/contexts/WorktreeContext':
    'const noop=()=>{};export const useWorktreeForSession=()=>null;export const useReportWorktreeLiveness=()=>noop;export const useObservedWorktreeForSession=()=>null;export const useRefreshObservedWorktree=()=>noop;',
  '@/lib/makerChatStore':
    'const running=new Map();export const makerChatStore={ensureInitialMessages(){},hasPausedQueue:()=>false,subscribeAll:()=>()=>{},getRunningSnapshot:()=>running};',
  '@/lib/toast': 'export const toast={success(){},warning(){},error(){}};',
};
let browser;
try {
  const config = loadConfig(path.join(desktop, 'tailwind.config.ts'));
  config.content = [
    path.join(renderer, 'features/cc-agent/sidebar/*.tsx'),
    path.join(renderer, 'components/new-chat/PermissionPrompt.tsx'),
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
    entryPoints: [
      path.join(desktop, 'scripts/fixtures/permission-focus/permission-focus-fixture.tsx'),
    ],
    write: false,
    outfile: path.join(temp, 'permission-focus.js'),
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
    aside{flex-shrink:0;padding:12px;background:var(--surface);border-right:1px solid var(--border-default)}
    nav{flex-shrink:0;text-align:center;padding-top:20px;border-right:1px solid var(--border-default)}
    .fixture-label{font-size:12px;margin:8px 0;color:var(--text-secondary)}
    main{flex:1;min-width:0;display:flex;flex-direction:column}
    header{height:52px;padding:16px 24px;border-bottom:1px solid var(--border-default)}
    .fixture-chat{padding:24px;display:flex;flex:1;flex-direction:column;justify-content:space-between}
    .fixture-chat>p{font-size:14px;color:var(--text-secondary)}
    `;
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
          body: `<!doctype html><meta charset="utf-8"><style>${css}${componentCss}${shellCss}</style><div id="root"></div><div id="rail-portal"></div><script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`,
        })
      : route.abort(),
  );
  page.setDefaultTimeout(8000);
  const results = [];
  for (const theme of (splitOnly || filesOnly || cardsOnly) ? [] : ['light', 'dark']) {
    for (const layout of ['rows', 'rail', 'one', 'two', 'three']) {
      for (const key of ['Enter', 'Control+Enter', 'Escape']) {
        await page.setViewportSize({ width: 1280, height: 760 });
        await page.goto(`http://fixture.local/?theme=${theme}&layout=${layout}`);
        const row = page.locator('[data-session-id="B"]');
        await row.click();
        assert.equal(await page.evaluate(() => window.permissionFocus.active), 'B');
        const focusAfterClick = await page.evaluate(() => ({
          tag: document.activeElement.tagName,
          session: document.activeElement.dataset.sessionId,
        }));
        await page.keyboard.press(key);
        const result = await page.evaluate(() => window.permissionFocus);
        results.push({
          theme,
          layout,
          key,
          focusAfterClick,
          responses: result.responses,
          events: result.events,
        });
        if (baseline) assert.equal(result.responses.length, 0);
        else {
          assert.equal(result.responses.length, 1);
          assert.equal(result.responses[0].session, 'B');
          assert.equal(result.responses[0].request, 'request-B');
          assert.equal(result.responses[0].decision.behavior, key === 'Escape' ? 'deny' : 'allow');
          if (key === 'Control+Enter')
            assert.equal(result.responses[0].decision.decisionClassification, 'user_permanent');
        }
        if (screenshots && key === 'Enter')
          await page.screenshot({
            path: path.join(screenshots, `${baseline ? 'before' : 'after'}-${theme}-${layout}.png`),
          });
        // Control case: blank chat click releases the stale navigation focus.
        if (baseline) {
          await page.locator('.fixture-chat>p').click();
          await page.keyboard.press(key);
          assert.equal(await page.evaluate(() => window.permissionFocus.responses.length), 1);
        }
      }
    }
  }
  let safetyCases = 0;
  for (const layout of (splitOnly || filesOnly || cardsOnly) ? [] : ['rows', 'one']) {
    const open = async (suffix = '') => {
      await page.goto(`http://fixture.local/?layout=${layout}${suffix}`);
      await page.locator('[data-session-id="B"]').waitFor();
    };
    const responses = () => page.evaluate(() => window.permissionFocus.responses);
    // Browser Tab traversal and native button activation, not a synthetic keyDown.
    await open();
    await page.locator('[data-session-id="B"]').click();
    const deny = page.getByRole('button', { name: /^拒绝/ });
    for (let i = 0; i < 30 && !(await deny.evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press('Tab');
    assert.ok(await deny.evaluate((el) => el === document.activeElement), 'Tab reaches Deny');
    await page.keyboard.press('Enter');
    assert.deepEqual(
      (await responses()).map((r) => [r.session, r.decision.behavior]),
      [['B', 'deny']],
    );
    safetyCases++;

    await open();
    await page.locator('[data-session-id="B"]').click({ button: 'right' });
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.deepEqual(await responses(), [], 'menu Escape only closes the menu');
    safetyCases++;

    await open();
    await page.locator('[data-session-id="B"]').dblclick();
    await page.getByRole('textbox').waitFor();
    await page.keyboard.type('synthetic rename');
    await page.keyboard.press('Escape');
    assert.deepEqual(await responses(), [], 'rename Escape never denies');
    safetyCases++;

    await open('&defer');
    await page.locator('[data-session-id="B"]').click();
    await page.keyboard.press('Escape');
    assert.deepEqual(await responses(), [], 'pending navigation cannot deny A');
    await page.evaluate(() => window.permissionFocus.finish());
    await page.waitForFunction(() => window.permissionFocus.active === 'B');
    await page.keyboard.press('Enter');
    assert.equal((await responses()).length, baseline ? 0 : 1);
    if (!baseline) assert.equal((await responses())[0].session, 'B');
    safetyCases++;

    await open('&empty');
    await page.evaluate(() => window.permissionFocus.arrive());
    await deny.waitFor();
    await page.keyboard.press('Enter');
    assert.deepEqual(
      (await responses()).map((r) => [r.session, r.decision.behavior]),
      [['A', 'allow']],
    );
    safetyCases++;

    await open();
    await page.locator('[data-session-id="B"]').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.sessionId), 'B');
    assert.deepEqual(await responses(), [], 'keyboard navigation keeps its keys');
    safetyCases++;

    for (const modifier of ['Control', 'Meta', 'Shift']) {
      await open();
      await page.locator('[data-session-id="B"]').click({ modifiers: [modifier] });
      // macOS maps Control-click to a context menu; preserve that native path too.
      const nativeContextMenu = modifier === 'Control' && process.platform === 'darwin';
      if (nativeContextMenu) await page.getByRole('menu').waitFor();
      await page.keyboard.press('Escape');
      if (!nativeContextMenu)
        assert.equal(await page.evaluate(() => document.activeElement.dataset.sessionId), 'B');
      assert.deepEqual(await responses(), [], 'multi-selection keeps its keys');
      safetyCases++;
    }
  }
  console.log(
    `Passed: ${safetyCases} native Tab/menu/rename/delayed navigation/arrival/keyboard/multi-selection cases`,
  );
  let misrouted = 0;
  const splitResults = [];
  for (const theme of (baseline || filesOnly || cardsOnly) ? [] : ['light', 'dark']) {
    for (const layout of ['rows', 'one']) {
      for (const order of ['A,B', 'B,A']) {
        for (const key of ['Enter', 'Control+Enter', 'Escape']) {
          await page.setViewportSize({ width: 1280, height: 900 });
          await page.goto(`http://fixture.local/?theme=${theme}&layout=${layout}&split=${order}`);
          for (const target of ['B', 'A', 'B']) {
            await page.locator(`[data-session-id="${target}"]`).click();
            assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
            await page.keyboard.press(key);
            const result = await page.evaluate(() => window.permissionFocus);
            splitResults.push({
              theme, layout, order, key, target,
              responses: result.responses,
              events: result.events,
            });
            assert.equal(result.responses.length, 1);
            if (result.responses[0].session !== target) misrouted++;
            if (!splitBaseline) {
              assert.equal(result.responses[0].session, target);
              assert.equal(result.responses[0].request, `request-${target}`);
              assert.equal(result.responses[0].decision.behavior, key === 'Escape' ? 'deny' : 'allow');
              if (key === 'Control+Enter')
                assert.equal(result.responses[0].decision.decisionClassification, 'user_permanent');
            }
            await page.evaluate(() => {
              window.permissionFocus.responses = [];
              window.permissionFocus.events = [];
            });
          }
        }
      }
    }
  }
  if (splitBaseline)
    assert.ok(misrouted > 0, 'dual-mounted baseline must expose a wrong-request response');
  else assert.equal(misrouted, 0);
  if (screenshots)
    fsWrite(
      path.join(screenshots, `${splitBaseline ? 'before' : 'after'}-split-events.json`),
      JSON.stringify(splitResults, null, 2),
    );
  console.log(
    `Split panes: ${splitResults.length} pointer/key cases; ${misrouted} wrong-request responses (${splitBaseline ? 'baseline reproduction' : 'must be zero'})`,
  );
  const filesResults = [];
  for (const layout of (baseline || splitOnly || cardsOnly) ? [] : ['rows', 'one']) {
    for (const theme of ['light', 'dark']) {
      for (const key of ['Enter', 'Control+Enter', 'Escape']) {
        await page.goto(`http://fixture.local/?files&layout=${layout}&theme=${theme}`);
        const row = page.locator('[data-session-id="A"]');
        await row.evaluate((el) => { window.filesRow = el; });
        assert.equal(await row.getAttribute('aria-current'), 'page');
        await row.click();
        await page.waitForFunction(() => window.permissionFocus.route === '/cc-agent/A');
        assert.ok(await row.evaluate((el) => el === window.filesRow), 'portal row stays mounted');
        assert.equal(await row.getAttribute('aria-current'), 'page');
        await page.keyboard.press(key);
        const result = await page.evaluate(() => window.permissionFocus);
        filesResults.push({ layout, theme, key, route: result.route, responses: result.responses, events: result.events });
        if (filesBaseline) assert.equal(result.responses.length, 0);
        else {
          assert.equal(result.responses.length, 1);
          assert.equal(result.responses[0].session, 'A');
          assert.equal(result.responses[0].request, 'request-A');
          assert.equal(result.responses[0].decision.behavior, key === 'Escape' ? 'deny' : 'allow');
        }
      }
    }
  }
  let filesSafetyCases = 0;
  if (!baseline && !splitOnly && !filesBaseline && !cardsOnly) {
    for (const layout of ['rows', 'one']) {
      for (const cancel of ['none', 'keyboard', 'focus']) {
        await page.goto(`http://fixture.local/?files&defer&layout=${layout}`);
        const row = page.locator('[data-session-id="A"]');
        await row.click();
        assert.equal(await page.evaluate(() => window.permissionFocus.route), '/cc-agent/files/A');
        assert.ok(await row.evaluate((el) => el === document.activeElement));
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => window.permissionFocus.responses.length), 0);
        if (cancel === 'keyboard') await page.keyboard.press('Enter');
        if (cancel === 'focus') await page.keyboard.press('Tab');
        await page.evaluate(() => { window.filesFocus = document.activeElement; window.permissionFocus.finish(); });
        await page.waitForFunction(() => window.permissionFocus.route === '/cc-agent/A');
        if (cancel === 'none') {
          assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
          await page.keyboard.press('Enter');
          assert.deepEqual(await page.evaluate(() => window.permissionFocus.responses.map((r) => [r.session, r.decision.behavior])), [['A', 'allow']]);
        } else {
          assert.ok(await page.evaluate(() => document.activeElement === window.filesFocus));
          assert.equal(await page.evaluate(() => window.permissionFocus.responses.length), 0);
        }
        filesSafetyCases++;
      }
    }
  }
  console.log(`Passed: ${filesSafetyCases} files-return delayed navigation / handoff cancellation cases`);
  if (screenshots && filesResults.length) fsWrite(
    path.join(screenshots, `${filesBaseline ? 'before' : 'after'}-files-events.json`),
    JSON.stringify(filesResults, null, 2),
  );
  console.log(`${filesBaseline ? 'Reproduced' : 'Passed'}: ${filesResults.length} files-to-same-task persistent portal cases`);
  const cardResults = [];
  let wrongCardResponses = 0;
  if (cardsOnly) {
    const kinds = ['plan', 'ask', 'permission', 'issue', 'rename', 'ghost'];
    for (const theme of ['light', 'dark']) {
      for (const order of ['A,B', 'B,A']) {
        const cases = kinds.flatMap((a) => kinds.map((b) => ({ a, b, key: 'Escape' })));
        cases.push(...kinds.map((kind) => ({ a: kind, b: kind,
          key: kind === 'plan' ? 'Enter' : kind === 'ask' ? '1' : 'Control+Enter' })));
        for (const { a, b, key } of cases) {
          await page.setViewportSize({ width: 1440, height: 1800 });
          await page.goto(`http://fixture.local/?layout=rows&theme=${theme}&split=${order}&cardA=${a}&cardB=${b}`);
          if (key === 'Control+Enter' && b === 'issue') {
            await page.locator('[data-interaction-session="A"]').getByRole('checkbox').check();
            await page.locator('[data-interaction-session="B"]').getByRole('checkbox').check();
          }
          await page.locator('[data-session-id="B"]').click();
          assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
          await page.keyboard.press(key);
          const result = await page.evaluate(() => window.permissionFocus);
          const correct = result.responses.length === 1 &&
            result.responses[0].session === 'B' && result.responses[0].request === 'request-B';
          cardResults.push({ theme, order, a, b, key, responses: result.responses, events: result.events });
          if (!correct) wrongCardResponses++;
          if (!cardsBaseline) assert.ok(correct, `${theme} ${order} ${a}/${b} ${key}: ${JSON.stringify(result.responses)}`);
        }
      }
    }
    if (cardsBaseline) assert.ok(wrongCardResponses > 0);
    else assert.equal(wrongCardResponses, 0);
    if (screenshots) fsWrite(
      path.join(screenshots, `${cardsBaseline ? 'before' : 'after'}-cards-events.json`),
      JSON.stringify(cardResults, null, 2),
    );
    console.log(`Interaction cards: ${cardResults.length} actual pointer/key cases; ${wrongCardResponses} wrong-request responses`);
  }
  assert.deepEqual(errors, []);
  if (screenshots && !splitOnly && !filesOnly && !cardsOnly)
    fsWrite(
      path.join(screenshots, `${baseline ? 'before' : 'after'}-events.json`),
      JSON.stringify(results, null, 2),
    );
  console.log(
    `${baseline ? 'Reproduced' : 'Passed'}: ${results.length} mouse/navigation/permission cases`,
  );
} finally {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
}
