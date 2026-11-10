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
// --pins-only        update pins (download + checksum verification only) without running anything
//                    downloaded; for the credentialed PR job, after a credential-free job ran the gate.
// --record=<file>    write the passing versions as {vendors:{components, rejected}} for --versions-from.
// --min-age-hours    skip releases younger than N hours. Default 24, the same cooldown mise applies
//                    by default (minimum_release_age = 24h); 0 takes the newest release at once.
// --open-pr          after the gate passes, commit the new pins onto the chore/vendor-pins branch
//                    and open or refresh its pull request (used by the daily CI job and releases).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

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

// Freshly downloaded upstream code runs in the gate; keep credentials out of its environment.
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY/i;
const untrustedEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));

function run(cmd, args, { env = {}, cwd = root, timeout = 15 * 60_000, untrusted = false } = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd, env: { ...(untrusted ? untrustedEnv() : process.env), ...env }, stdio: 'inherit', timeout,
    shell: process.platform === 'win32' && cmd === 'pnpm',
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
// Cindy Headless example profiles record the runtime they were validated with, and
// production-profile-parity.test.ts requires them to equal the pins (Codex follows tools/codex).
const HEADLESS_PROFILES = 'apps/cindy-headless/profiles';
const HEADLESS_BACKEND_PIN = { 'claude-code': 'claude', codex: 'codex-cli', pi: 'pi' };
const headlessProfileFiles = () => fs.readdirSync(path.join(root, HEADLESS_PROFILES), { recursive: true })
  .filter((f) => f.endsWith('.json')).map((f) => path.posix.join(HEADLESS_PROFILES, f.split(path.sep).join('/'))).sort();
const PIN_FILES = [...Object.values(PIN), ...SDK_MANIFESTS, 'pnpm-lock.yaml', ...headlessProfileFiles()];

/** Point every Headless profile at the current pins and refreeze the production locks. */
export function syncHeadlessProfiles() {
  let changed = false;
  for (const rel of headlessProfileFiles().filter((f) => !f.endsWith('profile.lock.json'))) {
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, 'utf8');
    const kind = HEADLESS_BACKEND_PIN[JSON.parse(text).agentBackend];
    if (!kind) continue;
    const next = text.replace(/("agentBinaryVersion":\s*")[^"]*(")/, `$1${pinnedVersion(kind)}$2`);
    if (next !== text) { fs.writeFileSync(file, next); changed = true; }
  }
  return !changed || run(process.execPath, ['apps/cindy-headless/scripts/freeze-production-profiles.mjs']).ok;
}

const isRelease = (v) => /^\d+\.\d+\.\d+$/.test(v);
const cmpSemver = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

// Cindy appends its continuation rules to Codex's native auto-review policy only for Codex
// versions whose stock policy was captured and compared (maker-core-and-agent-behavior.md).
// That version list is the source of truth; Codex floats only within it.
const CODEX_REVIEW_POLICY = 'packages/maker-core/src/agents/codex/native-auto-review-policy.ts';
export function codexVerifiedVersions() {
  const source = fs.readFileSync(path.join(root, CODEX_REVIEW_POLICY), 'utf8');
  const list = /const version = \/\\\/\(([0-9.\\|]+)\)/.exec(source)?.[1];
  return list ? list.replaceAll('\\', '').split('|').filter(isRelease) : [];
}

/** Newest stable upstream release that has soaked for minAgeHours. */
async function resolveLatest(kind, minAgeHours, log = defaultLog) {
  const oldEnough = (at) => !minAgeHours || Date.now() - Date.parse(at) >= minAgeHours * 3_600_000;
  const up = UPSTREAM[kind];
  if (up.npm) {
    const doc = await getJson(`https://registry.npmjs.org/${up.npm}`);
    return Object.keys(doc.versions)
      .filter((v) => isRelease(v) && cmpSemver(v, doc['dist-tags'].latest) <= 0 && oldEnough(doc.time[v]))
      .sort(cmpSemver).at(-1);
  }
  const releases = await getJson(`https://api.github.com/repos/${up.github}/releases?per_page=30`);
  const soaked = releases
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(up.tagPrefix) && oldEnough(r.published_at))
    .map((r) => r.tag_name.slice(up.tagPrefix.length))
    .filter(isRelease).sort(cmpSemver);
  if (kind !== 'codex') return soaked.at(-1);
  const verified = codexVerifiedVersions();
  const pick = soaked.filter((v) => verified.includes(v)).at(-1);
  if (pick !== soaked.at(-1)) {
    log(`codex: ${soaked.at(-1)} has no verified native auto-review policy; newest verified is ${pick ?? 'none'}. `
      + `Capture and compare it (${CODEX_REVIEW_POLICY}) to float further.`);
  }
  return pick;
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

/** What a packaged platform takes from the pins: bundled (ripgrep, SDK) or fetched at runtime (CDN or Linux fallback). */
const shippedKinds = (platform) => (platform.startsWith('linux-') ? ['claude', 'codex-cli', 'ripgrep'] : ['claude', 'codex', 'pi', 'ripgrep']);

async function sha256OfUrl(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'cindy-vendor-update' }, signal: AbortSignal.timeout(20 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of res.body) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Release builds on the signing machine: confirm every pinned asset the given platforms ship still
 * downloads with the pinned SHA-256 and size, and that the installed SDK is the pinned one. Hashes the
 * download stream in memory; nothing is written to disk or executed. The pins were gated before
 * they landed (vendor-update.yml runs the gate on every pin change).
 */
export async function verifyPinnedVendors({ platforms, log = defaultLog }) {
  const sdk = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', SDK, 'package.json'), 'utf8')).version;
  if (sdk !== pinnedVersion('claude-sdk')) throw new Error(`claude-sdk: node_modules has ${sdk}, pin is ${pinnedVersion('claude-sdk')}; run pnpm install`);
  const checks = platforms.flatMap((platform) => shippedKinds(platform).map((kind) => ({ kind, platform })));
  const results = await Promise.all(checks.map(async ({ kind, platform }) => {
    const asset = readJson(PIN[kind]).runtimeAssets?.[platform];
    const name = `${kind} ${pinnedVersion(kind)} ${platform}`;
    if (!asset?.url || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) return { name, ok: false, detail: 'pin has no url/sha256 for this platform' };
    try {
      const got = await sha256OfUrl(asset.url);
      const ok = got.sha256 === asset.sha256 && (asset.size == null || got.size === asset.size);
      return { name, ok, detail: ok ? `${got.size} bytes, sha256 ok` : `got sha256 ${got.sha256} (${got.size} bytes)` };
    } catch (error) {
      return { name, ok: false, detail: `${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ''} ${asset.url}` };
    }
  }));
  for (const r of results) log(`${r.ok ? 'VERIFIED' : 'MISMATCH'} ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(`${failed.length} pinned asset(s) failed verification`);
  return { verified: results.map(({ name, detail }) => ({ name, detail })), components: vendorRecord() };
}

/**
 * Bump to `target` ('latest' | 'pinned' | { [kind]: { version } }), then run the gate.
 * Throws after restoring the previous pins when an update or any gate step fails.
 */
export async function updateVendors({ target = 'latest', kinds = VENDOR_KINDS, minAgeHours = DEFAULT_MIN_AGE_HOURS, pinsOnly = false, log = defaultLog } = {}) {
  for (const k of kinds) if (!VENDOR_KINDS.includes(k)) throw new Error(`Unknown kind ${k} (known: ${VENDOR_KINDS.join(', ')})`);
  // Versions read from another build's record become updater arguments and package.json text.
  if (typeof target === 'object') {
    for (const k of kinds) if (target[k] && !isRelease(String(target[k].version))) throw new Error(`${k}: invalid version ${target[k].version}`);
  }
  const snapshot = new Map(PIN_FILES.map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]));
  // Pin files already edited before this run must never ride along in the automatic pin PR.
  const status = spawnSync('git', ['status', '--porcelain', '--', ...PIN_FILES], { cwd: root, encoding: 'utf8' });
  const dirtyBefore = status.status === 0 ? status.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)) : PIN_FILES;
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
  const fail = (message) => { throw new Error(message); };
  try {
    return await bumpAndGate();
  } catch (error) {
    // One rollback path for every failure: updater, upstream lookup (timeout, rate limit,
    // bad JSON), missing binary or failed gate step. Nothing untested stays behind.
    restore();
    throw error;
  }

  async function bumpAndGate() {
    // ── Bump ──
    const desired = async (kind) => {
      if (typeof target === 'object') return target[kind]?.version;
      if (kind === 'codex-cli') return pinnedVersion('codex'); // keep the CLI on the package's version
      if (kind === 'claude-sdk') return resolveSdk(pinnedVersion('claude'), minAgeHours);
      return resolveLatest(kind, minAgeHours, log);
    };
    if (target !== 'pinned') {
      // Order matters: codex-cli follows codex, the SDK follows the Claude CLI.
      for (const kind of ['claude', 'codex', 'codex-cli', 'pi', 'ripgrep', 'claude-sdk'].filter((k) => kinds.includes(k))) {
        const from = pinnedVersion(kind);
        const to = await desired(kind);
        // No eligible release on the newest page (all prereleases, still soaking, or Codex past the
        // verified list): the current pin is still tested by the gate, so keep it instead of blocking.
        if (!to && target === 'latest') { log(`${kind}: keeping ${from} (no eligible newer release)`); continue; }
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
          const install = pinsOnly ? ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'] : ['install', '--no-frozen-lockfile'];
          if (!run('pnpm', install, { env: { XDT_SKIP_AGENT_BIN_INSTALL: '1' } }).ok) fail('claude-sdk: pnpm install failed');
        } else if (!run(process.execPath, [UPDATER[kind], `--version=${to}`, `--platform=${platformKey}`]).ok) {
          fail(`${kind}: updater failed for ${to} (download or checksum verification)`);
        }
      }
    }
    if (changes.length && !syncHeadlessProfiles()) fail('could not refreeze the Cindy Headless profile locks');
    if (pinsOnly) return { changes, steps: [], dirtyBefore, components: vendorRecord(), rejected: [] };
    // Pinned builds still gate the exact binaries; make sure they are present first.
    if (!run(process.execPath, ['scripts/ensure-agent-binaries.mjs', '--kinds=claude,codex,pi,ripgrep']).ok) fail('could not ensure pinned binaries');
    const codexCliMarker = path.join(path.dirname(BINARY['codex-cli']), '.version');
    const codexCliInstalled = fs.existsSync(BINARY['codex-cli']) && fs.existsSync(codexCliMarker)
      ? fs.readFileSync(codexCliMarker, 'utf8').trim() : null;
    if (codexCliInstalled !== pinnedVersion('codex-cli') && !run(process.execPath, [UPDATER['codex-cli'], `--version=${pinnedVersion('codex-cli')}`, `--platform=${platformKey}`]).ok) {
      fail('could not ensure the standalone Codex CLI');
    }

    // ── Gate ──
    // A bad release of one runtime must not hold back the others (Claude Code ships almost daily).
    // When floating to latest and the failures point only at runtimes this run bumped, put those
    // back on their previous pins and gate the rest again. Anything else rolls everything back.
    const rejected = [];
    let steps = await runGate();
    while (target === 'latest' && steps.some((st) => !st.ok)) {
      const failing = steps.filter((st) => !st.ok);
      if (failing.some((st) => !st.kinds?.length)) break; // not attributable to a runtime
      const blamed = new Set(failing.flatMap((st) => st.kinds));
      for (const [a, b] of [['claude', 'claude-sdk'], ['codex', 'codex-cli']]) if (blamed.has(a) || blamed.has(b)) blamed.add(a).add(b);
      const drop = changes.filter((c) => blamed.has(c.kind));
      // A failing step that involves no runtime bumped in this run points at the gate or the pins.
      if (failing.some((st) => !st.kinds.some((k) => drop.some((c) => c.kind === k)))) break;
      for (const c of drop) {
        rejected.push({ ...c, reason: failing.filter((st) => st.kinds.includes(c.kind)).map((st) => st.name).join('; ') || 'moves with its partner runtime' });
        changes.splice(changes.indexOf(c), 1);
      }
      log(`rejecting ${drop.map((c) => `${c.kind} ${c.to}`).join(', ')}; keeping ${drop.map((c) => `${c.kind} ${c.from}`).join(', ')} and gating the rest again`);
      revertKinds(drop.map((c) => c.kind));
      steps = await runGate();
    }

    const failed = steps.filter((s) => !s.ok);
    if (failed.length) fail(`${failed.length} gate step(s) failed${changes.length || rejected.length ? '; pins restored' : ''}`);
    for (const c of changes) log(`bumped ${c.kind}: ${c.from} → ${c.to}`);
    for (const c of rejected) {
      log(`REJECTED ${c.kind} ${c.to} (kept ${c.from}): ${c.reason}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::warning title=${c.kind} ${c.to} rejected::kept ${c.from}; failed: ${c.reason}`);
    }
    return { changes, steps, dirtyBefore, components: vendorRecord(), rejected };
  }

  async function runGate() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-vendor-gate-'));
    const steps = [];
    const step = (name, r, kinds) => { steps.push({ name, ok: r.ok, seconds: r.seconds, kinds }); log(`${r.ok ? 'PASS' : 'FAIL'} ${name} (${r.seconds}s)`); };
    try {
      for (const kind of ['claude', 'codex', 'codex-cli', 'pi', 'ripgrep']) {
        const r = spawnSync(BINARY[kind], ['--version'], {
          encoding: 'utf8', timeout: 30_000, env: { ...untrustedEnv(), CODEX_HOME: fs.mkdtempSync(path.join(scratch, 'codex-home-')) },
        });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0];
        step(`${kind} --version = ${pinnedVersion(kind)} (${out || r.error?.message})`, { ok: r.status === 0 && out.includes(pinnedVersion(kind)), seconds: 0 }, [kind]);
      }
      step('Claude Agent SDK + CLI smoke (scripts/smoke-claude-sdk.mjs)', run(process.execPath, ['scripts/smoke-claude-sdk.mjs', '--cli', BINARY.claude], { untrusted: true }), ['claude', 'claude-sdk']);

      // The repo's manual `integration` tier for @cindy/maker-core (test-workspaces.config.mjs):
      // Cindy's own ClaudeCodeAgent / CodexAgent / PiAgent driving the real binaries over loopback
      // model servers, with no account and no network model.
      const dirs = { claude: 'src/agents/claude-code/__tests__', codex: 'src/agents/codex', pi: 'src/agents/pi/__tests__' };
      const files = Object.values(dirs).flatMap((dir) => fs.readdirSync(path.join(root, 'packages/maker-core', dir))
        .filter((f) => f.endsWith('.integration.test.ts')).map((f) => `${dir}/${f}`));
      // Codex's native reviewer must still carry the captured stock policy for the pinned version.
      files.push('src/agents/codex/native-auto-review-policy.test.ts', 'src/agents/codex/native-auto-review-policy.native.test.ts');
      const report = path.join(scratch, 'integration.json');
      const integration = run(process.execPath, [
        path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files,
        '--pool=forks', '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`,
      ], {
        cwd: path.join(root, 'packages/maker-core'),
        untrusted: true,
        env: {
          CINDY_TEST_CLAUDE_BINARY: BINARY.claude, CINDY_TEST_CODEX_BINARY: BINARY.codex, CINDY_CODEX_TEST_BINARY: BINARY.codex,
          CINDY_TEST_PI_BINARY: BINARY.pi, CINDY_PI_MCP_TEST_BINARY: BINARY.pi,
        },
      });
      let detail = 'no report';
      let blamed = null; // unknown until the report says which runtime's tests failed
      try {
        const json = JSON.parse(fs.readFileSync(report, 'utf8'));
        const kindOf = (file) => Object.entries(dirs).find(([, dir]) => file.includes(`/${dir}/`))?.[0];
        blamed = new Set();
        for (const f of json.testResults) {
          const failedHere = f.assertionResults.filter((t) => t.status === 'failed');
          for (const t of failedHere) log(`FAILED: ${t.fullName}`);
          // A file that crashed before reporting assertions fails without failed assertions.
          if (failedHere.length || f.status === 'failed') blamed.add(kindOf(f.name) ?? '*');
        }
        // A runtime whose tests all skipped (binary not found) must not read as green.
        const silent = Object.entries(dirs).filter(([, dir]) => !json.testResults.some((f) =>
          f.name.includes(`/${dir}/`) && f.assertionResults.some((t) => t.status === 'passed')));
        for (const [kind] of silent) { log(`NOTHING PASSED for ${kind}: its binary was not exercised`); blamed.add(kind); }
        integration.ok = integration.ok && json.numFailedTests === 0 && silent.length === 0;
        detail = `${json.numPassedTests} passed, ${json.numFailedTests} failed, ${json.numPendingTests} skipped, ${json.testResults.length} files`;
      } catch { integration.ok = false; }
      // Claude Code tests drive the SDK; Codex tests drive the package Codex (codex-cli follows it).
      const expand = { claude: ['claude', 'claude-sdk'], codex: ['codex'], pi: ['pi'] };
      step(`maker-core integration tier: ${detail}`, integration,
        integration.ok ? [] : blamed && !blamed.has('*') && blamed.size ? [...blamed].flatMap((k) => expand[k]) : null);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    return steps;
  }

  /** Put the given runtimes back on the pins they had before this run, binaries included. */
  function revertKinds(kinds) {
    const files = kinds.flatMap((k) => (k === 'claude-sdk' ? [...SDK_MANIFESTS, 'pnpm-lock.yaml'] : [PIN[k]]));
    for (const rel of [...files, ...headlessProfileFiles()]) fs.writeFileSync(path.join(root, rel), snapshot.get(rel));
    if (changes.length && !syncHeadlessProfiles()) fail('could not refreeze the Cindy Headless profile locks');
    if (kinds.includes('claude-sdk') && !run('pnpm', ['install', '--frozen-lockfile'], { env: { XDT_SKIP_AGENT_BIN_INSTALL: '1' } }).ok) fail('claude-sdk: pnpm install failed while reverting');
    if (kinds.includes('codex-cli') && !run(process.execPath, [UPDATER['codex-cli'], `--version=${pinnedVersion('codex-cli')}`, `--platform=${platformKey}`]).ok) fail('could not reinstall the standalone Codex CLI');
    const ensured = kinds.filter((k) => k !== 'claude-sdk' && k !== 'codex-cli');
    if (ensured.length && !run(process.execPath, ['scripts/ensure-agent-binaries.mjs', `--kinds=${ensured.join(',')}`]).ok) fail('could not reinstall the previous binaries');
  }
}

/**
 * Commit the pin files as they are in the working tree onto PIN_BRANCH (parent = HEAD) and open or
 * refresh its pull request against main. Builds the commit in a scratch index, so the working
 * tree, the index and HEAD stay untouched. Needs push rights on origin and an authenticated `gh`.
 */
export function openPinPullRequest({ changes, steps = [], rejected = [], dirtyBefore = [], cwd = root, log = defaultLog }) {
  if (dirtyBefore.length) {
    throw new Error(`pin files had local edits before the update (${dirtyBefore.join(', ')}); commit the pins by hand`);
  }
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
      ...(rejected.length ? ['测试门拒绝了下列上游版本，本 PR 保持原 pin，需要先适配：', '',
        ...rejected.map((c) => `- ❌ ${c.kind} ${c.to}（保持 ${c.from}）：${c.reason}`), ''] : []),
      '## 怎么验证的', '', '在新二进制上跑的测试门：', '',
      ...(steps.length ? steps.map((st) => `- ${st.ok ? '✅' : '❌'} ${st.name}`)
        : [`- ✅ 冒烟与 maker-core 集成测试已在无凭证的 job 中通过${process.env.GITHUB_RUN_ID
          ? `：${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : ''}`]), '',
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
  const { values: opt } = parseArgs({
    options: Object.fromEntries([
      ...['gate-only', 'pins-only', 'open-pr'].map((k) => [k, { type: 'boolean' }]),
      ...['versions-from', 'kinds', 'min-age-hours', 'record'].map((k) => [k, { type: 'string' }]),
    ]),
  });
  const arg = (name) => opt[name];
  const from = arg('versions-from');
  const target = opt['gate-only'] ? 'pinned'
    : from ? JSON.parse(fs.readFileSync(path.resolve(from), 'utf8')).vendors.components : 'latest';
  updateVendors({
    target,
    kinds: arg('kinds')?.split(',').filter(Boolean),
    minAgeHours: Number(arg('min-age-hours') ?? DEFAULT_MIN_AGE_HOURS),
    pinsOnly: Boolean(opt['pins-only']),
  }).then(({ changes, steps, dirtyBefore, components, rejected }) => {
    // The PR job has no gate of its own; the gate job's rejections travel in the record.
    if (from) rejected = JSON.parse(fs.readFileSync(path.resolve(from), 'utf8')).vendors.rejected ?? [];
    if (arg('record')) fs.writeFileSync(path.resolve(arg('record')), JSON.stringify({ vendors: { components, rejected } }, null, 2) + '\n');
    if (!changes.length) return defaultLog('nothing to bump.');
    if (opt['open-pr']) return openPinPullRequest({ changes, steps, rejected, dirtyBefore });
    defaultLog('pins updated — commit tools/*/latest.json, the SDK package.json files and pnpm-lock.yaml.');
  }).catch((error) => {
    console.error(`\x1b[31m[vendor-update]\x1b[0m ${error.message}`);
    process.exit(1);
  });
}
