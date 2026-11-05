/**
 * U10 regression, explicit Electron tier (§3.2): a 3000px App with no inner
 * overflow must pass real wheel input to chat; a 6000px App scrolls inside, then
 * chains to chat at its boundary. jsdom cannot exercise Chromium/OOPIF scrolling.
 * --compare REF uses that clean Git tree's production source/styles, not dirty
 * worktree versions; fixture and installed dependencies are held constant.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from 'playwright-core';
import { build } from 'esbuild';
import { buildPage, root, desktop } from './ui-page/build.mjs';
import { pageResponse } from './ui-page/run.mjs';

const ref = process.argv.includes('--compare')
  ? process.argv[process.argv.indexOf('--compare') + 1]
  : undefined;
const output = path.resolve(
  process.argv.includes('--output')
    ? process.argv[process.argv.indexOf('--output') + 1]
    : path.join(root, 'tmp/mcp-apps-wheel-verification'),
);
await mkdir(output, { recursive: true });
const git = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const atRef = ref
  ? new Set(
      git(['ls-tree', '-r', '--name-only', ref])
        .trim()
        .split('\n')
        .map((p) => path.join(root, p)),
    )
  : undefined;
const cache = new Map();
const overlay = ref
  ? {
      has: (file) =>
        atRef.has(file) &&
        !file.includes('/scripts/ui-page/') &&
        !file.includes('/scripts/fixtures/'),
      get(file) {
        if (!this.has(file)) return undefined;
        if (!cache.has(file))
          cache.set(
            file,
            execFileSync(
              'git',
              ['show', `${ref}:${path.relative(root, file).split(path.sep).join('/')}`],
              { cwd: root, maxBuffer: 64 * 1024 * 1024 },
            ),
          );
        const value = cache.get(file);
        return /\.(?:tsx?|jsx?|css|json)$/.test(file) ? value.toString() : value;
      },
      resolve(candidate) {
        const variants = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx'];
        const old = variants.map((s) => candidate + s).find((p) => atRef.has(p));
        const now = variants
          .map((s) => candidate + s)
          .find((p) => existsSync(p) && statSync(p).isFile());
        return old && old !== now ? old : null;
      },
    }
  : undefined;
const fixtureDir = path.join(desktop, 'scripts/fixtures/mcp-app-card');
const bundle = await buildPage(
  {
    name: 'mcp-app-wheel',
    dir: fixtureDir,
    entry: './wheel-fixture.tsx',
    stubs: {
      'src/renderer/lib/makerChatStore':
        'export const makerChatStore={subscribe:()=>()=>{},getSnapshot:()=>({})};',
      'src/renderer/features/device-link/stickySessionOrigin':
        'export const getStickySessionDeviceId=()=>undefined;',
      'src/renderer/features/device-link/remoteProjectsStore':
        'export const remoteProjectsStore={subscribe:()=>()=>{}};',
    },
  },
  overlay,
);
const server = http.createServer((req, res) => {
  const result = pageResponse('http://cindy-ui.test' + req.url, bundle, {
    case: 'default',
    theme: 'light',
    locale: 'zh-CN',
    platform: 'darwin',
  });
  res.writeHead(result?.status ?? (result ? 200 : 404), {
    'Content-Type': result?.contentType ?? 'text/plain',
  });
  res.end(result?.body ?? 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-app-wheel-'));
let electron;
try {
  const sandbox = path.join(desktop, 'src/main/mcp-apps/sandboxBridge.ts');
  await build({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(temp, 'main.cjs'),
    external: ['electron'],
    plugins: overlay
      ? [
          {
            name: 'baseline-sandbox',
            setup(b) {
              b.onLoad({ filter: /sandboxBridge\.ts$/ }, (args) => ({
                contents: overlay.get(args.path),
                loader: 'ts',
              }));
            },
          },
        ]
      : [],
    stdin: {
      resolveDir: root,
      contents: `
      const {app, BrowserWindow, protocol}=require('electron');
      const {mcpAppDirectSandboxDocument}=require(${JSON.stringify(sandbox)});
      app.setPath('userData',${JSON.stringify(path.join(temp, 'profile'))});
      app.commandLine.appendSwitch('site-per-process');
      protocol.registerSchemesAsPrivileged([{scheme:'cindy-mcp-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
      app.whenReady().then(()=>{
        globalThis.wheelHeight=3000;
        protocol.handle('cindy-mcp-app',request=>{
          const url=new URL(request.url); let text;
          if(url.pathname==='/sandbox') text=mcpAppDirectSandboxDocument('cindy-mcp-app://wheel-view/resource','cindy-mcp-app://wheel/bridge');
          else if(url.pathname==='/bridge') return new Response('[]',{headers:{'Content-Type':'application/json'}});
          else text='<!doctype html><style>html,body{margin:0}#content{height:'+globalThis.wheelHeight+'px;background:linear-gradient(white,gray)}</style><div id="content">App content</div><script>parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized"},"*");parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:'+globalThis.wheelHeight+'}},"*");</script>';
          return new Response(text,{headers:{'Content-Type':'text/html'}});
        });
        const win=new BrowserWindow({show:false,width:800,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false,experimentalFeatures:false,plugins:false,navigateOnDragDrop:false}});
        win.loadURL('http://127.0.0.1:${server.address().port}/');
      });`,
    },
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [path.join(temp, 'main.cjs')],
    env,
    timeout: 30000,
  });
  const page = await electron.firstWindow();
  const rows = [];
  for (const size of [1000, 3000, 6000]) {
    await electron.evaluate((_e, size) => {
      globalThis.wheelHeight = size;
    }, size);
    await page.reload();
    await page.locator('#conversation').evaluate((el) => {
      el.scrollTop = 263;
    });
    await page.waitForFunction(() => document.querySelector('iframe')?.clientHeight >= 1000);
    const inner = await (async () => {
      for (let i = 0; i < 100; i++) {
        const frame = page.frames().find((f) => f.url().includes('-view/resource'));
        if (frame) return frame;
        await delay(20);
      }
      throw Error('App frame unavailable');
    })();
    await inner.waitForSelector('#content');
    // real-wait: allow compositor frame geometry/hit-test data across OOPIF to settle.
    await delay(250);
    const state = async () => ({
      chat: await page.locator('#conversation').evaluate((el) => el.scrollTop),
      app: await inner.evaluate(() => scrollY),
      height: await inner.evaluate(() => innerHeight),
    });
    const wheel = async () => {
      await electron.evaluate(async ({ BrowserWindow }) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents;
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 180,
          y: 400,
          deltaX: 0,
          deltaY: 400,
        });
      });
      // real-wait: wheel acknowledgement precedes compositor scroll animation completion.
      await delay(500);
    };
    const before = await state();
    await wheel();
    const after = await state();
    rows.push({
      case: size < 6000 ? 'no-inner-overflow' : 'inner-scroll',
      size,
      before,
      after,
      pass:
        size < 6000
          ? after.chat > before.chat
          : after.app > before.app && after.chat === before.chat,
    });
    if (size === 6000) {
      await inner.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await delay(50);
      const before = await state();
      await wheel();
      const after = await state();
      rows.push({ case: 'inner-at-bottom', size, before, after, pass: after.chat > before.chat });
    }
    await page.screenshot({ path: path.join(output, `wheel-${ref ?? 'worktree'}-${size}.png`) });
  }
  const frames = await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.map((f) => ({
      url: f.url,
      processId: f.processId,
    })),
  );
  assert.equal(
    new Set(frames.map((f) => f.processId)).size,
    3,
    'Host, proxy and App must exercise separate renderer processes',
  );
  const result = { ref: ref ?? 'worktree', sourceDigest: bundle.sourceDigest, frames, rows };
  console.log(JSON.stringify(result, null, 2));
  await writeFile(
    path.join(output, `wheel-${ref ?? 'worktree'}.json`),
    JSON.stringify(result, null, 2),
  );
  if (!ref)
    assert.ok(
      rows.every((r) => r.pass),
      'real wheel must chain at App scroll boundaries',
    );
  console.log(
    'MCP_APPS_WHEEL_VERDICT=' + (rows.every((r) => r.pass) ? 'passed' : 'baseline-observed'),
  );
} finally {
  await electron?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
