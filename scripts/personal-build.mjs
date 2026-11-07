#!/usr/bin/env node
/** Portable developer builds. Never installs plugins into a live profile or switches a running app. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resumableCompose } from './personal-build/composition.mjs';

export function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const invariant = (ok, message) => { if (!ok) throw new Error(message); };
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
const shaPattern = /^[a-f0-9]{40,64}$/;

export function configFrom(file) {
  const c = json(file), base = path.dirname(path.resolve(file));
  invariant(c.version === 1, 'Config version must be 1');
  invariant(/^[a-z0-9][a-z0-9-]{0,39}$/.test(c.name), 'Use a profile name of 1–40 lowercase letters, digits or hyphens');
  invariant(['global', 'cn', 'dev'].includes(c.region), 'Choose region global, cn or dev');
  if (c.gitIdentity) invariant(['name', 'email'].every(k => typeof c.gitIdentity[k] === 'string' && c.gitIdentity[k].length && !/[\r\n<>]/.test(c.gitIdentity[k])), 'Invalid Git identity');
  for (const key of ['app', 'plugins']) {
    if (key === 'plugins' && !c[key]) continue;
    const repo = c[key];
    if (repo && c.gitIdentity) repo.identity = c.gitIdentity;
    invariant(repo && typeof repo.checkout === 'string' && repositoryPattern.test(repo.repository), `${key}: checkout and GitHub owner/repo required`);
    invariant(!repo.localRefs || (Array.isArray(repo.localRefs) && repo.localRefs.every(ref => typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-'))), `${key}: localRefs must be Git refs`);
    repo.checkout = fs.realpathSync(path.resolve(base, repo.checkout));
    invariant(!repo.base || (typeof repo.base === 'string' && !repo.base.startsWith('-') && !/[\s~^:?*[\\]/.test(repo.base)), `${key}: invalid base branch`);
    invariant(!repo.exclude || (Array.isArray(repo.exclude) && repo.exclude.every(n => Number.isSafeInteger(n) && n > 0)), `${key}: exclude must contain PR numbers`);
  }
  invariant(!c.author || /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(c.author), 'Invalid GitHub author');
  c.localPlugins ??= {};
  invariant(c.localPlugins && !Array.isArray(c.localPlugins) && typeof c.localPlugins === 'object', 'localPlugins must be an object');
  if (c.localPluginSources !== undefined) {
    invariant(typeof c.localPluginSources === 'string', 'localPluginSources must be a registry file');
    c.localPluginSources = fs.realpathSync(path.resolve(base, c.localPluginSources));
    const registry = json(c.localPluginSources);
    invariant(registry.version === 1 && registry.plugins && !Array.isArray(registry.plugins) && typeof registry.plugins === 'object', 'Invalid local plugin source registry');
    for (const [id, source] of Object.entries(registry.plugins)) {
      invariant(!Object.hasOwn(c.localPlugins, id), `Duplicate local plugin source: ${id}`);
      c.localPlugins[id] = typeof source === 'string' ? path.resolve(path.dirname(c.localPluginSources), source) : source;
    }
    // Resolved build snapshots are self-contained. Re-reading a saved config
    // must not merge the same registry twice or adopt later source edits.
    delete c.localPluginSources;
  }
  for (const [id, source] of Object.entries(c.localPlugins)) {
    invariant(/^[a-z0-9][a-z0-9-]*$/.test(id), 'Invalid local plugin id');
    if (source && typeof source === 'object' && source.source === 'repository' && Object.keys(source).length === 1) continue;
    invariant(typeof source === 'string', 'Local plugin source must be a directory or {source:"repository"}');
    c.localPlugins[id] = fs.realpathSync(path.resolve(base, source));
  }
  invariant(c.plugins || Object.keys(c.localPlugins).length === 0, 'localPlugins requires a plugins repository for its base version');
  return c;
}

/** REST pages are read until exhausted; drafts and fork PRs are retained. */
export function discover(repo, author, exec = run) {
  const metadata = JSON.parse(exec('gh', ['api', `repos/${repo.repository}`], repo.checkout));
  const base = repo.base || metadata.default_branch;
  invariant(typeof base === 'string' && base.length > 0, 'Repository has no default branch');
  const all = [];
  for (let page = 1; ; page++) {
    const rows = JSON.parse(exec('gh', ['api', `repos/${repo.repository}/pulls?state=open&per_page=100&page=${page}`], repo.checkout));
    invariant(Array.isArray(rows), 'Invalid GitHub PR response');
    all.push(...rows.filter(p => p.user?.login?.toLowerCase() === author.toLowerCase()));
    if (rows.length < 100) break;
  }
  const excluded = all.filter(p => (repo.exclude || []).includes(p.number));
  const selected = all.filter(p => !(repo.exclude || []).includes(p.number));
  // Only match a stacked base to a head from that same repository, not another fork's branch name.
  const key = (r, ref) => `${r?.full_name}:${ref}`;
  const heads = new Map(selected.map(p => [key(p.head.repo, p.head.ref), p]));
  const ordered = [], visited = new Set(), visiting = new Set();
  function visit(p) {
    if (visited.has(p.number)) return;
    invariant(!visiting.has(p.number), 'Cyclic stacked PR dependency');
    visiting.add(p.number);
    const parent = heads.get(key(p.base.repo, p.base.ref));
    if (parent && parent !== p) visit(parent);
    visiting.delete(p.number); visited.add(p.number); ordered.push(p);
  }
  selected.sort((a, b) => a.number - b.number).forEach(visit);
  const baseSha = exec('gh', ['api', `repos/${repo.repository}/commits/${encodeURIComponent(base)}`, '--jq', '.sha'], repo.checkout);
  invariant(shaPattern.test(baseSha), 'Invalid base commit');
  return { base, baseSha, selected: ordered.map(p => ({ number: p.number, sha: p.head.sha, draft: p.draft === true, url: p.html_url })),
    excluded: excluded.map(p => p.number) };
}

/** Hash exactly the copyable package, rejecting symlinks instead of following them outside its root. */
export function pluginFiles(dir) {
  const files = [];
  function walk(at, prefix = '') {
    for (const name of fs.readdirSync(at).sort()) {
      if (name.startsWith('.') || name === 'node_modules' || name.endsWith('.cindy')) continue;
      const src = path.join(at, name), rel = prefix + name, st = fs.lstatSync(src);
      if (st.isDirectory()) walk(src, rel + '/');
      else { invariant(st.isFile() && !st.isSymbolicLink(), `Plugin contains non-regular entry: ${rel}`); files.push([rel, src]); }
    }
  }
  walk(dir); return files;
}
export function packageHash(dir) {
  const hash = createHash('sha256');
  for (const [rel, file] of pluginFiles(dir)) {
    const data = fs.readFileSync(file);
    hash.update(`${Buffer.byteLength(rel)}:${rel}:${data.length}:`); hash.update(data);
  }
  return hash.digest('hex');
}
export function copyPlugin(id, source, dest) {
  const files = pluginFiles(source), manifest = json(path.join(source, 'ghost.json'));
  invariant(manifest.id === id, `Plugin manifest ID differs: ${id}`);
  invariant(!fs.existsSync(dest), `Plugin destination already exists: ${id}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const [rel, src] of files) {
    const to = path.join(dest, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(src, to);
  }
  // Source versions are facts. Never make an old local tree outrank a public
  // release by manufacturing a higher version during packaging.
  invariant(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(manifest.version), `${id}: invalid version`);
  // Keep the plugin's declared host requirement; do not lower compatibility requirements.
  return { id, source, sourceVersion: json(path.join(source, 'ghost.json')).version, version: manifest.version,
    sha256: packageHash(dest), minCindyVersion: manifest.minCindyVersion ?? null };
}

export function localPluginSource(config, id, checkout) {
  const source = config.localPlugins[id];
  return typeof source === 'string' ? source : path.join(checkout, id);
}

/** The host verifies the same content-v2 fingerprint using ghostContentTree. */
export function pluginContentHash(dir) {
  const h = createHash('sha256').update('cindy-ghost-content-v2\0');
  for (const [rel, file] of pluginFiles(dir).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const bytes = Buffer.from(rel), length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
    h.update(length).update(bytes).update(createHash('sha256').update(fs.readFileSync(file)).digest());
  }
  return h.digest('hex');
}

export function prepareLocalPlugins(config, checkout, destination, provenance = {}) {
  invariant(!fs.existsSync(destination), 'Personal plugin destination already exists');
  const entries = [];
  for (const id of Object.keys(config.localPlugins).sort()) {
    const source = localPluginSource(config, id, checkout);
    const dest = path.join(destination, id);
    const entry = copyPlugin(id, source, dest);
    invariant(packageHash(source) === entry.sha256, `${id}: source changed while copying`);
    entries.push({ ...entry, namespace: 'local', contentHash: pluginContentHash(dest),
      provenance: typeof config.localPlugins[id] === 'string' ? { kind: 'directory', directory: source } : { kind: 'repository', ...provenance } });
  }
  if (entries.length) write(path.join(destination, 'index.json'), { version: 1, plugins: entries });
  return entries;
}

/** Read-only inventory. Same id in local/root is not automatically safe to delete or migrate. */
export function auditPlugins(brain) {
  const rows = [];
  const roots = [['legacy-root', brain]];
  const ns = path.join(brain, '_ns');
  if (fs.existsSync(ns)) for (const d of fs.readdirSync(ns, { withFileTypes: true })) if (d.isDirectory()) roots.push([d.name, path.join(ns, d.name)]);
  for (const [namespace, root] of roots) for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dir = path.join(root, d.name), file = path.join(dir, 'ghost.json');
    if (!fs.existsSync(file)) continue;
    const m = json(file); rows.push({ id: m.id, version: m.version, namespace, directory: dir });
  }
  const duplicates = rows.filter(row => rows.filter(x => x.id === row.id).length > 1);
  return { instances: rows, duplicates, action: duplicates.length ? 'Review duplicate instances in Cindy before use; no data or installation was changed.' : 'No duplicate IDs found.' };
}

export function prepare(config, out, exec = run, { resume = false } = {}) {
  invariant(resume || !fs.existsSync(out), 'Output already exists; choose a new directory (existing builds are never reset)');
  if (!resume) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.mkdirSync(out); }
  const file = path.join(out, 'report.json');
  const report = resume ? json(file) : { version: 1, state: 'preparing', createdAt: new Date().toISOString(), name: config.name, region: config.region, configuration: config, plugins: [], omittedPlugins: [] };
  invariant(!resume || report.state === 'failed', 'Only failed preparations can continue');
  report.state = 'preparing'; delete report.error; report.directory = path.join(out, 'app');
  write(file, report);
  try {
    const author = config.author || exec('gh', ['api', 'user', '--jq', '.login'], config.app.checkout);
    report.author = author;
    for (const key of ['app', 'plugins']) {
      const repo = config[key]; if (!repo) continue;
      const field = key === 'app' ? 'app' : 'pluginRepository';
      if (report[field]?.target) continue;
      const selection = report[field]?.selected ? report[field] : discover(repo, author, exec);
      report[field] = { repository: repo.repository, ...selection }; write(file, report);
      report[field] = resumableCompose(repo, selection, path.join(out, key), path.join(out, `${key}-composition.json`), exec);
      write(file, report);
    }
    if (config.plugins) {
      if (resume) {
        const seeds = path.join(report.directory, 'apps/desktop/resources/builtin-ghosts/official');
        if (fs.existsSync(seeds)) throw new Error('Plugin copy failed after composition; inspect generated seeds and prepare a new output instead of overwriting edits');
      }
      const repo = config.plugins, info = report.pluginRepository, checkout = path.join(out, 'plugins');
      const changed = exec('git', ['-C', checkout, 'diff', '--name-only', info.baseSha, info.target], checkout);
      const ids = new Set([...changed.split('\n').map(p => p.split('/')[0]), ...Object.keys(config.localPlugins || {})]);
      for (const id of [...ids].sort()) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) continue;
        if (Object.hasOwn(config.localPlugins, id)) continue; // Dedicated local update, never a public seed.
        const source = path.join(checkout, id);
        if (!fs.existsSync(path.join(source, 'ghost.json'))) {
          if (config.localPlugins?.[id]) throw new Error(`${id}: local source has no ghost.json`);
          try { exec('git', ['-C', checkout, 'cat-file', '-e', `${info.baseSha}:${id}/ghost.json`], checkout); report.omittedPlugins.push({ id, reason: 'Removed by composition; existing installations are not deleted' }); } catch { /* Non-plugin directory. */ }
          continue;
        }
        const dest = path.join(report.directory, 'apps/desktop/resources/builtin-ghosts/official', id);
        report.plugins.push({ ...copyPlugin(id, source, dest), localOverride: false });
      }
      report.localPlugins = prepareLocalPlugins(config, checkout,
        path.join(report.directory, 'apps/desktop/resources/personal-plugins'),
        { repository: repo.repository, commit: info.target, prs: info.prs, localRefs: info.localRefs });
      if (report.localPlugins.length) report.localPluginsHash = packageHash(path.join(report.directory, 'apps/desktop/resources/personal-plugins'));
    }
    report.state = 'prepared'; write(file, report); return report;
  } catch (error) {
    report.state = 'failed'; report.error = error.message; write(file, report); throw error;
  }
}

export function verifyReport(file) {
  const r = json(file);
  invariant(r.version === 1 && ['prepared', 'checked'].includes(r.state) && shaPattern.test(r.app?.target), 'Build is not prepared');
  invariant(run('git', ['rev-parse', 'HEAD'], r.directory) === r.app.target, 'Build HEAD changed; prepare again');
  invariant(run('git', ['status', '--porcelain', '--untracked-files=no'], r.directory) === '', 'Build has tracked changes; prepare again');
  for (const p of r.plugins) invariant(packageHash(path.join(r.directory, 'apps/desktop/resources/builtin-ghosts/official', p.id)) === p.sha256, `Plugin ${p.id} changed; prepare again`);
  const personal = path.join(r.directory, 'apps/desktop/resources/personal-plugins');
  invariant((r.localPluginsHash ?? null) === (fs.existsSync(personal) ? packageHash(personal) : null), 'Personal plugin inventory changed; prepare again');
  const seeds = path.join(r.directory, 'apps/desktop/resources/builtin-ghosts');
  if (fs.existsSync(seeds)) {
    invariant(fs.readdirSync(seeds).every(n => n === 'official'), 'Unexpected seed root; prepare again');
    const actual = fs.readdirSync(path.join(seeds, 'official')).sort();
    invariant(JSON.stringify(actual) === JSON.stringify(r.plugins.map(p => p.id).sort()), 'Seed inventory changed; prepare again');
  }
  return r;
}
function pnpm(args, cwd) {
  // npm_execpath is not used: this CLI may be called directly, outside pnpm.
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}
export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'legacy-build') { const { legacyBuild } = await import('./personal-build/legacy-build.mjs'); return legacyBuild(rest); }
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    invariant(/^--[a-z-]+$/.test(rest[i]) && rest[i + 1] && !rest[i + 1].startsWith('--'), 'Options require a value');
    invariant(['config', 'out', 'app', 'plugins', 'report', 'brain', 'action'].includes(rest[i].slice(2)), `Unknown option ${rest[i]}`);
    options[rest[i].slice(2)] = rest[i + 1];
  }
  const need = key => { invariant(options[key], `--${key} is required`); return path.resolve(options[key]); };
  if (['auto-check', 'auto-launch', 'auto-status', 'auto-recover', 'auto-bootstrap'].includes(command)) { const { automaticCommand } = await import('./personal-build/automatic.mjs'); return automaticCommand(command, options); }
  if (['launch', 'stage', 'apply', 'rollback', 'doctor', 'sync-plugins', 'select', 'request', 'export'].includes(command)) {
    const { managedCommand } = await import('./personal-build/managed.mjs');
    return managedCommand(command, options);
  }
  if (command === 'bundle-tools') {
    const { toolBundle } = await import('./personal-build/managed.mjs');
    console.log(JSON.stringify(toolBundle(need('out')), null, 2)); return;
  }
  if (command === 'init') {
    const file = need('config'); invariant(!fs.existsSync(file), 'Config already exists');
    const app = fs.realpathSync(options.app || process.cwd());
    const describe = checkout => {
      const m = JSON.parse(run('gh', ['repo', 'view', '--json', 'nameWithOwner'], checkout));
      return { checkout, repository: m.nameWithOwner, exclude: [] };
    };
    const config = { version: 1, name: 'personal', region: 'global', author: run('gh', ['api', 'user', '--jq', '.login'], app), app: describe(app), localPlugins: {} };
    if (options.plugins) config.plugins = describe(fs.realpathSync(options.plugins));
    fs.mkdirSync(path.dirname(file), { recursive: true }); write(file, config); console.log(file); return;
  }
  if (command === 'continue') {
    const file = need('report'), previous = json(file);
    prepare(previous.configuration, path.dirname(file), run, { resume: true }); console.log(file); return;
  }
  if (command === 'prepare') { const out = need('out'); prepare(configFrom(need('config')), out); console.log(path.join(out, 'report.json')); return; }
  if (command === 'audit') { console.log(JSON.stringify(auditPlugins(need('brain')), null, 2)); return; }
  if (command === 'status') { console.log(JSON.stringify(json(need('report')), null, 2)); return; }
  if (command === 'check') {
    const file = need('report'), r = verifyReport(file);
    r.state = 'prepared'; delete r.checkedAt; delete r.checkError; write(file, r);
    try {
      pnpm(['install', '--frozen-lockfile'], r.directory);
      for (const args of [['--filter', 'desktop', 'db:validate'], ['check:design-inventory'], ['--filter', 'desktop', 'run', 'typecheck']]) pnpm(args, r.directory);
      verifyReport(file); r.state = 'checked'; r.checkedAt = new Date().toISOString(); write(file, r);
    } catch (error) { r.state = 'prepared'; r.checkError = error.message; write(file, r); throw error; }
    return;
  }
  if (command === 'start') {
    const r = verifyReport(need('report')); invariant(r.state === 'checked', 'Run check successfully before start');
    invariant(/^[a-z0-9][a-z0-9-]{0,39}$/.test(r.name) && ['global', 'cn', 'dev'].includes(r.region), 'Invalid launch profile');
    // Reuse the repository's platform-specific startup, compatibility and process guards.
    pnpm(['restart:desktop:remote', '--', `--region=${r.region}`, `--isolated=${r.name}`], r.directory); return;
  }
  invariant(!command || command === 'help', `Unknown command ${command}`);
  console.log('personal-build: init --config FILE [--app CHECKOUT] [--plugins CHECKOUT]\nprepare --config FILE --out NEW_DIRECTORY\ncheck|start|status --report FILE\naudit --brain CINDY_BRAIN_DIRECTORY\ncontinue --report FILE\nexport --report FILE --out NEW_DIRECTORY\nlaunch|doctor|sync-plugins|stage|apply|rollback --config FILE\nselect --config FILE --report FILE\nrequest --config FILE --action stage|stage-restart|restart\nbundle-tools --out NEW_DIRECTORY\nauto-launch|auto-check|auto-status|auto-recover --config FILE\nauto-bootstrap --config FILE --report BOOTSTRAP_REPORT\nManaged macOS lifecycle requires explicit runtime configuration. Restart only follows a request.');
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
