// Runner self-test: `pnpm ui:check:selftest`. It drives the real CLI against throwaway
// entries, so it is node:test (not vitest) and opens Electron; it is not part of test:unit.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-ui-selftest-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
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
    </div>
  ) : (
    <div>Ready</div>
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
