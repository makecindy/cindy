import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { localPluginsIdentity } from '../personal-build/automatic.mjs';
import { exportBuild, parseManifest, syncPlugins } from '../personal-build/managed.mjs';
import { auditPlugins, configFrom, copyPlugin, discover, packageHash, prepare, prepareLocalPlugins, run, verifyReport } from '../personal-build.mjs';

// Script integration tier, explicit in test:runner like the existing worktree runner tests.
// Production entry: prepare/discover/copyPlugin/auditPlugins. Previous personal scripts hardcoded
// the author/paths, truncated PR lists and missed independently installed local copies.
// No existing runner covers composition. Fixtures use only temp repositories and fake GitHub
// Measured standalone on macOS: ~1.8 seconds (7 cases).
// GitHub replies are injected; real Git checks that dirty source checkouts survive and conflicts cannot look successful.
const tmp = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-test-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const repoId = { full_name: 'example/app' };
function pr(number, head, base = 'main', repository = repoId) {
  return { number, user: { login: 'somebody' }, draft: true, head: { ref: head, sha: 'a'.repeat(40), repo: repository }, base: { ref: base, repo: repoId }, html_url: `https://github.com/example/app/pull/${number}` };
}

test('discovers the authenticated author beyond page one; orders stacks but not unrelated fork names', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...pr(i + 100, `other-${i}`), user: { login: 'other' } }));
  const parent = pr(8, 'parent'), child = pr(2, 'child', 'parent'), fork = pr(1, 'main', 'main', { full_name: 'fork/app' });
  const result = discover({ repository: 'example/app', checkout: '.', exclude: [9] }, 'Somebody', (_cmd, args) => {
    if (args[1].includes('/commits/')) return 'b'.repeat(40);
    if (!args[1].includes('/pulls?')) return JSON.stringify({ default_branch: 'main' });
    return JSON.stringify(args[1].endsWith('page=1') ? rows : [child, parent, fork, pr(9, 'excluded')]);
  });
  assert.deepEqual(result.selected.map(p => p.number), [1, 8, 2]);
  assert.deepEqual(result.excluded, [9]);
  assert.equal(result.selected.every(p => p.draft), true);
});

test('config paths with spaces resolve relative to config, without any personal account default', t => {
  const dir = tmp(t), file = path.join(dir, 'config.json'), checkout = path.join(dir, 'my source');
  fs.mkdirSync(checkout);
  put(file, { version: 1, name: 'my-build', region: 'global', app: { checkout: 'my source', repository: 'example/app' } });
  const config = configFrom(file);
  assert.equal(config.app.checkout, fs.realpathSync(checkout)); assert.equal(config.author, undefined);
  put(file, { ...config, name: '../another-profile' });
  assert.throws(() => configFrom(file), /profile name/);
});

test('local plugins preserve source versions and compatibility instead of relabeling old code as newest', t => {
  const root = tmp(t), src = path.join(root, 'source'), dest = path.join(root, 'dest');
  put(path.join(src, 'ghost.json'), { id: 'sample', version: '1.2.0', minCindyVersion: '0.9.0' });
  put(path.join(src, 'main.js'), 'test');
  const copied = copyPlugin('sample', src, dest, { version: '1.2.3' });
  assert.equal(copied.version, '1.2.0'); assert.equal(copied.minCindyVersion, '0.9.0');
  assert.equal(packageHash(src), packageHash(dest));
  assert.equal(JSON.parse(fs.readFileSync(path.join(src, 'ghost.json'))).version, '1.2.0');
  put(path.join(dest, 'main.js'), 'changed'); assert.notEqual(packageHash(dest), copied.sha256);
  fs.symlinkSync(path.join(root, 'dest', 'main.js'), path.join(src, 'link.js'));
  assert.throws(() => copyPlugin('sample', src, path.join(root, 'rejected'), {}), /non-regular/);
  assert.equal(fs.existsSync(path.join(root, 'rejected')), false);
});

test('external local source registry keeps legacy config compatible and rejects ambiguous sources', t => {
  const root = tmp(t), file = path.join(root, 'config.json');
  const checkout = path.join(root, 'source'), registry = path.join(root, 'registry', 'sources.json');
  fs.mkdirSync(checkout);
  const config = { version: 1, name: 'personal', region: 'global',
    app: { checkout, repository: 'example/app' }, plugins: { checkout, repository: 'example/plugins' },
    localPlugins: {}, localPluginSources: 'registry/sources.json' };
  put(file, config);
  put(registry, { version: 1, plugins: { sample: { source: 'repository' }, custom: '../source' } });
  assert.deepEqual(configFrom(file).localPlugins, { sample: { source: 'repository' }, custom: fs.realpathSync(checkout) });
  const snapshot = path.join(root, 'snapshot.json');
  put(snapshot, configFrom(file));
  assert.deepEqual(configFrom(snapshot).localPlugins, configFrom(file).localPlugins);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).localPlugins, {});
  put(file, { ...config, localPlugins: { sample: checkout } });
  assert.throws(() => configFrom(file), /Duplicate local plugin source/);
  put(file, config); put(registry, { version: 2, plugins: {} });
  assert.throws(() => configFrom(file), /registry/);
});

test('audit reports root/local duplicates without deleting either installation', t => {
  const brain = tmp(t);
  for (const [ns, version] of [['_root', '0.3.40'], ['local', '0.3.38']]) put(path.join(brain, '_ns', ns, 'sim', 'ghost.json'), { id: 'sim', version });
  const before = auditPlugins(brain); assert.equal(before.duplicates.length, 2);
  assert.deepEqual(auditPlugins(brain), before);
});

function fixture(t, conflict = false) {
  const root = tmp(t), checkout = path.join(root, 'source checkout'); fs.mkdirSync(checkout);
  const git = (...args) => run('git', args, checkout);
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture Author'); git('config', 'user.email', 'fixture@example.invalid');
  put(path.join(checkout, 'file'), 'base\n'); git('add', '.'); git('commit', '-m', 'base'); const baseSha = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'first'); put(path.join(checkout, 'file'), 'first\n'); git('commit', '-am', 'first'); const first = git('rev-parse', 'HEAD');
  git('checkout', 'main'); git('checkout', '-b', 'second'); put(path.join(checkout, conflict ? 'file' : 'second'), 'second\n'); git('add', '.'); git('commit', '-m', 'second'); const second = git('rev-parse', 'HEAD');
  git('checkout', 'main'); put(path.join(checkout, 'file'), 'user dirty content\n');
  const config = { name: 'fixture', region: 'global', app: { repository: 'example/app', checkout }, localPlugins: {} };
  const exec = (cmd, args, cwd) => {
    if (cmd === 'gh') {
      if (args[1] === 'user') return 'somebody';
      if (args[1].includes('/commits/')) return baseSha;
      if (args[1].includes('/pulls?')) return JSON.stringify([{ ...pr(1, 'first'), head: { ...pr(1, 'first').head, sha: first } }, { ...pr(2, 'second'), head: { ...pr(2, 'second').head, sha: second } }]);
      return JSON.stringify({ default_branch: 'main' });
    }
    // Fetch exact commits from the temp repo; no network, no user Git config writes.
    return run(cmd, args.map(a => a === 'https://github.com/example/app.git' ? checkout : a), cwd);
  };
  return { root, checkout, config, exec, baseSha };
}

test('prepare creates an immutable composition and report, preserving dirty source and old output', t => {
  const f = fixture(t), out = path.join(f.root, 'build output');
  const report = prepare(f.config, out, f.exec);
  assert.equal(report.state, 'prepared'); assert.equal(report.author, 'somebody');
  assert.equal(report.app.prs.length, 2);
  // Git may check out CRLF on Windows runners (core.autocrlf); the content, not the EOL, is under test.
  const checkedOut = name => fs.readFileSync(path.join(report.directory, name), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(checkedOut('file'), 'first\n');
  assert.equal(checkedOut('second'), 'second\n');
  assert.equal(fs.readFileSync(path.join(f.checkout, 'file'), 'utf8'), 'user dirty content\n');
  assert.equal(run('git', ['rev-parse', 'HEAD'], f.checkout), f.baseSha);
  assert.throws(() => prepare(f.config, out, f.exec), /Output already exists/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'report.json'))).state, 'prepared');
  const exported = exportBuild(path.join(out, 'report.json'), path.join(f.root, 'export'));
  assert.equal(exported.TARGET, report.app.target);
  assert.deepEqual(parseManifest(fs.readFileSync(path.join(f.root, 'export/manifest.json'), 'utf8')), exported);
  assert.equal(exported.FETCH_COMMITS.length, 3);
});

test('a conflicting PR leaves an explicit failed report, not a partial successful build', t => {
  const f = fixture(t, true), out = path.join(f.root, 'conflicted');
  assert.throws(() => prepare(f.config, out, f.exec), /PR #2 conflicts/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json')));
  assert.equal(report.state, 'failed'); assert.equal(report.app.selected.length, 2);
  assert.equal(fs.existsSync(path.join(out, 'app')), true);
  assert.throws(() => prepare(f.config, out, f.exec, { resume: true }), /Resolve and commit/);
  put(path.join(out, 'app/file'), 'resolved\n');
  run('git', ['add', 'file'], path.join(out, 'app'));
  run('git', ['commit', '-m', 'resolve fixture conflict'], path.join(out, 'app'));
  const continued = prepare(f.config, out, f.exec, { resume: true });
  assert.equal(continued.state, 'prepared');
  assert.equal(continued.app.prs.length, 2);
  assert.equal(fs.readFileSync(path.join(out, 'app/file'), 'utf8'), 'resolved\n');
  assert.equal(fs.readFileSync(path.join(f.checkout, 'file'), 'utf8'), 'user dirty content\n');
});


test('application and local plugin compositions share a report without replacing public seeds', t => {
  const f = fixture(t), source = path.join(f.root, 'local plugin');
  put(path.join(source, 'ghost.json'), { id: 'sample', version: '1.0.0' });
  put(path.join(source, 'main.js'), 'local edit');
  f.config.plugins = f.config.app;
  f.config.localPlugins = { sample: source };
  const out = path.join(f.root, 'with plugins');
  const result = prepare(f.config, out, f.exec), file = path.join(out, 'report.json');
  assert.equal(result.pluginRepository.prs.length, 2);
  assert.equal(result.plugins.length, 0);
  assert.equal(result.localPlugins[0].namespace, 'local');
  assert.equal(result.localPlugins[0].version, '1.0.0');
  assert.equal(verifyReport(file).state, 'prepared');
  put(path.join(result.directory, 'apps/desktop/resources/personal-plugins/sample/main.js'), 'tampered');
  assert.throws(() => verifyReport(file), /Personal plugin inventory changed/);
});


test('plugin sync retains installed seed on conflict and resumes the pinned composition after resolution', t => {
  const f = fixture(t, true), state = path.join(f.root, 'state'), client = path.join(f.root, 'client');
  const seed = path.join(client, 'apps/desktop/resources/builtin-ghosts/official/sample');
  put(path.join(seed, 'ghost.json'), { id: 'sample', version: '1.0.0' }); put(path.join(seed, 'main.js'), 'old');
  const local = path.join(f.root, 'local');
  put(path.join(local, 'ghost.json'), { id: 'sample', version: '1.0.1' }); put(path.join(local, 'main.js'), 'new');
  const c = { ...f.config, plugins: f.config.app, localPlugins: {}, runtime: { stateDir: state, clientDir: client, dataDir: path.join(f.root, 'data') } };
  assert.throws(() => syncPlugins(c, f.exec), /conflicts/);
  assert.equal(fs.readFileSync(path.join(seed, 'main.js'), 'utf8'), 'old');
  const report = JSON.parse(fs.readFileSync(path.join(state, 'plugins-report.json')));
  const checkout = path.join(report.directory, 'checkout');
  put(path.join(checkout, 'file'), 'both'); run('git', ['add', 'file'], checkout); run('git', ['-c', 'rerere.enabled=true', 'commit', '-m', 'resolved'], checkout);
  const result = syncPlugins(c, f.exec);
  assert.equal(result.state, 'synced'); assert.deepEqual(result.selection, report.selection);
  assert.equal(fs.readFileSync(path.join(seed, 'main.js'), 'utf8'), 'old');
  assert.throws(() => syncPlugins({ ...c, localPlugins: { sample: local } }, f.exec), /supervised launcher/);
  assert.equal(fs.existsSync(checkout), false);
});

test('registered repository sources use the composed tree and keep provenance and real version', t => {
  const root = tmp(t), checkout = path.join(root, 'composed'), destination = path.join(root, 'bundle');
  put(path.join(checkout, 'sample/ghost.json'), { id: 'sample', version: '1.2.3+local' });
  put(path.join(checkout, 'sample/main.js'), 'composed code');
  const entries = prepareLocalPlugins({ localPlugins: { sample: { source: 'repository' } } }, checkout, destination, { repository: 'example/plugins', commit: 'a'.repeat(40) });
  assert.equal(entries[0].version, '1.2.3+local');
  assert.equal(entries[0].provenance.commit, 'a'.repeat(40));
  assert.equal(entries[0].namespace, 'local');
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'index.json'))).plugins[0].sha256, packageHash(path.join(destination, 'sample')));
});

test('local plugin release identity ignores where and when a bundle was prepared', t => {
  const root = tmp(t), prepared = name => {
    const checkout = path.join(root, `checkout-${name}`);
    put(path.join(checkout, 'sample/ghost.json'), { id: 'sample', version: '1.0.0' });
    put(path.join(checkout, 'sample/main.js'), 'same bytes');
    const destination = path.join(root, `bundle-${name}`);
    prepareLocalPlugins({ localPlugins: { sample: { source: 'repository' } } }, checkout, destination, { repository: 'example/plugins', commit: name.repeat(40) });
    return destination;
  };
  const a = prepared('a'), b = prepared('b');
  assert.notEqual(packageHash(a), packageHash(b));
  assert.equal(localPluginsIdentity(a), localPluginsIdentity(b));
  put(path.join(b, 'sample/main.js'), 'changed bytes');
  assert.notEqual(localPluginsIdentity(a), localPluginsIdentity(b));
});
