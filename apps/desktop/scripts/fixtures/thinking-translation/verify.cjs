// Real macOS/Windows/Linux Electron window; synthetic source and fixed model replies.
// Run from repo root: node apps/desktop/scripts/fixtures/thinking-translation/verify.cjs [output]
// This never starts Cindy bootstrap, signs in, or reads a production profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const postcss = require('postcss');
const tailwind = require('tailwindcss');
const loadConfig = require('tailwindcss/loadConfig');
const { _electron } = require('playwright-core');
(async () => {
  const root = process.cwd();
  const renderer = path.join(root, 'apps/desktop/src/renderer');
  const output = path.resolve(
    process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-thinking-visual-')),
  );
  fs.mkdirSync(output, { recursive: true });
  const cfg = loadConfig(path.join(root, 'apps/desktop/tailwind.config.ts'));
  cfg.content = [
    path.join(
      renderer,
      'components/chat/{ThinkingCard,WorkGroupBlock,useThinkingTranslation,ThinkingText}.tsx',
    ),
    path.join(renderer, 'components/ui/{button,spinner,collapse}.tsx'),
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
  fs.writeFileSync(path.join(output, 'style.css'), css);
  await build({
    entryPoints: [path.join(__dirname, 'fixture.tsx')],
    outfile: path.join(output, 'bundle.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    define: {
      'import.meta.env.PROD': 'true',
      'import.meta.env.DEV': 'false',
      'process.env.NODE_ENV': '"production"',
    },
    target: 'chrome146',
    tsconfig: path.join(root, 'apps/desktop/tsconfig.json'),
    loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'visual-data-only',
        setup(b) {
          b.onResolve({ filter: /ChatSessionFileContext$/ }, () => ({
            path: 'context',
            namespace: 'fixture',
          }));
          b.onResolve({ filter: /makerTransport$/ }, () => ({
            path: 'transport',
            namespace: 'fixture',
          }));
          b.onResolve({ filter: /AgentActionRow$/ }, () => ({
            path: 'tool',
            namespace: 'fixture',
          }));
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
            contents:
              name === 'context'
                ? "export const useChatSessionFile=()=>({sessionId:'visual',origin:{kind:'local'}});"
                : name === 'tool'
                  ? 'export const AgentActionRow=()=>null;'
                  : "export async function translateThinkingFor(){window.fixture.calls++;await new Promise(r=>setTimeout(r,250));return window.fixture.fail?{error:'failed'}:{text:'**检查实现**\\n我会先检查 `main.ts`，再比较结果。这只是初步计划，并非已确认的结论。'};}",
            loader: 'js',
          }));
          b.onResolve({ filter: /^@\// }, ({ path: name }) => {
            const base = path.join(renderer, name.slice(2));
            return {
              path: ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']
                .map((ext) => base + ext)
                .find((file) => fs.existsSync(file) && fs.statSync(file).isFile()),
            };
          });
        },
      },
    ],
  });
  fs.writeFileSync(
    path.join(output, 'index.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="bundle.css"><div id="root"></div><script type="module" src="bundle.js"></script></html>',
  );
  fs.writeFileSync(
    path.join(output, 'main.cjs'),
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:960,height:800,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false,experimentalFeatures:false,plugins:false,navigateOnDragDrop:false,webviewTag:false}});w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.session.setPermissionRequestHandler((w,p,cb)=>cb(false));w.webContents.session.setPermissionCheckHandler(()=>false);w.loadFile(${JSON.stringify(path.join(output, 'index.html'))});});`,
  );
  const app = await _electron.launch({
    executablePath: require('electron'),
    timeout: 30000,
    args: [path.join(output, 'main.cjs')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const page = await app.firstWindow({ timeout: 20000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const results = [];
  try {
    for (const mode of ['light', 'dark']) {
      await page.goto('file://' + path.join(output, 'index.html') + '?theme=' + mode);
      await page.locator('[data-case=standalone]').waitFor({ timeout: 5000 });
      await page.evaluate(() => document.fonts.ready);
      const card = page.locator('[data-case=standalone]');
      await card.getByRole('button').click();
      await card.getByRole('button', { name: '翻译', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => window.fixture.calls), 0);
      await page.waitForTimeout(350);
      await page.mouse.move(2, 2);
      await page.screenshot({
        animations: 'disabled',
        path: path.join(output, mode + '-original.png'),
      });
      await card.getByRole('button', { name: '翻译', exact: true }).click();
      await card.getByRole('button', { name: '显示原文', exact: true }).waitFor();
      await card.getByText('机器翻译', { exact: true }).waitFor();
      await card.getByRole('button', { name: '显示原文', exact: true }).click();
      await card.getByRole('button', { name: '显示译文', exact: true }).click();
      assert.equal(await page.evaluate(() => window.fixture.calls), 1);
      const group = page.locator('[data-case=group]');
      await group.getByRole('button').first().click();
      await group.locator('[data-live-work-activity=thinking]').click();
      await group.getByRole('button', { name: '翻译', exact: true }).click();
      await group.getByRole('button', { name: '显示原文', exact: true }).waitFor();
      await page.waitForTimeout(350);
      await page.mouse.move(2, 2);
      await page.screenshot({
        animations: 'disabled',
        path: path.join(output, mode + '-translated.png'),
      });
      await page.setViewportSize({ width: 360, height: 800 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.waitForTimeout(350);
      await page.mouse.move(2, 2);
      await page.screenshot({
        animations: 'disabled',
        path: path.join(output, mode + '-narrow.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 960, height: 800 });
      results.push({
        mode,
        calls: await page.evaluate(() => window.fixture.calls),
        horizontalOverflow: false,
      });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          platform: process.platform,
          versions: await app.evaluate(() => process.versions),
          results,
          errors,
          scope:
            'Real Electron production components/styles. Synthetic source and fixed model replies. No live-service or native Mobile verification.',
        },
        null,
        2,
      ),
    );
    console.log('THINKING_VISUAL_PASSED=' + output);
  } catch (e) {
    console.error('Renderer errors:', errors);
    console.error('Body:', await page.locator('body').innerText());
    await page.waitForTimeout(350);
    await page.mouse.move(2, 2);
    await page.screenshot({ animations: 'disabled', path: path.join(output, 'failed.png') });
    throw e;
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
