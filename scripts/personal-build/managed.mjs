/** Managed developer checkout, retaining the macOS launcher workflow without machine-specific paths. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resumableCompose } from './composition.mjs';
import { readJournal } from './recovery.mjs';
import { configFrom, discover, copyPlugin, packageHash, auditPlugins, run, verifyReport, verifyUpgradeSnapshot } from '../personal-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '../personal-build.mjs');
const sha = /^[a-f0-9]{40,64}$/;
const check = (ok, why) => { if (!ok) throw new Error(why); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, file);
}
export function managedConfig(file) {
  const c = configFrom(file), base = path.dirname(path.resolve(file)), r = c.runtime;
  check(r && ['shared', 'isolated'].includes(r.mode), 'runtime.mode must explicitly select shared or isolated');
  for (const key of ['clientDir', 'stagingDir', 'stateDir', 'dataDir']) {
    check(typeof r[key] === 'string' && r[key].length, `runtime.${key} is required`);
    r[key] = path.resolve(base, r[key]);
  }
  check(new Set([c.app.checkout, r.clientDir, r.stagingDir, r.stateDir]).size === 4, 'Source, client, staging and state directories must differ');
  r.node = r.node ? path.resolve(base, r.node) : process.execPath;
  r.toolPaths = (r.toolPaths || []).map(p => path.resolve(base, p));
  r.personalApp = r.personalApp ? path.resolve(base, r.personalApp) : path.join(os.homedir(), 'Applications', `Cindy Personal${c.region === 'global' ? '' : c.region === 'cn' ? ' CN' : ' Dev'}.app`);
  check(r.personalApp.endsWith('.app'), 'runtime.personalApp must be an app directory');
  r.installedApp = r.installedApp || '/Applications/Cindy.app';
  check(path.resolve(r.personalApp) !== path.resolve(r.installedApp), 'Personal runtime must not replace the official installed app');
  r.idleMinutes ??= 120;
  check(Number.isInteger(r.idleMinutes) && r.idleMinutes >= 1 && r.idleMinutes <= 1440, 'Invalid idle timeout');
  return c;
}

/** Legacy files are data, never shell code. This keeps old producers usable during migration. */
export function parseManifest(text) {
  let m;
  if (text.trimStart().startsWith('{')) m = JSON.parse(text);
  else {
    m = {};
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const found = /^([A-Z_]+)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"']*))$/.exec(line.trim());
      check(found, 'Invalid legacy manifest line; use JSON instead of executable shell syntax');
      check(!Object.hasOwn(m, found[1]), 'Duplicate manifest key');
      m[found[1]] = found[2] ?? found[3] ?? found[4];
    }
  }
  for (const key of Object.keys(m)) check(['TARGET', 'MAIN', 'PACK', 'LABEL', 'DB_SCRIPT', 'FETCH', 'FORCE_RESTART', 'PACK_SHA256', 'FETCH_COMMITS'].includes(key), `Unknown manifest field ${key}`);
  check(sha.test(m.TARGET), 'Invalid manifest TARGET');
  check(!m.MAIN || sha.test(m.MAIN), 'Invalid manifest MAIN');
  for (const key of ['PACK', 'DB_SCRIPT']) check(!m[key] || /^[\w.-]+$/.test(m[key]) && !['.', '..'].includes(m[key]), `Unsafe manifest ${key}`);
  check(!m.FETCH || typeof m.FETCH === 'string' && m.FETCH.split(/\s+/).every(ref => /^[\w./-]+$/.test(ref) && !ref.startsWith('-') && !ref.includes('..')), 'Invalid FETCH refs');
  check(!m.FETCH_COMMITS || Array.isArray(m.FETCH_COMMITS) && m.FETCH_COMMITS.every(s => sha.test(s)), 'Invalid commit prerequisites');
  check(!m.PACK_SHA256 || /^[a-f0-9]{64}$/.test(m.PACK_SHA256), 'Invalid pack digest');
  check(!m.LABEL || typeof m.LABEL === 'string', 'Invalid LABEL');
  check(!m.FORCE_RESTART || m.FORCE_RESTART === '0', 'Immediate forced restart is not supported; use an idle update request');
  return m;
}
export function loadManifest(state) {
  const files = ['manifest.json', 'manifest.env'].filter(n => fs.existsSync(path.join(state, n)));
  check(files.length, 'No manifest; select a prepared build');
  const file = files.sort((a, b) => fs.statSync(path.join(state, b)).mtimeMs - fs.statSync(path.join(state, a)).mtimeMs)[0];
  return parseManifest(fs.readFileSync(path.join(state, file), 'utf8'));
}
export function runtimeEnv(c, configFile, manifest = {}) {
  const r = c.runtime;
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A native build launches from the shared runtime cache: the process is that cache's Cindy.app run
  // for this checkout. Recognize it by checkout (never by the shared executable alone), or the
  // update gates and launcher stop checks cannot see the real application.
  let nativeRuntime = null;
  try { nativeRuntime = read(path.join(r.clientDir, 'apps/desktop/resources/personal-native.json')).runtime?.directory ?? null; } catch { /* Ordinary Electron checkout. */ }
  const sourceElectron = `${escape(path.join(r.clientDir, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))}( |$)`;
  const electronPattern = typeof nativeRuntime === 'string' && path.isAbsolute(nativeRuntime)
    ? `(${sourceElectron}|${escape(path.join(nativeRuntime, 'Cindy.app/Contents/MacOS/Electron'))} .*${escape(path.join(r.clientDir, 'apps/desktop'))}( |$))`
    : sourceElectron;
  const result = { ...process.env,
    PERSONAL_CONFIG: path.resolve(configFile), PERSONAL_CLI: cli, PERSONAL_TOOLS_DIR: here,
    PERSONAL_SOURCE_DIR: c.app.checkout, PERSONAL_CLIENT_DIR: r.clientDir, PERSONAL_STAGING_DIR: r.stagingDir,
    PERSONAL_STATE_DIR: r.stateDir, PERSONAL_DATA_DIR: r.dataDir, PERSONAL_REGION: c.region,
    PERSONAL_MODE: r.mode, PERSONAL_PROFILE_NAME: c.name, PERSONAL_INSTALLED_APP: r.installedApp,
    PERSONAL_PREVIOUS_REF: `personal-build/${c.name}/previous`, PERSONAL_IDLE_MINUTES: String(r.idleMinutes),
    PERSONAL_ELECTRON_RE: electronPattern,
    PERSONAL_FETCH_COMMITS: (manifest.FETCH_COMMITS || []).join(' '), PERSONAL_REPOSITORY: c.app.repository,
    PERSONAL_NODE: r.node, PERSONAL_TOOL_PATH: r.toolPaths.join(path.delimiter),
    PATH: [path.dirname(r.node), ...r.toolPaths, process.env.PATH || ''].join(path.delimiter),
  };
  for (const key of ['TARGET', 'MAIN', 'PACK', 'LABEL', 'DB_SCRIPT', 'FETCH']) result[`PERSONAL_${key}`] = manifest[key] || '';
  return result;
}
function brains(c) {
  const roots = [], owners = path.join(c.runtime.dataDir, 'owners');
  if (fs.existsSync(owners)) for (const d of fs.readdirSync(owners, { withFileTypes: true })) {
    const b = path.join(owners, d.name, 'cindy-brain');
    if (d.isDirectory() && fs.existsSync(b)) roots.push(b);
  }
  return roots;
}
export function doctor(c, exec = run) {
  const r = c.runtime, result = { version: 1, name: c.name, mode: r.mode, paths: r, issues: [], duplicates: [] };
  for (const key of ['clientDir', 'stateDir', 'dataDir']) if (!fs.existsSync(r[key])) result.issues.push(`Missing ${key}: ${r[key]}`);
  try { result.current = exec('git', ['-C', r.clientDir, 'rev-parse', 'HEAD'], r.clientDir); } catch { result.issues.push('Cannot read current application HEAD'); }
  const journalFile = path.join(r.stateDir, 'automatic/journal.json');
  if (fs.existsSync(journalFile)) {
    try {
      const s = readJournal(journalFile);
      result.originalCheckoutHead = result.current;
      result.current = exec('git', ['-C', s.selected.directory, 'rev-parse', 'HEAD'], s.selected.directory);
      result.supervised = { phase: s.phase, selectedDirectory: s.selected.directory, selectedHead: s.selected.head, lastKnownGoodHead: s.good.head };
      if (result.current !== s.selected.head) result.issues.push('Selected supervised checkout changed');
      if (s.phase !== 'stable') result.issues.push(`Supervised update is ${s.phase}`);
    } catch (e) { result.issues.push(`Cannot read supervised version: ${e.message}`); }
  }
  try { result.manifest = loadManifest(r.stateDir); } catch (e) { result.issues.push(e.message); }
  for (const file of ['status', 'stage-result', 'apply-result']) {
    const f = path.join(r.stateDir, file); if (fs.existsSync(f)) result[file] = fs.readFileSync(f, 'utf8').trim();
  }
  if (fs.existsSync(path.join(r.stateDir, '.database-transition'))) result.issues.push('Unfinished database transition; inspect apply-result');
  const pluginReport = path.join(r.stateDir, 'plugins-report.json');
  if (fs.existsSync(pluginReport)) { result.plugins = read(pluginReport); if (result.plugins.state === 'failed') result.issues.push('Latest plugin synchronization failed; previous seeds retained'); }
  for (const b of brains(c)) result.duplicates.push(...auditPlugins(b).duplicates);
  if (result.duplicates.length) result.issues.push('Duplicate plugin instances remain; select or retire them through Cindy, not by deleting installation files');
  result.ok = result.issues.length === 0;
  return result;
}

/** Compose all candidates first. Failed preparation leaves the last seeds untouched. */
export function syncPlugins(c, exec = run) {
  if (!c.plugins) return { state: 'not-configured' };
  // The legacy mutable checkout cannot safely publish two resource sets or
  // acknowledge post-probation local installation. Use immutable preparation.
  check(Object.keys(c.localPlugins || {}).length === 0, 'Local plugin updates require prepare/check and the supervised launcher; legacy sync-plugins cannot apply them');
  const state = c.runtime.stateDir, reportFile = path.join(state, 'plugins-report.json');
  fs.mkdirSync(state, { recursive: true });
  const previousReport = fs.existsSync(reportFile) ? read(reportFile) : null;
  const resume = previousReport?.state === 'failed' && previousReport.directory && fs.existsSync(path.join(previousReport.directory, 'checkout/.git'));
  const temp = resume ? previousReport.directory : fs.mkdtempSync(path.join(state, 'plugin-sync-'));
  const checkout = path.join(temp, 'checkout');
  const seeds = path.join(c.runtime.clientDir, 'apps/desktop/resources/builtin-ghosts/official');
  const report = { version: 1, state: 'preparing', at: new Date().toISOString(), plugins: [], retired: [] };
  report.directory = temp;
  let succeeded = false;
  try {
    const author = c.author || exec('gh', ['api', 'user', '--jq', '.login'], c.plugins.checkout);
    const selection = resume ? previousReport.selection : discover(c.plugins, author, exec);
    report.selection = selection; save(reportFile, report);
    try { report.composition = resumableCompose(c.plugins, selection, checkout, path.join(temp, 'composition.json'), exec); }
    catch (e) { throw new Error(`${e.message} After committing the resolution, repeat sync-plugins with the same config.`); }
    // After a copy error, retry only our generated candidate directories; keep the composition.
    for (const dir of ['seeds', 'official']) fs.rmSync(path.join(temp, dir), { recursive: true, force: true });
    const changed = exec('git', ['-C', checkout, 'diff', '--name-only', selection.baseSha, report.composition.target], checkout);
    const active = new Set([...changed.split('\n').map(p => p.split('/')[0]), ...Object.keys(c.localPlugins)]);
    const previous = fs.existsSync(seeds) ? fs.readdirSync(seeds).filter(n => !n.startsWith('.')) : [];
    const ids = new Set([...active, ...previous]);
    const candidates = [];
    for (const id of [...ids].sort()) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) continue;
      const source = c.localPlugins[id] || path.join(checkout, id);
      if (!fs.existsSync(path.join(source, 'ghost.json'))) {
        check(!c.localPlugins[id], `Local plugin ${id} has no ghost.json`);
        if (previous.includes(id)) report.retired.push({ id, action: 'retained', reason: 'No canonical manifest; review before retirement' });
        continue;
      }
      let mainManifest;
      let existsOnMain = false;
      try { exec('git', ['-C', checkout, 'cat-file', '-e', `${selection.baseSha}:${id}/ghost.json`], checkout); existsOnMain = true; } catch { /* New plugin. */ }
      if (existsOnMain) mainManifest = JSON.parse(exec('git', ['-C', checkout, 'show', `${selection.baseSha}:${id}/ghost.json`], checkout));
      const dest = path.join(temp, 'seeds', id), isActive = active.has(id);
      const entry = copyPlugin(id, source, dest, isActive ? mainManifest : undefined);
      entry.kind = isActive ? (c.localPlugins[id] ? 'local' : 'pr') : 'retire';
      if (!isActive) {
        // Remove only a seed, never installed files or ledgers. Host handles store ownership.
        const installed = brains(c).flatMap(b => [path.join(b, id), path.join(b, '_ns/_root', id)]).filter(p => fs.existsSync(path.join(p, 'ghost.json')));
        const managedBySeed = brains(c).some(b => {
          const ledger = path.join(b, '.builtin-provisioning.json');
          if (!fs.existsSync(ledger)) return false;
          return (read(ledger).seeded || []).includes(id);
        });
        if (!managedBySeed && installed.length && installed.every(p => packageHash(p) === entry.sha256)) {
          candidates.push({ id, remove: true }); report.retired.push({ id, action: 'remove-seed', reason: 'Installed root package matches main' }); continue;
        }
      }
      candidates.push({ id, dest }); report.plugins.push(entry);
    }
    // Replace the resource set as one directory, after preparation has succeeded.
    const staged = path.join(temp, 'official'); fs.mkdirSync(staged);
    if (fs.existsSync(seeds)) fs.cpSync(seeds, staged, { recursive: true, dereference: false });
    for (const p of candidates) {
      const d = path.join(staged, p.id); fs.rmSync(d, { recursive: true, force: true });
      if (!p.remove) fs.renameSync(p.dest, d);
    }
    fs.mkdirSync(path.dirname(seeds), { recursive: true });
    const backup = `${seeds}.previous-${process.pid}`;
    if (fs.existsSync(seeds)) fs.renameSync(seeds, backup);
    try { fs.renameSync(staged, seeds); } catch (e) { if (fs.existsSync(backup)) fs.renameSync(backup, seeds); throw e; }
    fs.rmSync(backup, { recursive: true, force: true });
    report.state = 'synced'; succeeded = true; save(reportFile, report); return report;
  } catch (e) { report.state = 'failed'; report.error = e.message; save(reportFile, report); throw e; }
  finally {
    if (succeeded) { try { exec('git', ['-C', c.plugins.checkout, 'worktree', 'remove', '--force', checkout], c.plugins.checkout); } catch { /* Retain failed worktree for inspection. */ } }
    if (!fs.existsSync(checkout)) fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function selectBuild(c, reportFile) {
  const report = verifyReport(reportFile);
  verifyUpgradeSnapshot(c, report);
  // Managed stage still validates shared profile compatibility, even when the isolated check passed.
  run('git', ['-C', c.app.checkout, 'cat-file', '-e', `${report.app.target}^{commit}`], c.app.checkout);
  const m = { TARGET: report.app.target, MAIN: report.app.baseSha, PACK: '', FETCH: '', DB_SCRIPT: '', LABEL: `Personal build ${report.app.target.slice(0, 10)}` };
  save(path.join(c.runtime.stateDir, 'manifest.json'), m); return m;
}
export function queueRequest(state, action) {
  check(['stage', 'stage-restart', 'restart'].includes(action), 'Request must be stage, stage-restart or restart');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'request'), action + '\n', { flag: 'wx', mode: 0o600 });
}
export function toolBundle(dest) {
  check(!fs.existsSync(dest), 'Tool bundle destination exists');
  fs.mkdirSync(path.join(dest, 'personal-build'), { recursive: true });
  fs.copyFileSync(cli, path.join(dest, 'personal-build.mjs'));
  const hashes = {};
  for (const name of fs.readdirSync(here)) {
    check(fs.lstatSync(path.join(here, name)).isFile(), 'Unexpected tool bundle entry');
    fs.copyFileSync(path.join(here, name), path.join(dest, 'personal-build', name));
  }
  for (const file of ['personal-build.mjs', ...fs.readdirSync(here).map(n => `personal-build/${n}`)]) hashes[file] = createHash('sha256').update(fs.readFileSync(path.join(dest, file))).digest('hex');
  save(path.join(dest, 'bundle.json'), { version: 1, files: hashes }); return hashes;
}

export async function managedCommand(command, options) {
  if (command === 'export') { check(options.report && options.out, '--report and --out required'); console.log(JSON.stringify(exportBuild(options.report, options.out), null, 2)); return; }
  check(options.config, '--config required');
  const c = managedConfig(options.config), r = c.runtime;
  const automaticJournal = path.join(r.stateDir, 'automatic/journal.json');
  if (command === 'launch' && c.automatic?.enabled === true) { const { supervise } = await import('./automatic.mjs'); return supervise(options.config); }
  if (fs.existsSync(automaticJournal) && ['launch', 'apply', 'rollback', 'sync-plugins', 'request', 'select'].includes(command)) {
    if (command === 'launch') { const { supervise } = await import('./automatic.mjs'); return supervise(options.config); }
    throw new Error('This profile uses supervised versions; use auto-check/auto-status/auto-recover instead of mutating a retained version');
  }
  if (command === 'doctor') { console.log(JSON.stringify(doctor(c), null, 2)); return; }
  if (command === 'sync-plugins') { console.log(JSON.stringify(syncPlugins(c), null, 2)); return; }
  if (command === 'select') { check(options.report, '--report required'); console.log(JSON.stringify(selectBuild(c, options.report), null, 2)); return; }
  if (command === 'request') { queueRequest(r.stateDir, options.action); console.log(`Queued ${options.action}`); return; }
  check(process.platform === 'darwin', 'Managed launcher currently requires macOS; portable prepare/check/start remain available');
  // Use the same derivation as the real restart entry: monitoring a different DB is unsafe.
  const startup = await import(pathToFileURL(path.join(c.app.checkout, 'scripts/restart-desktop-remote.mjs')));
  const expected = r.mode === 'shared' ? startup.productionUserDataDir(c.region) : startup.defaultIsolatedUserDataDir(c.name, c.region);
  check(path.resolve(expected) === r.dataDir, `runtime.dataDir must match the launch profile: ${expected}`);
  fs.mkdirSync(r.stateDir, { recursive: true });
  const m = command === 'launch' ? {} : loadManifest(r.stateDir);
  if (m.PACK && m.PACK_SHA256 && fs.existsSync(path.join(r.stateDir, m.PACK))) check(createHash('sha256').update(fs.readFileSync(path.join(r.stateDir, m.PACK))).digest('hex') === m.PACK_SHA256, 'Code pack digest mismatch');
  if (command !== 'stage' && command !== 'launch') {
    const ps = spawnSync('pgrep', ['-f', runtimeEnv(c, options.config).PERSONAL_ELECTRON_RE], { encoding: 'utf8' });
    check(ps.status === 1, 'Managed app is still running or process state is unknown; use an idle update request');
  }
  if (command === 'launch') {
    const ps = spawnSync('pgrep', ['-f', runtimeEnv(c, options.config).PERSONAL_ELECTRON_RE], { encoding: 'utf8' });
    check(ps.status === 0 || ps.status === 1, 'Cannot determine running app state');
    if (ps.status === 0) { console.log('Personal client is already running; use request for a coordinated update.'); return; }
  }
  const file = command === 'launch' ? 'mac-launcher.zsh' : 'mac-engine.zsh';
  execFileSync('zsh', [path.join(here, file), ...(command === 'launch' ? [] : [command])], { env: runtimeEnv(c, options.config, m), stdio: 'inherit' });
}


/** Incremental application pack, with immutable prerequisites; plugins are synchronized at launch. */
export function exportBuild(reportFile, output) {
  const report = verifyReport(reportFile);
  const app = report.app, prerequisites = [...new Set([app.baseSha, ...app.prs.map(p => p.sha)])];
  check(prerequisites.every(s => sha.test(s)), 'Invalid prerequisites');
  check(!fs.existsSync(output), 'Export directory exists'); fs.mkdirSync(output, { recursive: true });
  const pack = `personal-${app.target.slice(0, 12)}.pack`, file = path.join(output, pack);
  const objects = run('git', ['rev-list', '--objects', app.target, '--not', ...prerequisites], report.directory);
  const fd = fs.openSync(file, 'wx');
  try { execFileSync('git', ['pack-objects', '--stdout'], { cwd: report.directory, input: objects + '\n', stdio: ['pipe', fd, 'pipe'] }); }
  finally { fs.closeSync(fd); }
  const manifest = { TARGET: app.target, MAIN: app.baseSha, PACK: pack, PACK_SHA256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), FETCH_COMMITS: prerequisites, LABEL: `Personal build ${app.target.slice(0, 12)}` };
  save(path.join(output, 'manifest.json'), manifest); save(path.join(output, 'build-report.json'), report); return manifest;
}
