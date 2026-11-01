import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, _electron } from 'playwright-core';
import { buildPage, inputsChanged, root } from './build.mjs';
import { auditOutcome, pageAudit } from './audit.mjs';
import { variantsFor } from './options.mjs';
import { reloadPage } from './registry.mjs';

const require = createRequire(import.meta.url);
export const origin = 'http://cindy-ui.test';
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const git = (args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

const bundlePrefix = (bundle) => `/b/${bundle.bundleDigest.slice(0, 16)}`;

/** HTML shell + in-memory bundle; anything else is not served (and fails the check). */
export function pageResponse(url, bundle, context) {
  const parsed = new URL(url);
  if (parsed.origin !== origin) return null;
  const prefix = bundlePrefix(bundle);
  if (parsed.pathname === '/') {
    const json = JSON.stringify(context).replace(/</g, '\\u003c');
    const links = bundle.styles
      .map((href) => `<link rel="stylesheet" href="${prefix}${href}">`)
      .join('');
    return {
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': csp },
      body: `<!doctype html><html lang="${context.locale}"><head><meta charset="utf-8"><title>Cindy UI Check</title>${links}<script type="application/json" id="ui-page-context">${json}</script></head><body><div id="root"></div><script type="module" src="${prefix}/page.js"></script></body></html>`,
    };
  }
  if (parsed.pathname === '/favicon.ico') return { status: 204, body: '' };
  // Entry files are versioned by bundle; content-hashed assets are shared.
  const key = parsed.pathname.startsWith(`${prefix}/`)
    ? parsed.pathname.slice(prefix.length)
    : parsed.pathname.startsWith('/assets/')
      ? parsed.pathname
      : null;
  const file = key && bundle.files.get(key);
  return file ? { contentType: file.contentType, body: file.body } : null;
}

/** Electron reads bundle files from disk through its own protocol handler (see electron.cjs). */
async function writeBundle(dir, bundle) {
  const prefix = bundlePrefix(bundle);
  for (const [key, file] of bundle.files) {
    const target = path.join(dir, key.startsWith('/assets/') ? key : `${prefix}${key}`);
    if (existsSync(target)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.body);
  }
}

function browserPath(explicit) {
  if (explicit) return explicit;
  const installed = chromium.executablePath();
  if (existsSync(installed)) return installed;
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
            .filter(Boolean)
            .map((base) => path.join(base, 'Google/Chrome/Application/chrome.exe'))
        : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const found = candidates.find((p) => existsSync(p));
  if (!found)
    throw new Error(
      '未找到浏览器。运行 pnpm --filter desktop exec playwright-core install chromium，或传 --browser <可执行文件路径>。',
    );
  return found;
}

const COMPARE_SCOPE = ['apps/desktop/src', 'apps/desktop/resources', 'packages'];
const TAILWIND_CONFIG = 'apps/desktop/tailwind.config.ts';
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|woff2?|ttf|otf)$/;
const MODULE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

/**
 * Product source (apps/desktop/src, packages) as of `ref`, read lazily from git: files that
 * differ from the worktree, including ones the worktree has since moved or deleted. The
 * scenario (fixtures, harness) stays current so before/after render the same data.
 */
function compareOverlay(ref) {
  const absolute = (list) =>
    new Set(
      list
        .split('\n')
        .filter(Boolean)
        .map((file) => path.join(root, file)),
    );
  const atRef = absolute(git(['ls-tree', '-r', '--name-only', ref, '--', ...COMPARE_SCOPE]));
  // Untracked files are new since the ref too.
  const changed = absolute(
    git(['diff', '--no-renames', '--name-only', ref, '--', ...COMPARE_SCOPE]) +
      git(['ls-files', '--others', '--exclude-standard', '--', ...COMPARE_SCOPE]),
  );
  const contents = new Map();
  const isFile = (file) => existsSync(file) && statSync(file).isFile();
  return {
    changed,
    atRef,
    used: new Set(),
    // Worktree files the ref side resolved past (e.g. foo.tsx where the ref had foo.ts).
    superseded: new Set(),
    has: (file) => changed.has(file) && atRef.has(file),
    get(file) {
      if (!this.has(file)) return undefined;
      this.used.add(file);
      if (!contents.has(file)) {
        const spec = `${ref}:${path.relative(root, file).split(path.sep).join('/')}`;
        // Images and fonts stay bytes; source, styles and translations are text.
        contents.set(
          file,
          BINARY.test(file)
            ? execFileSync('git', ['show', spec], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
            : git(['show', spec]),
        );
      }
      return contents.get(file);
    },
    // Resolves an import the way the ref's tree would; null when that matches the worktree.
    resolve(candidate) {
      const first = (exists) => MODULE_SUFFIXES.map((suffix) => candidate + suffix).find(exists);
      const old = first((file) => atRef.has(file));
      const now = first(isFile);
      if (!old || old === now) return null;
      if (now) this.superseded.add(now);
      return old;
    },
  };
}

function overviewHtml(rows) {
  const esc = (value) => String(value).replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;font:12px -apple-system,system-ui,sans-serif;background:#f4f4f5;color:#18181b}
    .row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin-bottom:20px}
    .label{width:180px;flex-shrink:0;line-height:1.5}.failed{color:#b91c1c;font-weight:600}
    figure{margin:0;background:#fff;border:1px solid #d4d4d8;border-radius:6px;padding:6px}
    figcaption{margin-bottom:4px;color:#52525b}img{display:block;max-width:640px;max-height:440px}
  </style>${rows
    .map(
      (row) =>
        `<div class="row"><div class="label"><b>${esc(row.title)}</b><br>${esc(row.subtitle)}<br><span class="${row.status === 'failed' ? 'failed' : ''}">${esc(row.status)}${row.warnings ? ` · ${row.warnings} warnings` : ''}</span></div>${row.images
          .map(
            (image) =>
              `<figure><figcaption>${esc(image.label)}</figcaption><img src="/__evidence/${image.src}"></figure>`,
          )
          .join('')}</div>`,
    )
    .join('')}`;
}

const KEEP_RUNS = 20;
const OVERVIEW_ROWS = 6;

/** The default evidence folder keeps the most recent runs only. */
async function pruneEvidence(outputRoot, current) {
  const runs = await Promise.all(
    (await readdir(outputRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async (entry) => {
        const dir = path.join(outputRoot, entry.name);
        return { dir, time: (await stat(dir)).mtimeMs };
      }),
  );
  const stale = runs
    .filter((run) => run.dir !== current)
    .sort((a, b) => b.time - a.time)
    .slice(KEEP_RUNS - 1);
  await Promise.all(stale.map((run) => rm(run.dir, { recursive: true, force: true })));
}

/**
 * Runs every variant of every selected page in one owned runtime, then exits.
 * Preview mode keeps the single variant open and rebuilds on source changes.
 */
export async function runPlan(plan, options, externalSignal) {
  const startedAt = performance.now();
  const outputRoot = options.output ?? path.join(root, 'artifacts/ui-check');
  await mkdir(outputRoot, { recursive: true });
  const label = plan.label ?? plan.pages.map((item) => item.definition.name).join('+');
  const evidence = await mkdtemp(path.join(outputRoot, `${label}-`));
  if (!options.output) await pruneEvidence(outputRoot, evidence);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'cindy-ui-check-'));
  const summary = {
    status: 'failed',
    mode: options.mode,
    engine: options.engine,
    startedAt: new Date().toISOString(),
    evidence,
    overview: null,
    commit: null,
    worktreeDirty: null,
    timings: {},
    pages: [],
    variants: [],
    coverage: plan.coverage,
    compare: null,
    errors: [],
    cleanup: { runtimeClosed: false, scratchRemoved: false },
  };
  try {
    summary.commit = git(['rev-parse', 'HEAD']).trim();
    summary.worktreeDirty = git(['status', '--porcelain']).trim().length > 0;
  } catch {
    // Not a git checkout; evidence still records digests.
  }
  const controller = new AbortController();
  let browser, app, electronPage, stopping;
  // Nothing to close yet (still launching): the finally block stops whatever launch returns.
  const stopRuntime = () =>
    !app && !browser
      ? Promise.resolve()
      : (stopping ??= (async () => {
          if (app) {
            const child = app.process();
            const force = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }, 4000);
            try {
              await app.close();
            } finally {
              clearTimeout(force);
            }
            assert(child.exitCode !== null || child.signalCode !== null, 'Electron still running');
          } else if (browser) await browser.close();
          summary.cleanup.runtimeClosed = true;
        })());
  const abort = () => controller.abort(externalSignal?.reason ?? new Error('Interrupted'));
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) abort();
  controller.signal.addEventListener(
    'abort',
    () => void stopRuntime().catch((error) => summary.errors.push(`shutdown: ${error.message}`)),
    { once: true },
  );
  const measure = async (name, fn) => {
    controller.signal.throwIfAborted();
    const start = performance.now();
    try {
      return await fn();
    } finally {
      summary.timings[name] = (summary.timings[name] ?? 0) + Math.round(performance.now() - start);
    }
  };

  // The route handler serves whatever variant is current (Electron reuses one window).
  const current = { bundle: null, context: null, blocked: [], overview: '' };
  const routePage = async (context) => {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`${origin}/__overview`))
        return route.fulfill({ contentType: 'text/html', body: current.overview });
      if (url.startsWith(`${origin}/__evidence/`)) {
        const file = path.join(evidence, decodeURIComponent(new URL(url).pathname.slice(12)));
        if (!file.startsWith(evidence + path.sep)) return route.abort();
        return readFile(file).then(
          (body) => route.fulfill({ contentType: 'image/png', body }),
          () => route.abort(),
        );
      }
      const response = current.bundle && pageResponse(url, current.bundle, current.context);
      if (response) return route.fulfill(response);
      current.blocked.push(url);
      return route.abort();
    });
    await context.routeWebSocket('**/*', (socket) => {
      current.blocked.push(socket.url());
      socket.close();
    });
  };

  const rows = [];
  let documents = 0;
  try {
    for (const item of plan.pages) {
      const after = await measure('buildMs', () => buildPage(item.definition));
      item.bundles = { after };
      const page = {
        name: item.definition.name,
        real: item.definition.real,
        notCovered: item.definition.notCovered,
        replaced: after.replaced,
        inputCount: after.inputCount,
        sourceDigest: after.sourceDigest,
        bundleDigest: after.bundleDigest,
      };
      if (options.compare) {
        const overlay = compareOverlay(options.compare);
        const loaded = [...after.inputs, ...after.styleInputs];
        // Nothing this page loads differs from the ref: a second render would be identical.
        // New files count too: one may replace a ref file under another extension.
        if (loaded.some((file) => overlay.changed.has(file)))
          item.bundles.before = await measure('buildMs', () => buildPage(item.definition, overlay));
        const relative = (file) => path.relative(root, file);
        page.compare = {
          ref: options.compare,
          replacedFromRef: [...overlay.used].map(relative).sort(),
          newSinceRef: loaded
            .filter(
              (file) =>
                overlay.changed.has(file) &&
                !overlay.atRef.has(file) &&
                !overlay.superseded.has(file),
            )
            .map(relative),
          // Loaded as a module by Tailwind from disk, so both sides use the current version.
          currentOnBothSides: git(['diff', '--name-only', options.compare, '--', TAILWIND_CONFIG])
            .split('\n')
            .filter(Boolean),
        };
      }
      summary.pages.push(page);
    }
    if (options.compare) summary.compare = { ref: options.compare };

    await measure('launchMs', async () => {
      if (options.engine === 'electron') {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|LANG|LC_ALL)$/i.test(
              key,
            ),
          ),
        );
        const first = plan.pages[0].variants[0].viewport;
        // Playwright's Electron launcher always installs signal handlers that exit(130) before
        // the CLI can write the summary and remove scratch data; the CLI owns interrupts instead.
        const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
        const ownListeners = new Map(signals.map((name) => [name, process.listeners(name)]));
        app = await _electron.launch({
          executablePath: require('electron'),
          args: [fileURLToPath(new URL('./electron.cjs', import.meta.url))],
          timeout: options.timeout,
          env: {
            ...env,
            CINDY_UI_PROFILE: path.join(scratch, 'profile'),
            CINDY_UI_BUNDLE_DIR: path.join(scratch, 'bundle'),
            CINDY_UI_EVIDENCE_DIR: evidence,
            CINDY_UI_WIDTH: String(first.width),
            CINDY_UI_HEIGHT: String(first.height),
            CINDY_UI_PREVIEW: options.mode === 'preview' ? '1' : '0',
          },
        });
        for (const name of signals)
          for (const listener of process.listeners(name))
            if (!ownListeners.get(name).includes(listener)) process.off(name, listener);
        electronPage = await app.firstWindow({ timeout: options.timeout });
        // Electron serves the test origin itself (electron.cjs) and cancels any other request.
        electronPage.on('requestfailed', (request) => {
          if (new URL(request.url()).origin !== origin) current.blocked.push(request.url());
        });
        summary.versions = await app.evaluate(() => ({
          electron: process.versions.electron,
          chrome: process.versions.chrome,
        }));
      } else {
        const executablePath = browserPath(options.browser);
        browser = await chromium.launch({
          executablePath,
          headless: options.mode !== 'preview',
          timeout: options.timeout,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
        });
        summary.versions = { chrome: browser.version(), executablePath };
      }
    });

    let usedElectronWindow = false;
    const freshElectronPage = async (size) => {
      if (usedElectronWindow) {
        // A new target clears both Chromium emulation and Playwright's cached
        // viewport/fullscreen state, even after a failed scenario. Reuse the same
        // isolated process/session and the host's one secure window factory.
        const ready = app.waitForEvent('window', { timeout: options.timeout });
        await app.evaluate(({ app, BrowserWindow }, viewport) => {
          const old = BrowserWindow.getAllWindows();
          app.emit('ui-check:create-window', viewport);
          for (const window of old) window.destroy();
        }, size);
        electronPage = await ready;
        electronPage.on('requestfailed', (request) => {
          if (new URL(request.url()).origin !== origin) current.blocked.push(request.url());
        });
      }
      usedElectronWindow = true;
      // Windows may clamp a newly created native window to the display work area.
      // Size it after creation, as for the first window; the renderer assertion
      // below remains exact, including tall screenshot fixtures.
      await app.evaluate(({ BrowserWindow }, viewport) => {
        BrowserWindow.getAllWindows()[0].setContentSize(viewport.width, viewport.height);
      }, size);
      return electronPage;
    };

    // Resources go into `opened` as soon as they exist, so a variant that fails to start is
    // still screenshotted, its listeners removed and its context closed by the caller.
    const openVariant = async (variant, bundle, definition, opened = {}) => {
      let page, context;
      if (app) {
        page = await freshElectronPage(variant.viewport);
      } else {
        context = await browser.newContext({
          viewport: variant.viewport,
          // Same density as a Retina Mac and as the Electron runner, so crops are comparable.
          deviceScaleFactor: 2,
          serviceWorkers: 'block',
          reducedMotion: 'reduce',
          colorScheme: variant.theme,
          locale: variant.locale,
        });
        await routePage(context);
        page = await context.newPage();
      }
      await page.emulateMedia({ colorScheme: variant.theme, reducedMotion: 'reduce' });
      const errors = [];
      const onError = (error) => errors.push(error.message);
      const onConsole = (message) => {
        if (message.type() === 'error') errors.push(message.text());
      };
      page.on('pageerror', onError);
      page.on('console', onConsole);
      Object.assign(opened, {
        page,
        context,
        errors,
        detach: () => {
          page.off('pageerror', onError);
          page.off('console', onConsole);
        },
      });
      if (app) await writeBundle(path.join(scratch, 'bundle'), bundle);
      current.bundle = bundle;
      current.blocked = [];
      current.context = {
        page: variant.page,
        case: variant.case,
        theme: variant.theme,
        locale: variant.locale,
        platform: variant.platform,
        viewport: variant.viewport,
        data: definition.cases[variant.case]?.data ?? {},
        storage: definition.cases[variant.case]?.storage,
      };
      page.setDefaultTimeout(Math.min(options.timeout, 10000));
      if (app) {
        const document = `/variant-${++documents}.html`;
        current.document = path.join(scratch, 'bundle', document);
        await writeFile(current.document, pageResponse(`${origin}/`, bundle, current.context).body);
        await page.goto(`${origin}${document}`);
      } else await page.goto(`${origin}/?variant=${encodeURIComponent(variant.id)}`);
      await page
        .waitForFunction(
          () => window.__uiPage?.ready || document.documentElement.dataset.uiPageError,
          undefined,
          { timeout: options.timeout },
        )
        .catch((error) => {
          throw new Error(
            `mountPage() never finished${errors.length ? `: ${errors[0]}` : ''} (${error.message.split('\n')[0]})`,
          );
        });
      const startupError = await page.evaluate(() => document.documentElement.dataset.uiPageError);
      if (startupError) throw new Error(`page failed to start: ${startupError}`);
      await definition.ready?.(page);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})));
      });
      if (app) {
        const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.deepEqual(actual, variant.viewport, 'Electron window matches the variant viewport');
      }
      return opened;
    };

    const runVariant = async (item, variant, role) => {
      const definition = item.definition;
      // Lets an observer (the runner self-test) act once a variant is in progress.
      if (process.env.CINDY_UI_PROGRESS) process.stderr.write(`UI_VARIANT ${variant.id} ${role}\n`);
      const dir = path.join(variant.id, role === 'before' ? 'before' : '');
      await mkdir(path.join(evidence, dir), { recursive: true });
      const result = {
        id: variant.id,
        role,
        page: variant.page,
        case: variant.case,
        about: definition.cases[variant.case]?.about,
        theme: variant.theme,
        locale: variant.locale,
        platform: variant.platform,
        viewport: variant.viewport,
        status: 'failed',
        screenshots: [],
        errors: [],
        warnings: [],
        hostMissing: [],
        focus: [],
        timings: {},
      };
      let opened;
      let timer;
      let work;
      // After a timeout or interrupt the scenario may still be running; it must not capture anymore.
      let timedOut = false;
      let interrupted = false;
      const started = performance.now();
      // Generic checks run at every capture, so states reached in check() (open menus, new
      // messages) are checked too. Host mutations are checked once after check().
      const audited = { errors: new Set(), warnings: new Set(), hostMissing: new Set() };
      const auditPage = async () => {
        const audit = await opened.page.evaluate(pageAudit);
        const outcome = auditOutcome({ ...audit, mutations: [] });
        for (const error of outcome.errors) audited.errors.add(error);
        for (const warning of outcome.warnings) audited.warnings.add(warning);
        for (const name of audit.hostMissing) audited.hostMissing.add(name);
      };
      const mergeAudits = () => {
        result.warnings.push(...audited.warnings);
        result.hostMissing = [...audited.hostMissing];
        if (role === 'after' && options.mode === 'check') result.errors.push(...audited.errors);
      };
      const capture = async (name, captureOptions = {}, { audit = true, failure = false } = {}) => {
        if ((timedOut || interrupted) && !failure)
          throw new Error(`variant stopped before capture ${name}`);
        const file = path.join(dir, `${name}.png`);
        const target = captureOptions.locator ?? opened.page;
        await target.screenshot({ path: path.join(evidence, file), timeout: 5000, scale: 'css' });
        result.screenshots.push(file.split(path.sep).join('/'));
        if (options.focus && !captureOptions.locator) await captureFocus(name);
        if (audit) await auditPage();
      };
      // `--focus`: a 2x crop around one element plus its measured box, so small spacing and
      // truncation changes are readable without opening the full screenshot.
      const captureFocus = async (name) => {
        const element = opened.page.locator(options.focus).first();
        const box = (await element.count()) ? await element.boundingBox() : null;
        // Absent at some captures is normal (e.g. before an event shows it).
        if (!box) return;
        const pad = 16;
        const { width, height } = variant.viewport;
        const x = Math.max(0, box.x - pad);
        const y = Math.max(0, box.y - pad);
        const clip = {
          x,
          y,
          width: Math.min(width, box.x + box.width + pad) - x,
          height: Math.min(height, box.y + box.height + pad) - y,
        };
        const file = path.join(dir, `${name}.focus.png`);
        await opened.page.screenshot({
          path: path.join(evidence, file),
          clip,
          scale: 'device',
          timeout: 5000,
        });
        const metrics = await element.evaluate((el) => {
          const style = getComputedStyle(el);
          const text = [...el.querySelectorAll('*')]
            .concat(el)
            .filter((node) => node.scrollWidth > node.clientWidth + 1);
          return {
            padding: style.padding,
            gap: style.gap,
            font: `${style.fontSize}/${style.lineHeight} ${style.fontWeight}`,
            clippedChildren: text.length,
          };
        });
        result.focus.push({
          capture: name,
          file: file.split(path.sep).join('/'),
          box: {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          },
          ...metrics,
        });
      };
      try {
        work = (async () => {
          opened = {};
          await openVariant(variant, item.bundles[role], definition, opened);
          result.timings.readyMs = Math.round(performance.now() - started);
          const { page } = opened;
          if (definition.adhoc && options.cases === 'all' && !item.expanded) {
            item.expanded = true;
            const cases = await page.evaluate(() => window.__uiPage.cases ?? null);
            if (cases?.length) {
              definition.cases = Object.fromEntries(cases.map((name) => [name, { about: name }]));
              const all = variantsFor(definition, { ...options, cases: 'all' });
              Object.assign(variant, all[0]);
              Object.assign(result, { id: variant.id, case: variant.case, about: variant.case });
              // Replace the provisional `default` variants with the declared case matrix.
              item.variants.splice(0, item.variants.length, variant, ...all.slice(1));
            }
          }
          await capture('initial');
          // The pre-change side replays the same steps so every capture has a counterpart;
          // its assertions only describe the old code and never fail the run.
          if (options.mode === 'check') {
            const checkStarted = performance.now();
            const ui = {
              ...variant,
              data: current.context.data,
              definition,
              page,
              capture,
              t: (key, values) => page.evaluate(([k, v]) => window.__uiPage.t(k, v), [key, values]),
              emit: (name, payload) =>
                page.evaluate(([n, p]) => window.__uiPage.emit(n, p), [name, payload]),
            };
            if (role === 'after') await definition.check?.call(definition, page, ui);
            else
              await definition.check?.call(definition, page, ui).catch((error) => {
                result.warnings.push(
                  `check on ${options.compare} stopped: ${String(error.message).split('\n')[0]}`,
                );
              });
            result.timings.checkMs = Math.round(performance.now() - checkStarted);
            const mutations = await page.evaluate(() => window.__uiPage.mutations);
            if (mutations.length && role === 'after')
              result.errors.push(`host mutations attempted: ${mutations.join(', ')}`);
            if (
              definition.check &&
              !result.screenshots.includes(`${dir ? `${dir}/` : ''}final.png`)
            )
              await capture('final');
          }
        })();
        work.catch(() => {});
        await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error(`variant timed out after ${options.timeout}ms`));
              // Unblock pending Playwright calls. Chromium: close this variant's context.
              // Electron: leave the page; only a hung renderer costs the shared window.
              if (opened?.context) void opened.context.close().catch(() => {});
              else if (app)
                void Promise.race([
                  electronPage.goto('about:blank'),
                  delay(3000).then(() => Promise.reject(new Error('renderer hung'))),
                ]).catch(() => stopRuntime().catch(() => {}));
            }, options.timeout);
          }),
          new Promise((_, reject) => {
            const stop = () => {
              interrupted = true;
              reject(controller.signal.reason);
            };
            if (controller.signal.aborted) stop();
            controller.signal.addEventListener('abort', stop, { once: true });
          }),
        ]);
        mergeAudits();
        if (opened?.errors) result.errors.push(...opened.errors);
        if (options.focus && !result.focus.length)
          result.warnings.push(`focus ${options.focus} was not visible at any capture`);
        if (current.blocked.length)
          result.errors.push(`unexpected network requests: ${current.blocked.join(', ')}`);
        if (role === 'before') result.status = 'captured';
        else result.status = result.errors.length ? 'failed' : 'passed';
      } catch (error) {
        result.errors.unshift(String(error?.stack ?? error));
        mergeAudits();
        if (opened?.errors) result.errors.push(...opened.errors);
        if (result.hostMissing.length === 0 && opened?.page && !opened.page.isClosed())
          result.hostMissing = await opened.page
            .evaluate(() => window.__uiPage?.hostMissing ?? [])
            .catch(() => []);
        if (opened?.page && !opened.page.isClosed())
          await capture('failure', {}, { audit: false, failure: true }).catch(() => {});
        result.status = role === 'before' ? 'before-failed' : 'failed';
      } finally {
        clearTimeout(timer);
        if (timedOut || interrupted) {
          // Pending Playwright calls fail within the page default timeout once the page is gone;
          // an interrupt closes the runtime, so they fail at once.
          const settled = await Promise.race([
            work.then(
              () => true,
              () => true,
            ),
            delay(timedOut ? Math.min(options.timeout, 10000) + 2000 : 2000).then(() => false),
          ]);
          if (!settled)
            summary.strandedScenarios = [...(summary.strandedScenarios ?? []), variant.id];
          // A stranded scenario still owns callbacks into shared runner/report state.
          // Stop rather than allow it to contaminate the following variants.
          if (!settled && app && !interrupted) {
            const error = new Error(
              `${variant.id} was still running after its timeout; stopped the run so it cannot affect later variants`,
            );
            result.errors.push(error.message);
            controller.abort(error);
          }
        }
        opened?.detach?.();
        if (opened?.context) await opened.context.close().catch(() => {});
        result.timings.totalMs = Math.round(performance.now() - started);
      }
      summary.variants.push(result);
      return result;
    };

    if (options.mode === 'preview') {
      const item = plan.pages[0];
      const variant = item.variants[0];
      let definition = item.definition;
      const opened = await openVariant(variant, item.bundles.after, definition);
      summary.status = 'preview-open';
      console.log(
        `UI_PREVIEW_READY ${evidence}\n关闭窗口或按 Ctrl+C 结束；源文件变化会重新编译并重置场景。`,
      );
      let reloads = 0;
      while (!controller.signal.aborted && !opened.page.isClosed()) {
        await delay(750, undefined, { signal: controller.signal }).catch(() => {});
        if (controller.signal.aborted || opened.page.isClosed()) break;
        if (!(await inputsChanged(item.bundles.after.fingerprints))) continue;
        try {
          // The scenario file may have changed too: reload its data, stubs and viewport.
          definition = item.definition = await reloadPage(definition);
          const scenario = definition.cases[variant.case];
          if (!scenario) throw new Error(`case ${variant.case} no longer exists`);
          item.bundles.after = await buildPage(definition);
          current.bundle = item.bundles.after;
          const viewport = options.viewports?.[0] ?? scenario.viewport ?? definition.viewport;
          current.context = {
            ...current.context,
            data: scenario.data ?? {},
            storage: scenario.storage,
            viewport,
          };
          if (app)
            await app.evaluate(({ BrowserWindow }, size) => {
              BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
            }, viewport);
          else await opened.page.setViewportSize(viewport);
          if (app) {
            await writeBundle(path.join(scratch, 'bundle'), current.bundle);
            await writeFile(
              current.document,
              pageResponse(`${origin}/`, current.bundle, current.context).body,
            );
          }
          await opened.page.reload();
          await opened.page.waitForFunction(() => window.__uiPage?.ready);
          reloads++;
          await opened.page.screenshot({ path: path.join(evidence, `reload-${reloads}.png`) });
          console.log('UI_PREVIEW_RELOADED');
        } catch (error) {
          console.error(`预览更新失败：${error.message}。修正文件后会再次尝试。`);
        }
      }
      summary.reloads = reloads;
      summary.status = opened.errors.length || current.blocked.length ? 'failed' : 'preview-closed';
      summary.errors.push(...opened.errors, ...current.blocked.map((url) => `blocked ${url}`));
    } else {
      for (const item of plan.pages) {
        for (let index = 0; index < item.variants.length; index++) {
          controller.signal.throwIfAborted();
          const variant = item.variants[index];
          const before = item.bundles.before
            ? await measure('variantsMs', () => runVariant(item, variant, 'before'))
            : null;
          const after = await measure('variantsMs', () => runVariant(item, variant, 'after'));
          rows.push({
            title: `${variant.page} · ${variant.case}`,
            subtitle: `${variant.theme} · ${variant.locale} · ${variant.viewport.width}×${variant.viewport.height}`,
            status: after.status,
            warnings: after.warnings.length,
            // Before/after of the same capture sit side by side.
            images: (after.focus.length
              ? after.focus.map((item) => item.file)
              : after.screenshots
            ).flatMap((src) => {
              const name = path.basename(src, '.png');
              const pair = (
                before?.focus.length ? before.focus.map((item) => item.file) : before?.screenshots
              )?.find((file) => path.basename(file, '.png') === name);
              return [
                ...(pair ? [{ src: pair, label: `${name} · ${options.compare}` }] : []),
                { src, label: before ? `${name} · now` : name },
              ];
            }),
          });
          if (app && app.process().exitCode !== null)
            throw new Error('Electron exited during the run');
        }
      }
      await measure('overviewMs', async () => {
        if (app) await freshElectronPage({ width: 1600, height: 900 });
        const context = app
          ? electronPage.context()
          : await browser.newContext({ viewport: { width: 1600, height: 900 } });
        if (!app) await routePage(context);
        const page = app ? electronPage : await context.newPage();
        // A few rows per image keeps each overview readable when opened at screen size.
        summary.overviews = [];
        for (let start = 0; start < rows.length; start += OVERVIEW_ROWS) {
          const suffix = start ? `-${start / OVERVIEW_ROWS + 1}` : '';
          current.overview = overviewHtml(rows.slice(start, start + OVERVIEW_ROWS));
          if (app) {
            await writeFile(
              path.join(scratch, 'bundle', `overview${suffix}.html`),
              current.overview,
            );
            await page.goto(`${origin}/overview${suffix}.html`);
          } else await page.goto(`${origin}/__overview?${suffix}`);
          await page.evaluate(async () => {
            await Promise.all(
              Array.from(document.images).map((img) => img.decode().catch(() => {})),
            );
          });
          const file = path.join(evidence, `overview${suffix}.png`);
          await page.screenshot({ path: file, fullPage: true, scale: 'css' });
          summary.overviews.push(file);
        }
        summary.overview = summary.overviews[0] ?? null;
        if (!app) await context.close();
      });
      const failed = summary.variants.filter(
        (variant) => variant.role === 'after' && variant.status !== 'passed',
      );
      summary.status = failed.length ? 'failed' : 'passed';
    }
  } catch (error) {
    summary.status = 'failed';
    summary.errors.push(String(controller.signal.reason?.stack ?? error?.stack ?? error));
  } finally {
    externalSignal?.removeEventListener('abort', abort);
    const closingAt = performance.now();
    try {
      await stopRuntime();
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
      summary.cleanup.scratchRemoved = !existsSync(scratch);
    } catch (error) {
      summary.status = 'failed';
      summary.cleanup.error = error.message;
    }
    if (!browser && !app) summary.cleanup.runtimeClosed = true;
    summary.timings.closeMs = Math.round(performance.now() - closingAt);
    summary.timings.totalMs = Math.round(performance.now() - startedAt);
    summary.finishedAt = new Date().toISOString();
    await writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
  }
  return summary;
}
