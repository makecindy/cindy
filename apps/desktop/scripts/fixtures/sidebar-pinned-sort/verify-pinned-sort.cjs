// Run from the repository root: node apps/desktop/scripts/fixtures/sidebar-pinned-sort/verify-pinned-sort.cjs
// Uses actual SortableList/CardMasonry, production CSS and native mouse gestures.
// Optional PINNED_SORT_CHROMIUM_PATH selects an existing Chromium executable.
// --baseline=<git-ref> additionally verifies that the old CSS blocks project dragging.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const esbuild = require('esbuild');
const postcss = require('postcss');
const tailwind = require('tailwindcss');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../../../../..');
const renderer = path.join(root, 'apps/desktop/src/renderer');
const cssPath = 'apps/desktop/src/renderer/styles/globals.css';
const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11);
const extraCss = `
body{padding:24px;background:var(--surface);color:var(--text-primary)}
.fixture-list{margin-bottom:24px}.fixture-header{display:flex;align-items:center;gap:8px;padding:8px;min-height:72px}
.fixture-header span{flex:1}.fixture-header button{padding:4px}.fixture-header input{width:40px}
.fixture-child{padding:8px;min-height:32px}.fixture-task{padding:12px;min-height:104px}
.xdt-sortable-row{background:var(--surface-elevated);border:1px solid var(--border-default)}
#external{position:fixed;left:650px;top:100px;width:200px;height:200px}output{display:none}
`;

async function drag(page, from, to, { bottom = false, cancel = false } = {}) {
  const source = await from.boundingBox();
  const target = await to.boundingBox();
  assert.ok(source && target, 'drag endpoints exist');
  const x = source.x + Math.min(16, source.width / 2);
  const y = source.y + source.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y + 8, { steps: 5 });
  await page.waitForTimeout(80);
  const tx = target.x + target.width / 2;
  const ty = target.y + target.height * (bottom ? 0.75 : 0.25);
  await page.mouse.move(tx, ty, { steps: 25 });
  await page.waitForTimeout(180);
  // Cross the native drag threshold again after Sortable has moved the rows;
  // a 1px nudge can leave Chromium with the previous dragover target.
  await page.mouse.move(tx + 12, ty + (bottom ? -6 : 6), { steps: 5 });
  await page.waitForTimeout(120);
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(100);
}

(async () => {
  const bundle = await esbuild.build({
    entryPoints: [path.join(__dirname, 'pinned-sort-fixture.tsx')],
    bundle: true,
    write: false,
    jsx: 'automatic',
    alias: { '@': renderer },
    logLevel: 'warning',
  });
  const config = require('tailwindcss/loadConfig')(
    path.join(root, 'apps/desktop/tailwind.config.ts'),
  );
  config.content = [
    path.join(__dirname, 'pinned-sort-fixture.tsx'),
    path.join(renderer, 'components/sidebar/SortableList.tsx'),
    path.join(renderer, 'features/cc-agent/sidebar/{CardMasonry,DraggableCardColumns}.tsx'),
  ];
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PINNED_SORT_CHROMIUM_PATH || undefined,
  });
  let scenarios = 0;
  try {
    for (const stage of baseline ? ['before', 'after'] : ['after']) {
      const globalCss =
        stage === 'before'
          ? cp.execFileSync('git', ['show', `${baseline}:${cssPath}`], {
              cwd: root,
              encoding: 'utf8',
            })
          : fs.readFileSync(path.join(root, cssPath), 'utf8');
      const css = (
        await postcss([tailwind(config)]).process(
          fs.readFileSync(path.join(renderer, 'styles/generated/tokens.css'), 'utf8') +
            '\n' +
            globalCss.replace(/^@import.*$/gm, '') +
            '\n' +
            fs.readFileSync(path.join(renderer, 'styles/sortable.css'), 'utf8'),
          { from: undefined },
        )
      ).css;
      for (const theme of ['light', 'dark']) {
        for (const [mode, columns] of [
          ['text', 1],
          ['list', 1],
          ['card', 1],
          ['card', 2],
          ['card', 3],
        ]) {
          const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.route('http://fixture.local/**', (route) =>
            route.fulfill({
              contentType: 'text/html',
              body: `<!doctype html><html><head><style>${css}${extraCss}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`,
            }),
          );
          const url = `http://fixture.local/?mode=${mode}&columns=${columns}&theme=${theme}`;
          const load = async (suffix = '') => {
            await page.goto(url + suffix);
            await page.getByTestId('project-a-title').waitFor();
          };
          const order = async () => JSON.parse(await page.getByTestId('order').textContent());
          const reorders = () =>
            page.evaluate(() =>
              window.pinnedSortEvents.filter((event) => event.type === 'reorder'),
            );
          await load();
          await drag(page, page.getByTestId('project-a-title'), page.getByTestId('project-c'), {
            bottom: true,
          });
          if (stage === 'before') {
            assert.deepEqual(
              await order(),
              ['project-a', 'project-b', 'project-c'],
              `${mode}/${columns}: reproduces blocked projects`,
            );
            assert.deepEqual(await reorders(), []);
          } else {
            assert.deepEqual(
              await order(),
              ['project-b', 'project-c', 'project-a'],
              `${mode}/${columns}: project moves to last`,
            );
            assert.equal((await reorders()).length, 1, 'one persistence callback');
            assert.equal(
              await page
                .locator('#ordinary-image')
                .evaluate((el) => getComputedStyle(el).webkitUserDrag),
              'none',
              'unrelated image stays non-draggable',
            );

            for (const selector of ['button', 'input', '.fixture-child']) {
              await load();
              await drag(
                page,
                page.getByTestId('project-c').locator(selector),
                page.getByTestId('project-a'),
              );
              assert.deepEqual(await reorders(), [], `${selector}: does not reorder its project`);
            }
            await page
              .getByTestId('project-c')
              .getByRole('button', { name: 'Action', exact: true })
              .click();
            assert.equal(
              await page.getByTestId('clicks').textContent(),
              '1',
              'action remains clickable',
            );
            await page.getByTestId('project-c').getByRole('textbox').fill('Edited');
            assert.equal(
              await page.getByTestId('project-c').getByRole('textbox').inputValue(),
              'Edited',
              'rename remains editable',
            );

            await load('&mixed');
            await drag(page, page.getByTestId('project-b-title'), page.getByTestId('project-a'));
            assert.deepEqual(
              await order(),
              ['project-b', 'project-a', 'task'],
              'mixed project/task pins reorder',
            );
            await load();
            await drag(page, page.getByTestId('project-c-title'), page.locator('#external'));
            assert.deepEqual(await reorders(), [], 'external drop does not persist');
            await load();
            await drag(page, page.getByTestId('project-c-title'), page.getByTestId('project-a'), {
              cancel: true,
            });
            assert.deepEqual(await reorders(), [], 'Escape cancels without persisting');

            if (mode !== 'card') {
              await load('&native=false');
              await drag(page, page.getByTestId('project-c-title'), page.getByTestId('project-a'));
              assert.deepEqual(
                await order(),
                ['project-c', 'project-a', 'project-b'],
                'ordinary fallback project sorting remains usable',
              );
            }
          }
          assert.deepEqual(errors, []);
          scenarios += 1;
          console.log(`PASS ${stage} ${theme} ${mode} ${columns} column(s)`);
          await page.close();
        }
      }
    }
    console.log(JSON.stringify({ passed: true, scenarios }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
