// Runner self-test: `pnpm ui:check:selftest`. It drives the real CLI against throwaway
// entries, so it is node:test (not vitest) and opens Electron; it is not part of test:unit.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPlan } from './run.mjs';
import { adhocPage } from './registry.mjs';
import { parseOptions, variantsFor } from './options.mjs';
import { scanPage, buildPage } from './build.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const harness = fileURLToPath(new URL('./harness/index.tsx', import.meta.url));
let dir;

function run(args, { interruptWhenRunning } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, NODE_DEBUG: '', CINDY_UI_PROGRESS: '1' };
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let interrupted = false;
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      // Interrupt as soon as the runtime is up and a variant is waiting on the page.
      if (interruptWhenRunning && !interrupted && /^UI_VARIANT /m.test(stderr)) {
        interrupted = true;
        child.kill('SIGINT');
      }
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const leftoverRunners = () => {
  try {
    return execFileSync('pgrep', ['-f', 'ui-page/electron.cjs'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

async function entry(name, source) {
  const file = path.join(dir, `${name}.tsx`);
  await writeFile(file, `import { mountPage, forbid } from ${JSON.stringify(harness)};\n${source}`);
  return file;
}

before(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cindy-ui-selftest-')));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// GIF encoding now imports a Vite worker. Guard the real worker runtime, transfer
// semantics and source tracking; replacing it with a synchronous stub would hide
// precisely the scheduling boundary the recording tests need. Explicit E2E tier.
test('bundles a real worker and tracks its transitive sources for compare and changed scans', async () => {
  const value = path.join(dir, 'worker-value.ts');
  const worker = path.join(dir, 'sample.worker.ts');
  await writeFile(value, 'export const value = 17;');
  await writeFile(worker, `import { value } from './worker-value';
self.onmessage = ({ data }) => {
  if (typeof document !== 'undefined') throw new Error('Worker ran on the page');
  data[0] += value;
  self.postMessage(data, [data.buffer]);
};`);
  const file = await entry('worker', `import SampleWorker from './sample.worker.ts?worker';
const worker = new SampleWorker();
const input = new Uint8Array([3]);
await new Promise<void>((resolve, reject) => {
  worker.onerror = reject;
  worker.onmessage = ({ data }) => { worker.terminate(); data[0] === 20 ? resolve() : reject(new Error('Wrong worker result')); };
  worker.postMessage(input, [input.buffer]);
  if (input.byteLength !== 0) reject(new Error('Input was not transferred'));
});
mountPage({ render: () => <div>Worker finished</div> });`);
  const definition = adhocPage(file);
  const scanned = await scanPage(definition);
  assert.ok(scanned.inputs.includes(value));
  const bundle = await buildPage(definition);
  const alternate = await buildPage(definition, {
    has: file => file === value,
    get: file => file === value ? 'export const value = 18;' : undefined,
    resolve: () => undefined,
  });
  assert.notEqual(bundle.fingerprints.get(value), alternate.fingerprints.get(value));
  assert.notEqual(bundle.bundleDigest, alternate.bundleDigest);
  assert.equal((await run(['--entry', file, '--theme', 'light', '--json'])).code, 0);
});

test('one run reports each failure kind on its own variant', async () => {
  const file = await entry(
    'matrix',
    `
function Page({ kind }: { kind: string }) {
  if (kind === 'throws') throw new Error('selftest render failure');
  if (kind === 'network') void fetch('https://example.com/selftest').catch(() => {});
  if (kind === 'mutation') try { (window as any).electronAPI.maker.send({}); } catch {}
  if (kind === 'missing') void (window as any).electronAPI.selftest?.unknownCall;
  return kind === 'raw-key' ? (
    <div>
      <p>bots.list.startChat</p>
      <p>bots.send</p>
      <p>cindy.app</p>
      <p>v1.0.0</p>
    </div>
  ) : (
    <div>Ready <span>v1.0.0</span></div>
  );
}
mountPage({
  cases: ['ok', 'throws', 'network', 'mutation', 'missing', 'raw-key'],
  host: { maker: { send: forbid('maker.send') } },
  render: (ctx) => <Page kind={ctx.case} />,
});
`,
  );
  const { code, stdout } = await run([
    '--entry',
    file,
    '--case',
    'all',
    '--json',
    '--timeout',
    '8000',
  ]);
  assert.equal(code, 1);
  const summary = JSON.parse(stdout);
  const byCase = Object.fromEntries(summary.variants.map((variant) => [variant.case, variant]));
  assert.deepEqual(Object.keys(byCase).sort(), [
    'missing',
    'mutation',
    'network',
    'ok',
    'raw-key',
    'throws',
  ]);
  assert.equal(byCase.ok.status, 'passed');
  assert.ok(existsSync(path.join(summary.evidence, byCase.ok.screenshots[0])));
  assert.match(byCase.throws.errors.join('\n'), /selftest render failure/);
  assert.match(byCase.network.errors.join('\n'), /example\.com/);
  assert.match(byCase.mutation.errors.join('\n'), /maker\.send/);
  assert.equal(byCase.missing.status, 'passed');
  assert.ok(byCase.missing.hostMissing.some((key) => key.startsWith('selftest')));
  // Two-segment keys count when they are real keys; ordinary dotted text does not.
  assert.match(byCase['raw-key'].errors.join('\n'), /bots\.list\.startChat, bots\.send$/m);
  assert.ok(existsSync(path.join(summary.evidence, 'summary.json')));
  // The PR description lists the failing variants it came from.
  assert.match(await readFile(summary.pr, 'utf8'), /未通过：`entry\.throws\./);
});

// Windows regression: forced 2x DPI plus native window decorations added one
// CSS pixel, and hidden windows could not capture a frame. Drive the real CLI
// across sizes/themes and inspect PNG dimensions; existing failure tests do not
// verify resizing. Dedicated Electron integration tier, not default unit tests.
test('captures exact viewports and overviews in a hidden Electron window', async () => {
  const file = await entry('viewport', 'mountPage({ render: () => <div>Viewport ready</div> });');
  const options = parseOptions([
    '--entry',
    file,
    '--engine',
    'electron',
    '--theme',
    'all',
    '--viewport',
    '560x400,360x640',
    '--json',
  ]);
  const definition = adhocPage(file);
  // Integration regression: region capture changes CDP viewport size. It must not
  // leak into the next variant, even when a scenario fails after changing it.
  definition.check = async (page, ui) => {
    if (ui.theme === 'light' && ui.viewport.width === 560) {
      await page.setViewportSize({ width: 700, height: 500 });
      throw new Error('intentional scenario failure after resizing');
    }
    // Real HTML fullscreen must resolve on the isolated test origin. Media
    // permission remains denied; enabling fullscreen is not a general grant.
    await page.locator('#root').evaluate((el) => el.requestFullscreen());
    assert.equal(await page.evaluate(() => document.fullscreenElement?.id), 'root');
    await page.evaluate(() => document.exitFullscreen());
    assert.equal(await page.evaluate(() => document.fullscreenElement), null);
    assert.equal(
      await page.evaluate(
        async () => (await navigator.permissions.query({ name: 'camera' })).state,
      ),
      'denied',
    );
  };
  const summary = await runPlan(
    { pages: [{ definition, variants: variantsFor(definition, options) }] },
    options,
  );
  assert.equal(summary.status, 'failed');
  assert.equal(summary.variants.length, 4);
  for (const variant of summary.variants) {
    if (variant === summary.variants[0])
      assert.match(variant.errors.join('\n'), /intentional scenario failure/);
    else assert.equal(variant.status, 'passed', JSON.stringify(variant.errors));
    assert.ok(variant.screenshots.length);
    const png = await readFile(path.join(summary.evidence, variant.screenshots[0]));
    assert.deepEqual(
      { width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
      variant.viewport,
    );
  }
  assert.ok(summary.overviews.length);
  for (const overview of summary.overviews) assert.ok(existsSync(overview));
  assert.equal(summary.cleanup.scratchRemoved, true);
});

// #7395 extended UI regression: the idle editor installs a 900x400 CDP
// override. The next theme must return to its declared native 900x700 viewport.
// The existing viewport test never resizes within a scenario. Electron tier.
test('a scenario viewport resize does not leak into the next theme', async () => {
  const { code, stdout } = await run([
    '--page', 'region-capture', '--case', 'idle', '--theme', 'all', '--json',
  ]);
  const summary = JSON.parse(stdout);
  assert.equal(code, 0, JSON.stringify(summary.variants.map((v) => v.errors)));
  assert.equal(summary.variants.length, 2);
  assert.ok(summary.variants.every((v) => v.status === 'passed'));
  assert.equal(summary.cleanup.runtimeClosed, true);
});

test('a page that never mounts fails at the timeout and leaves no runtime behind', async () => {
  const file = await entry('stuck', `export {};\n`);
  const started = Date.now();
  const { code, stdout } = await run(['--entry', file, '--json', '--timeout', '1000']);
  assert.equal(code, 1);
  assert.match(
    JSON.parse(stdout).variants[0].errors.join('\n'),
    /mountPage\(\) never finished|timed out/,
  );
  assert.ok(Date.now() - started < 15000);
  assert.equal(leftoverRunners(), '');
});

// Windows has no POSIX signals: a child killed with 'SIGINT' is terminated outright, so the
// CLI's own interrupt handling cannot be observed from here.
test(
  'an interrupt still writes the summary and stops the runtime',
  {
    skip: process.platform === 'win32' && 'Windows cannot deliver SIGINT to the child',
  },
  async () => {
    // Never mounts, so the run is still waiting when the interrupt arrives.
    const file = await entry('waiting', `export {};\n`);
    const { code, stdout } = await run(['--entry', file, '--timeout', '60000'], {
      interruptWhenRunning: true,
    });
    assert.equal(code, 1);
    const summaryFile = /summary:\s+(\S+)/.exec(stdout)?.[1];
    assert.ok(summaryFile, stdout);
    const summary = JSON.parse(await readFile(summaryFile, 'utf8'));
    assert.match(summary.errors.join('\n'), /用户中断/);
    assert.equal(leftoverRunners(), '');
  },
);

// UI integration tier: Kimi's quota warning uses the existing accessible-only
// label. The audit must distinguish it from an actually clipped visible label.
test('clipping audit ignores accessible-only text but retains visible clipping warnings', async () => {
  const file = await entry('accessible-clipping', `mountPage({render:()=> <main>
    <span className="sr-only">Accessible quota warning</span>
    <span style={{display:'block',width:20,overflow:'hidden',whiteSpace:'nowrap'}}>Visible quota warning clipped</span>
  </main>});`);
  const result = await run(['--entry', file, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const warnings = report.variants.flatMap(variant => variant.warnings);
  assert.ok(warnings.some(warning => warning.includes('Visible quota warning clipped')));
  assert.ok(!warnings.some(warning => warning.includes('Accessible quota warning')));
});
