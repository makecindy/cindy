#!/usr/bin/env node
// Bring bundled agent runtimes to upstream latest, then prove them before keeping the pins.
//
//   node scripts/vendor-update.mjs [--kinds=claude,claude-sdk,codex,codex-cli,pi,ripgrep]
//                                  [--min-age-hours=N] [--gate-only] [--versions-from=<build-info.json>]
//
// Versioned desktop packaging (apps/desktop/scripts/package-desktop.mjs) calls updateVendors()
// so every release floats to the newest upstream components; this CLI runs the same path.
//
// For each kind this runs the existing updater (tools/<kind>/update.mjs). The updaters verify
// every download against upstream checksums (Claude: official release manifest; Codex / Pi:
// GitHub asset digests; ripgrep: official .sha256) and rewrite tools/<kind>/latest.json with
// per-platform URLs and SHA-256 for all platforms. Then the gate runs on the real binaries:
//   1. version probes                 each binary runs and reports the pinned version
//   2. scripts/smoke-claude-sdk.mjs   real Agent SDK + Claude CLI against a loopback model
//   3. maker-core integration tier    real Claude / Codex / Pi driven by Cindy's agents
// If any step fails, every pin, package.json and lockfile edit is restored and the previous
// binaries are re-ensured, so a broken upstream release never lands.
//
// --gate-only        run the gate on the current pins without bumping.
// --versions-from    reuse the exact versions recorded in another build's build-info.json
//                    (`vendors.components`), so every platform of one release ships the same set.
// --min-age-hours    skip releases younger than N hours. Default 24, the same cooldown mise applies
//                    by default (minimum_release_age = 24h); 0 takes the newest release at once.
// --open-pr          after the gate passes, commit the new pins onto the chore/vendor-pins branch
//                    and open or refresh its pull request (used by the daily CI job and releases).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformKey = `${process.platform}-${process.arch}`;
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

export const VENDOR_KINDS = ['claude', 'claude-sdk', 'codex', 'codex-cli', 'pi', 'ripgrep'];
const SDK = '@anthropic-ai/claude-agent-sdk';
const SDK_MANIFESTS = ['packages/maker-core/package.json', 'packages/maker-cc-manager/package.json'];
const PIN = {
  claude: 'tools/claude/latest.json',
  codex: 'tools/codex-package/latest.json',
  // Standalone Codex CLI: packaged Linux builds download it from this pin (linux-runtime-fallback.ts).
  'codex-cli': 'tools/codex/latest.json',
  pi: 'tools/pi/latest.json',
  ripgrep: 'tools/ripgrep/latest.json',
};
const UPDATER = {
  claude: 'tools/claude/update.mjs',
  codex: 'tools/codex-package/update.mjs',
  'codex-cli': 'tools/codex/update.mjs',
  pi: 'tools/pi/update.mjs',
  ripgrep: 'tools/ripgrep/update.mjs',
};
const BINARY = {
  claude: path.join(root, 'apps/claude-code-bin', platformKey, exe('claude')),
  codex: path.join(root, 'apps/codex-package-bin', platformKey, 'bin', exe('codex')),
  'codex-cli': path.join(root, 'apps/codex-bin', platformKey, exe('codex')),
  pi: path.join(root, 'apps/pi-bin', platformKey, exe('pi')),
  ripgrep: path.join(root, 'apps/ripgrep-bin', platformKey, exe('rg')),
};
const UPSTREAM = {
  claude: { npm: '@anthropic-ai/claude-code' },
  codex: { github: 'openai/codex', tagPrefix: 'rust-v' },
  pi: { github: 'earendil-works/pi', tagPrefix: 'v' },
  ripgrep: { github: 'BurntSushi/ripgrep', tagPrefix: '' },
};

const defaultLog = (msg) => console.log(`\x1b[36m[vendor-update]\x1b[0m ${msg}`);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
export const pinnedVersion = (kind) =>
  kind === 'claude-sdk' ? readJson(SDK_MANIFESTS[0]).dependencies[SDK] : readJson(PIN[kind]).version;

function run(cmd, args, { env = {}, cwd = root, timeout = 15 * 60_000 } = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd, env: { ...process.env, ...env }, stdio: 'inherit', timeout, shell: process.platform === 'win32' && cmd === 'pnpm',
  });
  return { ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000) };
}

async function getJson(url) {
  const headers = { accept: 'application/json', 'user-agent': 'cindy-vendor-update' };
  if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export const DEFAULT_MIN_AGE_HOURS = 24;
export const PIN_BRANCH = 'chore/vendor-pins';
const PIN_FILES = [...Object.values(PIN), ...SDK_MANIFESTS, 'pnpm-lock.yaml'];

const isRelease = (v) => /^\d+\.\d+\.\d+$/.test(v);
const cmpSemver = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

/** Newest stable upstream release that has soaked for minAgeHours. */
async function resolveLatest(kind, minAgeHours) {
  const oldEnough = (at) => !minAgeHours || Date.now() - Date.parse(at) >= minAgeHours * 3_600_000;
  const up = UPSTREAM[kind];
  if (up.npm) {
    const doc = await getJson(`https://registry.npmjs.org/${up.npm}`);
    return Object.keys(doc.versions)
      .filter((v) => isRelease(v) && cmpSemver(v, doc['dist-tags'].latest) <= 0 && oldEnough(doc.time[v]))
      .sort(cmpSemver).at(-1);
  }
  const releases = await getJson(`https://api.github.com/repos/${up.github}/releases?per_page=30`);
  return releases
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(up.tagPrefix) && oldEnough(r.published_at))
    .map((r) => r.tag_name.slice(up.tagPrefix.length))
    .filter(isRelease).sort(cmpSemver).at(-1);
}

/** The SDK ships in lockstep with the CLI: newest soaked SDK built for a CLI no newer than the pin. */
async function resolveSdk(cliVersion, minAgeHours) {
  const doc = await getJson(`https://registry.npmjs.org/${SDK}`);
  const oldEnough = (at) => !minAgeHours || Date.now() - Date.parse(at) >= minAgeHours * 3_600_000;
  return Object.values(doc.versions)
    .filter((m) => isRelease(m.version) && m.claudeCodeVersion && cmpSemver(m.claudeCodeVersion, cliVersion) <= 0 && oldEnough(doc.time[m.version]))
    .map((m) => m.version).sort(cmpSemver).at(-1);
}

/** What a build shipped, for build-info.json: exact versions plus every platform's upstream URL and SHA-256. */
export function vendorRecord() {
  const components = {};
  for (const kind of VENDOR_KINDS) {
    if (kind === 'claude-sdk') { components[kind] = { version: pinnedVersion(kind) }; continue; }
    const pin = readJson(PIN[kind]);
    components[kind] = { version: pin.version, ...(pin.runtimeAssets ? { runtimeAssets: pin.runtimeAssets } : {}) };
  }
  return components;
}

/**
 * Bump to `target` ('latest' | 'pinned' | { [kind]: { version } }), then run the gate.
 * Throws after restoring the previous pins when an update or any gate step fails.
 */
export async function updateVendors({ target = 'latest', kinds = VENDOR_KINDS, minAgeHours = DEFAULT_MIN_AGE_HOURS, log = defaultLog } = {}) {
  for (const k of kinds) if (!VENDOR_KINDS.includes(k)) throw new Error(`Unknown kind ${k} (known: ${VENDOR_KINDS.join(', ')})`);
  const snapshot = new Map(PIN_FILES.map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]));
  const changes = [];
  const restore = () => {
    log('restoring previous pins');
    for (const [rel, text] of snapshot) fs.writeFileSync(path.join(root, rel), text);
    const changed = changes.map((c) => c.kind);
    if (changed.includes('claude-sdk')) run('pnpm', ['install', '--frozen-lockfile'], { env: { XDT_SKIP_AGENT_BIN_INSTALL: '1' } });
    if (changed.includes('codex-cli')) run(process.execPath, [UPDATER['codex-cli'], `--version=${pinnedVersion('codex-cli')}`, `--platform=${platformKey}`]);
    const ensured = changed.filter((k) => k !== 'claude-sdk' && k !== 'codex-cli');
    if (ensured.length) run(process.execPath, ['scripts/ensure-agent-binaries.mjs', `--kinds=${ensured.join(',')}`]);
  };
  const fail = (message) => { restore(); throw new Error(message); };

  // ── Bump ──
  const desired = async (kind) => {
    if (typeof target === 'object') return target[kind]?.version;
    if (kind === 'codex-cli') return pinnedVersion('codex'); // keep the CLI on the package's version
    if (kind === 'claude-sdk') return resolveSdk(pinnedVersion('claude'), minAgeHours);
    return resolveLatest(kind, minAgeHours);
  };
  if (target !== 'pinned') {
    // Order matters: codex-cli follows codex, the SDK follows the Claude CLI.
    for (const kind of ['claude', 'codex', 'codex-cli', 'pi', 'ripgrep', 'claude-sdk'].filter((k) => kinds.includes(k))) {
      const from = pinnedVersion(kind);
      const to = await desired(kind);
      if (!to) fail(`${kind}: no upstream release found${minAgeHours ? ` older than ${minAgeHours}h` : ''}`);
      if (to === from) { log(`${kind}: ${from} is current`); continue; }
      // Floating never moves backwards: the soak window can hide a release newer than the pin.
      if (target === 'latest' && cmpSemver(to, from) < 0) { log(`${kind}: keeping ${from} (newest soaked release is ${to})`); continue; }
      log(`${kind}: ${from} → ${to}`);
      changes.push({ kind, from, to });
      if (kind === 'claude-sdk') {
        for (const rel of SDK_MANIFESTS) {
          const file = path.join(root, rel);
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`"${SDK}": "${from}"`, `"${SDK}": "${to}"`));
        }
        if (!run('pnpm', ['install', '--no-frozen-lockfile'], { env: { XDT_SKIP_AGENT_BIN_INSTALL: '1' } }).ok) fail('claude-sdk: pnpm install failed');
      } else if (!run(process.execPath, [UPDATER[kind], `--version=${to}`, `--platform=${platformKey}`]).ok) {
        fail(`${kind}: updater failed for ${to} (download or checksum verification)`);
      }
    }
  }
  // Pinned builds still gate the exact binaries; make sure they are present first.
  if (!run(process.execPath, ['scripts/ensure-agent-binaries.mjs', '--kinds=claude,codex,pi,ripgrep']).ok) fail('could not ensure pinned binaries');
  if (!fs.existsSync(BINARY['codex-cli']) && !run(process.execPath, [UPDATER['codex-cli'], `--version=${pinnedVersion('codex-cli')}`, `--platform=${platformKey}`]).ok) {
    fail('could not ensure the standalone Codex CLI');
  }

  // ── Gate ──
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-vendor-gate-'));
  const steps = [];
  const step = (name, r) => { steps.push({ name, ok: r.ok, seconds: r.seconds }); log(`${r.ok ? 'PASS' : 'FAIL'} ${name} (${r.seconds}s)`); };
  try {
    for (const kind of ['claude', 'codex', 'codex-cli', 'pi', 'ripgrep']) {
      const r = spawnSync(BINARY[kind], ['--version'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, CODEX_HOME: fs.mkdtempSync(path.join(scratch, 'codex-home-')) },
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0];
      step(`${kind} --version = ${pinnedVersion(kind)} (${out || r.error?.message})`, { ok: r.status === 0 && out.includes(pinnedVersion(kind)), seconds: 0 });
    }
    step('Claude Agent SDK + CLI smoke (scripts/smoke-claude-sdk.mjs)', run(process.execPath, ['scripts/smoke-claude-sdk.mjs', '--cli', BINARY.claude]));

    // The repo's manual `integration` tier for @cindy/maker-core (test-workspaces.config.mjs):
    // Cindy's own ClaudeCodeAgent / CodexAgent / PiAgent driving the real binaries over loopback
    // model servers, with no account and no network model.
    const dirs = { claude: 'src/agents/claude-code/__tests__', codex: 'src/agents/codex', pi: 'src/agents/pi/__tests__' };
    const files = Object.values(dirs).flatMap((dir) => fs.readdirSync(path.join(root, 'packages/maker-core', dir))
      .filter((f) => f.endsWith('.integration.test.ts')).map((f) => `${dir}/${f}`));
    const report = path.join(scratch, 'integration.json');
    const integration = run(process.execPath, [
      path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files,
      '--pool=forks', '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`,
    ], {
      cwd: path.join(root, 'packages/maker-core'),
      env: {
        CINDY_TEST_CLAUDE_BINARY: BINARY.claude, CINDY_TEST_CODEX_BINARY: BINARY.codex, CINDY_CODEX_TEST_BINARY: BINARY.codex,
        CINDY_TEST_PI_BINARY: BINARY.pi, CINDY_PI_MCP_TEST_BINARY: BINARY.pi,
      },
    });
    let detail = 'no report';
    try {
      const json = JSON.parse(fs.readFileSync(report, 'utf8'));
      for (const f of json.testResults) for (const t of f.assertionResults) if (t.status === 'failed') log(`FAILED: ${t.fullName}`);
      // A runtime whose tests all skipped (binary not found) must not read as green.
      const silent = Object.entries(dirs).filter(([, dir]) => !json.testResults.some((f) =>
        f.name.includes(`/${dir}/`) && f.assertionResults.some((t) => t.status === 'passed')));
      for (const [kind] of silent) log(`NOTHING PASSED for ${kind}: its binary was not exercised`);
      integration.ok = integration.ok && json.numFailedTests === 0 && silent.length === 0;
      detail = `${json.numPassedTests} passed, ${json.numFailedTests} failed, ${json.numPendingTests} skipped, ${json.testResults.length} files`;
    } catch { integration.ok = false; }
    step(`maker-core integration tier: ${detail}`, integration);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  for (const c of changes) log(`bumped ${c.kind}: ${c.from} → ${c.to}`);
  const failed = steps.filter((s) => !s.ok);
  if (failed.length) fail(`${failed.length} gate step(s) failed${changes.length ? '; pins restored' : ''}`);
  return { changes, steps, components: vendorRecord() };
}

/**
 * Commit the pin files as they are in the working tree onto PIN_BRANCH (parent = HEAD) and open or
 * refresh its pull request against main. Builds the commit in a scratch index, so the working
 * tree, the index and HEAD stay untouched. Needs push rights on origin and an authenticated `gh`.
 */
export function openPinPullRequest({ changes, steps = [], cwd = root, log = defaultLog }) {
  const git = (args, env = {}, input) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout.trim();
  };
  const gh = (args) => {
    const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout.trim();
  };
  git(['fetch', '--quiet', 'origin', 'main']);
  // A PR parented on an unmerged commit would carry that commit into main too.
  if (spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd }).status !== 0) {
    throw new Error('HEAD is not on origin/main; commit the pin files by hand');
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-vendor-pins-'));
  try {
    const index = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    git(['read-tree', 'HEAD'], index);
    for (const rel of PIN_FILES) {
      const blob = git(['hash-object', '-w', '--', rel]);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], index);
    }
    const tree = git(['write-tree'], index);
    if (tree === git(['rev-parse', 'HEAD^{tree}'])) { log('pin files match HEAD; no pull request needed'); return null; }
    const ident = git(['var', 'GIT_COMMITTER_IDENT']).replace(/ \d+ [+-]\d{4}$/, '');
    const list = changes.map((c) => `${c.kind} ${c.from} → ${c.to}`);
    const message = ['⬆️ chore(vendors): bump agent runtimes to gated releases', '',
      ...list.map((line) => `- :arrow_up: ${line}`), '',
      '- :white_check_mark: smoke and maker-core integration gate passed on the new binaries', '',
      `Signed-off-by: ${ident}`].join('\n');
    const commit = git(['commit-tree', tree, '-p', 'HEAD', '-F', '-'], {}, message);
    // The branch belongs to this automation: each run replaces it with the newest gated set.
    git(['push', '--force', 'origin', `${commit}:refs/heads/${PIN_BRANCH}`]);
    const title = `chore(vendors): 升级 Agent 运行时（${list.join('，')}）`;
    const body = ['## 这次改了什么', '',
      '由 `scripts/vendor-update.mjs` 自动生成：把 Agent 运行时升到上游最新且发布满 24 小时的版本，下载时已按上游校验和验证。', '',
      ...list.map((line) => `- ${line}`), '',
      '## 怎么验证的', '', '在新二进制上跑的测试门：', '',
      ...steps.map((st) => `- ${st.ok ? '✅' : '❌'} ${st.name}`), '',
      '## 风险', '',
      '- 影响范围：Desktop 打包与运行时下载使用的 pin；macOS/Windows 安装后从 CDN 取运行时，需发布侧推送同一组版本。',
      '- 回滚 / 降级方式：revert 本 PR，或打包时传 `--vendors pinned`。'].join('\n');
    const open = JSON.parse(gh(['pr', 'list', '--head', PIN_BRANCH, '--state', 'open', '--json', 'number']) || '[]');
    if (open.length) {
      gh(['pr', 'edit', String(open[0].number), '--title', title, '--body', body]);
      log(`updated pull request #${open[0].number} on ${PIN_BRANCH}`);
      return open[0].number;
    }
    const url = gh(['pr', 'create', '--base', 'main', '--head', PIN_BRANCH, '--title', title, '--body', body]);
    log(`opened ${url}`);
    return url;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const from = arg('versions-from');
  const target = process.argv.includes('--gate-only') ? 'pinned'
    : from ? JSON.parse(fs.readFileSync(path.resolve(from), 'utf8')).vendors.components : 'latest';
  updateVendors({
    target,
    kinds: arg('kinds')?.split(',').filter(Boolean),
    minAgeHours: Number(arg('min-age-hours') ?? DEFAULT_MIN_AGE_HOURS),
  }).then(({ changes, steps }) => {
    if (!changes.length) return defaultLog('gate passed — nothing to bump.');
    if (process.argv.includes('--open-pr')) return openPinPullRequest({ changes, steps });
    defaultLog('gate passed — commit the pin changes (tools/*/latest.json, SDK package.json, pnpm-lock.yaml).');
  }).catch((error) => {
    console.error(`\x1b[31m[vendor-update]\x1b[0m ${error.message}`);
    process.exit(1);
  });
}
