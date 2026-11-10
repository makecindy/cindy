import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {mobileBuildNumber, mobileConfig, mobileFollowup, mobileNext, mobileReceipt} from '../personal-build/mobile.mjs';
import { localPluginsIdentity } from '../personal-build/automatic.mjs';
import { exportBuild, parseManifest, syncPlugins } from '../personal-build/managed.mjs';
import { auditPlugins, configFrom, copyPlugin, discover, packageHash, prepare, prepareLocalPlugins, run, verifyReport, verifyFreshSelection, verifyUpgradeSnapshot } from '../personal-build.mjs';

// Script integration tier, explicit in test:runner like the existing worktree runner tests.
// Production entry: prepare/discover/copyPlugin/auditPlugins. Previous personal scripts hardcoded
// the author/paths, truncated PR lists and missed independently installed local copies.
// No existing runner covers composition. Fixtures use only temp repositories and fake GitHub
// Measured standalone on macOS: ~1.8 seconds (7 cases).
// GitHub replies are injected; real Git checks that dirty source checkouts survive and conflicts cannot look successful.
const tmp = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-test-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const repoId = { full_name: 'example/app' };

test('personal iOS artifact check requires matching signed and provisioned APNs environments', () => {
  const script = fileURLToPath(new URL('../personal-build/mobile-ios.py', import.meta.url));
  const result = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import json, runpy, sys
verify = runpy.run_path(sys.argv[1])['verify_push_environment']
results = []
for value, expected in [('development', 'sandbox'), ('production', 'prod')]:
    proof = verify({'aps-environment': value}, {'aps-environment': value})
    assert proof['registrationEnvironment'] == expected
    results.append(proof)
for signed, provisioned in [(None, None), ('invalid', 'invalid'), ('development', 'production'), ('production', None)]:
    try:
        verify({'aps-environment': signed}, {'aps-environment': provisioned})
    except RuntimeError:
        continue
    raise AssertionError('accepted invalid push signing')
print(json.dumps(results))
`, script], {encoding:'utf8'});
  assert.deepEqual(JSON.parse(result).map(p => p.registrationEnvironment), ['sandbox', 'prod']);
});

// Delivery integration contract: earlier one-off scripts could reuse old signing profiles,
// install into the other app/device, or reinstall after an interrupted tool call. Existing
// composition tests do not cover device receipts. Minimal inputs are plugin metadata/errors;
// this runner tier exercises production transitions without contacting a phone or Apple.
const mobileIdentity = {
  enabled:true, platform:'ios', bundleId:'com.example.personal', appGroupId:'group.com.example.personal',
  teamId:'ABCDEFGHIJ', signingCertificateSha256:'A'.repeat(64), region:'global',
  stateDir:'/personal/mobile', deviceId:'00000000-0000-0000-0000-000000000001',
  hardwareUdid:'00000000-0000000000000001', launchAfterInstall:false, verifyInstallationMetadataOnly:true,
};
const delivery = phase => ({phase, identity:mobileIdentity, build:'2026110902', app:'/personal/Cindy.app'});
const appInfo = build => ({ok:true, result:{ok:true, udid:mobileIdentity.deviceId,
  bundleId:mobileIdentity.bundleId, installed:true,
  app:{bundleIdentifier:mobileIdentity.bundleId, bundleVersion:build}, matchesLocal:null}});

test('mobile certificate pin accepts SHA-256 and rejects legacy, mixed or malformed configuration', () => {
  const validate = value => mobileConfig(value, '/personal', 'global');
  assert.equal(validate({...mobileIdentity, signingCertificateSha256:'a'.repeat(64)}).signingCertificateSha256, 'A'.repeat(64));
  for (const value of [undefined, null, 123, 'A'.repeat(40), 'G'.repeat(64)]) {
    assert.throws(() => validate({...mobileIdentity, signingCertificateSha256:value}), /signingCertificateSha256/);
  }
  assert.throws(() => validate({...mobileIdentity, signingCertificateSha1:'A'.repeat(40)}), /Legacy/);
  const {signingCertificateSha256, ...old} = mobileIdentity;
  assert.throws(() => validate({...old, signingCertificateSha1:'A'.repeat(40)}), /migrate/);
});

test('artifact certificate pin rejects replacement certificates, unauthorized profiles and old requests', () => {
  const script = fileURLToPath(new URL('../personal-build/mobile-ios.py', import.meta.url));
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import hashlib, runpy, sys
m = runpy.run_path(sys.argv[1])
cert = b'public certificate fixture'
identity = {'signingCertificateSha256': hashlib.sha256(cert).hexdigest()}
m['verify_certificate'](cert, [cert], identity)
for candidate, allowed, pin in [
    (b'different certificate', [b'different certificate'], identity),
    (cert, [], identity),
    (cert, [cert], {'signingCertificateSha1': 'A' * 40}),
    (cert, [cert], dict(identity, signingCertificateSha1='A' * 40)),
    (cert, [cert], {'signingCertificateSha256': 'G' * 64}),
]:
    try:
        m['verify_certificate'](candidate, allowed, pin)
    except RuntimeError:
        continue
    raise AssertionError('accepted invalid certificate identity')
`, script]);
});

test('personal mobile delivery selects one physical device, never downgrades or launches', () => {
  let d = delivery('awaiting-device');
  assert.equal(mobileNext(d).tool, 'devices');
  d = mobileReceipt(d, 'devices', {devices:[{udid:mobileIdentity.deviceId, kind:'physical', platform:'ios', isAvailable:false}]});
  assert.equal(d.phase, 'awaiting-device');
  d = mobileReceipt(d, 'devices', {devices:[{udid:mobileIdentity.deviceId, kind:'physical', platform:'ios', isAvailable:true}]});
  assert.equal(mobileNext(d).args.action, 'info');
  assert.throws(() => mobileReceipt(d, 'info', {...appInfo('2026110901').result, udid:'other'}), /another device/);
  const ready = mobileReceipt(d, 'info', appInfo('2026110901'));
  assert.deepEqual(mobileNext(ready).args, {action:'install', udid:mobileIdentity.deviceId, appPath:'/personal/Cindy.app', wait:60});
  assert.equal(mobileNext(mobileReceipt(d, 'info', appInfo('2026110903'))), null);
  const verified = mobileReceipt(d, 'info', appInfo('2026110902'));
  assert.equal(verified.phase, 'installed-metadata-verified');
  assert.equal(verified.fullByteMatchVerified, false);
  assert.equal(mobileNext(verified), null);
});

test('uncertain installation reconciles metadata instead of blindly retrying', () => {
  const d = delivery('installing');
  assert.equal(mobileNext(d).args.action, 'info');
  assert.throws(() => mobileReceipt(d, 'install', {ok:false, error:{message:'connection lost'}}), /connection lost/);
  const unresolved = mobileReceipt(d, 'info', appInfo('2026110901'));
  assert.equal(unresolved.phase, 'installation-unconfirmed');
  assert.equal(mobileNext(unresolved), null);
  const done = mobileReceipt(d, 'install', {udid:mobileIdentity.deviceId, bundleId:mobileIdentity.bundleId,
    installed:true, state:'done', execution:'executed'});
  assert.equal(done.phase, 'installing'); // Tool success still requires installed metadata.
  assert.equal(mobileReceipt(done, 'info', appInfo('2026110902')).phase, 'installed-metadata-verified');
});

test('mobile configuration freezes an external identity and rejects launching or region changes', t => {
  const root = tmp(t), source = path.join(root, 'source'), identityFile = path.join(root, 'device.json');
  fs.mkdirSync(source);
  const configFile = path.join(root, 'config.json');
  put(configFile, {version:1, name:'personal', region:'global', app:{checkout:source, repository:'example/app'}, mobileConfig:'device.json'});
  put(identityFile, {...mobileIdentity, stateDir:'mobile-state'});
  const frozen = configFrom(configFile);
  put(identityFile, {...mobileIdentity, bundleId:'com.example.other'});
  assert.equal(frozen.mobileConfig, undefined);
  assert.equal(frozen.mobile.bundleId, mobileIdentity.bundleId);
  assert.equal(mobileConfig(frozen.mobile, root, 'global').stateDir, path.join(fs.realpathSync(root), 'mobile-state'));
  assert.throws(() => mobileConfig({...mobileIdentity, launchAfterInstall:true}, root, 'global'), /never launches/);
  assert.throws(() => mobileConfig(mobileIdentity, root, 'cn'), /regions must agree/);
  assert.equal(mobileBuildNumber(2026110902, new Date('2026-11-09T01:00:00Z')), '2026110903');
  assert.equal(mobileBuildNumber(2026110903, new Date('2026-11-08T01:00:00Z')), '2026110904');
});

test('optional mobile build failure preserves the desktop check and reports a separate pending problem', async t => {
  const file = path.join(tmp(t), 'report.json');
  put(file, {state:'checked', configuration:{mobile:{enabled:true}}});
  const result = await mobileFollowup(file, async () => {throw Error('Expired signing profile');});
  assert.equal(result.phase, 'build-failed');
  assert.match(result.error, /Expired/);
  assert.equal(JSON.parse(fs.readFileSync(file)).state, 'checked');
  put(file, {configuration:{}});
  assert.deepEqual(await mobileFollowup(file, () => {throw Error('must not build');}), {phase:'disabled'});
});
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
  const continued = prepare(f.config, out, (cmd,args,cwd) => { assert.notEqual(cmd,'gh','continuation must not rediscover the selection'); return f.exec(cmd,args,cwd); }, { resume: true });
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
  let composing = false;
  const result = prepare(f.config, out, (cmd,args,cwd) => {
    if (cmd === 'gh') assert.equal(composing,false,'both repositories must be captured before composition');
    if (cmd === 'git' && args.includes('worktree') && args.includes('add')) composing = true;
    return f.exec(cmd,args,cwd);
  }), file = path.join(out, 'report.json');
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

// Regression: an old checked build used to bypass current draft/new PRs during upgrades.
// Integration-script tier, injected GitHub replies; exercise the real selection gate without network.
test('upgrade freshness rejects changed main, draft heads, new/closed PRs and plugin selections', () => {
 const repo={repository:'example/app',checkout:'.'}, config={author:'somebody',app:repo,plugins:{...repo,repository:'example/plugins'}};
 let base='b'.repeat(40), app=[pr(1,'draft')], plugins=[];
 const exec=(_cmd,args)=> args[1].includes('/commits/') ? base :
   JSON.stringify(args[1].includes('/pulls?') ? (args[1].includes('example/plugins')?plugins:app) : {default_branch:'main'});
 const snapshot=r=>{const d=discover(r,'somebody',exec);return {repository:r.repository,base:d.base,baseSha:d.baseSha,prs:d.selected,excluded:d.excluded};};
 const report={author:'somebody',app:snapshot(config.app),pluginRepository:snapshot(config.plugins)};
 assert.equal(verifyFreshSelection(config,report,exec).author,'somebody');
 app=[pr(1,'draft'),pr(2,'new')];assert.throws(()=>verifyFreshSelection(config,report,exec),/app: main or PR/);
 app=[];assert.throws(()=>verifyFreshSelection(config,report,exec),/app: main or PR/);
 app=[pr(1,'draft')];app[0].head.sha='c'.repeat(40);assert.throws(()=>verifyFreshSelection(config,report,exec),/app: main or PR/);
 app=[pr(1,'draft')];base='d'.repeat(40);assert.throws(()=>verifyFreshSelection(config,report,exec),/app: main or PR/);
 base='b'.repeat(40);plugins=[pr(3,'plugin-draft')];assert.throws(()=>verifyFreshSelection(config,report,exec),/plugins: main or PR/);
 assert.throws(()=>verifyFreshSelection(config,report,()=>{throw Error('offline')}),/offline/);
});

// Upgrade-start policy: snapshot validation must stay offline while detecting omitted/changed PRs.
// Existing freshness tests cover live comparison, not a long-running build's fixed selection.
test('each preparation captures a new selection; activation checks the fixed snapshot offline', t => {
 const f=fixture(t), report=prepare(f.config,path.join(f.root,'first-build'),f.exec);
 assert.equal(verifyUpgradeSnapshot(f.config,report).author,'somebody');
 const changedExec=(cmd,args,cwd)=>cmd==='gh' && args[1].includes('/pulls?') ? '[]' : f.exec(cmd,args,cwd);
 const next=prepare(f.config,path.join(f.root,'next-build'),changedExec);
 assert.equal(next.app.prs.length,0);
 assert.equal(report.app.prs.length,2);
 assert.equal(verifyUpgradeSnapshot(f.config,report).author,'somebody');
 const omitted=structuredClone(report);omitted.app.prs.pop();
 assert.throws(()=>verifyUpgradeSnapshot(f.config,omitted),/differs from upgrade snapshot/);
 const changed=structuredClone(report);changed.app.prs[0].sha='f'.repeat(40);
 assert.throws(()=>verifyUpgradeSnapshot(f.config,changed),/differs from upgrade snapshot/);
 const old=structuredClone(report);delete old.upgradeSnapshot;
 assert.throws(()=>verifyUpgradeSnapshot(f.config,old),/Missing upgrade snapshot/);
});
