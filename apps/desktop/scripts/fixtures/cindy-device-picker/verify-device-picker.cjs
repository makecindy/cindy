// Run from the repository root. Optional --baseline=<git-ref> captures the old hit target.
// Uses one headless Chromium, synthetic data, and production components/styles; no Cindy process.
// Prepare once: pnpm exec playwright-core install chromium
// Or set DEVICE_PICKER_CHROMIUM_PATH to an existing Chrome/Chromium executable.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const postcss = require('postcss');
const tailwind = require('tailwindcss');
const { chromium } = require('playwright-core');
const root = process.cwd();
const renderer = path.join(root, 'apps/desktop/src/renderer');
const evidence = path.resolve(process.env.DEVICE_PICKER_EVIDENCE_DIR || 'artifacts/device-picker');
const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11);
const sourceFiles = [
  'features/bots/CindyDeviceRow.tsx',
  'features/bots/CindyDevicePicker.tsx',
  'components/ui/select.tsx',
];
const longName = 'Studio workstation with a very long device name 工作电脑';
const data = {
  bots: [
    {
      id: 'cindy-default',
      name: 'Cindy',
      status: 'active',
      avatar: 'cindy://avatar/preset/cindy',
      sessionId: 'fixture-chat',
    },
  ],
  remoteBots: [
    {
      id: 'cindy-default',
      deviceId: 'fixture-remote',
      deviceName: longName,
      name: 'Cindy',
      online: false,
      lastReplyAt: 20,
      readAt: 10,
    },
  ],
  devices: [{ deviceId: 'self', name: 'Local workstation', isSelf: true }],
  unread: { 'cindy-default': 3 },
};
const stubs = {
  botStore:
    'export const useBotProfiles=()=>window.devicePickerFixture.bots; export const useBotUnreadCounts=()=>window.devicePickerFixture.unread;',
  useRemoteBots: 'export const useRemoteBots=()=>window.devicePickerFixture.remoteBots;',
  useDeviceLinkDeviceList:
    'export const useDeviceLinkDeviceList=()=>window.devicePickerFixture.devices;',
  openBotWorkbenchTab: 'export const openBotWorkbenchTab=async()=>{};',
};
const extraCss = `body{margin:0;background:var(--surface);color:var(--text-primary)}
 .fixture-caption{margin:0;padding:16px;font-size:12px}.fixture-layout{display:flex;min-height:320px}
 aside{width:290px;flex-shrink:0;padding:12px;background:var(--sidebar);border-right:1px solid var(--border-default)}
 main{flex:1;min-width:0}header{height:56px;padding:10px;border-bottom:1px solid var(--border-default)}
 .fixture-results{padding:24px;display:grid;gap:12px}output{display:none}
 @media(max-width:700px){aside{width:220px}}`;

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-device-picker-'));
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.DEVICE_PICKER_CHROMIUM_PATH || undefined,
    });
    for (const stage of baseline ? ['before', 'after'] : ['after']) {
      const old = stage === 'before';
      const historical = Object.fromEntries(
        old
          ? sourceFiles.map((file) => [
              path.join(renderer, file),
              cp.execFileSync('git', ['show', `${baseline}:apps/desktop/src/renderer/${file}`], {
                encoding: 'utf8',
              }),
            ])
          : [],
      );
      const cfg = require('tailwindcss/loadConfig')(
        path.join(root, 'apps/desktop/tailwind.config.ts'),
      );
      cfg.content = [
        path.join(
          renderer,
          'features/bots/{CindyDevicePicker,CindyDeviceRow,BotAvatar,BotConnectionStatus,BotSessionContentHeader}.tsx',
        ),
        path.join(renderer, 'components/ui/{select,button,spinner}.tsx'),
        ...Object.values(historical).map((raw) => ({ raw, extension: 'tsx' })),
      ];
      const css = (
        await postcss([tailwind(cfg)]).process(
          fs.readFileSync(path.join(renderer, 'styles/generated/tokens.css'), 'utf8') +
            '\n' +
            fs
              .readFileSync(path.join(renderer, 'styles/globals.css'), 'utf8')
              .replace(/^@import.*$/gm, ''),
          { from: undefined },
        )
      ).css;
      const bundle = path.join(temp, `${stage}.js`);
      await esbuild.build({
        entryPoints: [path.join(__dirname, 'device-picker-fixture.tsx')],
        outfile: bundle,
        bundle: true,
        format: 'esm',
        platform: 'browser',
        jsx: 'automatic',
        loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl' },
        define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' },
        plugins: [
          {
            name: 'fixture-roster',
            setup(build) {
              build.onResolve(
                {
                  filter: /botStore$|useRemoteBots$|useDeviceLinkDeviceList$|openBotWorkbenchTab$/,
                },
                (args) => ({ path: path.basename(args.path), namespace: 'stub' }),
              );
              build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
                contents: stubs[args.path],
                loader: 'js',
              }));
              build.onResolve({ filter: /^@\// }, (args) => {
                const base = path.join(renderer, args.path.slice(2));
                const resolved = ['', '.tsx', '.ts', '.js', '/index.tsx', '/index.ts']
                  .map((suffix) => base + suffix)
                  .find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
                return { path: resolved };
              });
              build.onLoad({ filter: /\.(tsx?|js)$/ }, (args) =>
                historical[args.path]
                  ? {
                      contents: historical[args.path],
                      loader: args.path.endsWith('tsx') ? 'tsx' : 'ts',
                    }
                  : undefined,
              );
            },
          },
        ],
        logLevel: 'warning',
      });
      const buttonCss = fs.readFileSync(bundle.replace(/\.js$/, '.css'), 'utf8');
      for (const theme of ['light', 'dark'])
        for (const width of [1040, 560])
          for (const long of [false, true]) {
            const page = await browser.newPage({ viewport: { width, height: 400 } });
            page.setDefaultTimeout(8000);
            console.log('Checking', stage, theme, width, long);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.route('http://fixture.local/**', (route) =>
              route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html><html><head><meta charset="utf-8"><style>${css}${buttonCss}${extraCss}</style></head><body><div id="root"></div><script>window.devicePickerFixture=${JSON.stringify(data)}</script><script type="module">${fs.readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script')}</script></body></html>`,
              }),
            );
            await page.goto(
              `http://fixture.local/?stage=${stage}&theme=${theme}${long ? '&long&unselected' : ''}`,
            );
            const row = page.getByTestId('cindy-device-row');
            const trigger = row.getByRole('combobox');
            const header = page.locator('header');
            await trigger.waitFor();
            const box = await trigger.boundingBox();
            const rowBox = await row.boundingBox();
            const headerBox = await header.getByRole('combobox').boundingBox();
            assert.equal(box.height, 24);
            if (!old) {
              assert.ok(box.x + box.width <= rowBox.x + rowBox.width - 10, 'sidebar bounds');
              if (!long) {
                assert.ok(box.width < 100, 'compact sidebar');
                assert.ok(headerBox.width < 100, 'compact header');
              }
              assert.ok(headerBox.width <= 176, 'header maximum');
              assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
                false,
                'no horizontal overflow',
              );
              if (long) {
                for (const picker of [trigger, header.getByRole('combobox')]) {
                  assert.equal(
                    await picker
                      .locator('span')
                      .first()
                      .evaluate((el) => el.scrollWidth > el.clientWidth),
                    true,
                    'long device name is truncated',
                  );
                  assert.equal(await picker.getAttribute('title'), longName);
                }
              }
              const point = { x: rowBox.x + rowBox.width - 4, y: box.y + box.height / 2 };
              if (!long) point.x = box.x + box.width + 12;
              await page.mouse.click(point.x, point.y);
              assert.equal(
                await page.getByTestId('opens').textContent(),
                '1',
                'blank area opens chat exactly once',
              );
              assert.equal(
                await page.getByRole('listbox').count(),
                0,
                'blank area does not open menu',
              );
              await page.mouse.click(rowBox.x + 20, rowBox.y + 20);
              assert.equal(await page.getByTestId('opens').textContent(), '2', 'avatar opens chat');
            }
            await trigger.hover();
            const name = `${stage}-${theme}-${width}-${long ? 'long-name' : 'local'}`;
            await page.screenshot({ path: path.join(evidence, `${name}.png`) });
            if (old && !long) {
              await page.mouse.click(box.x + 110, box.y + box.height / 2);
            } else await trigger.click();
            const menu = page.getByRole('listbox');
            await menu.waitFor();
            if (old && !long)
              assert.equal(
                await page.getByTestId('opens').textContent(),
                '0',
                'baseline blank area opens menu instead of chat',
              );
            if (!old) {
              const menuBox = await menu.boundingBox();
              assert.ok(
                menuBox.width >= 250 && menuBox.x >= 0 && menuBox.x + menuBox.width <= width,
                'readable bounded menu',
              );
              assert.equal(
                await page.getByTestId('opens').textContent(),
                '2',
                'menu does not also open chat',
              );
              assert.ok((await menu.innerText()).includes('离线'));
              assert.ok((await menu.innerText()).includes('3'));
              const option = menu.getByRole('option', { name: new RegExp(longName) });
              assert.equal(await option.getAttribute('title'), longName);
            }
            await page.screenshot({ path: path.join(evidence, `${name}-menu.png`) });
            await page.keyboard.press('Escape');
            await menu.waitFor({ state: 'detached' });
            if (!old) {
              await page.waitForFunction(() =>
                document.activeElement?.matches(
                  '[data-testid="cindy-device-row"] [role="combobox"]',
                ),
              );
              assert.equal(
                await trigger.evaluate((el) => el === document.activeElement),
                true,
                'Escape restores focus',
              );
              await page.keyboard.press('Tab');
              assert.equal(
                await header
                  .getByRole('button')
                  .first()
                  .evaluate((el) => el === document.activeElement),
                true,
                'Tab leaves picker',
              );
              await trigger.focus();
              await page.keyboard.press('Enter');
              await menu.waitFor();
              await page.keyboard.press(long ? 'Home' : 'End');
              await page.waitForFunction(
                (label) => document.activeElement?.textContent?.includes(label),
                long ? '本机' : longName,
              );
              await page.keyboard.press('Enter');
              await menu.waitFor({ state: 'detached' });
              assert.equal(
                await page.getByTestId('selections').textContent(),
                '1',
                'keyboard selection once',
              );
              assert.equal(
                await page.getByTestId('opens').textContent(),
                '2',
                'selection never opens chat',
              );
              await trigger.focus();
              await page.keyboard.press('Space');
              await menu.waitFor();
              await page.keyboard.press('Escape');
              await menu.waitFor({ state: 'detached' });
              await header.getByRole('combobox').click();
              await menu
                .getByRole('option', { name: long ? '本机' : new RegExp(longName) })
                .click();
              await page.waitForFunction(
                (route) => document.querySelector('[data-testid="route"]')?.textContent === route,
                long ? '/bots/cindy-default' : '/bots/remote/fixture-remote/cindy-default',
              );
              assert.equal(
                await page.getByTestId('route').textContent(),
                long ? '/bots/cindy-default' : '/bots/remote/fixture-remote/cindy-default',
                'header routes to selected device',
              );
              const ordinary = page.getByTestId('ordinary-select').getByRole('combobox');
              const ordinaryWidth = (await ordinary.boundingBox()).width;
              await ordinary.click();
              assert.equal(
                Math.round((await menu.boundingBox()).width),
                Math.round(ordinaryWidth),
                'ordinary Select remains equal width',
              );
              await page.keyboard.press('Escape');
            }
            assert.deepEqual(errors, []);
            results.push({
              stage,
              theme,
              width,
              long,
              sidebarWidth: box.width,
              headerWidth: headerBox.width,
              height: box.height,
            });
            await page.close();
          }
    }
    fs.writeFileSync(
      path.join(evidence, 'device-picker-measurements.json'),
      JSON.stringify(results, null, 2),
    );
    console.log(
      JSON.stringify({ passed: true, scenarios: results.length, evidence, results }, null, 2),
    );
  } finally {
    await browser?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
