/** Developer-only automatic preparation and supervised activation. Never replaces a packaged app. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { managedConfig, runtimeEnv } from './managed.mjs';
import { prepare, main, run, packageHash, verifyReport, verifyUpgradeSnapshot } from '../personal-build.mjs';
import {acquire} from './lock.mjs';
export {acquire} from './lock.mjs';
import {installFixedRuntime} from './fixed-install.mjs';
import { nativeIdentity, verifyDeveloperSignature } from './native-capabilities.mjs';
import { checkCheckout } from './checkout-guard.mjs';
import { RecoveryJournal, durableWrite, compatibility } from './recovery.mjs';

const cli = fileURLToPath(new URL('../personal-build.mjs', import.meta.url));
const check = (v, m) => { if (!v) throw new Error(m); };
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const root = c => path.join(c.runtime.stateDir, 'automatic');
const journal = c => new RecoveryJournal(path.join(root(c), 'journal.json'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], cwd);
function config(file) {
  const c = managedConfig(file);
  c.automatic ??= {};
  for (const [key, value, min, max] of [['intervalMinutes', 360, 15, 10080], ['startupSeconds', 900, 30, 1800], ['probationSeconds', 120, 30, 900]]) {
    c.automatic[key] ??= value;
    check(Number.isInteger(c.automatic[key]) && c.automatic[key] >= min && c.automatic[key] <= max, `Invalid automatic.${key}`);
  }
  c.automatic.requireRemote ??= true;
  check(typeof c.automatic.requireRemote === 'boolean', 'Invalid remote health setting');
  c.automatic.mock ??= false;
  check(typeof c.automatic.mock === 'boolean' && (!c.automatic.mock || c.runtime.mode === 'isolated' && !c.automatic.requireRemote), 'Mock acceptance requires an isolated profile with requireRemote=false');
  return c;
}
/** Release identity of the bundled local plugins: stable plugin identity and content only.
 * index.json also records where each bundle was prepared (temporary checkouts, PR list), which
 * differs between preparations of identical plugin bytes and must not change the release. */
export function localPluginsIdentity(dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const entries = (index.plugins ?? []).map(p => [p.id, p.namespace ?? null, p.version]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const onDisk = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  check(JSON.stringify(onDisk) === JSON.stringify(entries.map(([id]) => id)), 'Personal plugin inventory differs from its index');
  return hash(entries.map(([id, namespace, version]) => [id, namespace, version, packageHash(path.join(dir, id))]));
}
export function releaseDescriptor(directory) {
  checkCheckout(directory);
  const head = git(directory, 'rev-parse', 'HEAD');
  const tree = git(directory, 'rev-parse', 'HEAD^{tree}');
  const seeds = path.join(directory, 'apps/desktop/resources/builtin-ghosts');
  const plugins = fs.existsSync(seeds) ? packageHash(seeds) : hash([]);
  const personalDir = path.join(directory, 'apps/desktop/resources/personal-plugins');
  const localPlugins = fs.existsSync(path.join(personalDir, 'index.json')) ? localPluginsIdentity(personalDir) : null;
  // Git subtree IDs cover every descendant without emitting multi-megabyte file inventories.
  const fingerprint = paths => hash(git(directory, 'ls-tree', 'HEAD', '--', ...paths));
  const migrations = fingerprint(['apps/desktop/drizzle']);
  const runtime = fingerprint(['pnpm-lock.yaml', 'package.json', 'apps/desktop/package.json', 'pnpm-workspace.yaml', 'apps/desktop/electron.vite.config.ts', '.npmrc']);
  // A migration-free change can still rewrite settings/credentials/plugin state. Defer those too.
  const dataCode = fingerprint(['apps/desktop/src/main', 'apps/desktop/src/preload', 'packages', 'scripts', 'patches']);
  let monitorProtocol = 0;
  try { git(directory, 'cat-file', '-e', 'HEAD:apps/desktop/src/main/personalBuildMonitor.ts'); monitorProtocol = 1; } catch { /* Older bootstrap needs an observed first upgrade. */ }
  if (localPlugins) {
    try { git(directory, 'cat-file', '-e', 'HEAD:apps/desktop/src/main/cindy-brain/personalPluginUpdates.ts'); }
    catch { throw new Error('This candidate cannot apply local plugin bundles; include the personal plugin update implementation first'); }
  }
  const native = nativeIdentity(directory);
  // Preserve existing release identities when no local bundle exists.
  return { monitorProtocol, id: hash(native ? [tree, plugins, localPlugins, native] : localPlugins ? [tree, plugins, localPlugins] : [tree, plugins]), directory: path.resolve(directory), head, tree, plugins, localPlugins, migrations, runtime, dataCode };
}
function verifyRelease(r) {
  check(releaseDescriptor(r.directory).id === r.id, 'Release changed after verification');
  check(fs.existsSync(path.join(r.directory, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')), 'Prepared Electron runtime missing');
}
function status(c, phase, extra = {}) { durableWrite(path.join(root(c), 'status.json'), { phase, at: Date.now(), ...extra }); }

async function stopLaunch(c, release, launched, dataDir = c.runtime.dataDir) {
  // A LaunchServices app is reparented outside the wrapper tree. Stop its exact
  // verified PID first; normal app exit lets the Terminal/runner finish as well.
  // Tearing down their process groups first can strand the app without its UI server.
  const owned = snapshot(c, release, dataDir);
  check(!owned.unknown, 'Process identity unavailable; cleanup deferred');
  if (owned.pid) await stopOwned(c, release, dataDir);
  if (launched && !launched.exited && launched.child.pid) {
    // macOS script creates a second process group for its PTY command. Include descendant
    // groups whose leader is in our child tree; killing only script's group leaves builds alive.
    const report = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
    check(report.status === 0, 'Cannot identify launch runner descendants; recovery deferred');
    const rows = report.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const owned = new Set([launched.child.pid]);
    let changed = true;
    while (changed) { changed = false; for (const [pid, ppid] of rows) if (owned.has(ppid) && !owned.has(pid)) { owned.add(pid); changed = true; } }
    const groups = new Set(rows.filter(([pid, , pgid]) => owned.has(pid) && owned.has(pgid)).map(([, , pgid]) => pgid));
    for (const group of [...groups].sort((a, b) => b - a)) {
      try { process.kill(-group, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    const deadline = Date.now() + 15000;
    // script may exit before its PTY descendants finish their normal shutdown.
    // Give both the runner and its owned groups the same grace period.
    while ((!launched.exited || [...groups].some(group => alive(-group))) && Date.now() < deadline) await sleep(100);
    check(launched.exited, 'Launch runner did not stop; recovery deferred');
    for (const group of groups) check(!alive(-group), 'Launch descendants still running; recovery deferred');
  }
  await stopOwned(c, release, dataDir);
}
function snapshot(c, release, dataDir = c.runtime.dataDir) {
  const result = spawnSync(c.runtime.node, [path.join(release.directory, 'scripts/desktop-whoami.mjs'), '--json', '--user-data-dir', dataDir], {
    cwd: release.directory, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    env: { ...runtimeEnv(c, cli), XDT_USER_DATA_DIR: dataDir },
  });
  let report; try { report = JSON.parse(result.stdout); } catch { return { unknown: true }; }
  if (!report.processScan?.ok) return { unknown: true };
  const instance = report.instances?.find(i => i.rootDir === release.directory && i.commit === release.head && i.commitVerified && i.userDataDir === dataDir && i.region === c.region);
  return { pid: instance?.pid, ready: instance?.ready === true, unknown: false };
}
function hasLaunchRunner(c, release, dataDir = c.runtime.dataDir) {
  const launches = path.join(root(c), 'launches');
  if (!fs.existsSync(launches)) return false;
  for (const entry of fs.readdirSync(launches)) {
    const file = path.join(launches, entry, 'runner.json');
    if (!fs.existsSync(file)) continue;
    const r = read(file);
    if (r.directory === release.directory && r.smoke === (dataDir !== c.runtime.dataDir)
      && Number.isSafeInteger(r.pid) && r.pid > 0 && alive(r.pid)) return true;
  }
  return false;
}
// Keep credential identity resolution inside the launched terminal, before the
// restart wrapper snapshots its environment. Legacy and supervised starts share it.
export const personalLaunchCommand = 'source "$PERSONAL_TOOLS_DIR/credential-signing.zsh" || exit 1; resolve_signing_identity || exit 1; exec "$@"';
/** ps comm is the executable path, not argv: a grep/shell mentioning the app is not an owner. */
export function fixedAppProcesses(table, app) {
  const executable = path.join(app, 'Contents/MacOS/Electron');
  return table.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    return match && match[2] === executable ? [Number(match[1])] : [];
  });
}
function assertFixedAppStopped(app) {
  const ps = spawnSync('ps', ['-axo', 'pid=,comm='], {encoding:'utf8',maxBuffer:64*1024*1024});
  check(ps.status === 0, 'Cannot check runtime ownership');
  const pids = fixedAppProcesses(ps.stdout, app);
  check(pids.length === 0, `Personal app is still running (PID ${pids.join(', ')}); no replacement`);
  return false;
}
function start(c, release, { mock = false } = {}) {
  check(process.stdin.isTTY, 'Run the personal developer launcher in Terminal; a live TTY is required for the repository startup wrapper');
  verifyRelease(release);
  const nativeFile = path.join(release.directory, 'apps/desktop/resources/personal-native.json');
  const runtime = fs.existsSync(nativeFile) ? read(nativeFile).runtime : null;
  const fixedApp = runtime && !mock && c.runtime.mode === 'shared' ? installFixedRuntime(runtime, c.runtime.personalApp, {verifySignature:verifyDeveloperSignature, isRunning:assertFixedAppStopped}) : null;
  const generation = randomUUID(), dir = path.join(root(c), 'launches', generation);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const env = runtimeEnv(c, cli);
  delete env.CINDY_PERSONAL_FIXED_APP;
  if (fixedApp) env.CINDY_PERSONAL_FIXED_APP = fixedApp;
  for (const name of ['XDT_ISOLATED', 'XDT_ISOLATED_NAME', 'XDT_ISOLATED_AUTH', 'XDT_ISOLATED_AUTH_PROOF', 'XDT_USER_DATA_DIR', 'XDT_USER_DATA_DIR_EPOCH']) delete env[name];
  env.CINDY_PERSONAL_MONITOR_DIR = dir; env.CINDY_PERSONAL_GENERATION = generation;
  const mode = mock ? [`--isolated=personal-smoke-${generation.slice(0, 8)}`, '--mock'] : c.runtime.mode === 'shared' ? ['--shared'] : [`--isolated=${c.name}`, ...(c.automatic.mock ? ['--mock'] : [])];
  const log = path.join(dir, 'console.log');
  // Keep coordinator output in a file, but pass the existing terminal input.
  // The repository wrapper uses that terminal for the dev server and owns its
  // single PTY + bounded log drain. Never pipe the PTY through the supervisor.
  const output = fs.openSync(log, 'a', 0o600);
  let child;
  try {
    child = spawn('/bin/zsh', ['-c', personalLaunchCommand,
      'personal-build', c.runtime.node, path.join(release.directory, 'scripts/desktop-restart-runner.mjs'),
      '--wait-ready', '--reuse-terminal', `--region=${c.region}`, ...mode], {
      cwd: release.directory, env, detached: true, stdio: ['inherit', output, output],
    });
  } finally { fs.closeSync(output); }
  let exited = false, error, exitCode;
  child.once('error', e => { error = e; exited = true; }); child.once('exit', (code) => { exitCode = code; exited = true; });
  if (child.pid) durableWrite(path.join(dir, 'runner.json'), { pid: child.pid, directory: release.directory, smoke: mock, generation });
  return { generation, dir, log, child, mode, get exited() { return exited; }, get error() { return error; }, get exitCode() { return exitCode; } };
}
export function readHeartbeat(runInfo, expectedPid, { now = Date.now(), remote = true } = {}) {
  try {
    const h = read(path.join(runInfo.dir, 'heartbeat.json'));
    if (h.protocol !== 1 || !Number.isFinite(h.at) || !Number.isSafeInteger(h.pid) || h.generation !== runInfo.generation || h.pid !== expectedPid || h.at > now || now - h.at > 10_000) return null;
    return { ...h, healthy: h.ready === true && (!remote || h.remoteReady === true) };
  } catch { return null; }
}
async function waitReady(c, release, launched, dataDir, requireHeartbeat) {
  const deadline = Date.now() + c.automatic.startupSeconds * 1000;
  while (Date.now() < deadline) {
    if (launched.error) throw launched.error;
    if (launched.exited && launched.exitCode !== 0) throw new Error(`Desktop startup wrapper failed (exit ${launched.exitCode}); see ${launched.log}`);
    const s = snapshot(c, release, dataDir);
    if (s.ready && s.pid && (!requireHeartbeat || readHeartbeat(launched, s.pid, { remote: c.automatic.requireRemote })?.healthy)) return s.pid;
    if (launched.exited && !s.pid && !s.unknown) throw new Error('Application exited before readiness');
    await sleep(2000);
  }
  throw new Error('Startup deadline exceeded');
}
async function stopOwned(c, release, dataDir = c.runtime.dataDir, expectedPid) {
  const s = snapshot(c, release, dataDir);
  check(!s.unknown, 'Process identity unavailable; cannot stop or recover safely');
  if (expectedPid !== undefined) check(s.pid === expectedPid && s.ready, 'Confirmed instance changed; no signal sent');
  if (!s.pid) { check(!hasLaunchRunner(c, release, dataDir), 'A launch runner is still active; recovery deferred'); return; }
  process.kill(s.pid, 'SIGTERM');
  await waitForOwnedShutdown(s.pid, {
    inspect: () => snapshot(c, release, dataDir),
    runnerActive: () => hasLaunchRunner(c, release, dataDir),
  });
}
/** Instance records disappear during will-quit, before the OS process necessarily exits.
 * Retain the original PID across every observation; absence from whoami alone is not shutdown. */
export async function waitForOwnedShutdown(pid, {
  inspect, runnerActive, isAlive = alive, wait = sleep, now = Date.now, timeoutMs = 60000,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const observed = inspect();
    check(!observed.unknown, 'Process state unknown during shutdown');
    if (!isAlive(pid) && !observed.pid && !runnerActive()) return;
    await wait(1000);
  }
  throw new Error(`Application PID ${pid} did not exit normally; no forced kill or version switch`);
}

async function smoke(c, release) {
  const launched = start(c, release, { mock: true });
  const startup = await import(pathToFileURL(path.join(c.app.checkout, 'scripts/restart-desktop-remote.mjs')));
  const profile = startup.defaultIsolatedUserDataDir(launched.mode[0].slice('--isolated='.length), c.region);
  try { await waitReady(c, release, launched, profile, false); }
  finally { await stopLaunch(c, release, launched, profile); }
  return { at: Date.now(), profile, log: launched.log };
}
export async function automaticCheck(file) {
  const c = config(file), unlock = acquire(path.join(root(c), 'prepare.lock'));
  try {
    const state = journal(c).read(); check(state.phase === 'stable', 'A launch or recovery is still pending');
    const out = path.join(root(c), 'versions', randomUUID());
    status(c, 'preparing');
    const report = prepare(c, out);
    let release = releaseDescriptor(report.directory);
    if (release.id === state.good.id || state.rejected.some(r => r.id === release.id)) { status(c, 'unchanged-or-rejected', { id: release.id }); return; }
    const compat = compatibility(state.good, release);
    if (release.monitorProtocol !== 1) { compat.compatible = false; compat.reasons.push('host health protocol missing'); }
    if (!compat.compatible) { status(c, 'deferred', { reasons: compat.reasons, report: path.join(out, 'report.json') }); return; }
    await main(['check', '--report', path.join(out, 'report.json')]);
    release = releaseDescriptor(report.directory); // Native artifacts participate in the checked identity.
    // The first comparison predates the native receipt; repeat it on the final identity so an
    // unchanged or previously rejected release never reruns assets, smoke startup or publication.
    if (release.id === state.good.id || state.rejected.some(r => r.id === release.id)) { status(c, 'unchanged-or-rejected', { id: release.id }); return; }
    // Materialize assets before activation; recovery never depends on downloading a replacement runtime.
    run(c.runtime.node, ['scripts/ensure-dev-runtime-assets.mjs'], report.directory);
    verifyUpgradeSnapshot(c, report);
    const proof = await smoke(c, release);
    verifyUpgradeSnapshot(c, report);
    // Publish only a complete candidate; supervisor owns the promotion journal independently.
    durableWrite(path.join(root(c), 'candidate.json'), { ...release, prepared: true, smoke: proof, buildReport: path.join(out, 'report.json') });
    status(c, 'prepared', { id: release.id });
  } catch (e) { status(c, 'preparation-failed', { error: e.message }); throw e; }
  finally { unlock(); }
}
function candidate(c, s) {
  try {
    const v = read(path.join(root(c), 'candidate.json'));
    if (v.monitorProtocol !== 1 || !v.prepared || !v.smoke || v.id === s.good.id || s.rejected.some(r => r.id === v.id) || !compatibility(s.good, v).compatible) return null;
    verifyRelease(v); return v;
  } catch { return null; }
}
async function trial(c, store, release) {
  let launched, pid;
  try {
    launched = start(c, release);
    pid = await waitReady(c, release, launched, c.runtime.dataDir, true);
    while (store.read().phase === 'trial') {
      const state = store.read(), h = readHeartbeat(launched, pid, { remote: c.automatic.requireRemote });
      const s = snapshot(c, release);
      store.observe({ generation: state.generation, id: release.id, healthy: !!h?.healthy && s.ready, processAlive: s.pid === pid }, c.automatic.probationSeconds * 1000);
      if (store.read().phase === 'trial') await sleep(2000);
    }
    if (store.read().phase === 'stable') return { launched, pid };
    throw new Error('Health probation failed');
  } catch (e) {
    if (store.read().phase === 'trial') store.reject(e.message);
    await stopLaunch(c, release, launched);
    throw e;
  }
}
const BOOTSTRAP_FILES = new Set([
  'apps/desktop/src/main/bootstrap-electron.ts',
  'apps/desktop/src/main/personalBuildMonitor.ts',
  'apps/desktop/src/main/__tests__/personalBuildMonitor.test.ts',
  'scripts/restart-desktop-remote.mjs',
]);
/** Explicit first handover only: install the health bridge without changing data/runtime/plugins. */
export function validateBootstrap(report, current, changedFiles) {
  check(report?.kind === 'personal-health-bootstrap' && report.checked === true && report.smoke?.ready === true, 'Bootstrap needs completed checks and an isolated startup');
  check(report.baseline?.verified === true && report.baseline.directory === current && report.baseline.readyProof?.head === report.baseline.head, 'Bootstrap needs the observed current baseline');
  check(report.candidate?.monitorProtocol === 1 && report.candidate.directory !== current, 'Bootstrap needs a separate candidate with the health protocol');
  const compat = compatibility(report.baseline, report.candidate);
  check(compat.reasons.every(reason => reason === 'persistent data implementation'), 'Bootstrap cannot change migrations, plugins or runtime dependencies');
  check(changedFiles.length > 0 && changedFiles.every(file => BOOTSTRAP_FILES.has(file)), 'Bootstrap may only add the reviewed health bridge');
  return report.candidate;
}
export function validateManualUpgrade(report, c, state, release) {
  check(c.automatic.enabled !== true, 'Disable automatic switching during a manual upgrade');
  check(state.phase === 'stable' && report.kind === 'personal-manual-upgrade' && report.checked === true,
    'Manual upgrade needs a stable baseline and checked report');
  check(report.baseline.id === state.good.id && report.candidate.id === release.id &&
    report.dataDir === c.runtime.dataDir && report.region === c.region, 'Manual upgrade identity/profile changed');
  check(release.monitorProtocol === 1 && report.smoke?.ready === true && report.smoke.releaseId === release.id,
    'Manual upgrade needs a successful isolated startup for this candidate');
  check(release.migrations === state.good.migrations && !release.dbScript,
    'Manual upgrade does not permit migration changes or private database scripts');
  check(!state.rejected.some(r => r.id === release.id), 'Candidate was rejected; inspect before retrying');
  return release;
}
async function prepareManualUpgrade(file, reportFile, output) {
  const c = config(file), unlock = acquire(path.join(root(c), 'prepare.lock'));
  try {
    check(c.automatic.enabled !== true, 'Keep automatic switching disabled');
    check(!fs.existsSync(output), 'Manual report already exists');
    const state = journal(c).read(), report = verifyReport(reportFile);
    check(state.phase === 'stable' && report.state === 'checked', 'Finish checks/recovery before manual preparation');
    const release = releaseDescriptor(report.directory);
    check(release.migrations === state.good.migrations && !release.dbScript, 'Migration changes need a separate migration workflow');
    check(release.monitorProtocol === 1, 'Candidate lacks host health protocol');
    check(!state.rejected.some(r => r.id === release.id), 'Candidate was previously rejected');
    const old = snapshot(c, state.good);
    check(old.pid && old.ready && !old.unknown, 'Manual upgrade needs an observed ready baseline');
    run(c.runtime.node, ['scripts/ensure-dev-runtime-assets.mjs'], report.directory);
    verifyUpgradeSnapshot(c, report);
    const proof = await smoke(c, release);
    verifyUpgradeSnapshot(c, report);
    verifyRelease(release);
    durableWrite(output, { kind: 'personal-manual-upgrade', checked: true, buildReport: path.resolve(reportFile),
      baseline: state.good, candidate: release, dataDir: c.runtime.dataDir, region: c.region,
      smoke: { ...proof, ready: true, releaseId: release.id }, rollbackPolicy: 'manual' });
  } finally { unlock(); }
}
function manualCandidate(c, store, manualFile) {
  const report = read(manualFile), build = verifyReport(report.buildReport);
  verifyUpgradeSnapshot(c, build);
  check(build.state === 'checked', 'Manual candidate checks were invalidated');
  const release = releaseDescriptor(build.directory), state = store.read();
  const manual = validateManualUpgrade(report, c, state, release);
  check(manual.id !== state.good.id && manual.directory !== state.good.directory, 'Candidate is already selected');
  verifyRelease(manual); verifyRelease(state.good);
  return { manual, baseline: state.good };
}
async function verifyLaunchProfile(c) {
  const startup = await import(pathToFileURL(path.join(c.app.checkout, 'scripts/restart-desktop-remote.mjs')));
  const expected = c.runtime.mode === 'shared' ? startup.productionUserDataDir(c.region) : startup.defaultIsolatedUserDataDir(c.name, c.region);
  check(path.resolve(expected) === c.runtime.dataDir, 'Configured data directory does not match the actual launch profile');
}

/** One-use manual handover. Hold the same lock from preflight through the new supervisor's
 * lifetime. In particular, never stop the app and THEN discover an occupied supervisor lock.
 * Injected process operations keep failure/race tests away from the real desktop/profile. */
export async function restartWithSupervisorLock(lockFile, expectedPid, { prepare, observe, stop, activate, record }) {
  check(Number.isSafeInteger(expectedPid) && expectedPid > 0, 'An explicit positive --expected-pid is required');
  let unlock, phase = 'preflight', verified = false;
  const write = extra => record({ phase, verified, ...extra });
  try {
    unlock = acquire(lockFile);
    write();
    await prepare();
    const before = await observe();
    check(!before.unknown && before.ready && before.pid === expectedPid, 'Confirmed instance changed; no signal sent');
    phase = 'stopping'; write({ pid: expectedPid });
    await stop(expectedPid);
    const after = await observe();
    check(!after.unknown && !after.pid, 'Shutdown unconfirmed; candidate was not started');
    phase = 'starting'; write();
    return await activate(() => { verified = true; phase = 'verified'; write(); });
  } catch (e) {
    const failedPhase = phase;
    phase = phase === 'preflight' ? 'blocked-before-stop' : phase === 'stopping' ? 'shutdown-unconfirmed'
      : verified ? 'supervision-failed' : 'activation-failed';
    write({ failedPhase, error: e.message });
    throw e;
  } finally { unlock?.(); }
}
async function restartManual(file, manualFile, expectedPid, output) {
  check(process.platform === 'darwin' && process.stdin.isTTY, 'Run the personal developer launcher in Terminal');
  check(Number.isSafeInteger(expectedPid) && expectedPid > 0, 'An explicit positive --expected-pid is required');
  const c = config(file), store = journal(c);
  // Exclusive creation makes interrupted commands one-use. Inspect the receipt and live process;
  // never replay an old restart approval against a later PID or an already activated candidate.
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(output, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ phase: 'created', at: Date.now() }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  let baseline, manual;
  return restartWithSupervisorLock(path.join(root(c), 'supervisor.lock'), expectedPid, {
    prepare: async () => {
      await verifyLaunchProfile(c);
      ({ baseline, manual } = manualCandidate(c, store, manualFile));
    },
    observe: () => snapshot(c, baseline),
    stop: pid => stopOwned(c, baseline, c.runtime.dataDir, pid),
    // No nested acquire, release/reacquire gap, or competing supervisor process.
    activate: onVerified => superviseLocked(file, c, store, undefined, manualFile, onVerified),
    record: state => durableWrite(output, { ...state, at: Date.now(), expectedPid,
      baseline: baseline?.id, candidate: manual?.id, report: path.resolve(manualFile),
      dataDir: c.runtime.dataDir, region: c.region }),
  });
}
export async function supervise(file, bootstrapFile, manualFile) {
  check(process.platform === 'darwin', 'Automatic developer launcher currently supports macOS');
  const c = config(file), unlock = acquire(path.join(root(c), 'supervisor.lock'));
  try { return await superviseLocked(file, c, journal(c), bootstrapFile, manualFile); }
  finally { unlock(); }
}
async function superviseLocked(file, c, store, bootstrapFile, manualFile, onVerified) {
  let background, current;
  await verifyLaunchProfile(c);
  let bootstrap, manual;
  if (manualFile) ({ manual } = manualCandidate(c, store, manualFile));
  if (bootstrapFile) {
    check(c.automatic.enabled !== true, 'Keep unattended updates disabled during first bootstrap');
    const report = read(bootstrapFile);
    verifyRelease(report.baseline); verifyRelease(report.candidate);
    git(report.candidate.directory, 'merge-base', '--is-ancestor', report.baseline.head, report.candidate.head);
    const files = git(report.candidate.directory, 'diff', '--name-only', report.baseline.head, report.candidate.head).split('\n').filter(Boolean);
    bootstrap = validateBootstrap(report, c.runtime.clientDir, files);
    check(report.dataDir === c.runtime.dataDir && report.region === c.region, 'Bootstrap profile changed');
    const old = snapshot(c, report.baseline);
    check(!old.unknown && !old.pid && !hasLaunchRunner(c, report.baseline), 'Exit the original application normally before bootstrap');
    if (!fs.existsSync(store.file)) store.init(report.baseline);
    check(store.read().good.id === report.baseline.id, 'Bootstrap baseline changed; prepare again');
  }
  if (!fs.existsSync(store.file)) {
    const initial = releaseDescriptor(c.runtime.clientDir);
    const existing = snapshot(c, initial); check(!existing.unknown && !existing.pid && !hasLaunchRunner(c, initial), 'Existing personal app must exit normally before first supervised launch');
    const launched = start(c, initial);
    let pid;
    try { pid = await waitReady(c, initial, launched, c.runtime.dataDir, initial.monitorProtocol === 1); }
    catch (e) { await stopLaunch(c, initial, launched); throw e; }
    store.init({ ...initial, verified: true }); current = { launched, pid };
  }
  let s = store.read();
  // An interrupted trial never becomes good merely because it survived its supervisor.
  if (s.phase === 'trial') { await stopOwned(c, s.selected); s = store.recoverInterrupted(); }
  check(s.phase !== 'blocked', s.error || 'Recovery previously failed; inspect the journal before restarting');
  if (!current && s.phase === 'stable') {
    const existing = snapshot(c, s.good); check(!existing.unknown && !existing.pid && !hasLaunchRunner(c, s.good), 'A personal application is already running');
    let v = manual || bootstrap || (c.automatic.enabled === true ? candidate(c, s) : null);
    if (v && !manual && !bootstrap) {
      try { verifyUpgradeSnapshot(c, verifyReport(v.buildReport)); }
      catch(e) { status(c, 'stale-candidate', {error:e.message}); v = null; }
    }
    if (v) {
      if (manual) store.beginManual(v, { prepared: true, stopped: true, manualRequested: true, smokeVerified: true, profileVerified: true });
      else store.begin(v, { compatible: true, prepared: true, idle: true, stopped: true });
      try { current = await trial(c, store, v); } catch (e) { status(c, store.read().phase, { error: e.message }); }
    }
  }
  s = store.read();
  check(s.phase !== 'blocked', s.error || 'Upgrade blocked; inspect before recovery');
  if (!current) {
    if (s.failed) { const p = snapshot(c, s.failed); check(!p.unknown && !p.pid && !hasLaunchRunner(c, s.failed), 'Candidate shutdown is unconfirmed; refusing concurrent recovery'); }
    verifyRelease(s.good);
    const launched = start(c, s.good);
    try {
      const pid = await waitReady(c, s.good, launched, c.runtime.dataDir, s.good.monitorProtocol === 1);
      if (s.phase === 'recovering') store.finishRecovery(true);
      current = { launched, pid };
    } catch (e) { if (s.phase === 'recovering') store.finishRecovery(false); await stopLaunch(c, s.good, launched); throw e; }
  }
  onVerified?.();
  let nextCheck = 0;
  const pluginRequests = new Set();
  while (true) {
    c.automatic = config(file).automatic;
    s = store.read();
    const present = snapshot(c, s.good);
    if (!present.unknown && !present.pid) break; // Respect the user's normal quit; no respawn loop.
    if (c.automatic.enabled === true && Date.now() >= nextCheck && !background) {
      nextCheck = Date.now() + c.automatic.intervalMinutes * 60000;
      const fd = fs.openSync(path.join(root(c), 'prepare.log'), 'a', 0o600);
      background = spawn(c.runtime.node, [cli, 'auto-check', '--config', path.resolve(file)], { cwd: path.dirname(cli), env: runtimeEnv(c, file), stdio: ['inherit', fd, fd] });
      fs.closeSync(fd); background.once('error', () => { background = null; }); background.once('exit', () => { background = null; });
    }
    const v = c.automatic.enabled === true ? candidate(c, s) : null;
    const h = readHeartbeat(current.launched, current.pid, { remote: c.automatic.requireRemote });
    // A failed app trial never touches installed local plugins. Only the
    // committed good release can request an update, once per launch.
    if (s.phase === 'stable' && s.good.localPlugins && h?.healthy && !h.busy && h.idle &&
        !pluginRequests.has(current.launched.generation)) {
      durableWrite(path.join(current.launched.dir, 'plugins-request.json'), {
        action: 'update-local-plugins', generation: current.launched.generation,
        pid: current.pid, requireRemote: c.automatic.requireRemote, expiresAt: Date.now() + 30_000,
      });
      pluginRequests.add(current.launched.generation);
    }
    if (v && h?.healthy && h.busy === false && h.idle === true) {
      try { verifyUpgradeSnapshot(c, verifyReport(v.buildReport)); }
      catch (e) { status(c, 'stale-candidate', {error:e.message}); await sleep(60000); continue; }
      durableWrite(path.join(current.launched.dir, 'request.json'), { action: 'quit', generation: current.launched.generation, pid: current.pid, requireRemote: c.automatic.requireRemote, expiresAt: Date.now() + 10000 });
      // The host rechecks all activity and exits normally. Silence is not an acknowledgement.
      const deadline = Date.now() + 30000; let stopped = false;
      while (Date.now() < deadline) {
        const p = snapshot(c, s.good);
        if (!p.unknown && !p.pid) { stopped = true; break; }
        await sleep(1000);
      }
      fs.rmSync(path.join(current.launched.dir, 'request.json'), { force: true });
      if (stopped && config(file).automatic.enabled !== true) {
        const launched = start(c, s.good);
        try { current = { launched, pid: await waitReady(c, s.good, launched, c.runtime.dataDir, s.good.monitorProtocol === 1) }; }
        catch (e) { await stopLaunch(c, s.good, launched); throw e; }
        continue;
      }
      if (stopped) {
        store.begin(v, { compatible: compatibility(s.good, v).compatible, prepared: true, idle: true, stopped: true });
        try { current = await trial(c, store, v); }
        catch (e) {
          status(c, 'recovering', { error: e.message });
          const failed = snapshot(c, v); check(!failed.unknown && !failed.pid, 'Candidate shutdown is unconfirmed; refusing concurrent recovery');
          const old = store.read().good; verifyRelease(old);
          const launched = start(c, old);
          try { const pid = await waitReady(c, old, launched, c.runtime.dataDir, old.monitorProtocol === 1); store.finishRecovery(true); current = { launched, pid }; }
          catch (recoveryError) { store.finishRecovery(false); await stopLaunch(c, old, launched); throw recoveryError; }
        }
      }
    }
    await sleep(2000);
  }
}
export async function automaticCommand(command, options) {
  check(options.config, '--config required');
  if (command === 'auto-check') return automaticCheck(options.config);
  if (command === 'auto-launch') return supervise(options.config);
  if (command === 'auto-bootstrap') { check(options.report, '--report required'); return supervise(options.config, options.report); }
  if (command === 'manual-check') {
    check(options.report && options.out, '--report and --out required');
    return prepareManualUpgrade(options.config, options.report, path.resolve(options.out));
  }
  if (command === 'manual-activate') {
    check(options.report, '--report required');
    return supervise(options.config, undefined, options.report);
  }
  if (command === 'manual-restart') {
    check(options.report && options.out, '--report and a new --out receipt are required');
    return restartManual(options.config, options.report, Number(options['expected-pid']), path.resolve(options.out));
  }
  const c = config(options.config);
  if (command === 'auto-recover') {
    const unlock = acquire(path.join(root(c), 'supervisor.lock'));
    try {
    let stored; try { stored = journal(c).read(); } catch { /* Independent known-good receipt survives journal corruption; restart retains profile exclusivity guards. */ }
    check(!(stored?.phase === 'blocked' && stored.rollbackPolicy === 'manual'), 'Manual upgrade failed; automatic code rollback is not safe');
    if (stored?.failed) { const p = snapshot(c, stored.failed); check(!p.unknown && !p.pid && !hasLaunchRunner(c, stored.failed), 'A failed candidate may still own the data profile'); }
    const good = read(path.join(root(c), 'known-good.json'));
    check(good.rollbackSafe !== false, 'Recovery compatibility is unverified after a manual upgrade');
    check(good.verified === true, 'No verified recovery release'); verifyRelease(good);
    const p = snapshot(c, good); check(!p.unknown && !p.pid && !hasLaunchRunner(c, good), 'Recovery version is already running or its identity is unknown');
    const launched = start(c, good);
    try { await waitReady(c, good, launched, c.runtime.dataDir, good.monitorProtocol === 1); }
    catch (e) { await stopLaunch(c, good, launched); throw e; }
    // Preserve the old evidence, repair a blocked/corrupt journal only after observed recovery,
    // and quarantine any pending candidate so manual rescue cannot immediately retry it.
    const store = journal(c), rejected = stored?.rejected || [];
    if (fs.existsSync(store.file)) fs.copyFileSync(store.file, `${store.file}.recovered-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
    const pendingFile = path.join(root(c), 'candidate.json');
    if (fs.existsSync(pendingFile)) fs.renameSync(pendingFile, `${pendingFile}.recovered-${randomUUID()}`);
    durableWrite(store.file, { version: 1, phase: 'stable', selected: good, good, previous: stored?.previous || null, rejected, generation: null });
    status(c, 'recovery-started', { id: good.id }); return;
    } finally { unlock(); }
  }
  if (command === 'auto-status') {
    const result = { enabled: c.automatic.enabled === true };
    for (const name of ['status', 'journal', 'candidate']) {
      const file = path.join(root(c), name + '.json'); if (fs.existsSync(file)) result[name] = read(file);
    }
    const launches = path.join(root(c), 'launches');
    result.localPluginUpdates = [];
    for (const generation of fs.existsSync(launches) ? fs.readdirSync(launches) : []) {
      if (!/^[a-f0-9-]{36}$/.test(generation)) continue;
      const directory = path.join(launches, generation);
      const reportFile = path.join(directory, 'plugins-result.json');
      const requestFile = path.join(directory, 'plugins-request.json');
      if (fs.existsSync(reportFile)) result.localPluginUpdates.push({ directory, ...read(reportFile) });
      else if (fs.existsSync(requestFile)) {
        const request = read(requestFile);
        result.localPluginUpdates.push({ directory, generation, pid: request.pid,
          phase: request.expiresAt < Date.now() ? 'deferred-expired' : 'pending', expiresAt: request.expiresAt });
      }
    }
    console.log(JSON.stringify(result, null, 2)); return;
  }
  throw new Error('Unknown automatic command');
}
